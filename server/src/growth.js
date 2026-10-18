import crypto from 'node:crypto';
import { HttpError } from './auth.js';
import { many, one, query, tx } from './db.js';
import { postTxn } from './payments.js';
import { notifyIn } from './messages.js';

/**
 * Growth (step 8b, batch E): referral codes and rewards, loyalty points, and the company
 * wallet behind corporate (business) rides. Amounts agreed 2026-10-12.
 */

export const REFERRAL = { riderReward: 50, maxRewardedPerReferrer: 20, driverReward: 200, driverTrips: 20, applyWithinDays: 7 };
export const LOYALTY = {
  rupeesPerPoint: 10, // 1 point per ₹10 paid
  redeemStep: 100, // redeem in blocks of 100 points
  rupeesPer100: 10, // 100 points = ₹10
  tiers: [
    { name: 'Gold', trips: 30, multiplier: 1.5 },
    { name: 'Silver', trips: 10, multiplier: 1.25 },
    { name: 'Blue', trips: 0, multiplier: 1 },
  ],
};

// --- referrals ----------------------------------------------------------------------------

/** The user's own code, created the first time it is asked for. */
export async function referralCode(user) {
  if (user.referral_code) return user.referral_code;
  const stem = (user.name.replace(/[^A-Za-z]/g, '').toUpperCase() + 'HOP').slice(0, 4);
  for (let i = 0; i < 5; i++) {
    const code = `${stem}${crypto.randomInt(1000, 10000)}`;
    const row = await one('UPDATE users SET referral_code = $2 WHERE id = $1 AND referral_code IS NULL RETURNING referral_code', [user.id, code]).catch((err) => {
      if (err.code === '23505') return null; // code taken: try another
      throw err;
    });
    if (row) return row.referral_code;
    const again = await one('SELECT referral_code FROM users WHERE id = $1', [user.id]);
    if (again.referral_code) return again.referral_code;
  }
  throw new HttpError(503, 'Could not create a referral code, try again');
}

/** A new rider or driver enters someone's code: same role, within 7 days of joining, before their first trip. */
export async function applyReferral(user, rawCode) {
  const code = String(rawCode ?? '').trim().toUpperCase();
  if (!/^[A-Z]{4}\d{4}$/.test(code)) throw new HttpError(400, 'Enter a code like ASHA1234');
  const referrer = await one('SELECT id, name, role FROM users WHERE referral_code = $1', [code]);
  if (!referrer) throw new HttpError(404, 'No one has that code');
  if (referrer.id === user.id) throw new HttpError(400, 'That is your own code');
  if (referrer.role !== user.role) throw new HttpError(400, `That is a ${referrer.role}'s code; ask a ${user.role} for theirs`);
  if (Date.now() - new Date(user.created_at).getTime() > REFERRAL.applyWithinDays * 86_400_000) {
    throw new HttpError(409, `Codes can only be used within ${REFERRAL.applyWithinDays} days of joining`);
  }
  const col = user.role === 'driver' ? 'driver_id' : 'rider_id';
  const { n } = await one(`SELECT count(*)::int AS n FROM rides WHERE ${col} = $1 AND status = 'completed'`, [user.id]);
  if (n > 0) throw new HttpError(409, 'Codes can only be used before your first trip');
  try {
    await one('INSERT INTO referrals (referrer_id, referred_id, kind) VALUES ($1, $2, $3) RETURNING id', [referrer.id, user.id, user.role]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'You have already used a referral code');
    throw err;
  }
  return { referrerName: referrer.name };
}

