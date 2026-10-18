import { Router } from 'express';
import { requireAuth, HttpError } from '../auth.js';
import { getRoute, reverseGeocode, searchPlaces, isLatLng } from '../geo.js';

const router = Router();
router.use(requireAuth);

const point = (lat, lng) => ({ lat: Number(lat), lng: Number(lng) });

router.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 3) return res.json({ results: [] });
  try {
    res.json({ results: await searchPlaces(q.slice(0, 120), point(req.query.lat, req.query.lng)) });
  } catch (err) {
    throw new HttpError(502, `Place search is unavailable right now (${err.message})`);
  }
});

router.get('/reverse', async (req, res) => {
  const p = point(req.query.lat, req.query.lng);
  if (!isLatLng(p)) throw new HttpError(400, 'lat and lng are required');
  res.json({ address: await reverseGeocode(p) });
});

/** Route between two points - drivers use it to draw the way to the pickup. */
router.get('/route', async (req, res) => {
  const from = point(req.query.fromLat, req.query.fromLng);
  const to = point(req.query.toLat, req.query.toLng);
  if (!isLatLng(from) || !isLatLng(to)) throw new HttpError(400, 'from and to are required');
  res.json({ route: await getRoute([from, to]) });
});

export default router;
