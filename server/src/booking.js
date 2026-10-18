import crypto from 'node:crypto';
import { HttpError } from './auth.js';
import { config } from './config.js';
import { many, one, query } from './db.js';
import { priceTrip } from './fare.js';
import { haversineKm } from './geo.js';
import { emitToUser } from './hub.js';
import { postTxn } from './payments.js';
import { sendSms, smsEnabled } from './sms.js';
import { PHONE_RE, normalizePhone } from './routes/auth.js';
import { languageOf, notifyIn, smsText } from './messages.js';

/**
 * Ways to book (step 8b, batch C): for someone else, hourly rentals, parcels, accessibility
 * requests, family sharing and price locks. Routes call these; the rules live here.
 */

const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const cleanName = (v, what) => {
  const name = String(v ?? '').trim().slice(0, 60);
  if (name.length < 2) throw new HttpError(400, `Enter the ${what}'s name`);
  return name;
};
const cleanPhone = (v, what) => {
  const phone = String(v ?? '').replace(/[\s-]/g, '');
  if (!PHONE_RE.test(phone)) throw new HttpError(400, `Enter the ${what}'s 10-digit mobile number`);
  return normalizePhone(phone);
};

// --- booking for someone else --------------------------------------------------------

/** Optional { name, phone } of the person who actually rides. Null when riders book for themselves. */
export function cleanPassenger(body, user) {
  const p = body?.passenger;
  if (!p) return null;
  const passenger = { name: cleanName(p.name, 'passenger'), phone: cleanPhone(p.phone, 'passenger') };
  if (passenger.phone === user.phone) return null; // booking for yourself
  return passenger;
}

// --- accessibility -----------------------------------------------------------------------

export const ACCESSIBILITY = {
  wheelchair: 'Travels with a folding wheelchair',
  assistance: 'Needs help getting in and out',
  hearing: 'Deaf or hard of hearing: please use chat',
  vision: 'Blind or low vision: please call out on arrival',
};

export function cleanAccessibility(body, vehicleType) {
  const list = Array.isArray(body?.accessibility) ? [...new Set(body.accessibility)] : [];
  for (const a of list) if (!ACCESSIBILITY[a]) throw new HttpError(400, 'Unknown accessibility request');
  // A folded wheelchair needs a boot.
  if (list.includes('wheelchair') && vehicleType !== 'car') throw new HttpError(400, 'A wheelchair needs a Cab');
  return list;
}

// --- parcels -----------------------------------------------------------------------------

export const PARCEL_SIZES = {
  small: { label: 'Small (fits in a bag)', vehicles: ['bike', 'auto', 'car'] },
  medium: { label: 'Medium (up to a suitcase)', vehicles: ['auto', 'car'] },
  large: { label: 'Large (needs a boot)', vehicles: ['car'] },
};

export function cleanParcel(body, vehicleType) {
  const p = body?.parcel ?? {};
  const size = PARCEL_SIZES[p.size] ? p.size : null;
  if (!size) throw new HttpError(400, 'Choose the parcel size');
  if (!PARCEL_SIZES[size].vehicles.includes(vehicleType)) throw new HttpError(400, `A ${size} parcel needs ${PARCEL_SIZES[size].vehicles.join(' or ')}`);
  const item = String(p.item ?? '').trim().slice(0, 120);
  if (item.length < 3) throw new HttpError(400, "Say what you're sending");
  // The sender confirms it is legal to carry: no cash, jewellery, drugs, weapons, alcohol, live animals.
  if (p.confirmAllowed !== true) throw new HttpError(400, 'Confirm the parcel has no restricted items');
  return { receiverName: cleanName(p.receiverName, 'receiver'), receiverPhone: cleanPhone(p.receiverPhone, 'receiver'), item, size };
}

export const newCode = () => String(crypto.randomInt(1000, 10000));

// --- texts to the passenger / parcel receiver -----------------------------------------------

async function text(phone, body) {
  if (!smsEnabled()) return { status: 'not_sent', error: 'SMS is not set up on this server' };
  try {
    const sent = await sendSms(phone, body);
    return { status: sent.status, sid: sent.sid };
  } catch (err) {
    return { status: 'failed', error: err.message };
  }
}

/** After a driver accepts: tell the passenger (booked for someone else) or the parcel receiver. */
export async function textOtherPerson(r) {
  const track = `${config.appUrl}/track/${r.share_token}`;
  const vehicle = `${r.v_model} ${r.v_plate}`;
  // Texts to people who don't use Hopin go in the language of the rider who booked.
  const lang = await languageOf(r.rider_id);
  if (r.passenger_phone) {
    const result = await text(
      r.passenger_phone,
      smsText(lang, 'passenger', { rider: r.rider_name, driver: r.driver_name, vehicle, otp: r.otp, track }),
    );
    await query('UPDATE rides SET passenger_sms = $2 WHERE id = $1', [r.id, JSON.stringify(result)]);
    // The provider's error stays in the server log and the ride row; riders get a plain message.
    if (result.error) console.warn(`[sms] passenger text for ride ${r.id} failed: ${result.error}`);
    await notifyIn(r.rider_id, 'passengerTexted', { failed: Boolean(result.error), name: r.passenger_name, otp: r.otp }, '/book');
  }
  if (r.kind === 'parcel' && r.parcel) {
    const result = await text(
      r.parcel.receiverPhone,
      smsText(lang, 'parcel', { rider: r.rider_name, item: r.parcel.item, driver: r.driver_name, vehicle, code: r.delivery_otp, track }),
    );
    await query('UPDATE rides SET delivery_sms = $2 WHERE id = $1', [r.id, JSON.stringify(result)]);
    if (result.error) {
      console.warn(`[sms] parcel receiver text for ride ${r.id} failed: ${result.error}`);
      await notifyIn(r.rider_id, 'receiverTextFailed', { name: r.parcel.receiverName, code: r.delivery_otp }, '/book');
    }
  }
}

