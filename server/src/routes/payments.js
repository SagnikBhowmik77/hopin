import { Router } from 'express';
import { HttpError, requireAuth, requireRole } from '../auth.js';
import { one, query, tx } from '../db.js';
import { amountDue, loadRide, serializeRide } from '../hub.js';
import { afterPaid, applyRazorpayPayment, markPaid, postTxn, requireOnlinePayments } from '../payments.js';
import { checkoutSignatureValid, createOrder, razorpayTestMode, webhookSignatureValid } from '../razorpay.js';
import { config } from '../config.js';
import { refundByRazorpayId, syncRefund } from '../refunds.js';
import { tippableRide } from '../fairMoney.js';
import { PRICE_LOCK } from '../booking.js';
import { lockRequest } from './priceLocks.js';
import { passPrices, passToday } from '../drivers.js';
import { membershipOf } from '../growth.js';

const router = Router();

/**
 * Razorpay webhook. Mounted in app.js with a raw body parser, because the
 * signature covers the exact bytes Razorpay sent. Unknown orders are ignored;
 * a temporary failure answers 500 so Razorpay retries later.
 */
export async function webhookHandler(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!webhookSignatureValid(raw, req.get('x-razorpay-signature'))) return res.status(400).json({ error: 'Bad signature' });
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  // Refund status updates (processed / failed) for refunds Hopin issued.
  const rzRefund = event.payload?.refund?.entity;
  if ((event.event === 'refund.processed' || event.event === 'refund.failed') && rzRefund?.id) {
    const row = await refundByRazorpayId(rzRefund.id);
    if (row) await syncRefund(row, rzRefund);
    return res.json({ ok: true });
  }
  const payment = event.payload?.payment?.entity;
  if ((event.event === 'payment.captured' || event.event === 'order.paid') && payment?.order_id) {
    try {
      await applyRazorpayPayment(payment.order_id, payment.id);
    } catch (err) {
      if (err.status !== 404) {
        console.error('[razorpay] webhook could not apply payment', err.message);
        return res.status(500).json({ error: 'Try again later' });
      }
    }
  }
  res.json({ ok: true });
}

router.use(requireAuth);

/** Pay what is due on a ride from the Hopin wallet (card/UPI go through Razorpay below). */
router.post('/rides/:id/pay', requireRole('rider'), async (req, res) => {
  if (req.body?.method !== 'wallet') throw new HttpError(400, 'Card and UPI payments go through Razorpay checkout');
  const r = await loadRide(req.params.id).catch(() => null);
  if (!r || r.rider_id !== req.user.id) throw new HttpError(404, 'Ride not found');
  if (r.payment_status !== 'due') throw new HttpError(409, r.payment_status === 'paid' ? 'Already paid' : 'Nothing to pay yet');
  const amount = amountDue(r);

  const paid = await tx(async ({ query: q }) => {
    if (!(await postTxn(q, { userId: req.user.id, amount: -amount, kind: 'ride', rideId: r.id, noOverdraw: true }))) {
      throw new HttpError(400, `Wallet balance is below ₹${amount}`);
    }
    return markPaid(q, r.id, `WALLET-${r.id.slice(0, 8).toUpperCase()}`, 'wallet');
  });
  if (!paid) throw new HttpError(409, 'Already paid');
  await afterPaid(r.id);
  res.json({ ride: serializeRide(await loadRide(r.id), req.user.id) });
});

/**
 * Starts a Razorpay payment. The amount always comes from Hopin's records
 * (what is due on the ride, or a validated top-up amount) - never from the browser.
 */
