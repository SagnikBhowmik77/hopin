import { config } from './config.js';
import { many, one, tx } from './db.js';
import { capturePayment, fetchPayment, razorpayEnabled, rideMethodFor } from './razorpay.js';
import { amountDue, broadcastRide, loadRide } from './hub.js';
import { emailEnabled, notify, sendEmail } from './notify.js';
import { renderReceipt } from './receipt.js';
import { HttpError } from './auth.js';
import { afterSplitPaid, afterTip, applySplitPayment, applyTip, fareBreakdown } from './fairMoney.js';
import { createLock } from './booking.js';
import { buyPass } from './drivers.js';
import { companyTxn, earnPoints, rewardRiderReferral } from './growth.js';
import { notifyIn } from './messages.js';

/**
 * Money flow
 *  - Each finished ride (or cancellation with a fee) gets payment_status 'due'.
 *  - Wallet rides are debited from the rider's real ledger balance on the spot.
 *  - Cash is confirmed by the driver.
 *  - Card, UPI, netbanking and wallet top-ups go through Razorpay. Without its
 *    keys those requests are refused with ONLINE_PAYMENTS_OFF - never faked.
 *    A Razorpay payment only counts once Razorpay itself reports it captured for
 *    the exact amount of the order Hopin created.
 *  - On payment the driver is credited `driverShare` of the amount.
 */

export const onlinePaymentsEnabled = () => razorpayEnabled();
export const ONLINE_PAYMENTS_OFF = 'Online payments (card, UPI, wallet top-up) are not set up yet. Please pay with cash.';

/**
 * Applies a Razorpay payment to the order it was made for. Safe to call from both
 * the checkout return and the webhook: whichever arrives first applies it, the
 * other is a no-op. Returns { order, applied }.
 */
export async function applyRazorpayPayment(razorpayOrderId, paymentId) {
  const order = await one('SELECT * FROM payment_orders WHERE razorpay_order_id = $1', [razorpayOrderId]);
  if (!order) throw new HttpError(404, 'Unknown payment order');
  if (order.status !== 'created') return { order, applied: false };

  // Ask Razorpay what really happened; never trust the browser's account of it.
  let payment;
  try {
    payment = await fetchPayment(paymentId);
    if (payment.order_id !== razorpayOrderId) throw new HttpError(400, 'That payment belongs to a different order');
    if (payment.amount !== order.amount * 100 || payment.currency !== 'INR') throw new HttpError(400, 'Payment amount does not match the order');
    if (payment.status === 'authorized') payment = await capturePayment(paymentId, payment.amount);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, `Could not confirm the payment with Razorpay (${err.message})`);
  }
  if (payment.status !== 'captured') throw new HttpError(402, `Payment is ${payment.status}, not completed`);

  const result = await tx(async ({ query: q }) => {
    const o = (await q('SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE', [order.id])).rows[0];
    if (o.status !== 'created') return { order: o, applied: false };
    let status = 'paid';
    if (o.kind === 'topup') await creditWallet(q, o.user_id, o.amount, paymentId);
    // Already tipped, split already settled, or the ride already paid another way (e.g. cash):
    // keep the money flagged for a refund, never lose track of it.
    else if (o.kind === 'tip') {
      if (!(await applyTip(q, { rideId: o.ride_id, riderId: o.user_id, amount: o.amount, ref: paymentId, fromWallet: false }))) status = 'needs_refund';
    } else if (o.kind === 'split') {
      if (!(await applySplitPayment(q, { splitId: o.split_id, payerId: o.user_id, ref: paymentId, fromWallet: false }))) status = 'needs_refund';
    } else if (o.kind === 'company_topup') {
      await companyTxn(q, { companyId: o.company_id, amount: o.amount, kind: 'topup', userId: o.user_id, ref: paymentId });
    } else if (o.kind === 'driver_pass') {
      if (!(await buyPass(q, { driverId: o.user_id, price: o.amount, ref: paymentId, fromWallet: false }))) status = 'needs_refund';
    } else if (o.kind === 'price_lock') {
      // Checked before anything is written, so a refusal (e.g. already 3 locks) leaves the money flagged, not lost.
      try {
        await createLock(q, { riderId: o.user_id, ...o.meta, ref: paymentId, fromWallet: false });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        status = 'needs_refund';
      }
    } else if (!(await markPaid(q, o.ride_id, paymentId, rideMethodFor(payment.method)))) status = 'needs_refund';
    const updated = (
      await q(`UPDATE payment_orders SET status = $2, razorpay_payment_id = $3, method = $4, paid_at = now() WHERE id = $1 RETURNING *`, [
        o.id,
        status,
        paymentId,
        payment.method ?? null,
      ])
    ).rows[0];
    return { order: updated, applied: true };
  });

  if (result.applied) {
    const o = result.order;
    if (o.kind === 'ride' && o.status === 'paid') await afterPaid(o.ride_id);
    if (o.kind === 'tip' && o.status === 'paid') await afterTip(o.ride_id);
    if (o.kind === 'split' && o.status === 'paid') await afterSplitPaid(o.split_id);
    if (o.kind === 'topup') await notifyIn(o.user_id, 'walletTopup', { amount: o.amount }, '/profile');
    if (o.kind === 'company_topup') await notifyIn(o.user_id, 'companyTopup', { amount: o.amount }, '/company');
    if (o.status === 'needs_refund') {
      await notifyIn(o.user_id, 'paidTwice', { kind: o.kind, amount: o.amount }, '/help');
      const admins = await many(`SELECT id FROM users WHERE role = 'admin'`);
      for (const a of admins) await notify(a.id, 'Refund needed', `A ₹${o.amount} Razorpay payment (${paymentId}) arrived for an already-paid ride.`, '/admin');
    }
  }
  return result;
}

