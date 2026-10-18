import { Router } from 'express';
import { HttpError, USER_SQL, publicUser, requireAuth, requireRole } from '../auth.js';
import { many, one, query, tx } from '../db.js';
import { currentDocs, driverVerification, todayIST } from '../driverDocs.js';
import { signedDocUrl } from '../storage.js';
import { issueRefund, refundable, syncRefund, toRefund } from '../refunds.js';
import { onlineDrivers, setDriverOffline } from '../hub.js';
import { toHelmetCheck } from '../helmet.js';
import { passPrices, setPassPrices } from '../drivers.js';
import { toSafetyCheck } from '../safetyChecks.js';
import { toDeviation } from '../deviation.js';
import { adminDeleteRecording, audioFor, heldRecordings } from '../recordings.js';
import { recentSpots, removeSpot } from '../waterlog.js';
import { listPayouts, markPayoutPaid, payoutDetails, rejectPayout } from '../payouts.js';
import { routingStatus } from '../liveEta.js';
import { normalizeCode } from '../promos.js';
import { TICKET_SQL, toTicket } from './support.js';
import { PHONE_RE, normalizePhone } from './auth.js';
import { notifyIn } from '../messages.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

router.get('/overview', async (_req, res) => {
  const stats = await one(`
    SELECT
      (SELECT count(*)::int FROM users WHERE role = 'rider') AS riders,
      (SELECT count(*)::int FROM users WHERE role = 'driver') AS drivers,
      (SELECT count(*)::int FROM rides WHERE status IN ('requested','accepted','arrived','ongoing')) AS active_rides,
      (SELECT count(*)::int FROM rides WHERE status = 'completed' AND completed_at >= date_trunc('day', now())) AS completed_today,
      (SELECT COALESCE(SUM(CASE WHEN status = 'cancelled' THEN cancellation_fee ELSE fare END), 0)::int
         FROM rides WHERE payment_status = 'paid' AND paid_at >= date_trunc('day', now())) AS gmv_today,
      (SELECT count(*)::int FROM sos_alerts WHERE status = 'open') AS open_sos,
      (SELECT count(*)::int FROM route_deviations WHERE resolved_at IS NULL) AS open_deviations,
      (SELECT count(*)::int FROM helmet_checks WHERE status = 'pending') AS pending_helmets,
      (SELECT count(*)::int FROM safety_checks WHERE escalated_at IS NOT NULL AND confirmed_at IS NULL) AS unconfirmed_night_rides,
      (SELECT count(*)::int FROM support_tickets WHERE status <> 'resolved') AS open_tickets`);
  res.json({ ...stats, online_drivers: onlineDrivers().length });
});

/**
 * Read-only figures for the operations dashboard: the last 7 days (IST) of trips and money,
 * the vehicle mix over 30 days, and what is live right now (online drivers, active rides).
 * Every number comes from the rides table or driver presence; nothing is estimated.
 */
router.get('/insights', async (_req, res) => {
  const days = await many(`
    WITH d AS (
      SELECT generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - 6, (now() AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day')::date AS day
    )
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
      (SELECT count(*)::int FROM rides r WHERE r.status = 'completed' AND (r.completed_at AT TIME ZONE 'Asia/Kolkata')::date = d.day) AS completed,
      (SELECT count(*)::int FROM rides r WHERE r.status = 'cancelled' AND (COALESCE(r.cancelled_at, r.created_at) AT TIME ZONE 'Asia/Kolkata')::date = d.day) AS cancelled,
      (SELECT COALESCE(SUM(r.fare), 0)::int FROM rides r WHERE r.status = 'completed' AND r.payment_status = 'paid' AND (r.paid_at AT TIME ZONE 'Asia/Kolkata')::date = d.day) AS paid
    FROM d ORDER BY d.day`);
  const vehicles = await many(`
    SELECT vehicle_type AS type, count(*)::int AS trips FROM rides
    WHERE status = 'completed' AND completed_at > now() - interval '30 days' GROUP BY vehicle_type`);
  const active = await many(`
    SELECT id, status, vehicle_type, pickup, dropoff FROM rides
    WHERE status IN ('requested','accepted','arrived','ongoing') ORDER BY created_at DESC LIMIT 100`);
  res.json({
    days,
    vehicles,
    live: {
      drivers: onlineDrivers()
        .filter((d) => typeof d.lat === 'number' && typeof d.lng === 'number')
        .map((d) => ({ lat: d.lat, lng: d.lng, vehicleType: d.vehicleType })),
      rides: active.map((r) => ({ id: r.id, status: r.status, vehicleType: r.vehicle_type, pickup: r.pickup, dropoff: r.dropoff })),
    },
  });
});

