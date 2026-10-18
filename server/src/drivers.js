import { HttpError } from './auth.js';
import { many, one, query } from './db.js';
import { haversineKm, isLatLng } from './geo.js';
import { postTxn } from './payments.js';

/**
 * Drivers (step 8b, batch D): the daily pass (100% of fares), heading home, the fatigue rule
 * and station queues' locations. The live parts (presence, dispatch) are in hub.js.
 */

export const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// Agreed 2026-10-12.
export const FATIGUE = {
  maxDriveMs: 10 * 3_600_000, // driving this long without a proper break...
  breakMs: 30 * 60_000, // ...requires an offline break this long, in one go
  restedBreakMs: 6 * 3_600_000, // "Well rested": last break at least this long...
  restedMaxDriveMs: 4 * 3_600_000, // ...and less than this driven since
};
export const HOME = { usesPerDay: 2, minGainKm: 1, arrivedKm: 1 };

// --- daily pass -------------------------------------------------------------------------

export async function passPrices() {
  return (await one(`SELECT value FROM settings WHERE key = 'driver_pass_prices'`))?.value ?? null;
}

export async function setPassPrices(prices) {
  const clean = {};
  for (const type of ['bike', 'auto', 'car']) {
    const n = Number(prices?.[type]);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new HttpError(400, `Enter a ${type === 'car' ? 'cab' : type} pass price from ₹1 to ₹1,000`);
    clean[type] = n;
  }
  await query(
    `INSERT INTO settings (key, value) VALUES ('driver_pass_prices', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(clean)],
  );
  return clean;
}

export const toPass = (d) => d && { day: d.day, price: d.pass_price, boughtAt: d.pass_bought_at };

export const passToday = async (driverId) =>
  toPass(await one(`SELECT *, to_char(day, 'YYYY-MM-DD') AS day FROM driver_days WHERE driver_id = $1 AND day = $2::date AND pass_ref IS NOT NULL`, [driverId, todayIST()]));

/**
 * Buys today's pass inside a transaction: from the driver's wallet, or after a confirmed
 * Razorpay payment (`ref`). Returns false if they already have today's pass.
 */
export async function buyPass(q, { driverId, price, ref, fromWallet }) {
  const row = (
    await q(
      `INSERT INTO driver_days (driver_id, day, pass_price, pass_ref, pass_bought_at) VALUES ($1, $2::date, $3, $4, now())
       ON CONFLICT (driver_id, day) DO UPDATE SET pass_price = EXCLUDED.pass_price, pass_ref = EXCLUDED.pass_ref, pass_bought_at = now()
       WHERE driver_days.pass_ref IS NULL RETURNING *`,
      [driverId, todayIST(), price, ref],
    )
  ).rows[0];
  if (!row) return false;
  if (fromWallet && !(await postTxn(q, { userId: driverId, amount: -price, kind: 'driver_pass', ref, noOverdraw: true }))) {
    throw new HttpError(400, `Your wallet has less than ₹${price}. Pay online instead.`);
  }
  return row;
}

// --- online sessions and the fatigue rule ------------------------------------------------------

export const startSession = (driverId) =>
  query(`INSERT INTO driver_sessions (driver_id) VALUES ($1) ON CONFLICT (driver_id) WHERE ended_at IS NULL DO NOTHING`, [driverId]);
export const touchSession = (driverId) => query(`UPDATE driver_sessions SET last_seen_at = now() WHERE driver_id = $1 AND ended_at IS NULL`, [driverId]);
export const endSession = (driverId) =>
  query(`UPDATE driver_sessions SET ended_at = now(), last_seen_at = now() WHERE driver_id = $1 AND ended_at IS NULL`, [driverId]);
/** At startup: sessions left open by a restart end when they were last known to be live. */
export const closeStaleSessions = () => query(`UPDATE driver_sessions SET ended_at = last_seen_at WHERE ended_at IS NULL`);

/**
 * Driving since the last 30-minute break, from real online sessions. Over 10 hours needs a
 * 30-minute offline break before going online again. "Well rested": the last break was 6+
 * hours and less than 4 hours driven since.
 */
export async function fatigue(driverId, now = Date.now()) {
  const sessions = await many(
    `SELECT started_at, last_seen_at, ended_at FROM driver_sessions WHERE driver_id = $1 AND COALESCE(ended_at, now()) > now() - interval '48 hours' ORDER BY started_at`,
    [driverId],
  );
  let stretchMs = 0;
  let lastBreakMs = null;
  let prevEnd = null;
  let online = false;
  for (const s of sessions) {
    const start = new Date(s.started_at).getTime();
    const end = s.ended_at ? new Date(s.ended_at).getTime() : now;
    if (!s.ended_at) online = true;
    if (prevEnd !== null && start - prevEnd >= FATIGUE.breakMs) {
      stretchMs = 0;
      lastBreakMs = start - prevEnd;
    }
    stretchMs += Math.max(0, end - start);
    prevEnd = end;
  }
  // Offline right now: the time since the last session counts as a break once long enough.
  if (!online && prevEnd !== null && now - prevEnd >= FATIGUE.breakMs) {
    stretchMs = 0;
    lastBreakMs = now - prevEnd;
  }
  const needsBreak = stretchMs >= FATIGUE.maxDriveMs;
  const breakUntil = needsBreak ? (online ? now : prevEnd) + FATIGUE.breakMs : null;
  return {
    drivingMin: Math.round(stretchMs / 60_000),
    needsBreak,
    breakUntil: breakUntil && new Date(breakUntil).toISOString(),
    rested: lastBreakMs !== null && lastBreakMs >= FATIGUE.restedBreakMs && stretchMs < FATIGUE.restedMaxDriveMs,
  };
}

export const breakMessage = (f) =>
  `You have driven ${Math.floor(f.drivingMin / 60)} h ${f.drivingMin % 60} min without a 30-minute break. You can go online again at ${new Date(f.breakUntil).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })}.`;

// --- heading home -------------------------------------------------------------------------------

export function cleanHome(p) {
  const place = { lat: Number(p?.lat), lng: Number(p?.lng), address: String(p?.address ?? '').trim().slice(0, 300) };
  if (!isLatLng(place)) throw new HttpError(400, 'Choose your home location');
  if (!place.address) place.address = `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`;
  return place;
}

/** Counts one use of "heading home" today; refuses after the daily limit. */
export async function useHeadingHome(driverId) {
  const row = await one(
    `INSERT INTO driver_days (driver_id, day, home_uses) VALUES ($1, $2::date, 1)
     ON CONFLICT (driver_id, day) DO UPDATE SET home_uses = driver_days.home_uses + 1 WHERE driver_days.home_uses < $3
     RETURNING home_uses`,
    [driverId, todayIST(), HOME.usesPerDay],
  );
  if (!row) throw new HttpError(409, `You can use "heading home" ${HOME.usesPerDay} times a day`);
  return HOME.usesPerDay - row.home_uses;
}

export async function homeUsesLeft(driverId) {
  const row = await one(`SELECT home_uses FROM driver_days WHERE driver_id = $1 AND day = $2::date`, [driverId, todayIST()]);
  return HOME.usesPerDay - (row?.home_uses ?? 0);
}

/** A ride is "on the way home" when its drop is at least 1 km closer to home than the driver is now. */
export function towardHome(driverPoint, home, dropoff) {
  if (!isLatLng(driverPoint)) return true;
  return haversineKm(dropoff, home) <= haversineKm(driverPoint, home) - HOME.minGainKm;
}

// --- stations -----------------------------------------------------------------------------------

let stationCache = null;
export async function stations() {
  stationCache ??= await many(`SELECT id, name, lat, lng, radius_m FROM stations WHERE active ORDER BY name`);
  return stationCache;
}
export const stationAtSync = (list, point) => (isLatLng(point) ? list.find((s) => haversineKm(s, point) * 1000 <= s.radius_m) ?? null : null);
export const stationAt = async (point) => stationAtSync(await stations(), point);
export function resetStationCache() {
  stationCache = null;
}
