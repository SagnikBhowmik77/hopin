import { config } from './config.js';
import { loadUser, phoneCheck, userFromToken } from './auth.js';
import { driverVerification } from './driverDocs.js';
import { helmetStatus } from './helmet.js';
import { HOME, breakMessage, endSession, fatigue, startSession, stationAtSync, stations, touchSession, towardHome } from './drivers.js';
import { checkDeviation, endDeviationWatch, resetDeviationWatches } from './deviation.js';
import { one, many, query } from './db.js';
import { delayOnRoute } from './waterlog.js';
import { roadEtaMin } from './liveEta.js';
import { haversineKm, isLatLng } from './geo.js';
import { surgeFrom } from './fare.js';
import { notifyIn } from './messages.js';

/**
 * Realtime layer. REST endpoints change ride state in Postgres; this module
 * pushes the result to whoever needs it and tracks which drivers are online.
 *
 * Rooms: `user:<id>` (every tab of a user), `admins`.
 * Presence lives in memory - losing it on restart is fine, drivers toggle online again.
 */

let io = null;
// driverId -> { vehicleType, lat, lng, sockets: Set, online }
const drivers = new Map();
// driverId -> { rideId, riderId, status, pickup, dropoff, arrivingSent } for rides in progress
const activeByDriver = new Map();

export const ACTIVE = ['requested', 'accepted', 'arrived', 'ongoing'];

export const RIDE_SQL = `
  SELECT r.*,
    ru.name AS rider_name, ru.phone AS rider_phone, ru.avatar AS rider_avatar,
    du.name AS driver_name, du.phone AS driver_phone, du.avatar AS driver_avatar,
    du.rating AS driver_rating, du.rating_count AS driver_rating_count, du.driver_deaf,
    v.type AS v_type, v.model AS v_model, v.plate AS v_plate,
    rv.stars AS review_stars, rv.comment AS review_comment, rv.tags AS review_tags
  FROM rides r
  JOIN users ru ON ru.id = r.rider_id
  LEFT JOIN users du ON du.id = r.driver_id
  LEFT JOIN vehicles v ON v.driver_id = r.driver_id
  LEFT JOIN reviews rv ON rv.ride_id = r.id`;

export const loadRide = (id, q = query) => q(`${RIDE_SQL} WHERE r.id = $1`, [id]).then((res) => res.rows[0] ?? null);

export function amountDue(r) {
  return r.status === 'cancelled' ? r.cancellation_fee : r.fare;
}

/** The ride as one party sees it. Only the rider gets the OTP. */
const smsStatus = (sms) => (sms ? { status: sms.error ? 'failed' : sms.status } : null);