/** Called when a rider's ride is paid: rewards a pending rider referral on their first paid trip. */
export async function rewardRiderReferral(riderId) {
  const result = await tx(async ({ query: q }) => {
    const ref = (await q(`UPDATE referrals SET status = 'rewarded', rewarded_at = now() WHERE referred_id = $1 AND kind = 'rider' AND status = 'pending' RETURNING *`, [riderId])).rows[0];
    if (!ref) return null;
    const { n } = (await q(`SELECT count(*)::int AS n FROM referrals WHERE referrer_id = $1 AND status = 'rewarded' AND referrer_reward > 0`, [ref.referrer_id])).rows[0];
    const referrerReward = n < REFERRAL.maxRewardedPerReferrer ? REFERRAL.riderReward : 0;
    await postTxn(q, { userId: riderId, amount: REFERRAL.riderReward, kind: 'referral', ref: `REFERRAL-NEW-${ref.id}` });
    if (referrerReward) await postTxn(q, { userId: ref.referrer_id, amount: referrerReward, kind: 'referral', ref: `REFERRAL-BY-${ref.id}` });
    await q('UPDATE referrals SET referrer_reward = $2, referred_reward = $3 WHERE id = $1', [ref.id, referrerReward, REFERRAL.riderReward]);
    return { ...ref, referrerReward };
  });
  if (!result) return;
  await notifyIn(riderId, 'referralRider', { amount: REFERRAL.riderReward }, '/profile');
  if (result.referrerReward) await notifyIn(result.referrer_id, 'referralReferrer', { amount: result.referrerReward }, '/profile');
}

/** Called when a driver completes a trip: pays the referring driver once the new driver reaches 20 trips. */
export async function rewardDriverReferral(driverId) {
  const { n } = await one(`SELECT count(*)::int AS n FROM rides WHERE driver_id = $1 AND status = 'completed'`, [driverId]);
  if (n < REFERRAL.driverTrips) return;
  const result = await tx(async ({ query: q }) => {
    const ref = (await q(`UPDATE referrals SET status = 'rewarded', rewarded_at = now(), referrer_reward = $2 WHERE referred_id = $1 AND kind = 'driver' AND status = 'pending' RETURNING *`, [driverId, REFERRAL.driverReward])).rows[0];
    if (!ref) return null;
    await postTxn(q, { userId: ref.referrer_id, amount: REFERRAL.driverReward, kind: 'referral', ref: `REFERRAL-DRIVER-${ref.id}` });
    return ref;
  });
  if (result) await notifyIn(result.referrer_id, 'driverReferral', { amount: REFERRAL.driverReward, trips: REFERRAL.driverTrips }, '/drive');
}

export async function referralStats(userId) {
  const rows = await many(`SELECT status, referrer_reward FROM referrals WHERE referrer_id = $1`, [userId]);
  const used = await one(`SELECT r.status, u.name FROM referrals r JOIN users u ON u.id = r.referrer_id WHERE r.referred_id = $1`, [userId]);
  return {
    invited: rows.length,
    rewarded: rows.filter((r) => r.status === 'rewarded').length,
    earned: rows.reduce((s, r) => s + r.referrer_reward, 0),
    usedCode: used ? { referrerName: used.name, status: used.status } : null,
  };
}

// --- loyalty ------------------------------------------------------------------------------

export async function loyaltyTier(riderId) {
  const { n } = await one(`SELECT count(*)::int AS n FROM rides WHERE rider_id = $1 AND status = 'completed' AND completed_at > now() - interval '90 days'`, [riderId]);
  const tier = LOYALTY.tiers.find((t) => n >= t.trips);
  const next = [...LOYALTY.tiers].reverse().find((t) => t.trips > n) ?? null;
  return { name: tier.name, multiplier: tier.multiplier, trips90: n, next: next && { name: next.name, tripsToGo: next.trips - n } };
}

/** Points for a paid, completed ride the rider paid for themselves (business rides earn none). */
export async function earnPoints(ride) {
  if (ride.status !== 'completed' || ride.payment_method === 'corporate') return 0;
  const tier = await loyaltyTier(ride.rider_id);
  const points = Math.floor((ride.fare / LOYALTY.rupeesPerPoint) * tier.multiplier);
  if (points <= 0) return 0;
  return tx(async ({ query: q }) => {
    const row = (
      await q(`INSERT INTO loyalty_txns (user_id, points, kind, ride_id, ref) VALUES ($1, $2, 'earned', $3, $4) ON CONFLICT (ref) DO NOTHING RETURNING id`, [
        ride.rider_id, points, ride.id, `LOYALTY-${ride.id}`,
      ])
    ).rows[0];
    if (!row) return 0;
    await q('UPDATE users SET loyalty_points = loyalty_points + $2 WHERE id = $1', [ride.rider_id, points]);
    return points;
  });
}