router.get('/sos', async (_req, res) => {
  const rows = await many(`
    SELECT s.*, u.name AS user_name, u.phone AS user_phone, u.role AS user_role, r.share_token,
           du.name AS driver_name, du.phone AS driver_phone, v.plate AS v_plate
    FROM sos_alerts s JOIN users u ON u.id = s.user_id JOIN rides r ON r.id = s.ride_id
    LEFT JOIN users du ON du.id = r.driver_id LEFT JOIN vehicles v ON v.driver_id = r.driver_id
    ORDER BY (s.status = 'open') DESC, s.created_at DESC LIMIT 50`);
  res.json({
    alerts: rows.map((s) => ({
      id: s.id,
      rideId: s.ride_id,
      status: s.status,
      location: s.location,
      user: { name: s.user_name, phone: s.user_phone, role: s.user_role },
      driver: s.driver_name ? { name: s.driver_name, phone: s.driver_phone, plate: s.v_plate } : null,
      trackPath: `/track/${s.share_token}`,
      smsResults: s.sms_results ?? [],
      createdAt: s.created_at,
      resolvedAt: s.resolved_at,
    })),
  });
});

router.post('/sos/:id/resolve', async (req, res) => {
  const s = await one(`UPDATE sos_alerts SET status = 'resolved', resolved_at = now() WHERE id = $1 AND status = 'open' RETURNING *`, [req.params.id]).catch(() => null);
  if (!s) throw new HttpError(409, 'Alert is already resolved');
  await notifyIn(s.user_id, 'sosResolved', {}, '/help');
  res.json({ ok: true });
});

// --- corporate accounts ---------------------------------------------------------------

router.get('/companies', async (_req, res) => {
  const rows = await many(`
    SELECT c.*, (SELECT count(*)::int FROM company_members m WHERE m.company_id = c.id AND m.status = 'active') AS members,
           (SELECT u.name FROM company_members m JOIN users u ON u.id = m.user_id WHERE m.company_id = c.id AND m.role = 'admin' AND m.status = 'active' LIMIT 1) AS admin_name
    FROM companies c ORDER BY c.created_at DESC`);
  res.json({
    companies: rows.map((c) => ({ id: c.id, name: c.name, walletBalance: c.wallet_balance, active: c.active, members: c.members, adminName: c.admin_name, createdAt: c.created_at })),
  });
});

/** Creates a company and makes an existing rider (by mobile) its admin. */
router.post('/companies', async (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 80);
  if (name.length < 2) throw new HttpError(400, 'Enter the company name');
  const phone = String(req.body?.adminPhone ?? '').replace(/[\s-]/g, '');
  if (!PHONE_RE.test(phone)) throw new HttpError(400, "Enter the company admin's 10-digit mobile number");
  const person = await one(`SELECT id, name, role FROM users WHERE phone = $1`, [normalizePhone(phone)]);
  if (!person || person.role !== 'rider') throw new HttpError(404, 'The company admin must have a Hopin rider account with that number');
  try {
    const company = await tx(async ({ query: q }) => {
      const c = (await q('INSERT INTO companies (name, created_by) VALUES ($1, $2) RETURNING *', [name, req.user.id])).rows[0];
      await q(`INSERT INTO company_members (company_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')`, [c.id, person.id]);
      return c;
    });
    await notifyIn(person.id, 'companyAdmin', { company: name }, '/company');
    res.status(201).json({ company: { id: company.id, name: company.name } });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'That company name is taken, or that person already belongs to a company');
    throw err;
  }
});

