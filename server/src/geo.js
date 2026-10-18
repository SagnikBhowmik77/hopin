import { config } from './config.js';

const UA = 'Hopin/0.2 (ride-booking app; local dev)';

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function isLatLng(p) {
  return Boolean(p) && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

const round1 = (n) => Math.round(n * 10) / 10;

// City driving rule of thumb for when OSRM is unreachable: roads are ~1.35x crow-fly, ~22 km/h.
export function estimateMinutes(km) {
  return Math.max(1, Math.round((km / 22) * 60));
}

function estimateRoute(points) {
  let km = 0;
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1], points[i]) * 1.35;
  return { distanceKm: round1(km), durationMin: estimateMinutes(km), geometry: points.map((p) => [p.lat, p.lng]), estimated: true };
}

async function getJson(url, timeoutMs = 6000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

const routeCache = new Map();

/** Driving route through all points in order (pickup, stops..., drop). Geometry is [lat, lng][]. */
export async function getRoute(points) {
  if (config.offlineGeo) return estimateRoute(points);
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  if (routeCache.has(coords)) return routeCache.get(coords);
  try {
    const data = await getJson(`${config.osrmUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson`);
    const r = data.routes?.[0];
    if (!r) throw new Error(data.code || 'no route');
    const route = {
      distanceKm: round1(r.distance / 1000),
      durationMin: Math.max(1, Math.round(r.duration / 60)),
      geometry: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      estimated: false,
    };
    if (routeCache.size > 500) routeCache.clear();
    routeCache.set(coords, route);
    return route;
  } catch (err) {
    console.warn(`[geo] OSRM failed (${err.message}); using straight-line estimate`);
    return estimateRoute(points);
  }
}

function photonLabel(props) {
  const street = props.housenumber && props.street ? `${props.housenumber} ${props.street}` : props.street;
  const parts = [props.name, street, props.district || props.locality, props.city, props.state];
  return [...new Set(parts.filter(Boolean))].join(', ');
}

const fromPhoton = (features) =>
  features.map((f) => ({ label: photonLabel(f.properties), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));

// --- Nominatim fallback ------------------------------------------------------
// Used when Photon is unreachable. Its usage policy allows at most one request
// per second with an identifying User-Agent, so calls are serialised and cached.
let nominatimQueue = Promise.resolve();
let lastNominatim = 0;
const geoCache = new Map();

function nominatim(path) {
  if (geoCache.has(path)) return Promise.resolve(geoCache.get(path));
  const run = nominatimQueue.then(async () => {
    const wait = lastNominatim + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatim = Date.now();
    const data = await getJson(`${config.nominatimUrl}${path}`);
    if (geoCache.size > 1000) geoCache.clear();
    geoCache.set(path, data);
    return data;
  });
  nominatimQueue = run.catch(() => {});
  return run;
}

const nominatimLabel = (r) => {
  const a = r.address ?? {};
  const head = r.name || [a.house_number, a.road].filter(Boolean).join(' ');
  const parts = [head, a.road, a.suburb || a.neighbourhood, a.city || a.town || a.village || a.county, a.state];
  const label = [...new Set(parts.filter(Boolean))].join(', ');
  return label || r.display_name.split(', ').slice(0, 4).join(', ');
};

// After a Photon failure, skip it for a while instead of making every keystroke wait for a timeout.
let photonDownUntil = 0;
const photonUp = () => Date.now() > photonDownUntil;
const photonFailed = (err) => {
  photonDownUntil = Date.now() + 5 * 60_000;
  console.warn(`[geo] Photon unavailable (${err.message}); using Nominatim for 5 min`);
};

/** Place autocomplete: Photon (built for search-as-you-type), falling back to Nominatim. */
export async function searchPlaces(q, near) {
  if (config.offlineGeo) return [];
  if (photonUp()) {
    const params = new URLSearchParams({ q, limit: '6', lang: 'en' });
    if (isLatLng(near)) {
      params.set('lat', String(near.lat));
      params.set('lon', String(near.lng));
    }
    try {
      const data = await getJson(`${config.photonUrl}/api/?${params}`, 3000);
      return fromPhoton(data.features || []).filter((p) => p.label);
    } catch (err) {
      photonFailed(err);
    }
  }
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '6', addressdetails: '1', 'accept-language': 'en' });
  if (isLatLng(near)) {
    // Prefer (not restrict to) results within ~50 km.
    params.set('viewbox', [near.lng - 0.5, near.lat + 0.5, near.lng + 0.5, near.lat - 0.5].map((n) => n.toFixed(4)).join(','));
  }
  const rows = await nominatim(`/search?${params}`);
  return rows.map((r) => ({ label: nominatimLabel(r), lat: Number(r.lat), lng: Number(r.lon) }));
}

export async function reverseGeocode(point) {
  const fallback = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  if (config.offlineGeo) return fallback;
  if (photonUp()) {
    try {
      const data = await getJson(`${config.photonUrl}/reverse?lat=${point.lat}&lon=${point.lng}&lang=en`, 3000);
      const label = fromPhoton(data.features || [])[0]?.label;
      if (label) return label;
    } catch (err) {
      photonFailed(err);
    }
  }
  try {
    const r = await nominatim(`/reverse?lat=${point.lat.toFixed(5)}&lon=${point.lng.toFixed(5)}&format=jsonv2&addressdetails=1&accept-language=en`);
    return r?.display_name ? nominatimLabel(r) : fallback;
  } catch {
    return fallback;
  }
}
