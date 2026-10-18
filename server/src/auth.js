import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.js';
import { one } from './db.js';
import { enabledProviders } from './supabase.js';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    // Machine-readable reason, e.g. PROFILE_REQUIRED, for the app to act on.
    if (code) this.code = code;
  }
}

export const USER_SQL = `
  SELECT u.*, v.type AS vehicle_type, v.model AS vehicle_model, v.plate AS vehicle_plate
  FROM users u LEFT JOIN vehicles v ON v.driver_id = u.id`;

export const loadUser = (id) => one(`${USER_SQL} WHERE u.id = $1`, [id]);

export function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    phoneVerified: u.phone_verified,
    role: u.role,
    avatar: u.avatar ?? null,
    rating: Math.round(u.rating * 10) / 10,
    ratingCount: u.rating_count,
    walletBalance: u.wallet_balance,
    defaultPayment: u.default_payment,
    emergencyContacts: u.emergency_contacts ?? [],
    // The rider's own trip PIN (their own profile only; drivers see it only when the rider shows it).
    tripPin: u.trip_pin ?? null,
    driverDeaf: Boolean(u.driver_deaf),
    shareTripsWithFamily: Boolean(u.share_trips_with_family),
    // Language for notifications and texts Hopin sends (step 10).
    language: u.language ?? 'en',
    vehicle: u.vehicle_type ? { type: u.vehicle_type, model: u.vehicle_model, plate: u.vehicle_plate } : null,
    createdAt: u.created_at,
  };
}

// --- Supabase access tokens ---------------------------------------------------
// Sign-in happens in Supabase Auth (email + password with verification, or Google).
// The app sends the resulting access token; Hopin checks its signature against the
// project's public keys, its issuer, audience and expiry. Keys are fetched once
// and cached by jose, and refetched when Supabase rotates them.

let jwks = null;

export function authConfigured() {
  return Boolean(config.supabase.url);
}

/** Verifies a Supabase access token and returns its claims, or throws HttpError 401. */
export async function verifyAccessToken(token) {
  if (!authConfigured()) throw new HttpError(503, 'Sign-in is not set up on this server (SUPABASE_URL is missing).');
  if (!token) throw new HttpError(401, 'Please sign in');
  jwks ??= createRemoteJWKSet(new URL(config.supabase.jwksUrl));
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, { issuer: config.supabase.issuer, audience: 'authenticated' }));
  } catch {
    throw new HttpError(401, 'Your session has expired. Please sign in again.');
  }
  // Anonymous Supabase sessions are not Hopin accounts.
  if (payload.is_anonymous || !payload.sub || !payload.email) throw new HttpError(401, 'Please sign in');
  return payload;
}

const bearer = (req) => {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
};

/** The signed-in Supabase identity, whether or not a Hopin profile exists yet. */
export async function requireSession(req, _res, next) {
  try {
    const claims = await verifyAccessToken(bearer(req));
    req.identity = {
      id: claims.sub,
      email: String(claims.email).toLowerCase(),
      provider: claims.app_metadata?.provider ?? 'email',
      // Supabase fills these from Google; empty for email sign-ups.
      name: claims.user_metadata?.full_name || claims.user_metadata?.name || '',
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** Signed in AND has a Hopin profile. Sets req.user to the full profile row. */
export async function requireAuth(req, res, next) {
  await requireSession(req, res, async (err) => {
    if (err) return next(err);
    const user = await loadUser(req.identity.id);
    if (!user) return next(new HttpError(403, 'Finish setting up your profile first', 'PROFILE_REQUIRED'));
    req.user = user;
    next();
  });
}

/** For Socket.IO: the profile behind a token, or null if the token or profile is missing. */
export async function userFromToken(token) {
  try {
    const claims = await verifyAccessToken(token);
    return await loadUser(claims.sub);
  } catch {
    return null;
  }
}

/**
 * Riders must have a verified mobile to book and drivers to take rides - but only
 * once SMS verification is actually switched on in Supabase; before that nobody
 * could verify, so nobody is blocked.
 */
export async function phoneCheck(user) {
  if (user.phone_verified) return null;
  let providers;
  try {
    providers = await enabledProviders();
  } catch (err) {
    return new HttpError(502, `Could not reach Supabase Auth (${err.message})`);
  }
  return providers.phone ? new HttpError(403, 'Verify your mobile number in Profile first.', 'PHONE_UNVERIFIED') : null;
}

export async function requireVerifiedPhone(req, _res, next) {
  next((await phoneCheck(req.user)) ?? undefined);
}

export const requireRole =
  (...roles) =>
  (req, _res, next) =>
    roles.includes(req.user.role) ? next() : next(new HttpError(403, `Only ${roles.join(' or ')}s can do that`));
