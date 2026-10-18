import { Router } from 'express';
import { HttpError, requireAuth, requireRole } from '../auth.js';
import { many, one, query } from '../db.js';
import { emitToUser } from '../hub.js';
import { PHONE_RE, normalizePhone } from './auth.js';
import { notifyIn } from '../messages.js';

/**
 * Family profiles. A rider invites another rider by phone; the link exists once they accept.
 * Trips are shared only by members who turned sharing on for themselves.
 */

const router = Router();
router.use(requireAuth, requireRole('rider'));

const MAX_FAMILY = 6;

/** A member's live trip, only if they share trips with family. */
async function liveTripOf(memberId) {
  const r = await one(
    `SELECT r.status, r.vehicle_type, r.share_token, r.pickup, r.dropoff, r.kind, du.name AS driver_name, v.plate
     FROM rides r LEFT JOIN users du ON du.id = r.driver_id LEFT JOIN vehicles v ON v.driver_id = r.driver_id
     WHERE r.rider_id = $1 AND r.status IN ('accepted', 'arrived', 'ongoing') ORDER BY r.created_at DESC LIMIT 1`,
    [memberId],
  );
  if (!r) return null;
  return {
    status: r.status,
    kind: r.kind,
    vehicleType: r.vehicle_type,
    driver: { name: r.driver_name, plate: r.plate },
    pickup: r.pickup.address,
    dropoff: r.kind === 'rental' ? null : r.dropoff.address,
    trackPath: `/track/${r.share_token}`,
  };
}

router.get('/', async (req, res) => {
  const links = await many(
    `SELECT f.*, iu.name AS inviter_name, iu.phone AS inviter_phone, iu.share_trips_with_family AS inviter_shares,
            mu.name AS member_name, mu.phone AS member_phone, mu.share_trips_with_family AS member_shares
     FROM family_links f JOIN users iu ON iu.id = f.inviter_id JOIN users mu ON mu.id = f.member_id
     WHERE $1 IN (f.inviter_id, f.member_id) AND f.status IN ('pending', 'accepted') ORDER BY f.created_at`,
    [req.user.id],
  );
  const members = [];
  const incoming = [];
  const outgoing = [];
  for (const f of links) {
    const iInvited = f.inviter_id === req.user.id;
    const other = iInvited
      ? { id: f.member_id, name: f.member_name, phone: f.member_phone, shares: f.member_shares }
      : { id: f.inviter_id, name: f.inviter_name, phone: f.inviter_phone, shares: f.inviter_shares };
    if (f.status === 'pending') (iInvited ? outgoing : incoming).push({ linkId: f.id, person: { id: other.id, name: other.name } });
    else {
      members.push({
        linkId: f.id,
        person: { id: other.id, name: other.name, phone: other.phone },
        sharesTrips: other.shares,
        liveTrip: other.shares ? await liveTripOf(other.id) : null,
      });
    }
  }
  res.json({ sharing: req.user.share_trips_with_family, members, incoming, outgoing });
});

router.post('/', async (req, res) => {
  const phone = String(req.body?.phone ?? '').replace(/[\s-]/g, '');
  if (!PHONE_RE.test(phone)) throw new HttpError(400, 'Enter their 10-digit mobile number');
  const other = await one(`SELECT id, name, role FROM users WHERE phone = $1`, [normalizePhone(phone)]);
  if (!other || other.role !== 'rider') throw new HttpError(404, 'No Hopin rider has that mobile number. They need a Hopin account first.');
  if (other.id === req.user.id) throw new HttpError(400, 'That is your own number');
  const { n } = await one(`SELECT count(*)::int AS n FROM family_links WHERE $1 IN (inviter_id, member_id) AND status IN ('pending', 'accepted')`, [req.user.id]);
  if (n >= MAX_FAMILY) throw new HttpError(409, `A family can have up to ${MAX_FAMILY} people`);
  try {
    await query('INSERT INTO family_links (inviter_id, member_id) VALUES ($1, $2)', [req.user.id, other.id]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `You and ${other.name} are already linked or have an invite waiting`);
    throw err;
  }
  emitToUser(other.id, 'family:update', {});
  await notifyIn(other.id, 'familyInvite', { name: req.user.name }, '/family');
  res.status(201).json({ ok: true });
});

router.post('/:id/answer', async (req, res) => {
  const accept = req.body?.accept === true;
  const f = await one(
    `UPDATE family_links SET status = $3, answered_at = now() WHERE id = $1 AND member_id = $2 AND status = 'pending' RETURNING *`,
    [req.params.id, req.user.id, accept ? 'accepted' : 'declined'],
  ).catch(() => null);
  if (!f) throw new HttpError(409, 'This invite is no longer open');
  emitToUser(f.inviter_id, 'family:update', {});
  if (accept) await notifyIn(f.inviter_id, 'familyAccepted', { name: req.user.name }, '/family');
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const f = await one(
    `UPDATE family_links SET status = 'removed', answered_at = now() WHERE id = $1 AND $2 IN (inviter_id, member_id) AND status IN ('pending', 'accepted') RETURNING *`,
    [req.params.id, req.user.id],
  ).catch(() => null);
  if (!f) throw new HttpError(404, 'Not found');
  emitToUser(f.inviter_id === req.user.id ? f.member_id : f.inviter_id, 'family:update', {});
  res.json({ ok: true });
});

/** Each person decides for themselves whether family can see their live trips. */
router.put('/sharing', async (req, res) => {
  const share = req.body?.share === true;
  await query('UPDATE users SET share_trips_with_family = $2 WHERE id = $1', [req.user.id, share]);
  res.json({ sharing: share });
});

export default router;