// --- rentals -----------------------------------------------------------------------------

export const toPackage = (p) => ({
  id: p.id,
  name: p.name,
  vehicleType: p.vehicle_type,
  hours: p.hours,
  km: p.km,
  price: p.price,
  extraKmRate: Number(p.extra_km_rate),
  extraMinRate: Number(p.extra_min_rate),
  seasonal: p.seasonal,
  availableFrom: p.available_from,
  availableTo: p.available_to,
  active: p.active,
});

const PACKAGE_SQL = `SELECT *, to_char(available_from, 'YYYY-MM-DD') AS available_from, to_char(available_to, 'YYYY-MM-DD') AS available_to FROM rental_packages`;

/** Packages a rider can book today. */
export const bookablePackages = async () =>
  (await many(`${PACKAGE_SQL} WHERE active AND (NOT seasonal OR $1::date BETWEEN available_from AND available_to) ORDER BY seasonal DESC, vehicle_type, hours`, [todayIST()])).map(toPackage);

export async function bookablePackage(id, vehicleType) {
  const p = (await bookablePackages()).find((x) => x.id === id);
  if (!p) throw new HttpError(400, 'Choose a rental package');
  if (p.vehicleType !== vehicleType) throw new HttpError(400, `That package is for ${p.vehicleType === 'car' ? 'a Cab' : 'an Auto'}`);
  return p;
}

export const allPackages = async () => (await many(`${PACKAGE_SQL} ORDER BY active DESC, seasonal DESC, vehicle_type, hours`)).map(toPackage);

/** Final rental fare: the package, plus extra km (from GPS) and extra minutes at the agreed rates. */
export function rentalFare(rental, actualKm, minutes) {
  const extraKm = Math.max(0, actualKm - rental.km);
  const extraMin = Math.max(0, minutes - rental.hours * 60);
  const extra = Math.ceil(extraKm * rental.extraKmRate) + Math.ceil(extraMin * rental.extraMinRate);
  return { extra, fare: rental.price + extra, extraKm: Math.round(extraKm * 10) / 10, extraMin };
}

// --- price locks ---------------------------------------------------------------------------

export const PRICE_LOCK = { fee: 49, days: 7, matchM: 300, maxActive: 3 };

export const toPriceLock = (l) =>
  l && { id: l.id, vehicleType: l.vehicle_type, pickup: l.pickup, dropoff: l.dropoff, lockedFare: l.locked_fare, fee: l.fee, expiresAt: l.expires_at };

/** Today's no-surge, no-promo fare for a route: what a lock freezes. */
export function lockableFare(type, route) {
  return priceTrip({ type, distanceKm: route.distanceKm, durationMin: route.durationMin, stops: 0, surge: 1 }).fare;
}

/** The rider's active lock matching this route and vehicle, if any. */
export async function matchingLock(riderId, type, pickup, dropoff) {
  const locks = await many(`SELECT * FROM price_locks WHERE rider_id = $1 AND vehicle_type = $2 AND expires_at > now()`, [riderId, type]);
  const near = (a, b) => haversineKm(a, b) * 1000 <= PRICE_LOCK.matchM;
  return locks.find((l) => near(l.pickup, pickup) && near(l.dropoff, dropoff)) ?? null;
}

/** Creates a lock inside a transaction once its fee is paid (wallet debit, or a confirmed Razorpay payment). */
export async function createLock(q, { riderId, vehicleType, pickup, dropoff, lockedFare, ref, fromWallet }) {
  const active = (await q(`SELECT count(*)::int AS n FROM price_locks WHERE rider_id = $1 AND expires_at > now()`, [riderId])).rows[0].n;
  if (active >= PRICE_LOCK.maxActive) throw new HttpError(409, `You can have at most ${PRICE_LOCK.maxActive} price locks`);
  if (fromWallet && !(await postTxn(q, { userId: riderId, amount: -PRICE_LOCK.fee, kind: 'price_lock', ref, noOverdraw: true }))) {
    throw new HttpError(400, `Your wallet has less than ₹${PRICE_LOCK.fee}`);
  }
  return (
    await q(
      `INSERT INTO price_locks (rider_id, vehicle_type, pickup, dropoff, locked_fare, fee, payment_ref, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8 * interval '1 day') RETURNING *`,
      [riderId, vehicleType, JSON.stringify(pickup), JSON.stringify(dropoff), lockedFare, PRICE_LOCK.fee, ref, PRICE_LOCK.days],
    )
  ).rows[0];
}

// --- family ------------------------------------------------------------------------------------

/** Accepted family members of a user. */
export const familyOf = async (userId) =>
  many(
    `SELECT u.id, u.name, u.share_trips_with_family FROM family_links f
     JOIN users u ON u.id = CASE WHEN f.inviter_id = $1 THEN f.member_id ELSE f.inviter_id END
     WHERE f.status = 'accepted' AND $1 IN (f.inviter_id, f.member_id)`,
    [userId],
  );

/** Tells a rider's family about their trip, only if that rider chose to share trips with family. */
export async function notifyFamily(r, key, vars) {
  const me = await one('SELECT share_trips_with_family FROM users WHERE id = $1', [r.rider_id]);
  if (!me?.share_trips_with_family) return;
  for (const f of await familyOf(r.rider_id)) {
    emitToUser(f.id, 'family:update', { riderId: r.rider_id });
    await notifyIn(f.id, key, vars, '/family');
  }
}
