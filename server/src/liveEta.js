import { config } from './config.js';
import { haversineKm } from './geo.js';

/**
 * Live trip ETAs from a real road route (step 11). While a driver is heading to the pickup or the
 * drop, the remaining driving time is asked of a routing service at most every `refreshMs` per
 * ride, and only once the vehicle has moved, so the free OpenRouteService quota (2,000 a day)
 * lasts. Between refreshes the last answer is reused.
 *
 * Order: OpenRouteService (if ORS_API_KEY is set and quota is left) → the public OSRM server →
 * nothing (the caller falls back to its straight-line estimate). Neither service has live traffic.
 */

const MOVED_KM = 0.05;
const TIMEOUT_MS = 4000;
const cache = new Map(); // `${rideId}:${leg}` -> { min, at, from, source }
const inflight = new Map();

const status = { orsCalls: 0, osrmCalls: 0, failures: 0, orsRemaining: null, orsResetAt: null, lastError: null };

const orsUsable = () => Boolean(config.ors.key) && !(status.orsRemaining === 0 && status.orsResetAt && Date.now() < status.orsResetAt);

/** Which service live ETAs use now, and what is left of today's free quota. */
export function routingStatus() {
  return {
    provider: orsUsable() ? 'openrouteservice' : config.offlineGeo ? 'none' : 'osrm',
    orsConfigured: Boolean(config.ors.key),
    orsRemaining: status.orsRemaining,
    orsResetAt: status.orsResetAt ? new Date(status.orsResetAt).toISOString() : null,
    orsCalls: status.orsCalls,
    osrmCalls: status.osrmCalls,
    failures: status.failures,
    lastError: status.lastError,
  };
}

async function orsMinutes(from, to) {
  status.orsCalls++;
  const res = await fetch(`${config.ors.url}/v2/directions/driving-car`, {
    method: 'POST',
    headers: { authorization: config.ors.key, 'content-type': 'application/json', accept: 'application/json' },
    // ORS only looks 350 m for a road by default; drops inside airports, stations or campuses
    // are further than that from the nearest drivable road, so allow up to 2 km.
    body: JSON.stringify({ coordinates: [[from.lng, from.lat], [to.lng, to.lat]], radiuses: [2000, 2000], instructions: false, geometry: false }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // ORS reports the plan's remaining quota on every answer.
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (remaining !== null) status.orsRemaining = Number(remaining);
  if (reset) status.orsResetAt = Number(reset) * 1000;
  if (res.status === 429) {
    status.orsRemaining = 0;
    status.orsResetAt ??= Date.now() + 3600_000;
    throw new Error('OpenRouteService quota used up');
  }
  if (!res.ok) throw new Error(`OpenRouteService answered ${res.status}`);
  const data = await res.json();
  const seconds = data.routes?.[0]?.summary?.duration;
  if (!Number.isFinite(seconds)) throw new Error('OpenRouteService returned no route');
  return seconds / 60;
}

async function osrmMinutes(from, to) {
  status.osrmCalls++;
  const coords = `${from.lng.toFixed(6)},${from.lat.toFixed(6)};${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
  const res = await fetch(`${config.osrmUrl}/route/v1/driving/${coords}?overview=false`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OSRM answered ${res.status}`);
  const seconds = (await res.json()).routes?.[0]?.duration;
  if (!Number.isFinite(seconds)) throw new Error('OSRM returned no route');
  return seconds / 60;
}

async function fetchMinutes(from, to) {
  if (orsUsable()) {
    try {
      return { min: await orsMinutes(from, to), source: 'openrouteservice' };
    } catch (err) {
      status.failures++;
      status.lastError = err.message;
    }
  }
  if (!config.offlineGeo) {
    try {
      return { min: await osrmMinutes(from, to), source: 'osrm' };
    } catch (err) {
      status.failures++;
      status.lastError = err.message;
    }
  }
  return null;
}

/**
 * Remaining driving minutes from `from` to `to` for this ride leg, or null when no routing
 * service answered (use the straight-line estimate then).
 */
export async function roadEtaMin(rideId, leg, from, to) {
  const key = `${rideId}:${leg}`;
  const c = cache.get(key);
  const fresh = c && (Date.now() - c.at < config.ors.refreshMs || haversineKm(from, c.from) < MOVED_KM);
  // A failed lookup is remembered too, so a routing outage doesn't slow every GPS update.
  const usable = (entry) => (entry && entry.min !== null ? entry : null);
  if (fresh) return usable(c);
  // A refresh is due. The location update should not wait for it, so the last answer is
  // used meanwhile; only the very first ETA of a leg waits for the routing service.
  if (c) {
    if (!inflight.has(key)) refresh(key, from, to).catch(() => {});
    return usable(c);
  }
  return usable(await refresh(key, from, to));
}

function refresh(key, from, to) {
  if (!inflight.has(key)) {
    inflight.set(
      key,
      fetchMinutes(from, to)
        .then((r) => {
          if (cache.size > 2000) cache.clear();
          const entry = r ? { min: Math.max(1, Math.round(r.min)), at: Date.now(), from, source: r.source } : { min: null, at: Date.now(), from, source: null };
          // After a failure the caller uses its moving straight-line estimate until the next try,
          // rather than an old road answer that would no longer count down.
          cache.set(key, entry);
          return entry;
        })
        .finally(() => inflight.delete(key)),
    );
  }
  return inflight.get(key);
}

export function resetLiveEta() {
  cache.clear();
  inflight.clear();
  Object.assign(status, { orsCalls: 0, osrmCalls: 0, failures: 0, orsRemaining: null, orsResetAt: null, lastError: null });
}