export function requireOnlinePayments() {
  if (!onlinePaymentsEnabled()) throw new HttpError(503, ONLINE_PAYMENTS_OFF);
}

/** Called inside the transaction that completes or cancels a ride. Returns true if it got paid. */
export async function settle(q, ride) {
  const amount = amountDue(ride);
  if (amount <= 0) return false;
  await q(`UPDATE rides SET payment_status = 'due' WHERE id = $1`, [ride.id]);
  if (ride.payment_method === 'corporate' && ride.company_id) {
    // Business ride: paid from the company wallet; if it ran short meanwhile, it stays due.
    const ok = await companyTxn(q, { companyId: ride.company_id, amount: -amount, kind: 'ride', rideId: ride.id, userId: ride.rider_id, ref: `COMPANY-RIDE-${ride.id}`, noOverdraw: true });
    return ok ? Boolean(await markPaid(q, ride.id, `COMPANY-${ride.id.slice(0, 8).toUpperCase()}`)) : false;
  }
  if (ride.payment_method !== 'wallet') return false;
  // Not enough balance: leave it due, the rider can pay another way.
  if (!(await postTxn(q, { userId: ride.rider_id, amount: -amount, kind: 'ride', rideId: ride.id, noOverdraw: true }))) return false;
  return Boolean(await markPaid(q, ride.id, `WALLET-${ride.id.slice(0, 8).toUpperCase()}`));
}

/**
 * The one way to change a wallet: records the movement and applies it to the balance in
 * the same transaction, so a balance always equals the sum of its ledger. 'cash_earning'
 * is only recorded (cash a driver collected by hand never enters the wallet).
 * With `noOverdraw` (riders' debits) it returns false instead of going below zero.
 */
