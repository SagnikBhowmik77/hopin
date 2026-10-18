import { HttpError } from './auth.js';
import { config } from './config.js';
import { many, one, query, tx } from './db.js';
import { amountDue } from './hub.js';
import { createRefund, fetchRefund, razorpayEnabled } from './razorpay.js';
import { postTxn } from './payments.js';
import { companyTxn } from './growth.js';
import { notifyIn } from './messages.js';

/**
 * Refunds, issued by an admin.
 *
 * Source: a paid ride, or a duplicate Razorpay payment (payment_orders 'needs_refund').
 * Destination:
 *   original - Razorpay payments go back through Razorpay's refund API; wallet-paid
 *              rides go back to the wallet. Cash rides have no "original" to send to.
 *   wallet   - credited to the rider's Hopin wallet at once.
 * The total refunded can never exceed what was paid: the source row is locked while
 * the refund is reserved, and failed refunds free their amount again.
 * A ride refund takes back the driver's share of that amount; duplicates never
 * reached the driver, so they don't touch earnings.
 */

const NOT_FAILED = `status <> 'failed'`;

export const toRefund = (r) => ({
  id: r.id,
  rideId: r.ride_id,
  paymentOrderId: r.payment_order_id,
  amount: r.amount,
  destination: r.destination,
  status: r.status,
  razorpayRefundId: r.razorpay_refund_id,
  reason: r.reason,
  failureReason: r.failure_reason,
  driverAdjustment: r.driver_adjustment,
  createdAt: r.created_at,
  processedAt: r.processed_at,
});

/** What can still be refunded from a source, and how. */
export async function refundable({ rideId, paymentOrderId }, q = query) {
  if (paymentOrderId) {
    const o = (await q(`SELECT * FROM payment_orders WHERE id = $1`, [paymentOrderId])).rows[0];
    if (!o || !['needs_refund', 'refunded'].includes(o.status)) throw new HttpError(404, 'No duplicate payment to refund here');
    const done = (await q(`SELECT COALESCE(SUM(amount), 0)::int AS s FROM refunds WHERE payment_order_id = $1 AND ${NOT_FAILED}`, [o.id])).rows[0].s;
    return { kind: 'duplicate', order: o, riderId: o.user_id, paid: o.amount, refunded: done, remaining: o.amount - done, razorpayPaymentId: o.razorpay_payment_id, originalIsWallet: false, cash: false };
  }
  const r = (await q(`SELECT * FROM rides WHERE id = $1`, [rideId])).rows[0];
  if (!r) throw new HttpError(404, 'Ride not found');
  if (r.payment_status !== 'paid') throw new HttpError(409, 'Only paid rides can be refunded');
  const paid = amountDue(r);
  const done = (await q(`SELECT COALESCE(SUM(amount), 0)::int AS s FROM refunds WHERE ride_id = $1 AND payment_order_id IS NULL AND ${NOT_FAILED}`, [r.id])).rows[0].s;
  return {
    kind: 'ride',
    ride: r,
    riderId: r.rider_id,
    paid,
    refunded: done,
    remaining: paid - done,
    razorpayPaymentId: String(r.payment_ref ?? '').startsWith('pay_') ? r.payment_ref : null,
    originalIsWallet: r.payment_method === 'wallet',
    cash: r.payment_method === 'cash',
    // Business rides were paid from a company wallet; their refunds go back there.
    corporate: r.payment_method === 'corporate' && Boolean(r.company_id),
  };
}

async function adjustDriver(q, ride, share, refundId) {
  if (!ride?.driver_id || share <= 0) return;
  // Taken from the driver's wallet, also for cash rides (they kept the cash); it may go below zero.
  await postTxn(q, { userId: ride.driver_id, amount: -share, kind: 'earning_adjustment', rideId: ride.id, ref: `REFADJ-${refundId}` });
}

