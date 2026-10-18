import { HttpError } from './auth.js';
import { config } from './config.js';
import { many, one, tx } from './db.js';
import { VEHICLES } from './fare.js';
import { amountDue, emitToAdmins, emitToUser } from './hub.js';
import { postTxn } from './payments.js';
import { notifyIn } from './messages.js';

/**
 * Fair money (step 8b, batch B): tips, fare splits, credit when a driver cancels late,
 * an automatic dispute after a long detour, and the fare breakdown shown to both sides.
 * Every wallet movement goes through postTxn, so balances always match the ledger.
 */

export const TIP_MIN = 10;
export const TIP_MAX = 500;

// --- tips ---------------------------------------------------------------------

/** Rejects a tip that cannot be given; returns the ride row. */
export async function tippableRide(rideId, riderId, amount) {
  if (!Number.isInteger(amount) || amount < TIP_MIN || amount > TIP_MAX) throw new HttpError(400, `Tips are from ₹${TIP_MIN} to ₹${TIP_MAX}`);
  const r = await one('SELECT * FROM rides WHERE id = $1', [rideId]).catch(() => null);
  if (!r || r.rider_id !== riderId) throw new HttpError(404, 'Ride not found');
  if (r.status !== 'completed' || !r.driver_id) throw new HttpError(409, 'You can tip after a completed trip');
  if (r.payment_status !== 'paid') throw new HttpError(409, 'Pay for the trip first');
  if (r.tip > 0) throw new HttpError(409, 'You already tipped for this trip');
  return r;
}

/**
 * Records a tip inside a transaction: 100% to the driver's wallet. `fromWallet` debits the
 * rider's wallet; otherwise the money came through Razorpay (`ref` is the payment id).
 * Returns false if the ride was tipped meanwhile (the caller then flags an online payment for refund).
 */
export async function applyTip(q, { rideId, riderId, amount, ref, fromWallet }) {
  const r = (await q('UPDATE rides SET tip = $3, tipped_at = now(), tip_ref = $4 WHERE id = $1 AND rider_id = $2 AND tip = 0 RETURNING *', [rideId, riderId, amount, ref])).rows[0];
  if (!r) return false;
  if (fromWallet && !(await postTxn(q, { userId: riderId, amount: -amount, kind: 'tip', rideId, ref, noOverdraw: true }))) {
    throw new HttpError(400, `Your wallet has less than ₹${amount}`);
  }
  await postTxn(q, { userId: r.driver_id, amount, kind: 'tip', rideId, ref: `${ref}-DRIVER` });
  return r;
}

export async function afterTip(rideId) {
  const r = await one('SELECT driver_id, tip FROM rides WHERE id = $1', [rideId]);
  await notifyIn(r.driver_id, 'tipReceived', { amount: r.tip }, '/drive');
}

// --- fare splits ----------------------------------------------------------------

export const toSplit = (s) =>
  s && {
    id: s.id,
    rideId: s.ride_id,
    amount: s.amount,
    status: s.status,
    requester: s.requester_name ? { id: s.requester_id, name: s.requester_name } : { id: s.requester_id },
    payer: s.payer_name ? { id: s.payer_id, name: s.payer_name } : { id: s.payer_id },
    createdAt: s.created_at,
    settledAt: s.settled_at,
  };

export const SPLIT_SQL = `
  SELECT s.*, ru.name AS requester_name, pu.name AS payer_name
  FROM fare_splits s JOIN users ru ON ru.id = s.requester_id JOIN users pu ON pu.id = s.payer_id`;

export const splitsForRide = async (rideId) => (await many(`${SPLIT_SQL} WHERE s.ride_id = $1 ORDER BY s.created_at`, [rideId])).map(toSplit);

