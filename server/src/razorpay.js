import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Razorpay's REST API (server side only - the key secret never leaves the server).
 * Docs: Orders API, Payments API, payment signature and webhook signature checks.
 */

export const razorpayEnabled = () => Boolean(config.razorpay.keyId && config.razorpay.keySecret);
/** rzp_test_ keys use Razorpay's sandbox: real API, no real money. */
export const razorpayTestMode = () => config.razorpay.keyId.startsWith('rzp_test_');

async function call(path, { method = 'GET', body } = {}) {
  const { keyId, keySecret, apiUrl } = config.razorpay;
  const res = await fetch(`${apiUrl}/v1${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.description || `Razorpay returned ${res.status}`);
  return data;
}

/** A Razorpay order for `rupees`. The amount is fixed here, by the server. */
export function createOrder({ rupees, receipt, notes }) {
  return call('/orders', { method: 'POST', body: { amount: rupees * 100, currency: 'INR', receipt: receipt.slice(0, 40), notes } });
}

export const fetchPayment = (paymentId) => call(`/payments/${encodeURIComponent(paymentId)}`);

export const capturePayment = (paymentId, paise) =>
  call(`/payments/${encodeURIComponent(paymentId)}/capture`, { method: 'POST', body: { amount: paise, currency: 'INR' } });

/** Refund (part of) a captured payment back to the card / UPI / bank it came from. */
export const createRefund = (paymentId, paise, notes) =>
  call(`/payments/${encodeURIComponent(paymentId)}/refund`, { method: 'POST', body: { amount: paise, speed: 'normal', notes } });

export const fetchRefund = (refundId) => call(`/refunds/${encodeURIComponent(refundId)}`);

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Checkout success signature: HMAC-SHA256 of "order_id|payment_id" with the key secret. */
export function checkoutSignatureValid(orderId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', config.razorpay.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqual(expected, signature);
}

/** Webhook signature: HMAC-SHA256 of the raw request body with the webhook secret. */
export function webhookSignatureValid(rawBody, signature) {
  if (!config.razorpay.webhookSecret || !signature) return false;
  const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex');
  return safeEqual(expected, signature);
}

/** Razorpay's payment method -> how Hopin records it on a ride. */
export function rideMethodFor(razorpayMethod) {
  return { card: 'card', upi: 'upi', netbanking: 'netbanking', wallet: 'online_wallet', emi: 'emi', paylater: 'paylater' }[razorpayMethod] ?? 'card';
}
