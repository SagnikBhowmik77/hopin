import crypto from 'node:crypto';
import { Router } from 'express';
import { HttpError, requireAuth, requireRole } from '../auth.js';
import { many, tx } from '../db.js';
import { VEHICLE_TYPES } from '../fare.js';
import { getRoute, haversineKm, isLatLng } from '../geo.js';
import { PRICE_LOCK, createLock, lockableFare, toPriceLock } from '../booking.js';

/**
 * Price lock: ₹49 freezes today's no-surge fare for one route and vehicle for 7 days.
 * Bookings on that route pay the locked fare or the normal fare, whichever is lower.
 * Paid here from the wallet, or through POST /api/payments/razorpay/order (kind 'price_lock').
 */

const router = Router();
router.use(requireAuth, requireRole('rider'));

/** Validates a lock request and works out the fare it would freeze. */
export async function lockRequest(body) {
  const place = (p, label) => {
    const out = { lat: Number(p?.lat), lng: Number(p?.lng), address: String(p?.address ?? '').trim().slice(0, 300) };
    if (!isLatLng(out)) throw new HttpError(400, `Choose a ${label} location`);
    if (!out.address) out.address = `${out.lat.toFixed(5)}, ${out.lng.toFixed(5)}`;
    return out;
  };
  const pickup = place(body?.pickup, 'pickup');
  const dropoff = place(body?.dropoff, 'drop');
  if (!VEHICLE_TYPES.includes(body?.vehicleType)) throw new HttpError(400, 'Pick a vehicle');
  if (haversineKm(pickup, dropoff) < 0.5) throw new HttpError(400, 'Pickup and drop are too close together to lock');
  const route = await getRoute([pickup, dropoff]);
  return { pickup, dropoff, vehicleType: body.vehicleType, lockedFare: lockableFare(body.vehicleType, route) };
}

router.get('/', async (req, res) => {
  const rows = await many(`SELECT * FROM price_locks WHERE rider_id = $1 AND expires_at > now() ORDER BY expires_at`, [req.user.id]);
  res.json({ locks: rows.map(toPriceLock), offer: { fee: PRICE_LOCK.fee, days: PRICE_LOCK.days, max: PRICE_LOCK.maxActive } });
});

/** Buy a lock with the wallet. */
router.post('/', async (req, res) => {
  const lock = await lockRequest(req.body);
  const ref = `LOCK-WALLET-${crypto.randomUUID()}`;
  const row = await tx(({ query: q }) => createLock(q, { riderId: req.user.id, ...lock, ref, fromWallet: true }));
  res.status(201).json({ lock: toPriceLock(row) });
});

export default router;
