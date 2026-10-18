import express, { Router } from 'express';
import { HttpError, requireAuth, requireRole } from '../auth.js';
import { many, one, query, tx } from '../db.js';
import { DOC_TYPES, driverVerification } from '../driverDocs.js';
import { breakMessage, buyPass, cleanHome, fatigue, homeUsesLeft, passPrices, passToday, todayIST, useHeadingHome } from '../drivers.js';
import { driverPresence, driverQueueInfo, emitToAdmins, setHeadingHome } from '../hub.js';
import { notify } from '../notify.js';
import { helmetStatus } from '../helmet.js';
import { config } from '../config.js';
import { cancelPayout, getMethod, myPayouts, payoutsEnabled, requestPayout, setMethod } from '../payouts.js';
import { MAX_DOC_BYTES, removeDocs, signedDocUrl, sniffMime, storageConfigured, uploadDoc } from '../storage.js';

const router = Router();
router.use(requireAuth, requireRole('driver'));

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };

// --- daily pass, heading home, fatigue, station queue (step 8b, batch D) ------------

/** Today's pass, and what one costs for this driver's vehicle. */
router.get('/pass', async (req, res) => {
  const prices = await passPrices();
  res.json({ today: await passToday(req.user.id), price: prices?.[req.user.vehicle_type] ?? null, walletBalance: req.user.wallet_balance });
});

/** Buy today's pass from the wallet. Online: POST /api/payments/razorpay/order (kind 'driver_pass'). */
router.post('/pass', async (req, res) => {
  if (!req.user.vehicle_type) throw new HttpError(400, 'Add your vehicle in your profile first');
  const price = (await passPrices())?.[req.user.vehicle_type];
  if (!price) throw new HttpError(503, 'Daily pass prices are not set yet');
  const ref = `PASS-WALLET-${req.user.id}-${todayIST()}`;
  const row = await tx(({ query: q }) => buyPass(q, { driverId: req.user.id, price, ref, fromWallet: true }));
  if (!row) throw new HttpError(409, 'You already have a pass for today');
  res.status(201).json({ today: await passToday(req.user.id) });
});

router.get('/home', async (req, res) => {
  const p = driverPresence(req.user.id);
  res.json({ home: req.user.home_place ?? null, headingHome: Boolean(p?.headingHome), usesLeft: await homeUsesLeft(req.user.id) });
});

router.put('/home', async (req, res) => {
  const home = cleanHome(req.body?.home);
  await query('UPDATE users SET home_place = $2 WHERE id = $1', [req.user.id, JSON.stringify(home)]);
  res.json({ home });
});

/** Switch "heading home" on (counts one of today's uses) or off. */
router.post('/heading-home', async (req, res) => {
  if (req.body?.on !== true) {
    setHeadingHome(req.user.id, null);
    return res.json({ headingHome: false, usesLeft: await homeUsesLeft(req.user.id) });
  }
  if (!req.user.home_place) throw new HttpError(400, 'Set your home location first');
  if (!driverPresence(req.user.id)?.online) throw new HttpError(409, 'Go online first');
  const usesLeft = await useHeadingHome(req.user.id);
  setHeadingHome(req.user.id, req.user.home_place);
  res.json({ headingHome: true, usesLeft });
});

router.get('/fatigue', async (req, res) => {
  const f = await fatigue(req.user.id);
  res.json({ ...f, message: f.needsBreak ? breakMessage(f) : null });
});

router.get('/station', async (req, res) => {
  res.json({ queue: await driverQueueInfo(req.user.id) });
});

// --- daily helmet selfie (bike drivers) -------------------------------------------

router.get('/helmet', async (req, res) => {
  res.json(await helmetStatus(req.user.id, req.user.vehicle_type));
});

router.put('/helmet', express.raw({ type: () => true, limit: MAX_DOC_BYTES + 1 }), async (req, res) => {
  if (!storageConfigured()) throw new HttpError(503, 'Photo storage is not set up on this server.');
  if (req.user.vehicle_type !== 'bike') throw new HttpError(400, 'Helmet selfies are only for bike drivers');
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!bytes.length) throw new HttpError(400, 'Take a photo first');
  if (bytes.length > MAX_DOC_BYTES) throw new HttpError(413, 'Photos must be 5 MB or smaller');
  const mime = sniffMime(bytes);
  if (mime !== 'image/jpeg' && mime !== 'image/png') throw new HttpError(400, 'Use a JPG or PNG photo');

  const path = `${req.user.id}/helmet-${Date.now()}.${EXT[mime]}`;
  try {
    await uploadDoc(path, bytes, mime);
  } catch (err) {
    throw new HttpError(502, `Could not store the photo (${err.message})`);
  }
  try {
    await one('INSERT INTO helmet_checks (driver_id, storage_path, mime_type, taken_on) VALUES ($1, $2, $3, $4::date) RETURNING id', [
      req.user.id, path, mime, todayIST(),
    ]);
  } catch (err) {
    await removeDocs([path]).catch(() => {});
    throw err;
  }
  emitToAdmins('helmet-check', { driverId: req.user.id });
  res.status(201).json(await helmetStatus(req.user.id, req.user.vehicle_type));
});