router.post('/companies/:id/active', async (req, res) => {
  const row = await one('UPDATE companies SET active = $2 WHERE id = $1 RETURNING id', [req.params.id, req.body?.active === true]).catch(() => null);
  if (!row) throw new HttpError(404, 'Company not found');
  res.json({ ok: true });
});

// --- driver daily pass prices ---------------------------------------------------------

router.get('/pass-prices', async (_req, res) => {
  res.json({ prices: await passPrices() });
});

router.put('/pass-prices', async (req, res) => {
  res.json({ prices: await setPassPrices(req.body?.prices) });
});

// --- helmet selfies (bike drivers) -----------------------------------------------

router.get('/helmet-checks', async (_req, res) => {
  const rows = await many(`
    SELECT h.*, to_char(h.taken_on, 'YYYY-MM-DD') AS taken_on, u.name AS driver_name, v.plate AS v_plate
    FROM helmet_checks h JOIN users u ON u.id = h.driver_id LEFT JOIN vehicles v ON v.driver_id = h.driver_id
    ORDER BY (h.status = 'pending') DESC, h.created_at DESC LIMIT 40`);
  const checks = [];
  for (const h of rows) {
    checks.push({
      ...toHelmetCheck(h),
      driver: { id: h.driver_id, name: h.driver_name, plate: h.v_plate },
      // Pending selfies get a short-lived link to look at; reviewed ones do not need one.
      url: h.status === 'pending' ? await signedDocUrl(h.storage_path).catch(() => null) : null,
    });
  }
  res.json({ checks });
});

router.post('/helmet-checks/:id/review', async (req, res) => {
  const approve = req.body?.approve === true;
  const reason = String(req.body?.reason ?? '').trim().slice(0, 200);
  if (!approve && !reason) throw new HttpError(400, 'Say why the selfie is rejected');
  const h = await one(
    `UPDATE helmet_checks SET status = $2, reject_reason = $3, reviewed_by = $4, reviewed_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING *, to_char(taken_on, 'YYYY-MM-DD') AS taken_on`,
    [req.params.id, approve ? 'approved' : 'rejected', approve ? null : reason, req.user.id],
  ).catch(() => null);
  if (!h) throw new HttpError(409, 'This selfie was already reviewed');
  if (!approve) {
    // Rejecting today's selfie takes the driver offline until they send a new one.
    if (h.taken_on === todayIST()) setDriverOffline(h.driver_id, `Helmet selfie rejected: ${reason}`);
    await notifyIn(h.driver_id, 'helmetRejected', { reason }, '/drive');
  }
  res.json({ check: toHelmetCheck(h) });
});

// --- night-ride safety checks ----------------------------------------------------

router.get('/safety-checks', async (_req, res) => {
  const rows = await many(`
    SELECT c.*, u.name AS rider_name, u.phone AS rider_phone, r.dropoff
    FROM safety_checks c JOIN users u ON u.id = c.rider_id JOIN rides r ON r.id = c.ride_id
    WHERE c.escalated_at IS NOT NULL ORDER BY (c.confirmed_at IS NULL) DESC, c.escalated_at DESC LIMIT 40`);
  res.json({
    checks: rows.map((c) => ({ ...toSafetyCheck(c), rider: { name: c.rider_name, phone: c.rider_phone }, drop: c.dropoff?.address ?? null })),
  });
});

// --- route-deviation alerts (step 7) -------------------------------------------

router.get('/deviations', async (_req, res) => {
  const rows = await many(`
    SELECT d.*, ru.name AS rider_name, du.name AS driver_name, v.plate AS v_plate, r.share_token, r.status AS ride_status
    FROM route_deviations d
    JOIN rides r ON r.id = d.ride_id
    JOIN users ru ON ru.id = d.rider_id
    JOIN users du ON du.id = d.driver_id
    LEFT JOIN vehicles v ON v.driver_id = d.driver_id
    ORDER BY (d.resolved_at IS NULL) DESC, d.alerted_at DESC LIMIT 50`);
  res.json({
    deviations: rows.map((d) => ({
      ...toDeviation(d),
      rider: { name: d.rider_name },
      driver: { name: d.driver_name, plate: d.v_plate },
      rideStatus: d.ride_status,
      // The live map only works while the trip is in progress.
      trackPath: d.ride_status === 'ongoing' ? `/track/${d.share_token}` : null,
    })),
  });
});

