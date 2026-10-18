import { LANGUAGES } from '../messages.js';
import { Router } from 'express';
import { HttpError, loadUser, publicUser, requireAuth, requireRole } from '../auth.js';
import { one, many, query, isUniqueViolation } from '../db.js';
import { toNotification } from '../notify.js';
import { PHONE_RE, cleanVehicle, normalizePhone } from './auth.js';

const router = Router();
router.use(requireAuth);

const UPI_RE = /^[\w.-]{2,64}@[a-zA-Z]{2,32}$/;
// Avatars are resized to 256px JPEG in the browser; this is a generous ceiling.
const MAX_AVATAR_CHARS = 200_000;

const fresh = async (req, res) => res.json({ user: publicUser(await loadUser(req.user.id)) });

router.patch('/', async (req, res) => {
  const { name, phone, avatar, defaultPayment, language } = req.body ?? {};
  const sets = [];
  const params = [req.user.id];
  const set = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (name !== undefined) {
    if (!String(name).trim()) throw new HttpError(400, 'Name cannot be empty');
    set('name', String(name).trim().slice(0, 60));
  }
  if (phone !== undefined) {
    if (!PHONE_RE.test(String(phone).replace(/[\s-]/g, ''))) throw new HttpError(400, 'Enter a valid 10-digit mobile number');
    const next = normalizePhone(phone);
    if (next !== req.user.phone) {
      set('phone', next);
      // A new number has not been confirmed by SMS yet.
      set('phone_verified', false);
    }
  }
  if (avatar !== undefined) {
    if (avatar !== null && !(typeof avatar === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(avatar))) throw new HttpError(400, 'Avatar must be an image');
    if (avatar && avatar.length > MAX_AVATAR_CHARS) throw new HttpError(400, 'That image is too large');
    set('avatar', avatar);
  }
  if (language !== undefined) {
    if (!LANGUAGES.includes(language)) throw new HttpError(400, 'Choose English or Hindi');
    set('language', language);
  }
  if (defaultPayment !== undefined) {
    if (!['cash', 'wallet', 'card', 'upi'].includes(defaultPayment)) throw new HttpError(400, 'Unknown payment method');
    set('default_payment', defaultPayment);
  }
  if (sets.length) {
    try {
      await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'That phone number is used by another account');
      throw err;
    }
  }
  return fresh(req, res);
});

router.put('/vehicle', requireRole('driver'), async (req, res) => {
  const v = cleanVehicle(req.body);
  await query(
    `INSERT INTO vehicles (driver_id, type, model, plate) VALUES ($1, $2, $3, $4)
     ON CONFLICT (driver_id) DO UPDATE SET type = EXCLUDED.type, model = EXCLUDED.model, plate = EXCLUDED.plate`,
    [req.user.id, v.type, v.model, v.plate],
  );
  return fresh(req, res);
});

router.put('/emergency-contacts', async (req, res) => {
  const list = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
  if (list.length > 3) throw new HttpError(400, 'Up to 3 emergency contacts');
  const contacts = list.map((c) => {
    const name = String(c?.name ?? '').trim().slice(0, 40);
    const phone = String(c?.phone ?? '').replace(/[\s-]/g, '');
    if (!name || !/^(\+91)?[6-9]\d{9}$/.test(phone)) throw new HttpError(400, 'Each contact needs a name and a valid mobile number');
    return { name, phone: normalizePhone(phone) };
  });
  await query('UPDATE users SET emergency_contacts = $2 WHERE id = $1', [req.user.id, JSON.stringify(contacts)]);
  return fresh(req, res);
});

/** A driver who is deaf or hard of hearing can tell riders, who are then asked to use chat. */
router.put('/driver-deaf', async (req, res) => {
  if (req.user.role !== 'driver') throw new HttpError(403, 'Only drivers set this');
  await query('UPDATE users SET driver_deaf = $2 WHERE id = $1', [req.user.id, req.body?.deaf === true]);
  return fresh(req, res);
});