router.get('/verification', async (req, res) => {
  res.json(await driverVerification(req.user.id));
});

/**
 * Upload one document. The file is the raw request body (so no form library is
 * needed); the number and expiry date come as query values. The real file type
 * is read from its first bytes, and only JPEG, PNG and PDF up to 5 MB are taken.
 */
router.put('/documents/:type', express.raw({ type: () => true, limit: MAX_DOC_BYTES + 1 }), async (req, res) => {
  if (!storageConfigured()) throw new HttpError(503, 'Document storage is not set up on this server.');
  const type = req.params.type;
  const spec = DOC_TYPES[type];
  if (!spec) throw new HttpError(404, 'Unknown document type');

  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!bytes.length) throw new HttpError(400, 'Choose a file to upload');
  if (bytes.length > MAX_DOC_BYTES) throw new HttpError(413, 'Files must be 5 MB or smaller');
  const mime = sniffMime(bytes);
  if (!mime) throw new HttpError(400, 'Upload a JPG, PNG or PDF file');

  const plate = req.user.vehicle_plate;
  if (spec.perVehicle && !plate) throw new HttpError(400, 'Add your vehicle in Profile first');

  let number = null;
  if (type === 'vehicle_rc') number = plate; // the RC number is the vehicle's registration number
  else if (spec.number) {
    number = String(req.query.number ?? '').trim().toUpperCase().replace(/\s+/g, ' ').slice(0, 40);
    if (number.replace(/[^A-Z0-9]/g, '').length < 5) throw new HttpError(400, `Enter the ${spec.number.toLowerCase()}`);
  }
  let expires = null;
  if (spec.expires) {
    expires = String(req.query.expires ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(Date.parse(expires))) throw new HttpError(400, 'Enter the expiry date');
    if (expires < todayIST()) throw new HttpError(400, 'This document has already expired');
  }

  const path = `${req.user.id}/${type}-${Date.now()}.${EXT[mime]}`;
  try {
    await uploadDoc(path, bytes, mime);
  } catch (err) {
    throw new HttpError(502, `Could not store the file (${err.message})`);
  }
  try {
    await one(
      `INSERT INTO driver_documents (driver_id, doc_type, storage_path, mime_type, size_bytes, doc_number, expires_on, vehicle_plate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [req.user.id, type, path, mime, bytes.length, number, expires, spec.perVehicle ? plate : null],
    );
  } catch (err) {
    // Don't leave an orphan file in storage if the record could not be saved.
    await removeDocs([path]).catch(() => {});
    throw err;
  }

  emitToAdmins('driver-docs', { driverId: req.user.id });
  const admins = await many(`SELECT id FROM users WHERE role = 'admin'`);
  for (const a of admins) await notify(a.id, 'Document to review', `${req.user.name} uploaded: ${spec.label}.`, '/admin');
  res.status(201).json(await driverVerification(req.user.id));
});

/** A 5-minute link to one of your own documents. */
router.get('/documents/:id/url', async (req, res) => {
  const d = await one('SELECT storage_path FROM driver_documents WHERE id = $1 AND driver_id = $2', [req.params.id, req.user.id]).catch(() => null);
  if (!d) throw new HttpError(404, 'Document not found');
  res.json({ url: await signedDocUrl(d.storage_path), expiresInSeconds: 300 });
});

// --- payouts (step 12): withdraw wallet earnings to UPI/bank, paid by an admin ---------

router.get('/payouts', async (req, res) => {
  const wallet = await one('SELECT wallet_balance FROM users WHERE id = $1', [req.user.id]);
  res.json({
    enabled: payoutsEnabled(),
    minAmount: config.payouts.minAmount,
    walletBalance: wallet.wallet_balance,
    method: await getMethod(req.user.id),
    payouts: await myPayouts(req.user.id),
  });
});

router.put('/payout-method', async (req, res) => {
  res.json({ method: await setMethod(req.user.id, req.body) });
});

router.post('/payouts', async (req, res) => {
  res.status(201).json({ payout: await requestPayout(req.user, req.body?.amount) });
});

router.post('/payouts/:id/cancel', async (req, res) => {
  res.json({ payout: await cancelPayout(req.user, req.params.id) });
});

export default router;