router.post('/deviations/:id/check', async (req, res) => {
  const d = await one(
    'UPDATE route_deviations SET checked_by = $2, checked_at = now() WHERE id = $1 AND checked_at IS NULL RETURNING *',
    [req.params.id, req.user.id],
  ).catch(() => null);
  if (!d) throw new HttpError(409, 'Already marked as checked');
  res.json({ deviation: toDeviation(d) });
});

router.get('/tickets', async (req, res) => {
  const status = ['open', 'in_progress', 'resolved'].includes(req.query.status) ? req.query.status : null;
  const rows = await many(`${TICKET_SQL} ${status ? 'WHERE t.status = $1' : ''} ORDER BY t.updated_at DESC LIMIT 100`, status ? [status] : []);
  res.json({ tickets: rows.map(toTicket) });
});

router.post('/tickets/:id/status', async (req, res) => {
  const status = req.body?.status;
  if (!['open', 'in_progress', 'resolved'].includes(status)) throw new HttpError(400, 'Unknown status');
  const t = await one('UPDATE support_tickets SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [req.params.id, status]).catch(() => null);
  if (!t) throw new HttpError(404, 'Ticket not found');
  if (status === 'resolved') await notifyIn(t.user_id, 'ticketResolved', { subject: t.subject }, `/help?ticket=${t.id}`);
  res.json({ ticket: toTicket(await one(`${TICKET_SQL} WHERE t.id = $1`, [t.id])) });
});

router.get('/promos', async (_req, res) => {
  const rows = await many(`
    SELECT p.*, (SELECT count(*)::int FROM promo_redemptions pr WHERE pr.code = p.code) AS used
    FROM promos p ORDER BY p.created_at DESC`);
  res.json({ promos: rows });
});

router.post('/promos', async (req, res) => {
  const b = req.body ?? {};
  const code = normalizeCode(b.code);
  if (!/^[A-Z0-9]{3,24}$/.test(code)) throw new HttpError(400, 'Code must be 3-24 letters or digits');
  if (!['percent', 'flat'].includes(b.kind)) throw new HttpError(400, 'Kind must be percent or flat');
  const value = Number(b.value);
  if (!Number.isInteger(value) || value <= 0 || (b.kind === 'percent' && value > 100)) throw new HttpError(400, 'Enter a valid discount value');
  const int = (v) => (v === '' || v == null ? null : Math.max(0, Math.round(Number(v))));
  try {
    await query(
      `INSERT INTO promos (code, description, kind, value, max_discount, min_fare, first_ride_only, usage_limit, per_user_limit, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        code,
        String(b.description ?? '').trim().slice(0, 140) || `${b.kind === 'percent' ? `${value}%` : `₹${value}`} off`,
        b.kind,
        value,
        int(b.maxDiscount),
        int(b.minFare) ?? 0,
        Boolean(b.firstRideOnly),
        int(b.usageLimit),
        int(b.perUserLimit) || 1,
        b.expiresAt ? new Date(b.expiresAt) : null,
      ],
    );
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `${code} already exists`);
    throw err;
  }
  res.status(201).json({ ok: true });
});

router.post('/promos/:code/toggle', async (req, res) => {
  const p = await one('UPDATE promos SET active = NOT active WHERE code = $1 RETURNING code, active', [normalizeCode(req.params.code)]);
  if (!p) throw new HttpError(404, 'Promo not found');
  res.json(p);
});

// --- refunds ---------------------------------------------------------------------

/** Recent refunds, plus Razorpay payments that arrived for already-paid rides. */
router.get('/refunds', async (_req, res) => {
  const refunds = await many(`
    SELECT f.*, u.name AS rider_name FROM refunds f JOIN users u ON u.id = f.rider_id
    ORDER BY f.created_at DESC LIMIT 100`);
  const duplicates = await many(`
    SELECT o.id, o.amount, o.razorpay_payment_id, o.ride_id, o.paid_at, u.name AS rider_name,
      (SELECT COALESCE(SUM(amount), 0)::int FROM refunds f WHERE f.payment_order_id = o.id AND f.status <> 'failed') AS refunded
    FROM payment_orders o JOIN users u ON u.id = o.user_id
    WHERE o.status = 'needs_refund' ORDER BY o.paid_at`);
  res.json({
    refunds: refunds.map((r) => ({ ...toRefund(r), riderName: r.rider_name })),
    duplicates: duplicates.map((d) => ({ id: d.id, amount: d.amount, refunded: d.refunded, paymentId: d.razorpay_payment_id, rideId: d.ride_id, paidAt: d.paid_at, riderName: d.rider_name })),
  });
});

/** How much of a ride (or duplicate payment) can still be refunded, and where it can go. */
router.get('/refundable', async (req, res) => {
  const info = await refundable({ rideId: req.query.rideId || null, paymentOrderId: req.query.paymentOrderId || null }).catch((err) => {
    if (err.code === '22P02') throw new HttpError(404, 'Not found');
    throw err;
  });
  res.json({
    paid: info.paid,
    refunded: info.refunded,
    remaining: info.remaining,
    // Where "original" sends the money, or null if there is no online original (cash).
    original: info.cash ? null : info.originalIsWallet ? 'wallet' : info.razorpayPaymentId ? 'razorpay' : null,
  });
});

router.post('/refunds', async (req, res) => {
  const { rideId, paymentOrderId, amount, destination, reason, ticketId } = req.body ?? {};
  if (!rideId && !paymentOrderId) throw new HttpError(400, 'Choose what to refund');
  const refund = await issueRefund({ adminId: req.user.id, rideId, paymentOrderId, amount, destination, reason, ticketId });
  res.status(201).json({ refund: toRefund(refund) });
});

/** Ask Razorpay for the latest status of an online refund. */
router.post('/refunds/:id/refresh', async (req, res) => {
  const row = await one('SELECT * FROM refunds WHERE id = $1', [req.params.id]).catch(() => null);
  if (!row) throw new HttpError(404, 'Refund not found');
  if (!row.razorpay_refund_id) return res.json({ refund: toRefund(row) });
  try {
    res.json({ refund: toRefund(await syncRefund(row)) });
  } catch (err) {
    throw new HttpError(502, `Could not reach Razorpay (${err.message})`);
  }
});

// --- driver verification ---------------------------------------------------------

/** Drivers with their verification state; anyone with documents waiting comes first. */
router.get('/drivers', async (_req, res) => {
  const rows = await many(`
    SELECT u.id, u.name, u.email, u.phone, u.phone_verified, u.created_at, v.type AS vehicle_type, v.model AS vehicle_model, v.plate AS vehicle_plate,
      (SELECT count(*)::int FROM (
         SELECT DISTINCT ON (doc_type) status FROM driver_documents d WHERE d.driver_id = u.id ORDER BY doc_type, created_at DESC
       ) cur WHERE cur.status = 'pending') AS pending
    FROM users u LEFT JOIN vehicles v ON v.driver_id = u.id
    WHERE u.role = 'driver'
    ORDER BY pending DESC, u.created_at DESC
    LIMIT 200`);
  const drivers = [];
  for (const d of rows) {
    const verification = await driverVerification(d.id);
    drivers.push({
      id: d.id,
      name: d.name,
      email: d.email,
      phone: d.phone,
      phoneVerified: d.phone_verified,
      vehicle: d.vehicle_type ? { type: d.vehicle_type, model: d.vehicle_model, plate: d.vehicle_plate } : null,
      pendingDocs: d.pending,
      canDrive: verification.canDrive,
      states: Object.fromEntries(verification.items.map((i) => [i.type, i.state])),
      joinedAt: d.created_at,
    });
  }
  res.json({ drivers });
});

/** One driver's current documents, each with a link that expires in 5 minutes. */
router.get('/drivers/:id', async (req, res) => {
  const d = await one(`${USER_SQL} WHERE u.id = $1 AND u.role = 'driver'`, [req.params.id]).catch(() => null);
  if (!d) throw new HttpError(404, 'Driver not found');
  const verification = await driverVerification(d.id);
  const paths = Object.fromEntries((await currentDocs(d.id)).map((doc) => [doc.id, doc.storage_path]));
  for (const item of verification.items) {
    if (!item.doc) continue;
    try {
      item.doc.url = await signedDocUrl(paths[item.doc.id]);
    } catch (err) {
      item.doc.urlError = `Could not create a viewing link (${err.message})`;
    }
  }
  res.json({ driver: publicUser(d), verification });
});

/** Approve, or reject with a reason. Only the newest document of its type can be reviewed. */
router.post('/documents/:id/review', async (req, res) => {
  const decision = req.body?.decision;
  if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'Decision must be approve or reject');
  const reason = String(req.body?.reason ?? '').trim().slice(0, 300);
  if (decision === 'reject' && reason.length < 5) throw new HttpError(400, 'Tell the driver why it was rejected');

  const doc = await one('SELECT * FROM driver_documents WHERE id = $1', [req.params.id]).catch(() => null);
  if (!doc) throw new HttpError(404, 'Document not found');
  const newest = await one('SELECT id FROM driver_documents WHERE driver_id = $1 AND doc_type = $2 ORDER BY created_at DESC LIMIT 1', [doc.driver_id, doc.doc_type]);
  if (newest.id !== doc.id) throw new HttpError(409, 'The driver has uploaded a newer version of this document');

  await query(
    `UPDATE driver_documents SET status = $2, reject_reason = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1`,
    [doc.id, decision === 'approve' ? 'approved' : 'rejected', decision === 'reject' ? reason : null, req.user.id],
  );

  const verification = await driverVerification(doc.driver_id);
  if (decision === 'reject') await notifyIn(doc.driver_id, 'docRejected', { doc: doc.doc_type, reason }, '/documents');
  else if (verification.canDrive) await notifyIn(doc.driver_id, 'approvedToDrive', {}, '/drive');
  else await notifyIn(doc.driver_id, 'docApproved', { doc: doc.doc_type }, '/documents');
  res.json({ verification });
});

// --- trip recordings sent to the safety team (batch F) ----------------------------
// Only recordings a rider or driver chose to send are listed or playable; every play is logged.

router.get('/recordings', async (_req, res) => {
  res.json({ recordings: await heldRecordings() });
});

router.get('/recordings/:id/audio', async (req, res) => {
  const { mime, bytes } = await audioFor(req.user.id, req.params.id);
  res.set({ 'content-type': mime, 'cache-control': 'no-store', 'content-length': String(bytes.length) });
  res.end(bytes);
});

router.delete('/recordings/:id', async (req, res) => {
  await adminDeleteRecording(req.params.id);
  res.json({ ok: true });
});

// --- waterlogging reports (batch G): admins can take down a false or abusive spot ----

router.get('/waterlogging', async (_req, res) => {
  res.json({ spots: await recentSpots() });
});

router.delete('/waterlogging/:id', async (req, res) => {
  await removeSpot(req.user.id, req.params.id);
  res.json({ ok: true });
});

// --- routing (step 11): which service live ETAs use, and today's free quota -----------

router.get('/routing', (_req, res) => {
  res.json(routingStatus());
});

// --- driver payouts (step 12): an admin pays by UPI/bank and records the UTR -----------

router.get('/payouts', async (req, res) => {
  const status = ['requested', 'paid', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : null;
  res.json({ payouts: await listPayouts(status) });
});

router.get('/payouts/:id/details', async (req, res) => {
  res.set('cache-control', 'no-store');
  res.json({ details: await payoutDetails(req.user.id, req.params.id) });
});

router.post('/payouts/:id/paid', async (req, res) => {
  res.json({ payout: await markPayoutPaid(req.user.id, req.params.id, req.body?.reference) });
});

router.post('/payouts/:id/reject', async (req, res) => {
  res.json({ payout: await rejectPayout(req.user.id, req.params.id, req.body?.reason) });
});

export default router;
