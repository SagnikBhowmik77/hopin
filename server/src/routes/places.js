import { Router } from 'express';
import { HttpError, requireAuth } from '../auth.js';
import { many, one } from '../db.js';
import { isLatLng } from '../geo.js';

/** Saved places (Home, Work and the user's own) for one-tap booking. */

const router = Router();
router.use(requireAuth);

const KINDS = ['home', 'work', 'other'];
const DEFAULT_NAME = { home: 'Home', work: 'Work' };
const MAX_PLACES = 20;

const toPlace = (p) => ({ id: p.id, kind: p.kind, name: p.name, lat: p.lat, lng: p.lng, address: p.address });

router.get('/', async (req, res) => {
  const rows = await many(
    `SELECT * FROM saved_places WHERE user_id = $1
     ORDER BY CASE kind WHEN 'home' THEN 0 WHEN 'work' THEN 1 ELSE 2 END, created_at`,
    [req.user.id],
  );
  res.json({ places: rows.map(toPlace) });
});

/** Saves a place. Home and Work are replaced if they already exist. */
router.post('/', async (req, res) => {
  const b = req.body ?? {};
  const kind = KINDS.includes(b.kind) ? b.kind : null;
  if (!kind) throw new HttpError(400, 'Choose Home, Work or Other');
  const place = { lat: Number(b.lat), lng: Number(b.lng) };
  if (!isLatLng(place)) throw new HttpError(400, 'Choose a location first');
  const address = String(b.address ?? '').trim().slice(0, 300) || `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`;
  const name = String(b.name ?? '').trim().slice(0, 40) || DEFAULT_NAME[kind];
  if (!name) throw new HttpError(400, 'Give this place a name');

  let row;
  if (kind === 'other') {
    const { n } = await one('SELECT count(*)::int AS n FROM saved_places WHERE user_id = $1', [req.user.id]);
    if (n >= MAX_PLACES) throw new HttpError(409, `You can save up to ${MAX_PLACES} places`);
    row = await one('INSERT INTO saved_places (user_id, kind, name, lat, lng, address) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [
      req.user.id, kind, name, place.lat, place.lng, address,
    ]);
  } else {
    row = await one(
      `INSERT INTO saved_places (user_id, kind, name, lat, lng, address) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, kind) WHERE kind IN ('home', 'work')
       DO UPDATE SET name = EXCLUDED.name, lat = EXCLUDED.lat, lng = EXCLUDED.lng, address = EXCLUDED.address
       RETURNING *`,
      [req.user.id, kind, name, place.lat, place.lng, address],
    );
  }
  res.status(201).json({ place: toPlace(row) });
});

router.delete('/:id', async (req, res) => {
  const row = await one('DELETE FROM saved_places WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.user.id]).catch(() => null);
  if (!row) throw new HttpError(404, 'Place not found');
  res.json({ ok: true });
});

export default router;