/** A rider's own 4-digit trip PIN, used instead of a random code. `null` goes back to random codes. */
router.put('/trip-pin', async (req, res) => {
  if (req.user.role !== 'rider') throw new HttpError(403, 'Only riders have a trip PIN');
  const pin = req.body?.pin == null || req.body.pin === '' ? null : String(req.body.pin).trim();
  if (pin !== null) {
    if (!/^\d{4}$/.test(pin)) throw new HttpError(400, 'Your PIN must be 4 digits');
    // Codes anyone could guess defeat the point of checking you got into the right vehicle.
    const easy = /^(\d)\1{3}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin);
    if (easy) throw new HttpError(400, 'Choose a PIN that is harder to guess than repeated or consecutive digits');
  }
  await query('UPDATE users SET trip_pin = $2 WHERE id = $1', [req.user.id, pin]);
  return fresh(req, res);
});

// --- payment methods ---------------------------------------------------------

router.get('/payment-methods', async (req, res) => {
  const upi = await many('SELECT id, vpa FROM upi_ids WHERE user_id = $1 ORDER BY created_at', [req.user.id]);
  res.json({ upi, walletBalance: req.user.wallet_balance, defaultPayment: req.user.default_payment });
});

router.post('/payment-methods/upi', async (req, res) => {
  const vpa = String(req.body?.vpa ?? '').trim().toLowerCase();
  if (!UPI_RE.test(vpa)) throw new HttpError(400, 'Enter a valid UPI ID, like name@okhdfc');
  const count = await one('SELECT count(*)::int AS n FROM upi_ids WHERE user_id = $1', [req.user.id]);
  if (count.n >= 5) throw new HttpError(400, 'Up to 5 UPI IDs');
  await query('INSERT INTO upi_ids (user_id, vpa) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, vpa]);
  res.status(201).json({ upi: await many('SELECT id, vpa FROM upi_ids WHERE user_id = $1 ORDER BY created_at', [req.user.id]) });
});

router.delete('/payment-methods/upi/:id', async (req, res) => {
  await query('DELETE FROM upi_ids WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]).catch(() => null);
  res.json({ upi: await many('SELECT id, vpa FROM upi_ids WHERE user_id = $1 ORDER BY created_at', [req.user.id]) });
});

router.get('/wallet', async (req, res) => {
  const txns = await many('SELECT id, amount, kind, ride_id, ref, created_at FROM wallet_txns WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [
    req.user.id,
  ]);
  res.json({ balance: req.user.wallet_balance, txns });
});

// --- notifications ---------------------------------------------------------------

router.get('/notifications', async (req, res) => {
  const rows = await many('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30', [req.user.id]);
  res.json({ notifications: rows.map(toNotification), unread: rows.filter((n) => !n.read).length });
});

router.post('/notifications/read', async (req, res) => {
  await query('UPDATE notifications SET read = true WHERE user_id = $1 AND read = false', [req.user.id]);
  res.json({ ok: true });
});

// --- driver public profile & reviews -----------------------------------------------

router.get('/drivers/:id', async (req, res) => {
  const d = await loadUser(req.params.id).catch(() => null);
  if (!d || d.role !== 'driver') throw new HttpError(404, 'Driver not found');
  const reviews = await many(
    `SELECT rv.stars, rv.comment, rv.tags, rv.created_at, u.name AS rider_name
     FROM reviews rv JOIN users u ON u.id = rv.rider_id WHERE rv.driver_id = $1 ORDER BY rv.created_at DESC LIMIT 20`,
    [d.id],
  );
  const stats = await one(
    `SELECT count(*)::int AS trips, COALESCE(SUM(distance_km), 0) AS km FROM rides WHERE driver_id = $1 AND status = 'completed'`,
    [d.id],
  );
  const tagCounts = {};
  for (const r of reviews) for (const t of r.tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
  res.json({
    driver: {
      id: d.id,
      name: d.name,
      avatar: d.avatar,
      rating: Math.round(d.rating * 10) / 10,
      ratingCount: d.rating_count,
      vehicle: d.vehicle_type ? { type: d.vehicle_type, model: d.vehicle_model, plate: d.vehicle_plate } : null,
      trips: stats.trips,
      since: d.created_at,
    },
    tags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]),
    reviews: reviews.map((r) => ({ stars: r.stars, comment: r.comment, tags: r.tags, createdAt: r.created_at, riderName: r.rider_name.split(' ')[0] })),
  });
});

export default router;