/** Turns points into wallet credit, in blocks of 100. */
export async function redeemPoints(userId, points) {
  if (!Number.isInteger(points) || points <= 0 || points % LOYALTY.redeemStep) throw new HttpError(400, `Redeem points in blocks of ${LOYALTY.redeemStep}`);
  const rupees = (points / LOYALTY.redeemStep) * LOYALTY.rupeesPer100;
  const ref = `LOYALTY-REDEEM-${crypto.randomUUID()}`;
  await tx(async ({ query: q }) => {
    const ok = (await q('UPDATE users SET loyalty_points = loyalty_points - $2 WHERE id = $1 AND loyalty_points >= $2 RETURNING id', [userId, points])).rows[0];
    if (!ok) throw new HttpError(400, 'You do not have that many points');
    await q(`INSERT INTO loyalty_txns (user_id, points, kind, ref) VALUES ($1, $2, 'redeemed', $3)`, [userId, -points, ref]);
    await postTxn(q, { userId, amount: rupees, kind: 'loyalty', ref });
  });
  return rupees;
}

// --- corporate ----------------------------------------------------------------------------

/** The active company membership of a user, if any. `q` lets a caller inside a transaction use its connection. */
export const membershipOf = async (userId, q = query) =>
  (
    await q(
      `SELECT m.*, c.name AS company_name, c.wallet_balance, c.active AS company_active FROM company_members m JOIN companies c ON c.id = m.company_id
       WHERE m.user_id = $1 AND m.status = 'active'`,
      [userId],
    )
  ).rows[0] ?? null;

/** This calendar month's business spend of one employee (India time). */
export async function monthSpend(companyId, userId, q = query) {
  const { s } = (
    await q(
      `SELECT COALESCE(-SUM(amount), 0)::int AS s FROM company_txns
       WHERE company_id = $1 AND user_id = $2 AND kind IN ('ride', 'refund')
         AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
      [companyId, userId],
    )
  ).rows[0];
  return s;
}

/**
 * Refuses a business booking the company cannot pay for, or that breaks the employee's
 * monthly limit. Called inside the booking transaction, so it uses that transaction's `q`.
 */
export async function checkBusinessBooking(userId, fare, q = query) {
  const m = await membershipOf(userId, q);
  if (!m || !m.company_active) throw new HttpError(403, 'You are not part of an active company account');
  if (m.wallet_balance < fare) throw new HttpError(400, `${m.company_name}'s wallet has ₹${m.wallet_balance}, less than this ₹${fare} fare. Ask your company admin to top it up.`);
  if (m.monthly_limit) {
    const spent = await monthSpend(m.company_id, userId, q);
    if (spent + fare > m.monthly_limit) throw new HttpError(400, `This would take you over your ₹${m.monthly_limit} monthly business limit (₹${spent} used).`);
  }
  return m;
}

/** The one way to move company wallet money. `noOverdraw` returns false instead of going below zero. */
export async function companyTxn(q, { companyId, amount, kind, rideId = null, userId = null, ref, noOverdraw = false }) {
  const ok = (
    await q(`UPDATE companies SET wallet_balance = wallet_balance + $2 WHERE id = $1 ${noOverdraw ? 'AND wallet_balance + $2 >= 0' : ''} RETURNING id`, [companyId, amount])
  ).rows[0];
  if (!ok) return false;
  await q('INSERT INTO company_txns (company_id, amount, kind, ride_id, user_id, ref) VALUES ($1, $2, $3, $4, $5, $6)', [companyId, amount, kind, rideId, userId, ref]);
  return true;
}
