import crypto from 'node:crypto';
import { config } from './config.js';
import { many, one, query, tx, isUniqueViolation } from './db.js';
import { HttpError } from './auth.js';
import { postTxn } from './payments.js';
import { emitToAdmins } from './hub.js';
import { notifyIn } from './messages.js';

/**
 * Driver payouts, paid by hand (step 12). Hopin has no payout API account (RazorpayX needs a
 * registered business), so an admin sends each payout from Hopin's own bank/UPI and records the
 * transfer's UTR here. Nothing is marked paid without that reference.
 *
 * Money: the amount leaves the driver's wallet the moment they ask (kind 'payout'), so it can't
 * also be spent on a pass or withdrawn twice. A rejected or cancelled request puts it back
 * ('payout_reversal'). Both go through postTxn, so the wallet ledger stays exact.
 */

function key() {
  const k = Buffer.from(config.payouts.key, 'base64');
  return k.length === 32 ? k : null;
}
export const payoutsEnabled = () => Boolean(key());
export const PAYOUTS_OFF = 'Payouts are not set up on this server.';

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function unseal(text) {
  const b = Buffer.from(text, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
}

const UPI_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^\d{9,18}$/;
const HOLDER_RE = /^[A-Za-z][A-Za-z .'-]{1,79}$/;
const UTR_RE = /^[A-Za-z0-9]{6,35}$/;

function cleanMethod(body) {
  if (body?.kind === 'upi') {
    const vpa = String(body.vpa ?? '').trim().toLowerCase();
    if (!UPI_RE.test(vpa)) throw new HttpError(400, 'Enter a valid UPI ID, like name@okhdfc');
    const [name, handle] = vpa.split('@');
    return { kind: 'upi', details: { vpa }, label: `UPI ${name.slice(0, 2)}***@${handle}` };
  }
  if (body?.kind === 'bank') {
    const holder = String(body.holder ?? '').trim().replace(/\s+/g, ' ');
    const account = String(body.account ?? '').replace(/\s/g, '');
    const ifsc = String(body.ifsc ?? '').trim().toUpperCase();
    if (!HOLDER_RE.test(holder)) throw new HttpError(400, "Enter the account holder's name as the bank has it");
    if (!ACCOUNT_RE.test(account)) throw new HttpError(400, 'Account numbers are 9 to 18 digits');
    if (!IFSC_RE.test(ifsc)) throw new HttpError(400, 'Enter a valid IFSC, like HDFC0001234');
    return { kind: 'bank', details: { holder, account, ifsc }, label: `${ifsc} ····${account.slice(-4)}` };
  }
  throw new HttpError(400, 'Choose UPI or bank account');
}

export async function getMethod(driverId) {
  const m = await one('SELECT kind, label, updated_at FROM payout_methods WHERE driver_id = $1', [driverId]);
  return m && { kind: m.kind, label: m.label, updatedAt: m.updated_at };
}

export async function setMethod(driverId, body) {
  if (!payoutsEnabled()) throw new HttpError(503, PAYOUTS_OFF);
  const m = cleanMethod(body);
  await query(
    `INSERT INTO payout_methods (driver_id, kind, details_enc, label) VALUES ($1, $2, $3, $4)
     ON CONFLICT (driver_id) DO UPDATE SET kind = $2, details_enc = $3, label = $4, updated_at = now()`,
    [driverId, m.kind, seal(m.details), m.label],
  );
  return getMethod(driverId);
}

export const toPayout = (p) => ({
  id: p.id,
  amount: p.amount,
  kind: p.kind,
  label: p.label,
  status: p.status,
  requestedAt: p.requested_at,
  closedAt: p.closed_at,
  reference: p.reference,
  rejectReason: p.reject_reason,
});

export async function myPayouts(driverId) {
  return (await many('SELECT * FROM payout_requests WHERE driver_id = $1 ORDER BY requested_at DESC LIMIT 30', [driverId])).map(toPayout);
}

export async function requestPayout(driver, amountIn) {
  if (!payoutsEnabled()) throw new HttpError(503, PAYOUTS_OFF);
  const amount = Number(amountIn);
  if (!Number.isInteger(amount) || amount < config.payouts.minAmount) throw new HttpError(400, `Withdraw at least ₹${config.payouts.minAmount}, in whole rupees`);
  const method = await one('SELECT * FROM payout_methods WHERE driver_id = $1', [driver.id]);
  if (!method) throw new HttpError(400, 'Add your UPI ID or bank account first');
  try {
    const p = await tx(async ({ query: q }) => {
      const row = (
        await q(`INSERT INTO payout_requests (driver_id, amount, kind, details_enc, label) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [
          driver.id,
          amount,
          method.kind,
          method.details_enc,
          method.label,
        ])
      ).rows[0];
      const ok = await postTxn(q, { userId: driver.id, amount: -amount, kind: 'payout', ref: `payout:${row.id}`, noOverdraw: true });
      if (!ok) throw new HttpError(409, 'Your wallet does not have that much');
      return row;
    });
    emitToAdmins('payout', { id: p.id });
    return toPayout(p);
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'You already have a withdrawal waiting. Cancel it or wait until it is paid.');
    throw err;
  }
}

/** Closes an open request and returns the money to the wallet. */
async function closeWithRefund(id, { status, by, reason = null, driverId = null }) {
  return tx(async ({ query: q }) => {
    const p = (
      await q(
        `UPDATE payout_requests SET status = $2, closed_at = now(), closed_by = $3, reject_reason = $4
         WHERE id = $1 AND status = 'requested' ${driverId ? 'AND driver_id = $5' : ''} RETURNING *`,
        driverId ? [id, status, by, reason, driverId] : [id, status, by, reason],
      )
    ).rows[0];
    if (!p) throw new HttpError(409, 'Only a waiting withdrawal can be changed');
    // wallet_txns.ref is unique, so a request can only ever be returned once.
    await postTxn(q, { userId: p.driver_id, amount: p.amount, kind: 'payout_reversal', ref: `payout-return:${p.id}` });
    return p;
  });
}

export async function cancelPayout(driver, id) {
  return toPayout(await closeWithRefund(id, { status: 'cancelled', by: driver.id, driverId: driver.id }));
}

// --- admins ----------------------------------------------------------------------------

export async function listPayouts(status) {
  const rows = await many(
    `SELECT p.*, u.name AS driver_name, u.phone AS driver_phone,
       (SELECT count(*)::int FROM payout_detail_views v WHERE v.request_id = p.id) AS views
     FROM payout_requests p JOIN users u ON u.id = p.driver_id
     ${status ? 'WHERE p.status = $1' : ''}
     ORDER BY (p.status = 'requested') DESC, p.requested_at DESC LIMIT 200`,
    status ? [status] : [],
  );
  return rows.map((p) => ({ ...toPayout(p), driver: { id: p.driver_id, name: p.driver_name, phone: p.driver_phone }, detailViews: p.views }));
}

/** The full UPI ID / bank details, for the admin making the transfer. Each view is logged. */
export async function payoutDetails(adminId, id) {
  if (!payoutsEnabled()) throw new HttpError(503, PAYOUTS_OFF);
  const p = await one('SELECT * FROM payout_requests WHERE id = $1', [id]);
  if (!p) throw new HttpError(404, 'Payout not found');
  await query('INSERT INTO payout_detail_views (request_id, admin_id) VALUES ($1, $2)', [id, adminId]);
  return { kind: p.kind, ...unseal(p.details_enc) };
}

export async function markPayoutPaid(adminId, id, referenceIn) {
  const reference = String(referenceIn ?? '').trim().toUpperCase();
  if (!UTR_RE.test(reference)) throw new HttpError(400, 'Enter the UTR / UPI reference of the transfer you made (6–35 letters or digits)');
  let p;
  try {
    p = await one(
      `UPDATE payout_requests SET status = 'paid', closed_at = now(), closed_by = $2, reference = $3
       WHERE id = $1 AND status = 'requested' RETURNING *`,
      [id, adminId, reference],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'That reference is already recorded on another payout');
    throw err;
  }
  if (!p) throw new HttpError(409, 'Only a waiting withdrawal can be marked paid');
  await notifyIn(p.driver_id, 'payoutSent', { amount: p.amount, label: p.label, reference }, '/drive');
  return toPayout(p);
}

export async function rejectPayout(adminId, id, reasonIn) {
  const reason = String(reasonIn ?? '').trim().slice(0, 200);
  if (reason.length < 5) throw new HttpError(400, 'Tell the driver why');
  const p = await closeWithRefund(id, { status: 'rejected', by: adminId, reason });
  await notifyIn(p.driver_id, 'payoutRejected', { amount: p.amount, reason }, '/drive');
  return toPayout(p);
}