/** The paying rider asks another Hopin rider (by phone) for part of a paid fare. */
export async function requestSplit({ ride, requester, phone, amount }) {
  if (ride.rider_id !== requester.id) throw new HttpError(404, 'Ride not found');
  if (ride.status !== 'completed' || ride.payment_status !== 'paid') throw new HttpError(409, 'You can split a fare once the trip is completed and paid');
  const payer = await one(`SELECT id, name, role FROM users WHERE phone = $1`, [phone]);
  if (!payer || payer.role !== 'rider') throw new HttpError(404, 'No Hopin rider has that mobile number. They need a Hopin account to pay their share.');
  if (payer.id === requester.id) throw new HttpError(400, 'That is your own number');
  const fare = amountDue(ride);
  const asked = await one(`SELECT COALESCE(SUM(amount), 0)::int AS total FROM fare_splits WHERE ride_id = $1 AND status IN ('pending', 'paid')`, [ride.id]);
  if (!Number.isInteger(amount) || amount < 1) throw new HttpError(400, 'Enter their share in whole rupees');
  // The requester always keeps at least part of the fare.
  if (asked.total + amount >= fare) throw new HttpError(400, `You can ask for up to ₹${fare - asked.total - 1} more on this ₹${fare} fare`);
  let s;
  try {
    s = await one('INSERT INTO fare_splits (ride_id, requester_id, payer_id, amount) VALUES ($1, $2, $3, $4) RETURNING *', [ride.id, requester.id, payer.id, amount]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `You already asked ${payer.name} about this trip`);
    throw err;
  }
  const view = toSplit({ ...s, requester_name: requester.name, payer_name: payer.name });
  emitToUser(payer.id, 'split:request', view);
  await notifyIn(payer.id, 'splitAsk', { name: requester.name, amount, fare }, '/trips');
  return view;
}

/**
 * Pays a split share inside a transaction: from the payer's wallet, or through Razorpay
 * (`ref` is the payment id). The money goes to the requester's wallet; the driver is not involved.
 * Returns false if the request is no longer pending.
 */
export async function applySplitPayment(q, { splitId, payerId, ref, fromWallet }) {
  const s = (await q(`UPDATE fare_splits SET status = 'paid', settled_at = now(), ref = $3 WHERE id = $1 AND payer_id = $2 AND status = 'pending' RETURNING *`, [splitId, payerId, ref])).rows[0];
  if (!s) return false;
  if (fromWallet && !(await postTxn(q, { userId: payerId, amount: -s.amount, kind: 'split', rideId: s.ride_id, ref, noOverdraw: true }))) {
    throw new HttpError(400, `Your wallet has less than ₹${s.amount}`);
  }
  await postTxn(q, { userId: s.requester_id, amount: s.amount, kind: 'split', rideId: s.ride_id, ref: `${ref}-IN` });
  return s;
}

export async function afterSplitPaid(splitId) {
  const s = toSplit(await one(`${SPLIT_SQL} WHERE s.id = $1`, [splitId]));
  emitToUser(s.requester.id, 'split:update', s);
  emitToUser(s.payer.id, 'split:update', s);
  await notifyIn(s.requester.id, 'splitPaid', { name: s.payer.name, amount: s.amount }, '/profile');
}

/** Declines (payer) or cancels (requester) a pending request. */
export async function closeSplit(splitId, userId) {
  const s = await one(
    `UPDATE fare_splits SET status = CASE WHEN payer_id = $2 THEN 'declined' ELSE 'cancelled' END, settled_at = now()
     WHERE id = $1 AND status = 'pending' AND $2 IN (payer_id, requester_id) RETURNING *`,
    [splitId, userId],
  ).catch(() => null);
  if (!s) throw new HttpError(409, 'This request is no longer open');
  const view = toSplit(await one(`${SPLIT_SQL} WHERE s.id = $1`, [s.id]));
  emitToUser(view.requester.id, 'split:update', view);
  emitToUser(view.payer.id, 'split:update', view);
  if (s.status === 'declined') await notifyIn(s.requester_id, 'splitDeclined', { name: view.payer.name, amount: s.amount }, `/trips/${s.ride_id}`);
  return view;
}

// --- a driver cancels late ----------------------------------------------------------