export function serializeRide(r, viewerId) {
  const isRider = viewerId === r.rider_id;
  const live = r.driver_id ? drivers.get(r.driver_id) : null;
  return {
    id: r.id,
    status: r.status,
    vehicleType: r.vehicle_type,
    pickup: r.pickup,
    stops: r.stops,
    dropoff: r.dropoff,
    route: r.route,
    distanceKm: r.distance_km,
    durationMin: r.duration_min,
    price: {
      baseFare: r.base_fare,
      surge: r.surge,
      stopCharge: r.stop_charge,
      discount: r.discount,
      promoCode: r.promo_code,
      fare: r.fare,
      cancellationFee: r.cancellation_fee,
      due: amountDue(r),
    },
    payment: { method: r.payment_method, status: r.payment_status, ref: r.payment_ref, paidAt: r.paid_at, upi: r.upi_vpa },
    otp: isRider ? r.otp : null,
    shareToken: isRider ? r.share_token : null,
    pickupEtaMin: r.pickup_eta_min,
    // Set for a ride booked ahead: the pickup time the rider chose.
    scheduledFor: r.scheduled_for ?? null,
    kind: r.kind ?? 'trip',
    // Booked for someone else: the driver sees who to pick up; only the booker sees their number.
    // Only whether the SMS went out; the provider's error text is for the server log, not riders.
    passenger: r.passenger_name ? { name: r.passenger_name, ...(isRider ? { phone: r.passenger_phone, sms: smsStatus(r.passenger_sms) } : {}) } : null,
    rental: r.rental ? { ...r.rental, actualKm: r.actual_km == null ? null : Number(r.actual_km), extra: r.rental_extra } : null,
    parcel: r.parcel
      ? {
          receiverName: r.parcel.receiverName,
          item: r.parcel.item,
          size: r.parcel.size,
          // The sender sees the receiver's number and the delivery code; the driver gets the code from the receiver.
          ...(isRider ? { receiverPhone: r.parcel.receiverPhone, deliveryOtp: r.delivery_otp, sms: smsStatus(r.delivery_sms) } : {}),
        }
      : null,
    accessibility: r.accessibility ?? [],
    lockSaving: r.lock_saving ?? 0,
    // False when routing was down at booking: the trip then has no route to watch for deviations.
    routeWatched: !r.route_estimated,
    // No phone numbers: riders and drivers talk through in-app chat (step 6).
    rider: { id: r.rider_id, name: r.rider_name, avatar: r.rider_avatar },
    driver: r.driver_id
      ? {
          id: r.driver_id,
          name: r.driver_name,
          avatar: r.driver_avatar,
          rating: Math.round(r.driver_rating * 10) / 10,
          ratingCount: r.driver_rating_count,
          // The driver chose to tell riders they are deaf or hard of hearing.
          deaf: Boolean(r.driver_deaf),
          // From their real online sessions: driving since the last break, and "Well rested".
          drivingMin: drivers.get(r.driver_id)?.fatigue?.drivingMin ?? null,
          rested: Boolean(drivers.get(r.driver_id)?.fatigue?.rested),
          vehicle: { type: r.v_type, model: r.v_model, plate: r.v_plate },
        }
      : null,
    driverLocation: live && isLatLng(live) ? { lat: live.lat, lng: live.lng } : null,
    review: r.review_stars ? { stars: r.review_stars, comment: r.review_comment, tags: r.review_tags } : null,
    cancelledBy: r.cancelled_by,
    cancelReason: r.cancel_reason,
    createdAt: r.created_at,
    acceptedAt: r.accepted_at,
    arrivedAt: r.arrived_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    cancelledAt: r.cancelled_at,
  };
}

export function emitToUser(userId, event, payload) {
  io?.to(`user:${userId}`).emit(event, payload);
}

export function emitToAdmins(event, payload) {
  io?.to('admins').emit(event, payload);
}

function trackActive(r) {
  if (!r.driver_id) return;
  if (['accepted', 'arrived', 'ongoing'].includes(r.status)) {
    const prev = activeByDriver.get(r.driver_id);
    activeByDriver.set(r.driver_id, {
      rideId: r.id,
      riderId: r.rider_id,
      driverId: r.driver_id,
      status: r.status,
      // Planned road route, for route-deviation alerts (step 7).
      route: r.route,
      routeEstimated: r.route_estimated,
      stops: r.stops,
      kind: r.kind ?? 'trip',
      // Distance driven during a rental, from GPS (kept across updates of the same ride).
      km: prev?.rideId === r.id ? prev.km : Number(r.actual_km ?? 0),
      lastFix: prev?.rideId === r.id ? prev.lastFix : null,
      kmSavedAt: prev?.rideId === r.id ? prev.kmSavedAt : 0,
      pickup: r.pickup,
      dropoff: r.dropoff,
      // The routed trip's average speed, so live ETAs agree with the quoted duration.
      kmh: Math.min(60, Math.max(12, r.distance_km / (r.duration_min / 60))),
      arrivingSent: prev?.rideId === r.id ? prev.arrivingSent : false,
    });
  } else {
    activeByDriver.delete(r.driver_id);
  }
}

/** Sends each party its own view of the ride. */
export function broadcastRide(r) {
  trackActive(r);
  if (r.status !== 'requested') clearStationOffer(r.id);
  if (r.status === 'completed' || r.status === 'cancelled') {
    endDeviationWatch(r.id).catch((err) => console.warn('[hub] closing route alert failed', err.message));
  }
  emitToUser(r.rider_id, 'ride:update', serializeRide(r, r.rider_id));
  if (r.driver_id) emitToUser(r.driver_id, 'ride:update', serializeRide(r, r.driver_id));
}

