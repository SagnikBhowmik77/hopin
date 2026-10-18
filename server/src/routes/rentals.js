import { Router } from 'express';
import { HttpError, requireAuth, requireRole } from '../auth.js';
import { many, one } from '../db.js';
import { isLatLng } from '../geo.js';
import { allPackages, bookablePackages, toPackage } from '../booking.js';

/** Hourly rental packages (incl. seasonal Puja packages) and admin-entered road closures. */

const router = Router();
router.use(requireAuth);

router.get('/packages', async (_req, res) => {
  res.json({ packages: await bookablePackages() });
});

const toClosure = (c) => ({
  id: c.id,
  title: c.title,
  note: c.note,
  source: c.source,
  lat: c.lat,
  lng: c.lng,
  radiusM: c.radius_m,
  startsAt: c.starts_at,
  endsAt: c.ends_at,
});

/** Closures in force now or starting within the next day, for the map. */
router.get('/closures', async (_req, res) => {
  const rows = await many(`SELECT * FROM road_closures WHERE ends_at > now() AND starts_at < now() + interval '1 day' ORDER BY starts_at`);
  res.json({ closures: rows.map(toClosure) });
});

// --- admin -------------------------------------------------------------------------------

router.get('/admin/packages', requireRole('admin'), async (_req, res) => {
  res.json({ packages: await allPackages() });
});

function cleanPackage(b) {
  const name = String(b?.name ?? '').trim().slice(0, 60);
  if (name.length < 3) throw new HttpError(400, 'Give the package a name');
  if (!['auto', 'car'].includes(b?.vehicleType)) throw new HttpError(400, 'Rentals are for Auto or Cab');
  const int = (v, lo, hi, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${what} must be ${lo}–${hi}`);
    return n;
  };
  const rate = (v, what) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new HttpError(400, `${what} must be ₹0–100`);
    return Math.round(n * 100) / 100;
  };
  const seasonal = b?.seasonal === true;
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? v : null);
  const from = seasonal ? date(b.availableFrom) : null;
  const to = seasonal ? date(b.availableTo) : null;
  if (seasonal && (!from || !to || from > to)) throw new HttpError(400, 'A seasonal package needs a start and end date');
  return {
    name,
    vehicleType: b.vehicleType,
    hours: int(b.hours, 1, 12, 'Hours'),
    km: int(b.km, 1, 300, 'Kilometres'),
    price: int(b.price, 1, 20_000, 'Price'),
    extraKmRate: rate(b.extraKmRate, 'Extra km rate'),
    extraMinRate: rate(b.extraMinRate, 'Extra minute rate'),
    seasonal,
    from,
    to,
  };
}

router.post('/admin/packages', requireRole('admin'), async (req, res) => {
  const p = cleanPackage(req.body);
  const row = await one(
    `INSERT INTO rental_packages (name, vehicle_type, hours, km, price, extra_km_rate, extra_min_rate, seasonal, available_from, available_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *, to_char(available_from, 'YYYY-MM-DD') AS available_from, to_char(available_to, 'YYYY-MM-DD') AS available_to`,
    [p.name, p.vehicleType, p.hours, p.km, p.price, p.extraKmRate, p.extraMinRate, p.seasonal, p.from, p.to],
  );
  res.status(201).json({ package: toPackage(row) });
});

/** Switch a package on or off (bookings already made keep the price they were booked at). */
router.post('/admin/packages/:id/active', requireRole('admin'), async (req, res) => {
  const row = await one(
    `UPDATE rental_packages SET active = $2 WHERE id = $1 RETURNING *, to_char(available_from, 'YYYY-MM-DD') AS available_from, to_char(available_to, 'YYYY-MM-DD') AS available_to`,
    [req.params.id, req.body?.active === true],
  ).catch(() => null);
  if (!row) throw new HttpError(404, 'Package not found');
  res.json({ package: toPackage(row) });
});

router.get('/admin/closures', requireRole('admin'), async (_req, res) => {
  const rows = await many(`SELECT * FROM road_closures WHERE ends_at > now() - interval '7 days' ORDER BY starts_at DESC`);
  res.json({ closures: rows.map(toClosure) });
});

router.post('/admin/closures', requireRole('admin'), async (req, res) => {
  const b = req.body ?? {};
  const title = String(b.title ?? '').trim().slice(0, 100);
  const source = String(b.source ?? '').trim().slice(0, 200);
  const note = String(b.note ?? '').trim().slice(0, 300) || null;
  if (title.length < 3) throw new HttpError(400, 'Name the closure, e.g. "Park Street no-entry"');
  // Closures must come from a real notice, so record where the information came from.
  if (source.length < 3) throw new HttpError(400, 'Say where this comes from, e.g. the Kolkata Traffic Police notice');
  const point = { lat: Number(b.lat), lng: Number(b.lng) };
  if (!isLatLng(point)) throw new HttpError(400, 'Choose the place on the map');
  const radius = Number(b.radiusM);
  if (!Number.isInteger(radius) || radius < 50 || radius > 5000) throw new HttpError(400, 'Radius must be 50–5000 m');
  const starts = new Date(b.startsAt);
  const ends = new Date(b.endsAt);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) throw new HttpError(400, 'Give a start and an end time');
  const row = await one(
    `INSERT INTO road_closures (title, note, source, lat, lng, radius_m, starts_at, ends_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [title, note, source, point.lat, point.lng, radius, starts, ends, req.user.id],
  );
  res.status(201).json({ closure: toClosure(row) });
});

router.delete('/admin/closures/:id', requireRole('admin'), async (req, res) => {
  const row = await one('DELETE FROM road_closures WHERE id = $1 RETURNING id', [req.params.id]).catch(() => null);
  if (!row) throw new HttpError(404, 'Closure not found');
  res.json({ ok: true });
});

export default router;
