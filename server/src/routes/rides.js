import { Router } from 'express';
import crypto from 'node:crypto';
import { requireAuth, requireRole, requireVerifiedPhone, HttpError } from '../auth.js';
import { driverVerification } from '../driverDocs.js';
import { openAlerts, riderOk } from '../deviation.js';
import { confirmSafe, pendingCheckFor, runSafetyChecks, startNightCheck } from '../safetyChecks.js';
import { SPLIT_SQL, afterSplitPaid, afterTip, applySplitPayment, applyTip, closeSplit, driverCancelCredit, fareBreakdown, maybeOpenDetourDispute, requestSplit, splitsForRide, tippableRide, toSplit } from '../fairMoney.js';
import { PHONE_RE, normalizePhone } from './auth.js';
import { todayIST, towardHome } from '../drivers.js';
import { checkBusinessBooking, rewardDriverReferral } from '../growth.js';
import { PRICE_LOCK, bookablePackage, cleanAccessibility, cleanParcel, cleanPassenger, lockableFare, matchingLock, newCode, notifyFamily, rentalFare, textOtherPerson } from '../booking.js';
import { refundsForRide } from '../refunds.js';
import { runRecordingCleanup } from '../recordings.js';
import { delayOnRoute, expireSpots } from '../waterlog.js';
import { config } from '../config.js';
import { one, many, query, tx, isUniqueViolation } from '../db.js';
import { etaMinutes, MAX_STOPS, priceTrip, VEHICLES, VEHICLE_TYPES } from '../fare.js';
import { getRoute, haversineKm, isLatLng } from '../geo.js';
import { ACTIVE, RIDE_SQL, broadcastRide, dispatchRide, driverPresence, driverSpeedKmh, emitToUser, loadRide, offerFor, passOn, serializeRide, stationPlace, stationReservedFor, surgeAt, surgeDetail, takeTripKm, withdrawOffer } from '../hub.js';
import { evaluatePromo, normalizeCode } from '../promos.js';
import { afterPaid, emailReceipt, markPaid, requireOnlinePayments, settle } from '../payments.js';
import { renderReceipt } from '../receipt.js';
import { notifyIn, timeIn } from '../messages.js';

const router = Router();
router.use(requireAuth);

const UPI_RE = /^[\w.-]{2,64}@[a-zA-Z]{2,32}$/;
const PAYMENT_METHODS = ['cash', 'wallet', 'card', 'upi', 'corporate'];

function cleanPlace(p, label) {
  const place = { lat: Number(p?.lat), lng: Number(p?.lng), address: String(p?.address ?? '').trim().slice(0, 300) };
  if (!isLatLng(place)) throw new HttpError(400, `Choose a ${label} location`);
  if (!place.address) place.address = `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`;
  return place;
}

/** Validates pickup, optional stops and drop from a request body. */
function cleanTrip(body) {
  const pickup = cleanPlace(body?.pickup, 'pickup');
  const dropoff = cleanPlace(body?.dropoff, 'drop');
  const rawStops = Array.isArray(body?.stops) ? body.stops : [];
  if (rawStops.length > MAX_STOPS) throw new HttpError(400, `At most ${MAX_STOPS} extra stops`);
  const stops = rawStops.map((s, i) => cleanPlace(s, `stop ${i + 1}`));
  const all = [pickup, ...stops, dropoff];
  if (haversineKm(pickup, dropoff) < 0.2 && stops.length === 0) throw new HttpError(400, 'Pickup and drop are too close together');
  for (let i = 1; i < all.length; i++) if (haversineKm(all[i - 1], all[i]) > 150) throw new HttpError(400, 'Trips are limited to 150 km per leg');
  return { pickup, stops, dropoff, all };
}

/** Validates an optional scheduled pickup time. Returns a Date, or null for "ride now". */
function cleanSchedule(body) {
  if (body?.scheduledFor == null || body.scheduledFor === '') return null;
  const at = new Date(body.scheduledFor);
  if (Number.isNaN(at.getTime())) throw new HttpError(400, 'Pick a valid pickup time');
  const { minAheadMin, maxDays } = config.schedule;
  const ahead = at.getTime() - Date.now();
  if (ahead < minAheadMin * 60_000) throw new HttpError(400, `Schedule at least ${minAheadMin} minutes ahead, or book now`);
  if (ahead > maxDays * 86_400_000) throw new HttpError(400, `Rides can be scheduled up to ${maxDays} days ahead`);
  return at;
}

const forViewer = (req) =>
  req.user.role === 'driver' ? { col: 'r.driver_id', id: req.user.id } : { col: 'r.rider_id', id: req.user.id };

/** Loads a ride the current user is part of (admins can see any). */
async function ownRide(req) {
  const r = await loadRide(req.params.id).catch(() => null);
  if (!r || (req.user.role !== 'admin' && r.rider_id !== req.user.id && r.driver_id !== req.user.id)) throw new HttpError(404, 'Ride not found');
  return r;
}

/** Runs an UPDATE ... RETURNING id; 409 if no row matched, else broadcasts the fresh ride. */
async function transition(sql, params, conflictMessage) {
  const row = await one(sql, params).catch((err) => {
    if (err.code === '22P02') return null; // malformed uuid
    throw err;
  });
  if (!row) throw new HttpError(409, conflictMessage);
  const r = await loadRide(row.id);
  broadcastRide(r);
  return r;
}

// --- quoting & booking -----------------------------------------------------