export const driverPresence = (id) => drivers.get(id) ?? null;

/** Stops offering rides to a driver (e.g. their helmet selfie was rejected) and tells their app why. */
export function setDriverOffline(id, reason) {
  const p = drivers.get(id);
  if (p) p.online = false;
  endSession(id).catch(() => {});
  emitToUser(id, 'driver:forced-offline', { reason });
}

/** The driver's current speed from their GPS, or 0 when there is no fresh fix (stopped, or GPS quiet). */
export function driverSpeedKmh(id) {
  const p = drivers.get(id);
  if (!p?.fixAt || Date.now() - p.fixAt > 20_000) return 0;
  return p.speedKmh ?? 0;
}

export function onlineDrivers() {
  return [...drivers.entries()].filter(([, p]) => p.online).map(([id, p]) => ({ id, ...p }));
}

const busyDriverIds = async () => new Set((await many(`SELECT driver_id FROM rides WHERE status IN ('accepted','arrived','ongoing')`)).map((r) => r.driver_id));

/** Riders already waiting vs free drivers within 3 km of the pickup, per vehicle type. */
export async function surgeAt(point, type) {
  return (await surgeDetail(point, type)).multiplier;
}

/** The surge multiplier and the real counts behind it, shown to riders as "open surge". */
export async function surgeDetail(point, type) {
  const recent = await many(`SELECT pickup FROM rides WHERE status = 'requested' AND vehicle_type = $1 AND COALESCE(requested_at, created_at) > now() - interval '10 minutes'`, [type]);
  const waiting = recent.filter((r) => haversineKm(r.pickup, point) <= 3).length;
  const busy = await busyDriverIds();
  const freeDrivers = onlineDrivers().filter((d) => d.vehicleType === type && !busy.has(d.id) && isLatLng(d) && haversineKm(d, point) <= 3).length;
  return { multiplier: surgeFrom(waiting, freeDrivers), waiting, freeDrivers, radiusKm: 3 };
}

export function offerFor(r, presence) {
  const offer = serializeRide(r, null);
  offer.pickupDistanceKm = presence && isLatLng(presence) ? Math.round(haversineKm(presence, r.pickup) * 10) / 10 : null;
  return offer;
}

/**
 * Offers a fresh request. Pickups at a station go to the front of that station's driver
 * queue first; everything else (or an empty queue) goes to all nearby free drivers.
 */
export async function dispatchRide(r) {
  if (stationOffers.has(r.id)) return 1; // already working through the station queue
  if (!stationList.length) stationList = await stations();
  const st = stationAtSync(stationList, r.pickup);
  if (st) {
    const busy = await busyDriverIds();
    if (stationQueue(st.id, r.vehicle_type, busy, new Set(r.declined_by)).length) return offerToQueue(r, st);
  }
  return openDispatch(r);
}

/** Offers to every nearby, free, online driver of the right vehicle type (respecting "heading home"). */
async function openDispatch(r) {
  const declined = new Set(r.declined_by);
  const busy = await busyDriverIds();
  let offered = 0;
  for (const d of onlineDrivers()) {
    if (d.vehicleType !== r.vehicle_type || declined.has(d.id) || busy.has(d.id)) continue;
    if (isLatLng(d) && haversineKm(d, r.pickup) > config.dispatchRadiusKm) continue;
    if (d.headingHome && !towardHome(d, d.headingHome, r.dropoff)) continue;
    emitToUser(d.id, 'ride:offer', offerFor(r, d));
    offered++;
  }
  return offered;
}

// --- station queues -----------------------------------------------------------------------
// Free, online drivers inside a station area queue in the order they arrived. A pickup there
// is offered to the front of the queue for 45 s; ignored or declined, it moves to the next
// driver and the one who passed goes to the back. Kept in memory: after a restart drivers
// rejoin as their next GPS fix arrives.

const STATION_OFFER_MS = 45_000;
let stationList = [];
const stationOffers = new Map(); // rideId -> { stationId, tried: Set, current, timer }

