import { many, one, tx } from './db.js';
import { HttpError } from './auth.js';
import { haversineKm, isLatLng } from './geo.js';

/**
 * Monsoon waterlogging (step 8b, batch G). Riders and drivers report flooded spots from their
 * phone's GPS; people nearby confirm or clear them. Spots on a trip's route add expected delay to
 * its ETA. They never change the fare, and Hopin cannot route around them: the public routing
 * server has no way to avoid a street, so the driver decides on the spot.
 *
 * There is no free live waterlogging feed for Kolkata, so this is crowd-reported only.
 */

export const SEVERITY = {
  ankle: { label: 'Ankle deep', delayMin: 2 },
  knee: { label: 'Knee deep', delayMin: 6 },
  impassable: { label: 'Not passable', delayMin: 15 },
};
const RANK = { ankle: 1, knee: 2, impassable: 3 };
const deeper = (a, b) => (RANK[a] >= RANK[b] ? a : b);

export const WATERLOG = {
  hours: 6, // a report lives this long after its last "still flooded"
  mergeM: 150, // a new report this close to an active one confirms it instead
  routeM: 80, // a spot this close to the route counts as on it
  maxAccuracyM: 200, // GPS fixes worse than this cannot report or vote
  voteWithinKm: 1, // you must be this close to confirm or clear a spot
  clearVotes: 2, // distinct people saying "cleared" close a spot (the reporter alone is enough)
  perDay: 10, // new reports per person per day
  maxDelayMin: 40,
};

export const toSpot = (r) => ({
  id: r.id,
  lat: r.lat,
  lng: r.lng,
  severity: r.severity,
  label: SEVERITY[r.severity].label,
  note: r.note,
  status: r.status,
  reportedAt: r.created_at,
  lastConfirmedAt: r.last_confirmed_at,
  expiresAt: r.expires_at,
  confirmations: r.confirmations ?? 0,
  clearedVotes: r.cleared_votes ?? 0,
});

const SPOT_SQL = `
  SELECT w.*,
    (SELECT count(*)::int FROM waterlog_votes v WHERE v.report_id = w.id AND v.vote = 'still') AS confirmations,
    (SELECT count(*)::int FROM waterlog_votes v WHERE v.report_id = w.id AND v.vote = 'cleared') AS cleared_votes
  FROM waterlog_reports w`;

// Active spots are read on every live location update, so keep them in memory briefly.
let cache = { at: 0, spots: [] };
const CACHE_MS = 30_000;
export const forgetSpots = () => (cache = { at: 0, spots: [] });

export async function activeSpots() {
  if (Date.now() - cache.at < CACHE_MS) return cache.spots;
  const rows = await many(`${SPOT_SQL} WHERE w.status = 'active' AND w.expires_at > now() ORDER BY w.created_at DESC LIMIT 500`);
  cache = { at: Date.now(), spots: rows.map(toSpot) };
  return cache.spots;
}

function cleanFix(body) {
  const point = { lat: Number(body?.lat), lng: Number(body?.lng) };
  if (!isLatLng(point)) throw new HttpError(400, 'Your location is needed. Allow location access and try again.');
  const accuracy = Number(body?.accuracy);
  if (!Number.isFinite(accuracy) || accuracy > WATERLOG.maxAccuracyM) {
    throw new HttpError(400, `Your GPS is not precise enough right now (needs ${WATERLOG.maxAccuracyM} m or better). Step outside or wait a moment.`);
  }
  return point;
}

/** New report, or a confirmation of the active spot already within mergeM. */
export async function reportSpot(user, body) {
  const point = cleanFix(body);
  const severity = String(body?.severity ?? '');
  if (!SEVERITY[severity]) throw new HttpError(400, 'Choose how deep the water is');
  const note = String(body?.note ?? '').trim().slice(0, 200) || null;

  const near = (await many(`SELECT * FROM waterlog_reports WHERE status = 'active' AND expires_at > now()`))
    .map((r) => ({ r, m: haversineKm(point, r) * 1000 }))
    .filter((x) => x.m <= WATERLOG.mergeM)
    .sort((a, b) => a.m - b.m)[0];
  if (near) {
    await vote(user, near.r.id, { ...body, vote: 'still', severity });
    return { spot: await spotById(near.r.id), merged: true };
  }

  const today = await one(`SELECT count(*)::int AS n FROM waterlog_reports WHERE reported_by = $1 AND created_at > now() - interval '1 day'`, [user.id]);
  if (today.n >= WATERLOG.perDay) throw new HttpError(429, `You can add up to ${WATERLOG.perDay} new spots a day`);
  const row = await one(
    `INSERT INTO waterlog_reports (lat, lng, severity, note, reported_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + $6 * interval '1 hour') RETURNING id`,
    [point.lat, point.lng, severity, note, user.id, WATERLOG.hours],
  );
  forgetSpots();
  return { spot: await spotById(row.id), merged: false };
}

