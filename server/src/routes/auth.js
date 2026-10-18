import { Router } from 'express';
import { HttpError, authConfigured, loadUser, publicUser, requireAuth, requireSession } from '../auth.js';
import { config } from '../config.js';
import { query, tx, isUniqueViolation } from '../db.js';
import { VEHICLE_TYPES } from '../fare.js';
import { adminGetUser, enabledProviders } from '../supabase.js';

const router = Router();
// Indian mobile numbers, with or without +91.
export const PHONE_RE = /^(\+91)?[6-9]\d{9}$/;

export const normalizePhone = (p) => {
  const digits = String(p ?? '').replace(/[\s-]/g, '');
  return digits ? (digits.startsWith('+91') ? digits : `+91${digits}`) : null;
};

export function cleanVehicle(v) {
  if (!VEHICLE_TYPES.includes(v?.type)) throw new HttpError(400, 'Pick a vehicle type');
  const model = String(v.model ?? '').trim().slice(0, 60);
  const plate = String(v.plate ?? '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 16);
  if (!model || !plate) throw new HttpError(400, 'Vehicle model and number plate are required');
  return { type: v.type, model, plate };
}

/**
 * Public settings the app needs to start Supabase sign-in. The publishable key is
 * designed to be public; the secret key never leaves the server.
 */
router.get('/config', async (_req, res) => {
  if (!authConfigured() || !config.supabase.publishableKey) {
    throw new HttpError(503, 'Sign-in is not set up on this server (Supabase keys are missing).');
  }
  let providers;
  try {
    providers = await enabledProviders();
  } catch (err) {
    throw new HttpError(502, `Could not reach Supabase Auth (${err.message})`);
  }
  res.json({ supabaseUrl: config.supabase.url, publishableKey: config.supabase.publishableKey, providers });
});

/** The signed-in person's Hopin profile, or a prompt to create one. */
router.get('/me', requireSession, async (req, res) => {
  const user = await loadUser(req.identity.id);
  if (user) return res.json({ user: publicUser(user) });
  res.json({ user: null, needsProfile: true, identity: { email: req.identity.email, name: req.identity.name, provider: req.identity.provider } });
});

/**
 * First-time profile after signing in with Supabase: name, mobile, rider or driver
 * (+ vehicle). The email comes from the verified Supabase token, not the request.
 */
router.post('/profile', requireSession, async (req, res) => {
  const { name, phone, role, vehicle, language } = req.body ?? {};
  // The language picked on the sign-in screen (step 10); anything else falls back to English.
  const lang = language === 'hi' ? 'hi' : 'en';
  if (await loadUser(req.identity.id)) throw new HttpError(409, 'Your profile already exists');
  const cleanName = String(name ?? '').trim().slice(0, 60);
  if (!cleanName) throw new HttpError(400, 'Name is required');
  if (!PHONE_RE.test(String(phone ?? '').replace(/[\s-]/g, ''))) throw new HttpError(400, 'Enter a valid 10-digit mobile number');
  // Admin accounts are only created with `npm run create-admin`, never here.
  if (!['rider', 'driver'].includes(role)) throw new HttpError(400, 'Choose whether you ride or drive');
  const v = role === 'driver' ? cleanVehicle(vehicle) : null;

  try {
    await tx(async ({ query: q }) => {
      await q(`INSERT INTO users (id, name, email, phone, role, language) VALUES ($1, $2, $3, $4, $5, $6)`, [
        req.identity.id,
        cleanName,
        req.identity.email,
        normalizePhone(phone),
        role,
        lang,
      ]);
      if (v) await q('INSERT INTO vehicles (driver_id, type, model, plate) VALUES ($1, $2, $3, $4)', [req.identity.id, v.type, v.model, v.plate]);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'That mobile number is already used by another account');
    throw err;
  }
  res.status(201).json({ user: publicUser(await loadUser(req.identity.id)) });
});

/**
 * Called after the app has confirmed a number with Supabase (SMS code sent by
 * Twilio). Hopin does not take the app's word for it: it asks Supabase's admin API
 * whether this account's phone is confirmed, and only then marks it verified.
 */
router.post('/phone/sync', requireAuth, async (req, res) => {
  let providers;
  try {
    providers = await enabledProviders();
  } catch (err) {
    throw new HttpError(502, `Could not reach Supabase Auth (${err.message})`);
  }
  if (!providers.phone) throw new HttpError(503, 'SMS verification is not switched on yet.');

  let authUser;
  try {
    authUser = await adminGetUser(req.user.id);
  } catch (err) {
    throw new HttpError(502, `Could not check your number with Supabase (${err.message})`);
  }
  if (!authUser.phone || !authUser.phone_confirmed_at) {
    throw new HttpError(409, 'Your number is not confirmed yet. Enter the code we sent you by SMS.');
  }
  // Supabase stores numbers without the leading "+".
  const confirmed = `+${String(authUser.phone).replace(/^\+/, '')}`;
  if (!/^\+91[6-9]\d{9}$/.test(confirmed)) throw new HttpError(409, 'Only Indian mobile numbers are supported.');
  try {
    await query('UPDATE users SET phone = $2, phone_verified = true WHERE id = $1', [req.user.id, confirmed]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'That mobile number is already used by another Hopin account');
    throw err;
  }
  res.json({ user: publicUser(await loadUser(req.user.id)) });
});

export default router;