function stationQueue(stationId, type, busy, declined) {
  return onlineDrivers()
    .filter((d) => d.station?.id === stationId && d.vehicleType === type && !busy.has(d.id) && !declined.has(d.id))
    .sort((a, b) => a.stationSince - b.stationSince);
}

function updateStation(presence, point) {
  const st = stationAtSync(stationList, point);
  if ((st?.id ?? null) !== (presence.station?.id ?? null)) {
    presence.station = st;
    presence.stationSince = st ? Date.now() : null;
  }
}

async function offerToQueue(r, st) {
  const state = stationOffers.get(r.id) ?? { stationId: st.id, tried: new Set(), current: null, timer: null };
  stationOffers.set(r.id, state);
  const busy = await busyDriverIds();
  const next = stationQueue(st.id, r.vehicle_type, busy, new Set(r.declined_by)).find(
    (d) => !state.tried.has(d.id) && (!d.headingHome || towardHome(d, d.headingHome, r.dropoff)),
  );
  if (!next) {
    // Everyone in the queue passed: offer it to all nearby drivers instead.
    stationOffers.delete(r.id);
    return openDispatch(r);
  }
  state.tried.add(next.id);
  state.current = next.id;
  emitToUser(next.id, 'ride:offer', { ...offerFor(r, next), station: { name: st.name, offerSeconds: STATION_OFFER_MS / 1000 } });
  clearTimeout(state.timer);
  state.timer = setTimeout(() => passOn(r.id, next.id).catch((err) => console.warn('[hub] station queue failed', err.message)), STATION_OFFER_MS);
  state.timer.unref?.();
  return 1;
}

/** The driver at the front let a station request go (timed out or declined): next in line, and they go to the back. */
export async function passOn(rideId, driverId) {
  const state = stationOffers.get(rideId);
  if (!state || state.current !== driverId) return;
  clearTimeout(state.timer);
  emitToUser(driverId, 'ride:withdrawn', { id: rideId });
  const p = drivers.get(driverId);
  if (p?.station) p.stationSince = Date.now();
  const r = await loadRide(rideId);
  if (!r || r.status !== 'requested') return stationOffers.delete(rideId);
  await offerToQueue(r, stationList.find((s) => s.id === state.stationId));
}

function clearStationOffer(rideId) {
  const s = stationOffers.get(rideId);
  if (s) {
    clearTimeout(s.timer);
    stationOffers.delete(rideId);
  }
}

/** The driver a station request is currently reserved for, if any. */
export const stationReservedFor = (rideId) => stationOffers.get(rideId)?.current ?? null;

/** Rider's view: their place among requests waiting at the same station, and drivers queued there. */
export async function stationPlace(r) {
  if (!stationList.length) stationList = await stations();
  const st = stationAtSync(stationList, r.pickup);
  if (!st || r.status !== 'requested') return null;
  const waiting = (await many(`SELECT id, pickup FROM rides WHERE status = 'requested' AND vehicle_type = $1 ORDER BY COALESCE(requested_at, created_at), id`, [r.vehicle_type])).filter(
    (w) => stationAtSync([st], w.pickup),
  );
  const busy = await busyDriverIds();
  return { station: st.name, place: waiting.findIndex((w) => w.id === r.id) + 1, waiting: waiting.length, driversQueued: stationQueue(st.id, r.vehicle_type, busy, new Set()).length };
}

/** Driver's view: their position in the queue of the station they are in. */
export async function driverQueueInfo(driverId) {
  const p = drivers.get(driverId);
  if (!p?.online || !p.station) return null;
  const busy = await busyDriverIds();
  const queue = stationQueue(p.station.id, p.vehicleType, busy, new Set());
  return { station: p.station.name, position: queue.findIndex((d) => d.id === driverId) + 1, total: queue.length };
}

/** "Heading home": only rides that bring the driver closer to `home` (null switches it off). */
export function setHeadingHome(driverId, home) {
  const p = drivers.get(driverId);
  if (p) p.headingHome = home;
}

/** Tells every other driver of that type the request is gone. */
export function withdrawOffer(r) {
  for (const [id, p] of drivers) {
    if (p.vehicleType === r.vehicle_type && id !== r.driver_id) emitToUser(id, 'ride:withdrawn', { id: r.id });
  }
}