export async function postTxn(q, { userId, amount, kind, rideId = null, ref = null, noOverdraw = false }) {
  if (kind !== 'cash_earning') {
    const ok = (
      await q(`UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2 ${noOverdraw ? 'AND wallet_balance + $1 >= 0' : ''} RETURNING id`, [
        amount,
        userId,
      ])
    ).rows[0];
    if (!ok) return false;
  }
  await q('INSERT INTO wallet_txns (user_id, amount, kind, ride_id, ref) VALUES ($1, $2, $3, $4, $5)', [userId, amount, kind, rideId, ref]);
  return true;
}

/** Marks a due ride as paid and credits the driver. Idempotent: returns null if already paid. */
export async function markPaid(q, rideId, ref, method) {
  const r = (
    await q(
      `UPDATE rides SET payment_status = 'paid', payment_ref = $2, paid_at = now(), payment_method = COALESCE($3, payment_method)
       WHERE id = $1 AND payment_status = 'due' RETURNING *`,
      [rideId, ref, method ?? null],
    )
  ).rows[0];
  if (!r) return null;
  const due = amountDue(r);
  // A ride accepted on a pass day pays the driver everything.
  const earning = Math.round(due * (r.commission_free ? 1 : config.driverShare));
  if (r.driver_id && due > 0) {
    if (r.payment_method === 'cash') {
      // The driver collected the whole fare by hand; Hopin's share comes out of their wallet.
      await postTxn(q, { userId: r.driver_id, amount: due, kind: 'cash_earning', rideId: r.id });
      if (due > earning) await postTxn(q, { userId: r.driver_id, amount: earning - due, kind: 'commission', rideId: r.id });
    } else if (earning > 0) {
      await postTxn(q, { userId: r.driver_id, amount: earning, kind: 'earning', rideId: r.id });
    }
  }
  return r;
}

/**
 * Credits a wallet top-up. Only ever called with a payment reference confirmed by
 * the payment gateway (step 4). `ref` is unique, so a replayed confirmation cannot
 * credit twice.
 */
export async function creditWallet(q, userId, amount, ref) {
  const inserted = (
    await q(`INSERT INTO wallet_txns (user_id, amount, kind, ref) VALUES ($1, $2, 'topup', $3) ON CONFLICT (ref) DO NOTHING RETURNING id`, [userId, amount, ref])
  ).rows[0];
  if (inserted) await q('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
  return Boolean(inserted);
}

/** Everything that should happen once a ride is paid: live update, notifications, emailed receipt. */
export async function afterPaid(rideId) {
  const r = await loadRide(rideId);
  broadcastRide(r);
  const amount = amountDue(r);
  await notifyIn(r.rider_id, 'paymentReceived', { amount, method: r.payment_method.toUpperCase() }, `/trips/${r.id}`);
  if (r.driver_id) await notifyIn(r.driver_id, 'tripPaidDriver', { amount: Math.round(amount * (r.commission_free ? 1 : config.driverShare)) }, '/trips');
  // Growth: a first paid trip may complete a referral; personal trips earn loyalty points.
  if (r.status === 'completed') {
    await rewardRiderReferral(r.rider_id).catch((err) => console.warn('[growth] referral reward failed', err.message));
    await earnPoints(r).catch((err) => console.warn('[growth] loyalty points failed', err.message));
  }
  // Automatic receipt email only when a mail server is configured; otherwise there is nothing to send with.
  if (emailEnabled()) emailReceipt(r).catch((err) => console.warn('[mail] receipt failed', err.message));
}

export async function emailReceipt(r) {
  const rider = await one('SELECT email, name FROM users WHERE id = $1', [r.rider_id]);
  return sendEmail({
    to: rider.email,
    subject: `Your Hopin receipt - ${new Date(r.created_at).toLocaleDateString('en-IN')}`,
    text: `Hi ${rider.name},\n\nThanks for riding with Hopin. Your receipt for Rs. ${amountDue(r)} is attached.\n\n- Team Hopin`,
    attachments: [{ filename: `hopin-receipt-${r.id.slice(0, 8)}.pdf`, content: await renderReceipt(r, await fareBreakdown(r)) }],
  });
}
