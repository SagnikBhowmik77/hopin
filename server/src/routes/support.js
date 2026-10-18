import { Router } from 'express';
import { HttpError, requireAuth } from '../auth.js';
import { many, one, query, tx } from '../db.js';
import { emitToAdmins } from '../hub.js';
import { notifyIn } from '../messages.js';

const router = Router();
router.use(requireAuth);

export const CATEGORIES = ['payment', 'fare_dispute', 'lost_item', 'driver', 'safety', 'app', 'other'];

export const TICKET_SQL = `
  SELECT t.*, u.name AS user_name, u.email AS user_email, u.role AS user_role,
    (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
  FROM support_tickets t JOIN users u ON u.id = t.user_id`;

export const toTicket = (t) => ({
  id: t.id,
  category: t.category,
  subject: t.subject,
  status: t.status,
  rideId: t.ride_id,
  user: { name: t.user_name, email: t.user_email, role: t.user_role },
  messageCount: t.message_count,
  createdAt: t.created_at,
  updatedAt: t.updated_at,
});

export async function ticketThread(id) {
  return many(
    `SELECT m.id, m.body, m.created_at, u.name AS author_name, u.role AS author_role, m.author_id
     FROM ticket_messages m JOIN users u ON u.id = m.author_id WHERE m.ticket_id = $1 ORDER BY m.created_at`,
    [id],
  ).then((rows) => rows.map((m) => ({ id: m.id, body: m.body, createdAt: m.created_at, author: { id: m.author_id, name: m.author_name, role: m.author_role } })));
}

router.get('/tickets', async (req, res) => {
  const rows = await many(`${TICKET_SQL} WHERE t.user_id = $1 ORDER BY t.updated_at DESC`, [req.user.id]);
  res.json({ tickets: rows.map(toTicket) });
});

router.post('/tickets', async (req, res) => {
  const category = req.body?.category;
  const subject = String(req.body?.subject ?? '').trim().slice(0, 120);
  const message = String(req.body?.message ?? '').trim().slice(0, 4000);
  const rideId = req.body?.rideId || null;
  if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Pick a category');
  if (!subject || !message) throw new HttpError(400, 'Add a subject and describe the issue');
  if (category === 'fare_dispute' && !rideId) throw new HttpError(400, 'Choose the trip you are disputing');
  if (rideId) {
    const r = await one('SELECT id, rider_id, payment_status FROM rides WHERE id = $1 AND (rider_id = $2 OR driver_id = $2)', [rideId, req.user.id]).catch(() => null);
    if (!r) throw new HttpError(400, 'That ride is not yours');
    // A fare dispute is about money the rider actually paid.
    if (category === 'fare_dispute' && (r.rider_id !== req.user.id || r.payment_status !== 'paid')) {
      throw new HttpError(400, 'Fare disputes are for trips you have paid for');
    }
  }
  const id = await tx(async ({ query: q }) => {
    const t = (await q('INSERT INTO support_tickets (user_id, ride_id, category, subject) VALUES ($1, $2, $3, $4) RETURNING id', [req.user.id, rideId, category, subject])).rows[0];
    await q('INSERT INTO ticket_messages (ticket_id, author_id, body) VALUES ($1, $2, $3)', [t.id, req.user.id, message]);
    return t.id;
  });
  const t = toTicket(await one(`${TICKET_SQL} WHERE t.id = $1`, [id]));
  emitToAdmins('ticket', t);
  res.status(201).json({ ticket: t });
});

async function ownTicket(req) {
  const t = await one(`${TICKET_SQL} WHERE t.id = $1`, [req.params.id]).catch(() => null);
  if (!t || (t.user_id !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'Ticket not found');
  return t;
}

router.get('/tickets/:id', async (req, res) => {
  const t = await ownTicket(req);
  res.json({ ticket: toTicket(t), messages: await ticketThread(t.id) });
});

/** Both the ticket owner and admins post replies here; the other side gets notified. */
router.post('/tickets/:id/messages', async (req, res) => {
  const t = await ownTicket(req);
  const body = String(req.body?.body ?? '').trim().slice(0, 4000);
  if (!body) throw new HttpError(400, 'Write a message');
  const fromAdmin = req.user.role === 'admin';
  await query('INSERT INTO ticket_messages (ticket_id, author_id, body) VALUES ($1, $2, $3)', [t.id, req.user.id, body]);
  await query(
    `UPDATE support_tickets SET updated_at = now(), status = CASE WHEN $2 AND status = 'open' THEN 'in_progress' WHEN NOT $2 AND status = 'resolved' THEN 'open' ELSE status END WHERE id = $1`,
    [t.id, fromAdmin],
  );
  if (fromAdmin) await notifyIn(t.user_id, 'supportReplied', { subject: t.subject }, `/help?ticket=${t.id}`);
  else emitToAdmins('ticket', toTicket(await one(`${TICKET_SQL} WHERE t.id = $1`, [t.id])));
  res.status(201).json({ ticket: toTicket(await one(`${TICKET_SQL} WHERE t.id = $1`, [t.id])), messages: await ticketThread(t.id) });
});

export default router;
