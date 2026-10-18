import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';

/**
 * Rate limits per IP (step 13). They stop password/OTP guessing, booking and report spam, and
 * protect the free services Hopin leans on (Nominatim geocoding, Twilio, OpenRouteService).
 * Limits are counted in this server's memory; with several servers they would need a shared store.
 *
 * SOS has no limit of its own beyond the general one: blocking an emergency is worse than abuse.
 */

const MIN = 60_000;

function limiter(limit, windowMs, message) {
  return rateLimit({
    windowMs,
    limit: Math.round(limit * config.rateLimit.scale),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: message },
  });
}

const slowDown = 'Too many requests. Wait a minute and try again.';

export function applyLimits(app) {
  // Everything under /api: generous, since a live ride polls and sends GPS updates.
  app.use('/api', limiter(900, 5 * MIN, slowDown));

  // Profile creation and phone verification: brute-force protection. Only the actions are
  // limited: every app start reads GET /api/auth/config and /me, and a family or office behind
  // one IP must not lock itself out. (Passwords and OTPs are checked by Supabase, not here.)
  const signIn = limiter(40, 15 * MIN, 'Too many sign-in attempts. Try again in a few minutes.');
  app.post('/api/auth/profile', signIn);
  app.post('/api/auth/phone/sync', signIn);

  // Place search / reverse geocoding hit the free Nominatim server (its policy: be gentle).
  app.use('/api/geo', limiter(90, MIN, slowDown));

  // Quotes run as the rider types; bookings, reports and payouts are rarer.
  app.post('/api/rides/quote', limiter(90, MIN, slowDown));
  const actions = limiter(30, 10 * MIN, 'You have done that many times in a short while. Wait a few minutes and try again.');
  app.post('/api/rides', actions);
  app.post('/api/support/tickets', actions);
  app.post('/api/waterlogging', actions);
  app.post('/api/recordings', actions);
  app.post('/api/driver/payouts', actions);
  app.put('/api/driver/payout-method', actions);
  app.post('/api/push/test', limiter(10, 10 * MIN, slowDown));
  app.post('/api/payments/razorpay/order', limiter(30, 10 * MIN, slowDown));
  // These send SMS (costs money, could be used to spam strangers).
  app.post('/api/family', actions);
  app.post('/api/rides/:id/splits', actions);
}