/**
 * A driver who cancels after the free period (or after arriving) pays the rider the same
 * amount a rider would pay as a late-cancellation fee: rider's wallet +, driver's wallet -.
 */
export async function driverCancelCredit(q, ride) {
  const late = ride.arrived_at || (ride.accepted_at && Date.now() - new Date(ride.accepted_at).getTime() > config.freeCancelMs);
  if (!late || !ride.driver_id) return 0;
  const amount = VEHICLES[ride.vehicle_type].cancelFee;
  await postTxn(q, { userId: ride.rider_id, amount, kind: 'cancel_credit', rideId: ride.id, ref: `CANCEL-CREDIT-${ride.id}` });
  await postTxn(q, { userId: ride.driver_id, amount: -amount, kind: 'cancel_penalty', rideId: ride.id, ref: `CANCEL-PENALTY-${ride.id}` });
  return amount;
}

// --- a long detour opens a dispute ----------------------------------------------------

/**
 * Fares are fixed before the trip, so a detour never costs more money, only time. When a
 * route alert fired and the trip ran 25% and at least 5 minutes longer than planned, open a
 * fare-dispute ticket for the rider with the evidence; an admin decides any refund.
 */
export async function maybeOpenDetourDispute(ride) {
  if (ride.status !== 'completed' || !ride.started_at || !ride.completed_at) return null;
  const alerts = await many(`SELECT distance_m, max_distance_m FROM route_deviations WHERE ride_id = $1 AND kind = 'off_route'`, [ride.id]);
  if (!alerts.length) return null;
  const actualMin = Math.round((new Date(ride.completed_at) - new Date(ride.started_at)) / 60_000);
  const extra = actualMin - ride.duration_min;
  if (extra < 5 || actualMin < ride.duration_min * 1.25) return null;
  const furthest = Math.max(...alerts.map((a) => a.max_distance_m));
  const body = `[Opened automatically by Hopin] During this trip the driver left the planned route (furthest ${furthest >= 1000 ? `${(furthest / 1000).toFixed(1)} km` : `${furthest} m`} away). The trip took ${actualMin} min against ${ride.duration_min} min planned (${extra} min longer). The fare (₹${ride.fare}) was fixed before the trip. Our team will review whether a refund is due.`;
  const ticketId = await tx(async ({ query: q }) => {
    const t = (
      await q(`INSERT INTO support_tickets (user_id, ride_id, category, subject) VALUES ($1, $2, 'fare_dispute', $3) RETURNING id`, [
        ride.rider_id,
        ride.id,
        `Long detour: ${extra} min longer than planned`,
      ])
    ).rows[0];
    await q('INSERT INTO ticket_messages (ticket_id, author_id, body) VALUES ($1, $2, $3)', [t.id, ride.rider_id, body]);
    return t.id;
  });
  emitToAdmins('ticket', { id: ticketId });
  await notifyIn(ride.rider_id, 'detourReview', { extra }, `/help?ticket=${ticketId}`);
  return ticketId;
}

// --- fare breakdown ---------------------------------------------------------------------

/**
 * Who got what for one ride, from the ledger: the driver's share (incl. tip, after any
 * refund adjustment) and what Hopin kept. Null until the ride is paid.
 */
export async function fareBreakdown(ride) {
  if (ride.payment_status !== 'paid') return null;
  const rows = await many(`SELECT kind, amount FROM wallet_txns WHERE ride_id = $1 AND user_id = $2`, [ride.id, ride.driver_id]);
  const sum = (...kinds) => rows.filter((t) => kinds.includes(t.kind)).reduce((s, t) => s + t.amount, 0);
  const paid = amountDue(ride);
  const driverFare = sum('earning', 'cash_earning', 'commission');
  return {
    paid,
    method: ride.payment_method,
    driverFare,
    hopinFare: paid - driverFare,
    driverSharePct: paid ? Math.round((driverFare / paid) * 100) : 0,
    tip: ride.tip ?? 0,
    refundAdjustment: sum('earning_adjustment'),
    cash: ride.payment_method === 'cash',
  };
}