async function activeFor(driverId) {
  if (activeByDriver.has(driverId)) return activeByDriver.get(driverId);
  // Cache miss (e.g. server restarted mid-ride): look it up once.
  const r = await one(`SELECT * FROM rides WHERE driver_id = $1 AND status IN ('accepted','arrived','ongoing')`, [driverId]);
  if (r) trackActive(r);
  return activeByDriver.get(driverId) ?? null;
}

async function relayLocation(driverId, point) {
  const a = await activeFor(driverId);
  if (!a) return;
  const target = a.status === 'ongoing' ? a.dropoff : a.pickup;
  const km = haversineKm(point, target);
  // Road-route time from where the driver is now (step 11). Without a routing answer: road
  // distance is ~1.35x straight-line in Indian cities, at the trip's planned average speed.
  const road = a.status === 'arrived' || (a.kind === 'rental' && a.status === 'ongoing') ? null : await roadEtaMin(a.rideId, a.status, point, target).catch(() => null);
  let etaMin = a.status === 'arrived' ? 0 : road ? road.min : Math.max(1, Math.round(((km * 1.35) / a.kmh) * 60));
  // During the trip, reported waterlogging still ahead on the route adds expected delay.
  const waterlogDelayMin = a.status === 'ongoing' ? (await delayOnRoute(a.route, point).catch(() => ({ delayMin: 0 }))).delayMin : 0;
  etaMin += waterlogDelayMin;
  emitToUser(a.riderId, 'ride:location', { rideId: a.rideId, lat: point.lat, lng: point.lng, etaMin, etaSource: road?.source ?? 'estimate', waterlogDelayMin, status: a.status });
  if (a.kind === 'rental' && a.status === 'ongoing') await measureRental(a, point);
  await checkDeviation(a, point);
  if (a.status === 'accepted' && km < 0.3 && !a.arrivingSent) {
    a.arrivingSent = true;
    await notifyIn(a.riderId, 'driverArriving', {}, '/book');
  }
}

/**
 * Adds up the distance of a rental from accurate GPS fixes. Impossible jumps (over 150 km/h)
 * are ignored. Saved every 30 s so a server restart does not lose it.
 */
async function measureRental(a, point) {
  if (Number.isFinite(point.accuracy) && point.accuracy > config.deviation.maxAccuracyM) return;
  const now = Date.now();
  if (a.lastFix) {
    const km = haversineKm(a.lastFix, point);
    const hours = (now - a.lastFix.at) / 3_600_000;
    if (hours > 0 && km / hours <= 150) a.km += km;
  }
  a.lastFix = { lat: point.lat, lng: point.lng, at: now };
  if (now - a.kmSavedAt > 30_000) {
    a.kmSavedAt = now;
    await query('UPDATE rides SET actual_km = $2 WHERE id = $1', [a.rideId, Math.round(a.km * 100) / 100]);
  }
}

/** The GPS distance measured for a ride in progress, or null if this server has not measured it. */
export function takeTripKm(rideId) {
  for (const a of activeByDriver.values()) if (a.rideId === rideId) return a.km;
  return null;
}

/**
 * About once a minute while online: keep the session alive, re-check fatigue (taking the
 * driver offline after their current trip once a break is due), and end "heading home" on arrival.
 */
async function driverHousekeeping(driverId, presence, point, now) {
  if (presence.headingHome && haversineKm(point, presence.headingHome) <= HOME.arrivedKm) {
    presence.headingHome = null;
    emitToUser(driverId, 'driver:home-reached', {});
    await notifyIn(driverId, 'homeReached', {}, '/drive');
  }
  if (now - (presence.touchedAt ?? 0) < 60_000) return;
  presence.touchedAt = now;
  await touchSession(driverId);
  presence.fatigue = await fatigue(driverId, now);
  if (presence.fatigue.needsBreak && !(await activeFor(driverId))) setDriverOffline(driverId, breakMessage(presence.fatigue));
}