export async function issueRefund({ adminId, rideId, paymentOrderId, amount, destination, reason, ticketId }) {
  amount = Number(amount);
  reason = String(reason ?? '').trim().slice(0, 300);
  if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, 'Enter a refund amount in whole rupees');
  if (!['original', 'wallet'].includes(destination)) throw new HttpError(400, 'Choose where the money goes');
  if (reason.length < 5) throw new HttpError(400, 'Give a reason for the refund');

  // 1. Reserve the refund while the source is locked, so concurrent refunds can't overshoot.
  const { refund, info, share } = await tx(async ({ query: q }) => {
    if (paymentOrderId) await q('SELECT id FROM payment_orders WHERE id = $1 FOR UPDATE', [paymentOrderId]);
    else await q('SELECT id FROM rides WHERE id = $1 FOR UPDATE', [rideId]);
    const info = await refundable({ rideId, paymentOrderId }, q);
    if (amount > info.remaining) throw new HttpError(400, `Only ₹${info.remaining} can still be refunded (₹${info.paid} paid, ₹${info.refunded} already refunded)`);
    if (info.corporate && destination !== 'original') throw new HttpError(400, "Business rides are refunded to the company's wallet: choose the original method");
    if (destination === 'original' && !info.corporate) {
      if (info.cash) throw new HttpError(400, 'Cash trips can only be refunded to the Hopin wallet');
      if (!info.originalIsWallet && !info.razorpayPaymentId) throw new HttpError(400, 'This payment has no online original to refund to');
      if (info.razorpayPaymentId && !razorpayEnabled()) throw new HttpError(503, 'Razorpay is not set up, so this cannot go back to the original method');
    }
    const share = info.kind === 'ride' ? Math.round(amount * config.driverShare) : 0;
    const toWallet = destination === 'wallet' || info.originalIsWallet || info.corporate;
    const refund = (
      await q(
        `INSERT INTO refunds (ride_id, payment_order_id, rider_id, ticket_id, amount, destination, status, reason, driver_adjustment, created_by, processed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [info.ride?.id ?? info.order?.ride_id ?? null, info.order?.id ?? null, info.riderId, ticketId || null, amount, destination, toWallet ? 'processed' : 'pending', reason, share, adminId, toWallet ? new Date() : null],
      )
    ).rows[0];
    if (toWallet) {
      // Wallet refunds are real ledger money, settled immediately.
      if (info.corporate) {
        await companyTxn(q, { companyId: info.ride.company_id, amount, kind: 'refund', rideId: refund.ride_id, userId: info.riderId, ref: `REFUND-${refund.id}` });
      } else {
        await postTxn(q, { userId: info.riderId, amount, kind: 'refund', rideId: refund.ride_id, ref: `REFUND-${refund.id}` });
      }
      await adjustDriver(q, info.ride, share, refund.id);
    }
    return { refund, info, share };
  });

  // 2. Online refunds go to Razorpay outside the lock; a failure frees the amount again.
  let result = refund;
  if (refund.status === 'pending') {
    try {
      const rz = await createRefund(info.razorpayPaymentId, amount * 100, { hopinRefundId: refund.id });
      result = await tx(async ({ query: q }) => {
        const status = rz.status === 'processed' ? 'processed' : rz.status === 'failed' ? 'failed' : 'pending';
        const row = (
          await q(`UPDATE refunds SET razorpay_refund_id = $2, status = $3, processed_at = CASE WHEN $3 = 'processed' THEN now() END WHERE id = $1 RETURNING *`, [refund.id, rz.id, status])
        ).rows[0];
        if (status !== 'failed') await adjustDriver(q, info.ride, share, refund.id);
        return row;
      });
    } catch (err) {
      await query(`UPDATE refunds SET status = 'failed', failure_reason = $2 WHERE id = $1`, [refund.id, err.message.slice(0, 300)]);
      throw new HttpError(502, `Razorpay refused the refund: ${err.message}`);
    }
  }

  await afterRefund(result, info);
  return result;
}

async function afterRefund(refund, info) {
  if (refund.status === 'failed') return;
  if (info.kind === 'duplicate') {
    const left = await refundable({ paymentOrderId: info.order.id });
    if (left.remaining === 0) await query(`UPDATE payment_orders SET status = 'refunded' WHERE id = $1`, [info.order.id]);
  }
  const toWallet = refund.destination === 'wallet' || info.originalIsWallet;
  await notifyIn(refund.rider_id, 'refundSent', { amount: refund.amount, toWallet, reason: refund.reason }, refund.ride_id ? `/trips/${refund.ride_id}` : '/profile');
  if (refund.driver_adjustment > 0 && info.ride?.driver_id) {
    await notifyIn(info.ride.driver_id, 'driverRefundTaken', { amount: refund.driver_adjustment }, '/trips');
  }
  if (refund.ticket_id) {
    await query(`INSERT INTO ticket_messages (ticket_id, author_id, body) VALUES ($1, $2, $3)`, [
      refund.ticket_id,
      refund.created_by,
      // Support threads are written by admins, in English.
      `We've refunded ₹${refund.amount} to ${toWallet ? 'your Hopin wallet' : 'your original payment method (banks usually take a few working days)'}.`,
    ]);
    await query(`UPDATE support_tickets SET status = 'resolved', updated_at = now() WHERE id = $1`, [refund.ticket_id]);
  }
}

/** Brings a Razorpay refund's status up to date (admin refresh, or the webhook). */
export async function syncRefund(refundRow, rz) {
  rz ??= await fetchRefund(refundRow.razorpay_refund_id);
  const status = rz.status === 'processed' ? 'processed' : rz.status === 'failed' ? 'failed' : 'pending';
  if (status === refundRow.status) return refundRow;
  return tx(async ({ query: q }) => {
    const row = (
      await q(`UPDATE refunds SET status = $2, processed_at = CASE WHEN $2 = 'processed' THEN now() ELSE processed_at END, failure_reason = $3 WHERE id = $1 AND status = 'pending' RETURNING *`, [
        refundRow.id,
        status,
        status === 'failed' ? 'Reported as failed by Razorpay' : null,
      ])
    ).rows[0];
    if (!row) return refundRow;
    if (status === 'failed' && row.driver_adjustment > 0 && row.ride_id) {
      // The money never left, so give the driver's share back.
      const ride = (await q('SELECT * FROM rides WHERE id = $1', [row.ride_id])).rows[0];
      if (ride.driver_id) {
        await postTxn(q, { userId: ride.driver_id, amount: row.driver_adjustment, kind: 'earning_adjustment', rideId: ride.id, ref: `REFADJ-${row.id}-reversal` });
      }
    }
    return row;
  });
}

export const refundsForRide = (rideId) => many(`SELECT * FROM refunds WHERE ride_id = $1 ORDER BY created_at`, [rideId]).then((rows) => rows.map(toRefund));
export const refundByRazorpayId = (id) => one('SELECT * FROM refunds WHERE razorpay_refund_id = $1', [id]);