router.post('/quote', requireRole('rider'), async (req, res) => {
  const { pickup, stops, dropoff, all } = cleanTrip(req.body);
  const scheduledFor = cleanSchedule(req.body);
  const route = await getRoute(all);
  const code = normalizeCode(req.body?.promoCode);
  // Reported waterlogging on the route: extra minutes on the ETA only, never on the fare.
  const waterlog = scheduledFor ? { spots: [], delayMin: 0, impassable: false } : await delayOnRoute(route.geometry);
  const options = [];
  for (const type of VEHICLE_TYPES) {
    // Future demand cannot be known, so scheduled rides are priced without surge.
    const demand = scheduledFor ? null : await surgeDetail(pickup, type);
    const surge = demand?.multiplier ?? 1;
    const pre = priceTrip({ type, distanceKm: route.distanceKm, durationMin: route.durationMin, stops: stops.length, surge });
    let promo = null;
    let promoError = null;
    if (code) {
      try {
        promo = await evaluatePromo(query, code, req.user.id, pre.subtotal);
      } catch (err) {
        promoError = err.message;
      }
    }
    options.push({
      type,
      label: VEHICLES[type].label,
      seats: VEHICLES[type].seats,
      etaMin: etaMinutes(type, route.durationMin) + waterlog.delayMin,
      waterlogDelayMin: waterlog.delayMin,
      price: priceTrip({ type, distanceKm: route.distanceKm, durationMin: route.durationMin, stops: stops.length, surge, discount: promo?.discount ?? 0 }),
      promo,
      promoError,
      // Open surge: the real counts behind the price (riders waiting vs free drivers within 3 km).
      demand: demand && { waiting: demand.waiting, freeDrivers: demand.freeDrivers, radiusKm: demand.radiusKm },
    });
    // Price lock (direct trips only): an active lock caps the fare; otherwise what a new lock would freeze.
    if (stops.length === 0) {
      const o = options[options.length - 1];
      const lock = await matchingLock(req.user.id, type, pickup, dropoff);
      if (lock) {
        o.lock = { id: lock.id, lockedFare: lock.locked_fare, expiresAt: lock.expires_at };
        if (lock.locked_fare < o.price.fare) o.price = { ...o.price, lockSaving: o.price.fare - lock.locked_fare, fare: lock.locked_fare };
      } else {
        o.lockOffer = { lockedFare: lockableFare(type, route), fee: PRICE_LOCK.fee, days: PRICE_LOCK.days };
      }
    }
  }
  res.json({ route, options, waterlog });
});

const timers = new Map();

async function expire(rideId) {
  timers.delete(rideId);
  const row = await one(
    `UPDATE rides SET status = 'cancelled', cancelled_by = 'system', cancel_reason = 'No drivers accepted in time', cancelled_at = now()
     WHERE id = $1 AND status = 'requested' RETURNING id`,
    [rideId],
  );
  if (!row) return;
  const r = await loadRide(rideId);
  broadcastRide(r);
  withdrawOffer(r);
  await notifyIn(r.rider_id, 'noDrivers', (lang) => ({ time: r.scheduled_for ? timeIn(lang, r.scheduled_for) : null }), '/book');
}

function scheduleExpiry(rideId, delay = config.requestTimeoutMs) {
  const t = setTimeout(() => expire(rideId).catch((err) => console.warn('[rides] expiry failed', err.message)), delay);
  t.unref();
  timers.set(rideId, t);
}

function clearExpiry(rideId) {
  clearTimeout(timers.get(rideId));
  timers.delete(rideId);
}

/** Requests left over from before a restart have no timer. */
export async function resumeExpiries() {
  const open = await many(`SELECT id, created_at, requested_at, scheduled_for FROM rides WHERE status = 'requested'`);
  for (const r of open) scheduleExpiry(r.id, Math.max(0, expiryAt(r) - Date.now()));
  return open.length;
}