export function initHub(socketServer) {
  io = socketServer;
  stations()
    .then((list) => (stationList = list))
    .catch((err) => console.warn('[hub] could not load stations', err.message));

  io.use(async (socket, next) => {
    const user = await userFromToken(socket.handshake.auth?.token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = { id: user.id, role: user.role, vehicleType: user.vehicle_type ?? null };
    next();
  });

  io.on('connection', (socket) => {
    const me = socket.data.user;
    socket.join(`user:${me.id}`);
    if (me.role === 'admin') socket.join('admins');
    if (me.role !== 'driver') return;

    const presence = drivers.get(me.id) ?? { sockets: new Set(), online: false };
    // Re-read on every connect so a vehicle change in the profile takes effect.
    presence.vehicleType = me.vehicleType;
    presence.sockets.add(socket.id);
    drivers.set(me.id, presence);

    socket.on('driver:online', async (point, ack) => {
      if (!presence.vehicleType) return ack?.({ ok: false, error: 'Add your vehicle in your profile first' });
      // Fresh from the database: the driver may have just verified their number.
      const blocked = await phoneCheck(await loadUser(me.id));
      if (blocked) return ack?.({ ok: false, error: blocked.message, code: blocked.code });
      // Only drivers whose documents are all approved and in date may drive.
      const verification = await driverVerification(me.id);
      if (!verification.canDrive) return ack?.({ ok: false, error: verification.message, code: 'DRIVER_NOT_VERIFIED' });
      // Bike drivers: a helmet selfie for today, not rejected.
      const helmet = await helmetStatus(me.id, presence.vehicleType);
      if (!helmet.canDrive) return ack?.({ ok: false, error: helmet.message, code: 'HELMET_SELFIE_REQUIRED' });
      // Fatigue: no going online until a 30-minute break after 10 hours of driving.
      const f = await fatigue(me.id);
      if (f.needsBreak) return ack?.({ ok: false, error: breakMessage(f), code: 'NEEDS_BREAK', breakUntil: f.breakUntil });
      await startSession(me.id);
      presence.fatigue = f;
      presence.touchedAt = Date.now();
      presence.online = true;
      if (isLatLng(point)) {
        Object.assign(presence, { lat: point.lat, lng: point.lng });
        if (!stationList.length) stationList = await stations();
        updateStation(presence, point);
      }
      ack?.({ ok: true });
    });

    socket.on('driver:offline', (_p, ack) => {
      presence.online = false;
      presence.station = null;
      presence.headingHome = null;
      endSession(me.id).catch(() => {});
      ack?.({ ok: true });
    });

    // The client throttles this to about once a second.
    socket.on('driver:location', (point) => {
      if (!isLatLng(point)) return;
      // Speed from the last two fixes, so the server can tell when the driver is moving.
      const now = Date.now();
      if (isLatLng(presence) && presence.fixAt && now - presence.fixAt >= 1000) {
        presence.speedKmh = (haversineKm(presence, point) / ((now - presence.fixAt) / 3_600_000)) || 0;
      }
      presence.fixAt = now;
      presence.lat = point.lat;
      presence.lng = point.lng;
      if (presence.online) {
        updateStation(presence, point);
        driverHousekeeping(me.id, presence, point, now).catch((err) => console.warn('[hub] driver check failed', err.message));
      }
      // GPS accuracy in metres, when the device reports it: poor fixes never raise route alerts.
      const accuracy = Number(point.accuracy);
      relayLocation(me.id, { lat: point.lat, lng: point.lng, accuracy: Number.isFinite(accuracy) ? accuracy : undefined }).catch((err) => console.warn('[hub] relay failed', err.message));
    });

    socket.on('disconnect', () => {
      presence.sockets.delete(socket.id);
      // Last tab closed: stop offering rides but keep the last known position.
      if (presence.sockets.size === 0) {
        if (presence.online) endSession(me.id).catch(() => {});
        presence.online = false;
        presence.station = null;
      }
    });
  });
}

/** Test hook. */
export function resetPresence() {
  drivers.clear();
  activeByDriver.clear();
  resetDeviationWatches();
  for (const id of [...stationOffers.keys()]) clearStationOffer(id);
}