export async function spotById(id) {
  const r = await one(`${SPOT_SQL} WHERE w.id = $1`, [id]);
  return r && toSpot(r);
}

/** "Still flooded" (keeps it alive, may raise the depth) or "cleared". One vote per person per spot. */
export async function vote(user, reportId, body) {
  const point = cleanFix(body);
  const choice = body?.vote === 'cleared' ? 'cleared' : body?.vote === 'still' ? 'still' : null;
  if (!choice) throw new HttpError(400, 'Say whether it is still flooded or cleared');
  const severity = choice === 'still' && SEVERITY[body?.severity] ? body.severity : null;

  await tx(async ({ query: q }) => {
    const r = (await q(`SELECT * FROM waterlog_reports WHERE id = $1 FOR UPDATE`, [reportId])).rows[0];
    if (!r) throw new HttpError(404, 'Spot not found');
    if (r.status !== 'active' || new Date(r.expires_at) <= new Date()) throw new HttpError(409, 'This spot is no longer active');
    if (haversineKm(point, r) > WATERLOG.voteWithinKm) throw new HttpError(403, `You need to be within ${WATERLOG.voteWithinKm} km of the spot to update it`);
    await q(
      `INSERT INTO waterlog_votes (report_id, user_id, vote, severity) VALUES ($1, $2, $3, $4)
       ON CONFLICT (report_id, user_id) DO UPDATE SET vote = $3, severity = $4, created_at = now()`,
      [reportId, user.id, choice, severity],
    );
    if (choice === 'still') {
      await q(
        `UPDATE waterlog_reports SET last_confirmed_at = now(), expires_at = now() + $2 * interval '1 hour', severity = $3 WHERE id = $1`,
        [reportId, WATERLOG.hours, severity ? deeper(severity, r.severity) : r.severity],
      );
      return;
    }
    const cleared = (await q(`SELECT count(*)::int AS n FROM waterlog_votes WHERE report_id = $1 AND vote = 'cleared'`, [reportId])).rows[0].n;
    if (r.reported_by === user.id || cleared >= WATERLOG.clearVotes) {
      await q(`UPDATE waterlog_reports SET status = 'cleared', closed_at = now(), closed_by = $2 WHERE id = $1`, [reportId, user.id]);
    }
  });
  forgetSpots();
  return spotById(reportId);
}

export async function removeSpot(adminId, reportId) {
  const r = await one(`UPDATE waterlog_reports SET status = 'removed', closed_at = now(), closed_by = $2 WHERE id = $1 AND status = 'active' RETURNING id`, [
    reportId,
    adminId,
  ]);
  if (!r) throw new HttpError(404, 'No active spot with that id');
  forgetSpots();
}

export async function recentSpots() {
  return (await many(`${SPOT_SQL} WHERE w.created_at > now() - interval '3 days' ORDER BY w.created_at DESC LIMIT 200`)).map(toSpot);
}

export async function expireSpots() {
  const rows = await many(`UPDATE waterlog_reports SET status = 'expired', closed_at = now() WHERE status = 'active' AND expires_at <= now() RETURNING id`);
  if (rows.length) forgetSpots();
  return rows.length;
}

// --- spots on a route ----------------------------------------------------------------

const EARTH_M = 6371000;
const rad = (deg) => (deg * Math.PI) / 180;

/** Distance from a point to a [lat, lng][] polyline, and how far along it (in segments) the nearest part is. */
function nearestOnLine(p, line) {
  const k = Math.cos(rad(p.lat));
  const xy = ([lat, lng]) => [rad(lng - p.lng) * EARTH_M * k, rad(lat - p.lat) * EARTH_M];
  let [ax, ay] = xy(line[0]);
  let best = { m: Math.hypot(ax, ay), at: 0 };
  for (let i = 1; i < line.length; i++) {
    const [bx, by] = xy(line[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const m = Math.hypot(ax + t * dx, ay + t * dy);
    if (m < best.m) best = { m, at: i - 1 + t };
    ax = bx;
    ay = by;
  }
  return best;
}

/**
 * Active spots along a route and the extra minutes they are expected to add. With `from`
 * (the vehicle's position), only spots still ahead of it count.
 */
export async function delayOnRoute(line, from = null) {
  if (!Array.isArray(line) || line.length < 2) return { spots: [], delayMin: 0, impassable: false };
  const start = from ? nearestOnLine(from, line).at : -1;
  const spots = (await activeSpots()).filter((s) => {
    const n = nearestOnLine(s, line);
    return n.m <= WATERLOG.routeM && n.at > start;
  });
  const delayMin = Math.min(WATERLOG.maxDelayMin, spots.reduce((sum, s) => sum + SEVERITY[s.severity].delayMin, 0));
  return { spots, delayMin, impassable: spots.some((s) => s.severity === 'impassable') };
}