router.post('/razorpay/order', async (req, res) => {
  requireOnlinePayments();
  const kind = req.body?.kind;
  let amount;
  let rideId = null;
  let splitId = null;
  let meta = null;
  let companyId = null;
  let description;
  if (kind === 'ride') {
    if (req.user.role !== 'rider') throw new HttpError(403, 'Only riders pay for rides');
    const r = await loadRide(String(req.body?.rideId ?? '')).catch(() => null);
    if (!r || r.rider_id !== req.user.id) throw new HttpError(404, 'Ride not found');
    if (r.payment_status !== 'due') throw new HttpError(409, r.payment_status === 'paid' ? 'Already paid' : 'Nothing to pay yet');
    amount = amountDue(r);
    rideId = r.id;
    description = r.status === 'cancelled' ? 'Cancellation fee' : `Ride ${r.pickup.address.split(',')[0]} → ${r.dropoff.address.split(',')[0]}`;
  } else if (kind === 'tip') {
    if (req.user.role !== 'rider') throw new HttpError(403, 'Only riders tip');
    amount = Number(req.body?.amount);
    const r = await tippableRide(String(req.body?.rideId ?? ''), req.user.id, amount);
    rideId = r.id;
    description = 'Tip for your driver';
  } else if (kind === 'split') {
    const s = await one(`SELECT * FROM fare_splits WHERE id = $1 AND payer_id = $2 AND status = 'pending'`, [String(req.body?.splitId ?? ''), req.user.id]).catch(() => null);
    if (!s) throw new HttpError(409, 'This request is no longer open');
    amount = s.amount;
    rideId = s.ride_id;
    splitId = s.id;
    description = 'Your share of a Hopin fare';
  } else if (kind === 'company_topup') {
    const m = await membershipOf(req.user.id);
    if (!m || m.role !== 'admin') throw new HttpError(403, 'Only a company admin can top up the company wallet');
    amount = Number(req.body?.amount);
    if (!Number.isInteger(amount) || amount < 500 || amount > 100_000) throw new HttpError(400, 'Top up between ₹500 and ₹1,00,000');
    companyId = m.company_id;
    description = `${m.company_name}: company wallet top-up`;
  } else if (kind === 'driver_pass') {
    if (req.user.role !== 'driver' || !req.user.vehicle_type) throw new HttpError(403, 'Only drivers with a vehicle buy a pass');
    if (await passToday(req.user.id)) throw new HttpError(409, 'You already have a pass for today');
    amount = (await passPrices())?.[req.user.vehicle_type];
    if (!amount) throw new HttpError(503, 'Daily pass prices are not set yet');
    description = "Hopin daily pass: keep 100% of today's fares";
  } else if (kind === 'price_lock') {
    if (req.user.role !== 'rider') throw new HttpError(403, 'Only riders lock prices');
    // The lock (route, vehicle, frozen fare) is fixed now and created once the payment is confirmed.
    meta = await lockRequest(req.body);
    amount = PRICE_LOCK.fee;
    description = `Price lock: ${PRICE_LOCK.days} days`;
  } else if (kind === 'topup') {
    amount = Number(req.body?.amount);
    if (!Number.isInteger(amount) || amount < 50 || amount > 10_000) throw new HttpError(400, 'Top up between ₹50 and ₹10,000');
    description = 'Hopin wallet top-up';
  } else {
    throw new HttpError(400, 'Unknown payment');
  }

  let order;
  try {
    order = await createOrder({ rupees: amount, receipt: `${kind}-${Date.now()}`, notes: { kind, userId: req.user.id, ...(rideId ? { rideId } : {}) } });
  } catch (err) {
    throw new HttpError(502, `Razorpay could not start the payment (${err.message})`);
  }
  await query(`INSERT INTO payment_orders (razorpay_order_id, user_id, kind, ride_id, amount, test_mode, split_id, meta, company_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
    order.id,
    req.user.id,
    kind,
    rideId,
    amount,
    razorpayTestMode(),
    splitId,
    meta && JSON.stringify(meta),
    companyId,
  ]);
  // Everything the browser needs to open Razorpay Checkout. The key id is public by design.
  res.status(201).json({
    keyId: config.razorpay.keyId,
    orderId: order.id,
    amountPaise: order.amount,
    currency: order.currency,
    description,
    testMode: razorpayTestMode(),
    prefill: { name: req.user.name, email: req.user.email, contact: req.user.phone },
  });
});

/** Checkout's success callback lands here: check Razorpay's signature, then confirm with Razorpay. */
router.post('/razorpay/verify', async (req, res) => {
  requireOnlinePayments();
  const { orderId, paymentId, signature } = req.body ?? {};
  if (!orderId || !paymentId || !signature) throw new HttpError(400, 'Missing payment details');
  const own = await one('SELECT user_id FROM payment_orders WHERE razorpay_order_id = $1', [orderId]);
  if (!own || own.user_id !== req.user.id) throw new HttpError(404, 'Payment not found');
  if (!checkoutSignatureValid(orderId, paymentId, signature)) throw new HttpError(400, 'Payment signature is not valid');
  const { order } = await applyRazorpayPayment(orderId, paymentId);
  const out = { status: order.status, kind: order.kind, amount: order.amount };
  if (order.kind === 'ride') out.ride = serializeRide(await loadRide(order.ride_id), req.user.id);
  else out.walletBalance = (await one('SELECT wallet_balance FROM users WHERE id = $1', [req.user.id])).wallet_balance;
  res.json(out);
});

export default router;
