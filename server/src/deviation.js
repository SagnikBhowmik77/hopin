import { config } from './config.js';
import { many, one, query, isUniqueViolation } from './db.js';
import { haversineKm } from './geo.js';
import { emitToAdmins, emitToUser } from './hub.js';
import { notifyIn } from './messages.js';

/**
 * Trip safety alerts, raised from the driver's GPS during a trip (status 'ongoing'):
 *
 * - off_route: further than config.deviation.meters from the planned road route for
 *   config.deviation.seconds; closes when back within backMeters.
 * - long_stop: within config.longStop.radiusM of one spot for config.longStop.minutes,
 *   away from the drop and any planned stop; closes when the vehicle moves on.
 *
 * Each alert is stored, and rider, driver and admins are told live. The rider can answer
 * "I'm OK", which closes it until the situation changes. Every alert also closes when the
 * trip ends. Not checked: the drive to the pickup, straight-line routes (routing was down
 * at booking) and inaccurate GPS fixes.
 */

const EARTH_M = 6371000;
const rad = (deg) => (deg * Math.PI) / 180;

/** Metres from a point to the nearest part of a [lat, lng][] polyline. */
export function distanceToRouteM(p, line) {
  if (!Array.isArray(line) || line.length === 0) return null;
  // Flat projection centred on the point: accurate to well under 1% at city scale.
  const k = Math.cos(rad(p.lat));
  const xy = ([lat, lng]) => [rad(lng - p.lng) * EARTH_M * k, rad(lat - p.lat) * EARTH_M];
  let [ax, ay] = xy(line[0]);
  let best = Math.hypot(ax, ay);
  for (let i = 1; i < line.length; i++) {
    const [bx, by] = xy(line[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    ax = bx;
    ay = by;
  }
  return best;
}

const metresBetween = (a, b) => haversineKm(a, b) * 1000;

// Alert timers must never keep the process alive on their own (clean shutdown, tests).
const later = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
};

export const toDeviation = (d) =>
  d && {
    id: d.id,
    rideId: d.ride_id,
    kind: d.kind ?? 'off_route',
    status: d.resolved_at ? 'resolved' : 'open',
    distanceM: d.distance_m,
    maxDistanceM: d.max_distance_m,
    location: { lat: d.lat, lng: d.lng },
    startedAt: d.started_at,
    alertedAt: d.alerted_at,
    resolvedAt: d.resolved_at,
    resolution: d.resolution,
    checkedAt: d.checked_at,
  };

/** The ride's open alerts (at most one of each kind). */
export const openAlerts = async (rideId) =>
  (await many('SELECT * FROM route_deviations WHERE ride_id = $1 AND resolved_at IS NULL ORDER BY alerted_at', [rideId])).map(toDeviation);

// rideId -> { busy, off: {...}, stop: {...} }. Rebuilt from the database after a restart.
//   off:  { offSince, last, timer, open: { id, maxM } | null, quiet }
//   stop: { anchor, anchorAt, timer, open: { id } | null, quiet }
// `quiet` is set when the rider answered "I'm OK"; no new alert of that kind until the situation changes.
const watches = new Map();

async function watchFor(rideId) {
  let w = watches.get(rideId);
  if (!w) {
    const open = await many('SELECT id, kind, max_distance_m FROM route_deviations WHERE ride_id = $1 AND resolved_at IS NULL', [rideId]);
    const find = (kind) => open.find((d) => d.kind === kind);
    w = {
      busy: false,
      off: { offSince: null, last: null, timer: null, quiet: false, open: find('off_route') ? { id: find('off_route').id, maxM: find('off_route').max_distance_m } : null },
      stop: { anchor: null, anchorAt: null, timer: null, quiet: false, open: find('long_stop') ? { id: find('long_stop').id } : null },
    };
    watches.set(rideId, w);
  }
  return w;
}

function tell(d) {
  const view = toDeviation(d);
  emitToUser(d.rider_id, 'ride:deviation', view);
  emitToUser(d.driver_id, 'ride:deviation', view);
  emitToAdmins('deviation', view);
}

const kmText = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

async function raise(a, kind, state, point, metres, startedAt) {
  const m = Math.round(metres);
  let d;
  try {
    d = await one(
      `INSERT INTO route_deviations (ride_id, driver_id, rider_id, kind, started_at, lat, lng, distance_m, max_distance_m)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
      [a.rideId, a.driverId, a.riderId, kind, new Date(startedAt), point.lat, point.lng, m],
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return; // already raised
  }
  state.open = { id: d.id, maxM: m };
  tell(d);
  await notifyIn(a.riderId, kind === 'off_route' ? 'offRoute' : 'longStop', { distance: kmText(m), minutes: config.longStop.minutes }, '/book');
}

async function resolve(rideId, kind, resolution) {
  const rows = await many(
    `UPDATE route_deviations SET resolved_at = now(), resolution = $3
     WHERE ride_id = $1 AND resolved_at IS NULL AND ($2::text IS NULL OR kind = $2::text) RETURNING *`,
    [rideId, kind, resolution],
  );
  const w = watches.get(rideId);
  for (const d of rows) {
    if (w) w[d.kind === 'long_stop' ? 'stop' : 'off'].open = null;
    tell(d);
    if (resolution === 'back_on_route') await notifyIn(d.rider_id, 'backOnRoute', {}, '/book');
  }
}

function stopTimer(s) {
  clearTimeout(s.timer);
  s.timer = null;
}

/** Runs `fn` for the ride unless another check for it is in progress (GPS fixes: skip one). */
async function exclusive(w, fn) {
  if (w.busy) return;
  w.busy = true;
  try {
    await fn();
  } finally {
    w.busy = false;
  }
}

/** For timers: never skip, wait until the ride's current check is done. */
function whenFree(w, fn, label) {
  if (w.busy) return later(() => whenFree(w, fn, label), 250);
  exclusive(w, fn).catch((err) => console.warn(`[alerts] ${label} failed`, err.message));
}

// --- off route -------------------------------------------------------------------

async function checkOffRoute(a, w, point, now) {
  const cfg = config.deviation;
  const s = w.off;
  const metres = distanceToRouteM(point, a.route);
  if (metres == null) return;
  if (metres > cfg.meters) {
    s.offSince ??= now;
    s.last = { point, metres };
    if (s.open) {
      if (metres > s.open.maxM) {
        s.open.maxM = Math.round(metres);
        await query('UPDATE route_deviations SET max_distance_m = $2 WHERE id = $1', [s.open.id, s.open.maxM]);
      }
    } else if (!s.quiet && now - s.offSince >= cfg.seconds * 1000) {
      stopTimer(s);
      await raise(a, 'off_route', s, point, metres, s.offSince);
    } else if (!s.quiet && !s.timer) {
      // Phones often stop sending fixes while standing still, so do not wait for the
      // next one: raise the alert on time from the last known position.
      s.timer = later(() => {
        s.timer = null;
        whenFree(
          w,
          async () => {
            if (s.open || s.quiet || s.offSince == null || !s.last) return;
            await raise(a, 'off_route', s, s.last.point, s.last.metres, s.offSince);
          },
          'off-route alert',
        );
      }, s.offSince + cfg.seconds * 1000 - now);
    }
  } else if (metres <= cfg.backMeters) {
    s.offSince = null;
    s.quiet = false;
    stopTimer(s);
    if (s.open) await resolve(a.rideId, 'off_route', 'back_on_route');
  } else if (!s.open) {
    // Between the two thresholds and no alert yet: the clock starts again next time.
    s.offSince = null;
    stopTimer(s);
  }
}

// --- long stop -------------------------------------------------------------------

/** True near the pickup, a planned stop or the drop, where waiting is expected. */
function atPlannedPlace(a, point) {
  return [a.pickup, ...(a.stops ?? []), a.dropoff].some((p) => p && metresBetween(p, point) <= config.longStop.plannedPlaceM);
}

async function checkLongStop(a, w, point, now) {
  const cfg = config.longStop;
  const s = w.stop;
  if (s.anchor && metresBetween(s.anchor, point) <= cfg.radiusM) return; // still standing; the timer is running

  // Moved on (or first fix of the trip): start watching from here.
  s.anchor = { lat: point.lat, lng: point.lng };
  s.anchorAt = now;
  s.quiet = false;
  stopTimer(s);
  if (s.open) await resolve(a.rideId, 'long_stop', 'moving_again');
  const anchor = s.anchor;
  s.timer = later(() => {
    s.timer = null;
    whenFree(
      w,
      async () => {
        if (s.anchor !== anchor || s.open || s.quiet || atPlannedPlace(a, anchor)) return;
        await raise(a, 'long_stop', s, anchor, distanceToRouteM(anchor, a.route) ?? 0, s.anchorAt);
      },
      'long-stop alert',
    );
  }, cfg.minutes * 60_000);
}

/**
 * Called with every GPS fix of a driver who has a ride in progress.
 * `a` is the hub's active-ride entry: { rideId, riderId, driverId, status, route, routeEstimated, stops, dropoff }.
 */
export async function checkDeviation(a, point, now = Date.now()) {
  if (a.status !== 'ongoing') return;
  if (Number.isFinite(point.accuracy) && point.accuracy > config.deviation.maxAccuracyM) return;
  const w = await watchFor(a.rideId);
  await exclusive(w, async () => {
    // On a rental the rider stops wherever they like, so long stops are expected.
    if (a.kind !== 'rental') await checkLongStop(a, w, point, now);
    if (!a.routeEstimated) await checkOffRoute(a, w, point, now);
  });
}

/** The rider says they are fine: close the alert and stay quiet until things change. */
export async function riderOk(rideId, alertId) {
  const d = await one('SELECT kind FROM route_deviations WHERE id = $1 AND ride_id = $2 AND resolved_at IS NULL', [alertId, rideId]).catch(() => null);
  if (!d) return false;
  const w = await watchFor(rideId);
  w[d.kind === 'long_stop' ? 'stop' : 'off'].quiet = true;
  await resolve(rideId, d.kind, 'rider_ok');
  return true;
}

/** The trip is over (completed or cancelled): close any open alert and forget the ride. */
export async function endDeviationWatch(rideId) {
  const w = watches.get(rideId);
  if (w) {
    stopTimer(w.off);
    stopTimer(w.stop);
  }
  await resolve(rideId, null, 'trip_ended');
  watches.delete(rideId);
}

/** Test hook. */
export function resetDeviationWatches() {
  for (const w of watches.values()) {
    stopTimer(w.off);
    stopTimer(w.stop);
  }
  watches.clear();
}
