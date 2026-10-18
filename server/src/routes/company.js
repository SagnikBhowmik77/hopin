import { Router } from 'express';
import { HttpError, requireAuth, requireRole } from '../auth.js';
import { many, one, query } from '../db.js';
import { membershipOf, monthSpend } from '../growth.js';
import { PHONE_RE, normalizePhone } from './auth.js';
import { notifyIn } from '../messages.js';

/**
 * Corporate accounts. A Hopin admin creates the company and its first admin (see admin.js).
 * The company admin tops up the company wallet (Razorpay, kind 'company_topup'), invites
 * employees, sets monthly limits and exports business rides. Employees book with 'corporate'.
 */

const router = Router();
router.use(requireAuth, requireRole('rider'));

/** My company membership (or pending invite). */
router.get('/me', async (req, res) => {
  const m = await membershipOf(req.user.id);
  const invite = m
    ? null
    : await one(
        `SELECT m.id, c.name FROM company_members m JOIN companies c ON c.id = m.company_id WHERE m.user_id = $1 AND m.status = 'invited'`,
        [req.user.id],
      );
  res.json({
    membership: m && {
      companyId: m.company_id,
      company: m.company_name,
      role: m.role,
      monthlyLimit: m.monthly_limit,
      spentThisMonth: await monthSpend(m.company_id, req.user.id),
      companyBalance: m.wallet_balance,
      active: m.company_active,
    },
    invite: invite && { id: invite.id, company: invite.name },
  });
});

router.post('/invites/:id/answer', async (req, res) => {
  const accept = req.body?.accept === true;
  const m = await one(`UPDATE company_members SET status = $3 WHERE id = $1 AND user_id = $2 AND status = 'invited' RETURNING *`, [
    req.params.id,
    req.user.id,
    accept ? 'active' : 'declined',
  ]).catch(() => null);
  if (!m) throw new HttpError(409, 'This invite is no longer open');
  res.json({ ok: true });
});

// --- company admin -------------------------------------------------------------------------

async function adminOf(req) {
  const m = await membershipOf(req.user.id);
  if (!m || m.role !== 'admin') throw new HttpError(403, 'Only your company admin can do this');
  return m;
}

router.get('/', async (req, res) => {
  const m = await adminOf(req);
  const members = await many(
    `SELECT cm.id, cm.role, cm.status, cm.monthly_limit, u.id AS user_id, u.name, u.phone FROM company_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.company_id = $1 AND cm.status IN ('invited', 'active') ORDER BY cm.role, u.name`,
    [m.company_id],
  );
  const txns = await many(
    `SELECT t.amount, t.kind, t.created_at, u.name FROM company_txns t LEFT JOIN users u ON u.id = t.user_id WHERE t.company_id = $1 ORDER BY t.created_at DESC LIMIT 30`,
    [m.company_id],
  );
  const out = [];
  for (const x of members) {
    out.push({
      id: x.id,
      role: x.role,
      status: x.status,
      monthlyLimit: x.monthly_limit,
      person: { id: x.user_id, name: x.name, phone: x.phone },
      spentThisMonth: x.status === 'active' ? await monthSpend(m.company_id, x.user_id) : 0,
    });
  }
  res.json({
    company: { id: m.company_id, name: m.company_name, walletBalance: m.wallet_balance },
    members: out,
    txns: txns.map((t) => ({ amount: t.amount, kind: t.kind, at: t.created_at, who: t.name })),
  });
});

const cleanLimit = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new HttpError(400, 'A monthly limit is a whole number of rupees, or empty for none');
  return n;
};

router.post('/members', async (req, res) => {
  const m = await adminOf(req);
  const phone = String(req.body?.phone ?? '').replace(/[\s-]/g, '');
  if (!PHONE_RE.test(phone)) throw new HttpError(400, "Enter the employee's 10-digit mobile number");
  const person = await one(`SELECT id, name, role FROM users WHERE phone = $1`, [normalizePhone(phone)]);
  if (!person || person.role !== 'rider') throw new HttpError(404, 'No Hopin rider has that mobile number. They need a Hopin account first.');
  try {
    await query(`INSERT INTO company_members (company_id, user_id, role, status, monthly_limit) VALUES ($1, $2, 'employee', 'invited', $3)`, [
      m.company_id,
      person.id,
      cleanLimit(req.body?.monthlyLimit),
    ]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `${person.name} already belongs to a company account or has an invite`);
    throw err;
  }
  await notifyIn(person.id, 'companyInvite', { company: m.company_name }, '/profile');
  res.status(201).json({ ok: true });
});

router.patch('/members/:id', async (req, res) => {
  const m = await adminOf(req);
  const row = await one(`UPDATE company_members SET monthly_limit = $3 WHERE id = $1 AND company_id = $2 AND status IN ('invited', 'active') RETURNING id`, [
    req.params.id,
    m.company_id,
    cleanLimit(req.body?.monthlyLimit),
  ]).catch(() => null);
  if (!row) throw new HttpError(404, 'Member not found');
  res.json({ ok: true });
});

router.delete('/members/:id', async (req, res) => {
  const m = await adminOf(req);
  const row = await one(
    `UPDATE company_members SET status = 'removed' WHERE id = $1 AND company_id = $2 AND user_id <> $3 AND status IN ('invited', 'active') RETURNING id`,
    [req.params.id, m.company_id, req.user.id],
  ).catch(() => null);
  if (!row) throw new HttpError(404, 'Member not found (you cannot remove yourself)');
  res.json({ ok: true });
});

/** Business rides of one month as CSV (default: this month, India time). */
router.get('/rides.csv', async (req, res) => {
  const m = await adminOf(req);
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month ?? '')) ? req.query.month : new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
  const rows = await many(
    `SELECT r.completed_at, r.cancelled_at, r.status, u.name, u.phone, r.pickup, r.dropoff, r.vehicle_type, r.distance_km,
            CASE WHEN r.status = 'cancelled' THEN r.cancellation_fee ELSE r.fare END AS amount, r.payment_status, r.business_note, r.id
     FROM rides r JOIN users u ON u.id = r.rider_id
     WHERE r.company_id = $1 AND r.status IN ('completed', 'cancelled')
       AND to_char(COALESCE(r.completed_at, r.cancelled_at) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $2
     ORDER BY COALESCE(r.completed_at, r.cancelled_at)`,
    [m.company_id, month],
  );
  // Quote every cell; a leading = + - @ is prefixed with ' so spreadsheets never run it as a formula.
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replaceAll('"', '""')}"`;
  };
  const lines = [
    ['Date', 'Employee', 'Mobile', 'From', 'To', 'Vehicle', 'Km', 'Amount (Rs)', 'Payment', 'Note', 'Status', 'Ride ID'].map(cell).join(','),
    ...rows.map((r) =>
      [
        new Date(r.completed_at ?? r.cancelled_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        r.name,
        r.phone,
        r.pickup.address,
        r.dropoff.address,
        r.vehicle_type,
        r.distance_km,
        r.amount,
        r.payment_status,
        r.business_note,
        r.status,
        r.id,
      ]
        .map(cell)
        .join(','),
    ),
  ];
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="hopin-business-rides-${month}.csv"` });
  res.send(lines.join('\n'));
});

export default router;