router.post('/', requireRole('rider'), requireVerifiedPhone, async (req, res) => {
  const { vehicleType, paymentMethod } = req.body ?? {};
  if (!VEHICLE_TYPES.includes(vehicleType)) throw new HttpError(400, 'Pick a vehicle');
  if (!PAYMENT_METHODS.includes(paymentMethod)) throw new HttpError(400, 'Pick a payment method');
  // Never book a ride the rider would have no real way to pay for.
  if (paymentMethod === 'card' || paymentMethod === 'upi') requireOnlinePayments();
  const upiVpa = paymentMethod === 'upi' ? String(req.body?.upiVpa ?? '').trim() : null;
  if (paymentMethod === 'upi' && !UPI_RE.test(upiVpa)) throw new HttpError(400, 'Enter a valid UPI ID, like name@okhdfc');

  // trip (A to B), rental (driver by the hour, no fixed drop) or parcel (deliver an item).
  const kind = ['rental', 'parcel'].includes(req.body?.kind) ? req.body.kind : 'trip';
  const passenger = kind === 'parcel' ? null : cleanPassenger(req.body, req.user);
  const accessibility = kind === 'parcel' ? [] : cleanAccessibility(req.body, vehicleType);
  const parcel = kind === 'parcel' ? cleanParcel(req.body, vehicleType) : null;
  const scheduledFor = cleanSchedule(req.body);
  if (scheduledFor) {
    const { n } = await one(`SELECT count(*)::int AS n FROM rides WHERE rider_id = $1 AND status = 'scheduled'`, [req.user.id]);
    if (n >= config.schedule.maxUpcoming) throw new HttpError(409, `You can have at most ${config.schedule.maxUpcoming} scheduled rides`);
  }

  // Route, surge and fare are always computed here - never trusted from the client.
  let pickup, stops, dropoff, route, rental = null;
  if (kind === 'rental') {
    const pkg = await bookablePackage(String(req.body?.packageId ?? ''), vehicleType);
    pickup = cleanPlace(req.body?.pickup, 'pickup');
    stops = [];
    dropoff = pickup; // no fixed drop: the rental ends wherever the rider chooses
    route = { geometry: [], distanceKm: pkg.km, durationMin: pkg.hours * 60, estimated: true };
    rental = { packageId: pkg.id, name: pkg.name, hours: pkg.hours, km: pkg.km, price: pkg.price, extraKmRate: pkg.extraKmRate, extraMinRate: pkg.extraMinRate };
  } else {
    let all;
    ({ pickup, stops, dropoff, all } = cleanTrip(req.body));
    route = await getRoute(all);
  }
  // Rentals and scheduled rides have no surge; rentals take no promo codes.
  const surge = scheduledFor || rental ? 1 : await surgeAt(pickup, vehicleType);
  const code = rental ? null : normalizeCode(req.body?.promoCode);
  const lock = kind === 'trip' && stops.length === 0 ? await matchingLock(req.user.id, vehicleType, pickup, dropoff) : null;

  let rideId;
  try {
    rideId = await tx(async ({ query: q }) => {
      let price, promo = null;
      if (rental) {
        price = { baseFare: rental.price, surge: 1, stopCharge: 0, discount: 0, fare: rental.price };
      } else {
        const pre = priceTrip({ type: vehicleType, distanceKm: route.distanceKm, durationMin: route.durationMin, stops: stops.length, surge });
        promo = code ? await evaluatePromo(q, code, req.user.id, pre.subtotal) : null;
        price = priceTrip({ type: vehicleType, distanceKm: route.distanceKm, durationMin: route.durationMin, stops: stops.length, surge, discount: promo?.discount ?? 0 });
      }
      // A price lock caps the fare; the rider pays whichever is lower.
      const lockSaving = lock ? Math.max(0, price.fare - lock.locked_fare) : 0;
      const fare = price.fare - lockSaving;
      if (paymentMethod === 'wallet' && req.user.wallet_balance < fare) {
        throw new HttpError(400, `Wallet balance ₹${req.user.wallet_balance} is less than the fare ₹${fare}. Top up or choose another method.`);
      }
      // Business ride: the company wallet and the employee's monthly limit must cover it.
      const company = paymentMethod === 'corporate' ? await checkBusinessBooking(req.user.id, fare, q) : null;
      const { rows } = await q(
        `INSERT INTO rides (rider_id, vehicle_type, pickup, stops, dropoff, route, distance_km, duration_min,
           base_fare, surge, stop_charge, discount, promo_code, fare, payment_method, upi_vpa, share_token, route_estimated,
           status, scheduled_for, requested_at,
           kind, passenger_name, passenger_phone, rental, parcel, delivery_otp, accessibility, price_lock_id, lock_saving,
           company_id, business_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32) RETURNING id`,
        [
          req.user.id, vehicleType, JSON.stringify(pickup), JSON.stringify(stops), JSON.stringify(dropoff), JSON.stringify(route.geometry),
          route.distanceKm, route.durationMin, price.baseFare, price.surge, price.stopCharge, price.discount, promo?.code ?? null,
          fare, paymentMethod, upiVpa, crypto.randomBytes(12).toString('base64url'), Boolean(route.estimated),
          scheduledFor ? 'scheduled' : 'requested', scheduledFor, scheduledFor ? null : new Date(),
          kind, passenger?.name ?? null, passenger?.phone ?? null, rental && JSON.stringify(rental), parcel && JSON.stringify(parcel),
          parcel ? newCode() : null, accessibility, lockSaving > 0 ? lock.id : null, lockSaving,
          company?.company_id ?? null, company ? String(req.body?.businessNote ?? '').trim().slice(0, 120) || null : null,
        ],
      );
      if (promo) await q('INSERT INTO promo_redemptions (code, user_id, ride_id) VALUES ($1, $2, $3)', [promo.code, req.user.id, rows[0].id]);
      return rows[0].id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'You already have a ride in progress');
    throw err;
  }

  const r = await loadRide(rideId);
  if (scheduledFor) {
    // Offered to drivers by the scheduler shortly before pickup.
    return res.status(201).json({ ride: serializeRide(r, req.user.id), offeredTo: 0 });
  }
  scheduleExpiry(r.id);
  const offeredTo = await dispatchRide(r);
  res.status(201).json({ ride: serializeRide(r, req.user.id), offeredTo });
});

// --- scheduled rides -----------------------------------------------------------

/** When an unanswered request gives up: 2 minutes after it went out, or for a scheduled ride a few minutes after its pickup time. */
function expiryAt(r) {
  const start = new Date(r.requested_at ?? r.created_at).getTime() + config.requestTimeoutMs;
  return r.scheduled_for ? Math.max(start, new Date(r.scheduled_for).getTime() + config.schedule.graceMin * 60_000) : start;
}

/** `why`: 'late' (could not look for a driver in time) or 'busy' (the rider was on another ride). */
async function cancelScheduled(rideId, why) {
  const reason = why === 'busy' ? 'you had another ride in progress at that time' : 'Hopin could not look for a driver in time';
  const row = await one(
    `UPDATE rides SET status = 'cancelled', cancelled_by = 'system', cancel_reason = $2, cancelled_at = now()
     WHERE id = $1 AND status = 'scheduled' RETURNING id`,
    [rideId, reason],
  );
  if (!row) return;
  const r = await loadRide(rideId);
  broadcastRide(r);
  await notifyIn(r.rider_id, 'scheduledCancelled', (lang) => ({ time: timeIn(lang, r.scheduled_for), why }), '/book');
}

const lastOffered = new Map(); // rideId -> when it was last offered to drivers

/**
 * Turns scheduled rides that are due into live requests (config.schedule.leadMin before
 * pickup) and re-offers scheduled requests still without a driver about once a minute,
 * so drivers who came online since also see them. Safe to run often.
 */
export async function runScheduler(now = Date.now()) {
  const { leadMin, graceMin } = config.schedule;
  const due = await many(`SELECT id, scheduled_for FROM rides WHERE status = 'scheduled' AND scheduled_for <= $1 ORDER BY scheduled_for`, [
    new Date(now + leadMin * 60_000),
  ]);
  for (const s of due) {
    // The server was not running when it should have gone out: say so rather than send a driver late.
    if (new Date(s.scheduled_for).getTime() + graceMin * 60_000 < now) {
      await cancelScheduled(s.id, 'late');
      continue;
    }
    let row;
    try {
      row = await one(`UPDATE rides SET status = 'requested', requested_at = now() WHERE id = $1 AND status = 'scheduled' RETURNING id`, [s.id]);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await cancelScheduled(s.id, 'busy');
      continue;
    }
    if (!row) continue; // cancelled meanwhile
    const r = await loadRide(s.id);
    scheduleExpiry(r.id, Math.max(0, expiryAt(r) - Date.now()));
    broadcastRide(r);
    await dispatchRide(r);
    lastOffered.set(r.id, now);
    await notifyIn(r.rider_id, 'findingDriver', (lang) => ({ time: timeIn(lang, r.scheduled_for) }), '/book');
  }

  const waiting = await many(`${RIDE_SQL} WHERE r.status = 'requested' AND r.scheduled_for IS NOT NULL`);
  const ids = new Set(waiting.map((r) => r.id));
  for (const id of lastOffered.keys()) if (!ids.has(id)) lastOffered.delete(id);
  for (const r of waiting) {
    if (now - (lastOffered.get(r.id) ?? 0) < 60_000) continue;
    lastOffered.set(r.id, now);
    await dispatchRide(r);
  }
}

const toSurgeWatch = (w) => w && { id: w.id, vehicleType: w.vehicle_type, pickup: w.pickup, status: w.status, expiresAt: w.expires_at };

/** Tells riders who asked when prices near their pickup are back to normal (or that their 30 minutes ran out). */
export async function runSurgeWatches() {
  const watching = await many(`SELECT * FROM surge_watches WHERE status = 'watching'`);
  for (const w of watching) {
    const near = { vehicle: w.vehicle_type, place: w.pickup.address.split(',')[0] };
    if ((await surgeDetail(w.pickup, w.vehicle_type)).multiplier <= 1) {
      const done = await one(`UPDATE surge_watches SET status = 'notified', closed_at = now() WHERE id = $1 AND status = 'watching' RETURNING id`, [w.id]);
      if (done) await notifyIn(w.rider_id, 'surgeNormal', near, '/book');
    } else if (new Date(w.expires_at) <= new Date()) {
      const done = await one(`UPDATE surge_watches SET status = 'expired', closed_at = now() WHERE id = $1 AND status = 'watching' RETURNING id`, [w.id]);
      if (done) await notifyIn(w.rider_id, 'surgeStill', near, '/book');
    }
  }
}

export function startScheduler() {
  const tick = () => {
    runScheduler().catch((err) => console.warn('[rides] scheduler failed', err.message));
    runSafetyChecks().catch((err) => console.warn('[safety] night checks failed', err.message));
    runSurgeWatches().catch((err) => console.warn('[rides] surge watches failed', err.message));
    runRecordingCleanup().catch((err) => console.warn('[recording] cleanup failed', err.message));
    expireSpots().catch((err) => console.warn('[waterlog] expiry failed', err.message));
  };
  tick();
  setInterval(tick, config.schedule.tickMs).unref();
}

// --- reading ----------------------------------------------------------------

router.get('/active', async (req, res) => {
  const v = forViewer(req);
  const r = await one(`${RIDE_SQL} WHERE ${v.col} = $1 AND r.status = ANY($2) ORDER BY r.created_at DESC LIMIT 1`, [v.id, ACTIVE]);
  res.json({ ride: r ? { ...serializeRide(r, req.user.id), alerts: await openAlerts(r.id) } : null });
});

router.get('/history', async (req, res) => {
  const v = forViewer(req);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = await many(
    `${RIDE_SQL} WHERE ${v.col} = $1 AND r.status IN ('completed', 'cancelled') ORDER BY r.created_at DESC LIMIT $2`,
    [v.id, limit],
  );
  // The route polyline is heavy and not needed for a list.
  res.json({ rides: rows.map((r) => ({ ...serializeRide(r, req.user.id), route: undefined })) });
});

/** Fare-split requests waiting for this rider to pay. */
router.get('/splits/incoming', requireRole('rider'), async (req, res) => {
  const rows = await many(`${SPLIT_SQL} WHERE s.payer_id = $1 AND s.status = 'pending' ORDER BY s.created_at DESC`, [req.user.id]);
  res.json({ splits: rows.map(toSplit) });
});

/** "Tell me when prices are normal": the rider's active watch, start one, stop it. */
router.get('/surge-watch', requireRole('rider'), async (req, res) => {
  res.json({ watch: toSurgeWatch(await one(`SELECT * FROM surge_watches WHERE rider_id = $1 AND status = 'watching'`, [req.user.id])) });
});

router.post('/surge-watch', requireRole('rider'), async (req, res) => {
  const pickup = cleanPlace(req.body?.pickup, 'pickup');
  const type = req.body?.vehicleType;
  if (!VEHICLE_TYPES.includes(type)) throw new HttpError(400, 'Pick a vehicle');
  const now = await surgeDetail(pickup, type);
  if (now.multiplier <= 1) throw new HttpError(409, 'Prices are already normal here');
  await query(`UPDATE surge_watches SET status = 'cancelled', closed_at = now() WHERE rider_id = $1 AND status = 'watching'`, [req.user.id]);
  const w = await one(
    `INSERT INTO surge_watches (rider_id, vehicle_type, pickup, expires_at) VALUES ($1, $2, $3, now() + interval '30 minutes') RETURNING *`,
    [req.user.id, type, JSON.stringify(pickup)],
  );
  res.status(201).json({ watch: toSurgeWatch(w) });
});

router.delete('/surge-watch', requireRole('rider'), async (req, res) => {
  await query(`UPDATE surge_watches SET status = 'cancelled', closed_at = now() WHERE rider_id = $1 AND status = 'watching'`, [req.user.id]);
  res.json({ watch: null });
});

/** The rider's unanswered "Reached safely?" check, if any. */
router.get('/safety-check', requireRole('rider'), async (req, res) => {
  res.json({ check: await pendingCheckFor(req.user.id) });
});

/** The rider's upcoming scheduled rides, soonest first. */
router.get('/scheduled', requireRole('rider'), async (req, res) => {
  const rows = await many(`${RIDE_SQL} WHERE r.rider_id = $1 AND r.status = 'scheduled' ORDER BY r.scheduled_for`, [req.user.id]);
  res.json({ rides: rows.map((r) => ({ ...serializeRide(r, req.user.id), route: undefined })) });
});

/** Open requests a driver could take right now - used when they first go online. */
router.get('/open', requireRole('driver'), async (req, res) => {
  const type = req.user.vehicle_type;
  if (!type) return res.json({ rides: [] });
  const presence = driverPresence(req.user.id);
  const rows = await many(
    `${RIDE_SQL} WHERE r.status = 'requested' AND r.vehicle_type = $1 AND NOT (r.declined_by ? $2::text) ORDER BY COALESCE(r.requested_at, r.created_at) DESC LIMIT 20`,
    [type, req.user.id],
  );
  const nearby = rows.filter(
    (r) =>
      (!presence || !isLatLng(presence) || haversineKm(presence, r.pickup) <= config.dispatchRadiusKm) &&
      // Reserved for the front of a station queue, or not on the way home: not shown.
      (!stationReservedFor(r.id) || stationReservedFor(r.id) === req.user.id) &&
      (!presence?.headingHome || towardHome(presence, presence.headingHome, r.dropoff)),
  );
  res.json({ rides: nearby.map((r) => offerFor(r, presence)) });
});

/** Rider: their place in line at a station pickup, and how many drivers are queued there. */
router.get('/:id/station', requireRole('rider'), async (req, res) => {
  res.json({ queue: await stationPlace(await ownRide(req)) });
});

router.get('/earnings', requireRole('driver'), async (req, res) => {
  const sums = await one(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('day', now())), 0)::int AS today,
       COALESCE(SUM(amount) FILTER (WHERE created_at >= now() - interval '7 days'), 0)::int AS week,
       COALESCE(SUM(amount), 0)::int AS total
     FROM wallet_txns WHERE user_id = $1
       AND kind IN ('earning', 'cash_earning', 'commission', 'earning_adjustment', 'tip', 'cancel_penalty')`,
    [req.user.id],
  );
  const trips = await one(
    `SELECT count(*) FILTER (WHERE completed_at >= date_trunc('day', now()))::int AS today, count(*)::int AS total,
            COALESCE(SUM(distance_km), 0) AS km
     FROM rides WHERE driver_id = $1 AND status = 'completed'`,
    [req.user.id],
  );
  res.json({
    earnings: sums,
    trips: { today: trips.today, total: trips.total, km: Math.round(trips.km * 10) / 10 },
    walletBalance: req.user.wallet_balance,
    rating: Math.round(req.user.rating * 10) / 10,
    ratingCount: req.user.rating_count,
  });
});

router.get('/:id', async (req, res) => {
  const r = await ownRide(req);
  res.json({
    ride: {
      ...serializeRide(r, req.user.id),
      refunds: await refundsForRide(r.id),
      alerts: await openAlerts(r.id),
      breakdown: await fareBreakdown(r),
      tip: r.tip,
      // Split requests are between riders; the driver does not see them.
      splits: req.user.role === 'driver' ? [] : await splitsForRide(r.id),
    },
  });
});

// --- driver actions ----------------------------------------------------------

router.post('/:id/accept', requireRole('driver'), requireVerifiedPhone, async (req, res) => {
  // Documents can expire while a driver is online, so check at every accept too.
  const verification = await driverVerification(req.user.id);
  if (!verification.canDrive) throw new HttpError(403, verification.message, 'DRIVER_NOT_VERIFIED');
  if (!req.user.vehicle_type) throw new HttpError(400, 'Add your vehicle in your profile first');
  // A station request is offered to the front of the queue first; only that driver can take it for now.
  const reserved = stationReservedFor(req.params.id);
  if (reserved && reserved !== req.user.id) throw new HttpError(409, 'This request is offered to the driver at the front of the station queue');
  const target = await one(`SELECT pickup FROM rides WHERE id = $1`, [req.params.id]).catch(() => null);
  if (!target) throw new HttpError(404, 'Ride not found');
  const presence = driverPresence(req.user.id);
  const eta = presence && isLatLng(presence) ? (await getRoute([presence, target.pickup])).durationMin : null;

  let r;
  try {
    // The status check in WHERE makes this atomic: if two drivers accept at once, one gets 0 rows.
    r = await transition(
      // The rider's own trip PIN when they set one, otherwise a fresh random code.
      `UPDATE rides SET status = 'accepted', driver_id = $2, accepted_at = now(), pickup_eta_min = $4,
         -- Someone else riding needs a code they are told by SMS, not the booker's own PIN.
         otp = CASE WHEN passenger_phone IS NULL THEN COALESCE((SELECT trip_pin FROM users WHERE id = rides.rider_id), $3) ELSE $3 END,
         -- Accepted on a day the driver holds a pass: they keep 100% of this fare.
         commission_free = EXISTS (SELECT 1 FROM driver_days WHERE driver_id = $2 AND day = $6::date AND pass_ref IS NOT NULL)
       WHERE id = $1 AND status = 'requested' AND vehicle_type = $5 RETURNING id`,
      [req.params.id, req.user.id, String(crypto.randomInt(1000, 10000)), eta, req.user.vehicle_type, todayIST()],
      'Another driver already took this ride',
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'Finish your current ride first');
    throw err;
  }
  clearExpiry(r.id);
  withdrawOffer(r);
  await notifyIn(r.rider_id, 'driverAssigned', { driver: r.driver_name, vehicle: `${r.v_model} ${r.v_plate}`, eta, passenger: r.passenger_name, otp: r.otp }, '/book');
  // Booked for someone else / a parcel: text the passenger or the receiver.
  await textOtherPerson(r).catch((err) => console.warn('[rides] texting the passenger/receiver failed', err.message));
  res.json({ ride: serializeRide(r, req.user.id) });
});

router.post('/:id/decline', requireRole('driver'), async (req, res) => {
  await query(`UPDATE rides SET declined_by = declined_by || to_jsonb($2::text) WHERE id = $1 AND status = 'requested' AND NOT (declined_by ? $2::text)`, [
    req.params.id,
    req.user.id,
  ]).catch(() => null);
  // Declining a station request passes it to the next driver in the queue.
  await passOn(req.params.id, req.user.id).catch(() => {});
  res.json({ ok: true });
});

router.post('/:id/arrive', requireRole('driver'), async (req, res) => {
  const r = await transition(
    `UPDATE rides SET status = 'arrived', arrived_at = now() WHERE id = $1 AND driver_id = $2 AND status = 'accepted' RETURNING id`,
    [req.params.id, req.user.id],
    'This ride cannot be marked as arrived',
  );
  await notifyIn(r.rider_id, 'driverArrived', { plate: r.v_plate }, '/book');
  res.json({ ride: serializeRide(r, req.user.id) });
});

router.post('/:id/start', requireRole('driver'), async (req, res) => {
  const otp = String(req.body?.otp ?? '').trim();
  const current = await ownRide(req);
  if (current.driver_id !== req.user.id) throw new HttpError(404, 'Ride not found');
  if (current.status !== 'arrived') throw new HttpError(409, 'Mark yourself as arrived first');
  if (otp !== current.otp) throw new HttpError(400, 'Wrong OTP - ask the rider again');
  const r = await transition(
    `UPDATE rides SET status = 'ongoing', started_at = now() WHERE id = $1 AND driver_id = $2 AND status = 'arrived' RETURNING id`,
    [req.params.id, req.user.id],
    'This ride cannot be started',
  );
  await notifyIn(r.rider_id, 'rideStarted', { kind: r.kind, place: r.dropoff?.address?.split(',')[0], rental: r.rental?.name, receiver: r.parcel?.receiverName }, '/book');
  await notifyFamily(r, 'familyRideStarted', { name: r.rider_name, driver: r.driver_name, plate: r.v_plate });
  res.json({ ride: serializeRide(r, req.user.id) });
});

router.post('/:id/complete', requireRole('driver'), async (req, res) => {
  const current = await ownRide(req);
  // A parcel is delivered only when the receiver hands over their code.
  if (current.kind === 'parcel' && String(req.body?.deliveryOtp ?? '').trim() !== current.delivery_otp) {
    throw new HttpError(400, "Wrong delivery code - ask the receiver for the code they got by SMS");
  }
  const paid = await tx(async ({ query: q }) => {
    let row = (
      await q(`UPDATE rides SET status = 'completed', completed_at = now() WHERE id = $1 AND driver_id = $2 AND status = 'ongoing' RETURNING *`, [
        req.params.id,
        req.user.id,
      ]).catch(() => ({ rows: [] }))
    ).rows[0];
    if (!row) throw new HttpError(409, 'Only an ongoing ride can be completed');
    if (row.kind === 'rental') {
      // Final rental fare: package + extra km (driver GPS) + extra minutes.
      const km = takeTripKm(row.id) ?? Number(row.actual_km ?? 0);
      // Nearest minute: nobody pays a whole extra minute for a few seconds.
      const minutes = Math.round((new Date(row.completed_at) - new Date(row.started_at)) / 60_000);
      const f = rentalFare(row.rental, km, minutes);
      row = (await q('UPDATE rides SET actual_km = $2, rental_extra = $3, fare = $4 WHERE id = $1 RETURNING *', [row.id, Math.round(km * 100) / 100, f.extra, f.fare])).rows[0];
    }
    return settle(q, row);
  });
  const r = await loadRide(req.params.id);
  broadcastRide(r);
  await notifyIn(r.rider_id, 'tripEnded', { kind: r.kind, fare: r.fare, paid }, `/trips/${r.id}`);
  await rewardDriverReferral(r.driver_id).catch((err) => console.warn('[growth] driver referral failed', err.message));
  await notifyFamily(r, 'familyRideEnded', { name: r.rider_name, rental: r.kind === 'rental', place: r.dropoff?.address?.split(',')[0] });
  await startNightCheck(r);
  await maybeOpenDetourDispute(r);
  if (paid) await afterPaid(r.id);
  res.json({ ride: serializeRide(r, req.user.id) });
});

router.post('/:id/collect-cash', requireRole('driver'), async (req, res) => {
  const r0 = await ownRide(req);
  if (r0.driver_id !== req.user.id || r0.payment_method !== 'cash') throw new HttpError(409, 'This is not a cash ride');
  const paid = await tx(({ query: q }) => markPaid(q, r0.id, `CASH-${r0.id.slice(0, 8).toUpperCase()}`));
  if (!paid) throw new HttpError(409, 'Nothing is due on this ride');
  await afterPaid(r0.id);
  res.json({ ride: serializeRide(await loadRide(r0.id), req.user.id) });
});

// --- either party -------------------------------------------------------------

router.post('/:id/cancel', requireRole('rider', 'driver'), async (req, res) => {
  const asRider = req.user.role === 'rider';
  const current = await ownRide(req);
  // Riders can cancel until the trip starts (a scheduled ride, free); drivers only after accepting.
  const allowed = asRider ? ['scheduled', 'requested', 'accepted', 'arrived'] : ['accepted', 'arrived'];
  if (!allowed.includes(current.status)) throw new HttpError(409, 'This ride can no longer be cancelled');

  // Free within the grace period; a fee once the driver has arrived or has been driving over for a while.
  const late = current.status === 'arrived' || (current.accepted_at && Date.now() - new Date(current.accepted_at).getTime() > config.freeCancelMs);
  const fee = asRider && late ? VEHICLES[current.vehicle_type].cancelFee : 0;
  const reason = String(req.body?.reason ?? '').trim().slice(0, 200) || (asRider ? 'Cancelled by rider' : 'Cancelled by driver');

  const { paid, credit } = await tx(async ({ query: q }) => {
    const row = (
      await q(
        `UPDATE rides SET status = 'cancelled', cancelled_by = $3, cancel_reason = $4, cancellation_fee = $5, cancelled_at = now()
         WHERE id = $1 AND ${asRider ? 'rider_id' : 'driver_id'} = $2 AND status = ANY($6) RETURNING *`,
        [current.id, req.user.id, req.user.role, reason, fee, allowed],
      )
    ).rows[0];
    if (!row) throw new HttpError(409, 'This ride can no longer be cancelled');
    // A driver cancelling late pays the rider what a rider would pay for cancelling late.
    const credit = asRider ? 0 : await driverCancelCredit(q, row);
    return { paid: fee > 0 ? await settle(q, row) : false, credit };
  });
  clearExpiry(current.id);
  const r = await loadRide(current.id);
  broadcastRide(r);
  withdrawOffer(r);
  const other = asRider ? r.driver_id : r.rider_id;
  if (other) await notifyIn(other, 'rideCancelled', { byRider: asRider, reason }, asRider ? '/drive' : '/book');
  if (fee > 0) await notifyIn(r.rider_id, 'cancelFee', { fee }, `/trips/${r.id}`);
  if (credit > 0) {
    await notifyIn(r.rider_id, 'lateCancelCredit', { amount: credit }, '/profile');
    await notifyIn(r.driver_id, 'lateCancelCharge', { amount: credit }, '/drive');
  }
  if (paid) await afterPaid(r.id);
  res.json({ ride: serializeRide(r, req.user.id), cancellationFee: fee, riderCredit: credit });
});

/** Tells the rider up front whether cancelling now will cost anything. */
router.get('/:id/cancel-fee', requireRole('rider'), async (req, res) => {
  const r = await ownRide(req);
  const late = r.status === 'arrived' || (r.accepted_at && Date.now() - new Date(r.accepted_at).getTime() > config.freeCancelMs);
  res.json({ fee: ['accepted', 'arrived'].includes(r.status) && late ? VEHICLES[r.vehicle_type].cancelFee : 0 });
});

const REVIEW_TAGS = ['Safe driving', 'Clean vehicle', 'Polite', 'On time', 'Knew the route', 'Rash driving', 'Late pickup', 'Rude'];

router.post('/:id/review', requireRole('rider'), async (req, res) => {
  const stars = Number(req.body?.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new HttpError(400, 'Rating must be 1 to 5 stars');
  const comment = String(req.body?.comment ?? '').trim().slice(0, 500) || null;
  const tags = (Array.isArray(req.body?.tags) ? req.body.tags : []).filter((t) => REVIEW_TAGS.includes(t)).slice(0, 5);
  const r0 = await ownRide(req);
  if (r0.rider_id !== req.user.id || r0.status !== 'completed' || !r0.driver_id) throw new HttpError(409, 'Only completed trips can be reviewed');

  await tx(async ({ query: q }) => {
    const ins = await q(
      `INSERT INTO reviews (ride_id, rider_id, driver_id, stars, comment, tags) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (ride_id) DO NOTHING RETURNING ride_id`,
      [r0.id, req.user.id, r0.driver_id, stars, comment, JSON.stringify(tags)],
    );
    if (!ins.rows[0]) throw new HttpError(409, 'You already reviewed this trip');
    // Incremental mean in a single statement so concurrent reviews cannot clobber each other.
    await q(
      `UPDATE users SET rating = (rating * rating_count + $2) / (rating_count + 1), rating_count = rating_count + 1 WHERE id = $1`,
      [r0.driver_id, stars],
    );
  });
  await notifyIn(r0.driver_id, 'newReview', { stars, comment: comment ? comment.slice(0, 120) : null, rider: r0.rider_name }, '/profile');
  res.json({ ride: serializeRide(await loadRide(r0.id), req.user.id) });
});

// --- tips and fare splits ------------------------------------------------------------

/** Tip from the wallet. Online tips go through POST /api/payments/razorpay/order (kind 'tip'). */
router.post('/:id/tip', requireRole('rider'), async (req, res) => {
  const amount = Number(req.body?.amount);
  const r = await tippableRide(req.params.id, req.user.id, amount);
  const ref = `TIP-WALLET-${r.id}`;
  const ok = await tx(({ query: q }) => applyTip(q, { rideId: r.id, riderId: req.user.id, amount, ref, fromWallet: true }));
  if (!ok) throw new HttpError(409, 'You already tipped for this trip');
  await afterTip(r.id);
  res.json({ tip: amount });
});

router.post('/:id/splits', requireRole('rider'), async (req, res) => {
  const r = await ownRide(req);
  const phone = String(req.body?.phone ?? '').replace(/[\s-]/g, '');
  if (!PHONE_RE.test(phone)) throw new HttpError(400, 'Enter their 10-digit mobile number');
  const split = await requestSplit({ ride: r, requester: req.user, phone: normalizePhone(phone), amount: Number(req.body?.amount) });
  res.status(201).json({ split, splits: await splitsForRide(r.id) });
});

/** Pay a share from the wallet. Online: POST /api/payments/razorpay/order (kind 'split'). */
router.post('/splits/:splitId/pay', requireRole('rider'), async (req, res) => {
  const ref = `SPLIT-WALLET-${req.params.splitId}`;
  const s = await tx(({ query: q }) => applySplitPayment(q, { splitId: req.params.splitId, payerId: req.user.id, ref, fromWallet: true })).catch((err) => {
    if (err.code === '22P02') return false; // malformed id
    throw err;
  });
  if (!s) throw new HttpError(409, 'This request is no longer open');
  await afterSplitPaid(s.id);
  res.json({ ok: true });
});

router.post('/splits/:splitId/close', requireRole('rider'), async (req, res) => {
  res.json({ split: await closeSplit(req.params.splitId, req.user.id) });
});

// --- safety answers from the rider ---------------------------------------------

/** "I'm safe" after a night ride. */
router.post('/:id/safe', requireRole('rider'), async (req, res) => {
  const r = await ownRide(req);
  const check = await confirmSafe(r.id, req.user.id);
  if (!check) throw new HttpError(409, 'There is no open safety check for this trip');
  res.json({ check });
});

/** "I'm OK" for a long-stop or off-route alert during the trip. */
router.post('/:id/alerts/:alertId/ok', requireRole('rider'), async (req, res) => {
  const r = await ownRide(req);
  if (!(await riderOk(r.id, req.params.alertId))) throw new HttpError(409, 'This alert is already closed');
  res.json({ alerts: await openAlerts(r.id) });
});

// --- chat --------------------------------------------------------------------
// Rider and driver message each other here instead of sharing phone numbers.
// Open only while a driver is assigned and the trip is not over; read-only afterwards.
// Admins can read a chat (e.g. for a complaint) but never write in it.

const CHAT_OPEN = ['accepted', 'arrived', 'ongoing'];
const CHAT_MAX_CHARS = 500;
const CHAT_PER_MINUTE = 20;

// One-tap messages. Drivers who are moving can send only these (no typing while driving).
export const QUICK_REPLIES = {
  rider: ["I'm at the pickup point", 'Coming in 2 minutes', 'Please call out when you arrive', 'OK'],
  driver: ["I've arrived at pickup", "I'm nearby", 'Stuck in traffic, about 5 minutes', 'Where exactly are you?', 'Please come to the main road', 'OK, on my way'],
};

const toMessage = (m) => ({ id: m.id, rideId: m.ride_id, senderId: m.sender_id, body: m.body, createdAt: m.created_at, readAt: m.read_at });

router.get('/:id/messages', async (req, res) => {
  const r = await ownRide(req);
  const rows = await many('SELECT * FROM ride_messages WHERE ride_id = $1 ORDER BY created_at, id', [r.id]);
  res.json({ messages: rows.map(toMessage), open: CHAT_OPEN.includes(r.status), quickReplies: QUICK_REPLIES[req.user.role] ?? [] });
});

router.post('/:id/messages', requireRole('rider', 'driver'), async (req, res) => {
  const r = await ownRide(req);
  if (!CHAT_OPEN.includes(r.status)) throw new HttpError(409, 'Chat is only open while a driver is on the way or the trip is in progress');
  const body = String(req.body?.body ?? '').trim();
  if (!body) throw new HttpError(400, 'Write a message first');
  if (body.length > CHAT_MAX_CHARS) throw new HttpError(400, `Messages are limited to ${CHAT_MAX_CHARS} characters`);
  if (req.user.role === 'driver' && !QUICK_REPLIES.driver.includes(body) && driverSpeedKmh(req.user.id) > config.driverTypingMaxKmh) {
    throw new HttpError(409, 'You are driving. Use a quick reply, or pull over to type.', 'DRIVER_MOVING');
  }
  const { n } = await one(`SELECT count(*)::int AS n FROM ride_messages WHERE sender_id = $1 AND created_at > now() - interval '1 minute'`, [req.user.id]);
  if (n >= CHAT_PER_MINUTE) throw new HttpError(429, 'Too many messages in a minute - wait a moment');
  const message = toMessage(await one('INSERT INTO ride_messages (ride_id, sender_id, body) VALUES ($1, $2, $3) RETURNING *', [r.id, req.user.id, body]));
  emitToUser(r.rider_id, 'chat:message', message);
  emitToUser(r.driver_id, 'chat:message', message);
  res.status(201).json({ message });
});

/** Marks the other party's messages as read and tells them. */
router.post('/:id/messages/read', requireRole('rider', 'driver'), async (req, res) => {
  const r = await ownRide(req);
  const rows = await many(
    'UPDATE ride_messages SET read_at = now() WHERE ride_id = $1 AND sender_id <> $2 AND read_at IS NULL RETURNING id, read_at',
    [r.id, req.user.id],
  );
  if (rows.length) {
    const other = req.user.id === r.rider_id ? r.driver_id : r.rider_id;
    emitToUser(other, 'chat:read', { rideId: r.id, ids: rows.map((m) => m.id), readAt: rows[0].read_at });
  }
  res.json({ read: rows.length });
});

router.get('/:id/receipt.pdf', async (req, res) => {
  const r = await ownRide(req);
  if (r.status !== 'completed' && !(r.status === 'cancelled' && r.cancellation_fee > 0)) throw new HttpError(409, 'No receipt for this ride');
  const pdf = await renderReceipt(r, await fareBreakdown(r));
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="hopin-receipt-${r.id.slice(0, 8)}.pdf"` });
  res.send(pdf);
});

router.post('/:id/receipt/email', requireRole('rider'), async (req, res) => {
  const r = await ownRide(req);
  if (r.status !== 'completed' && !(r.status === 'cancelled' && r.cancellation_fee > 0)) throw new HttpError(409, 'No receipt for this ride');
  res.json(await emailReceipt(r));
});

export { REVIEW_TAGS };
export default router;
