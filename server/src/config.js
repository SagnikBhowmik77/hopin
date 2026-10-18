import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(root, '.data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Optional .env next to package.json. Real environment variables win.
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile?.(envFile);

const env = process.env;
const supabaseUrl = (env.SUPABASE_URL || '').replace(/\/+$/, '');

export const config = {
  port: Number(env.PORT) || 8720,
  // Public URL of the web app; used for payment redirects, share links and emails.
  appUrl: env.APP_URL || 'http://localhost:5190',
  // Supabase: Connect -> Session pooler URI.
  databaseUrl: env.DATABASE_URL || '',
  // Supabase Auth handles sign-in. Hopin checks its ES256-signed access tokens
  // against the project's published public keys (JWKS); no shared secret needed.
  supabase: {
    url: supabaseUrl,
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY || '',
    // Server-only. Used for admin actions (creating the admin account).
    secretKey: env.SUPABASE_SECRET_KEY || '',
    issuer: supabaseUrl ? `${supabaseUrl}/auth/v1` : '',
    jwksUrl: supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : '',
  },
  requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS) || 120_000,
  // Behind a host's proxy (Render, Railway, Nginx...) set TRUST_PROXY=1 so rate limits see each
  // user's real IP instead of the proxy's (otherwise everyone shares one limit).
  trustProxy: env.TRUST_PROXY ? (Number.isNaN(Number(env.TRUST_PROXY)) ? env.TRUST_PROXY : Number(env.TRUST_PROXY)) : false,
  // Requests per IP per window (step 13). `scale` multiplies every limit (tests raise it).
  rateLimit: { scale: Number(env.RATE_LIMIT_SCALE) || 1 },
  dispatchRadiusKm: Number(env.DISPATCH_RADIUS_KM) || 15,
  // Rider cancels later than this after a driver accepted -> cancellation fee.
  freeCancelMs: Number(env.FREE_CANCEL_MS) || 120_000,
  // Share of each fare paid out to the driver.
  driverShare: 0.8,
  osrmUrl: env.OSRM_URL || 'https://router.project-osrm.org',
  photonUrl: env.PHOTON_URL || 'https://photon.komoot.io',
  nominatimUrl: env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
  offlineGeo: env.HOPIN_OFFLINE_GEO === '1',
  // OpenRouteService (step 11): road-route ETAs on live trips. Free key: 2,000 directions a day.
  ors: {
    key: env.ORS_API_KEY || '',
    url: (env.ORS_URL || 'https://api.openrouteservice.org').replace(/\/+$/, ''),
    refreshMs: Number(env.LIVE_ETA_REFRESH_MS) || 30_000,
  },
  // Scheduled rides (step 8): bookable from `minAheadMin` to `maxDays` ahead; offered to
  // drivers `leadMin` before pickup and kept open until `graceMin` after it.
  schedule: {
    leadMin: Number(env.SCHEDULE_LEAD_MIN) || 15,
    minAheadMin: Number(env.SCHEDULE_MIN_AHEAD_MIN) || 30,
    maxDays: Number(env.SCHEDULE_MAX_DAYS) || 7,
    graceMin: Number(env.SCHEDULE_GRACE_MIN) || 5,
    maxUpcoming: 5,
    tickMs: Number(env.SCHEDULE_TICK_MS) || 20_000,
  },
  // Long unplanned stop during a trip (step 8b): within `radiusM` for `minutes`, and not
  // within `plannedPlaceM` of the pickup, a planned stop or the drop.
  longStop: {
    minutes: Number(env.LONG_STOP_MINUTES) || 6,
    radiusM: 60,
    plannedPlaceM: 150,
  },
  // "Reached safely?" after trips that end between startHour and endHour (India time):
  // no reply within replyMinutes texts the rider's emergency contacts and alerts admins.
  nightCheck: {
    startHour: env.NIGHT_CHECK_START_HOUR ? Number(env.NIGHT_CHECK_START_HOUR) : 22,
    endHour: env.NIGHT_CHECK_END_HOUR ? Number(env.NIGHT_CHECK_END_HOUR) : 6,
    replyMinutes: Number(env.NIGHT_CHECK_REPLY_MINUTES) || 10,
  },
  // Web Push (step 9). VAPID keys are generated locally; browser push services are free.
  push: {
    publicKey: env.VAPID_PUBLIC_KEY || '',
    privateKey: env.VAPID_PRIVATE_KEY || '',
    subject: env.VAPID_SUBJECT || '',
    // Extra endpoint hosts to accept besides the real push services (tests only).
    extraHosts: (env.PUSH_EXTRA_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
  },
  // Driver payouts, paid by hand by an admin (step 12). `key` (32 bytes, base64) encrypts the
  // drivers' bank/UPI details at rest; without it payouts are off.
  payouts: {
    key: env.PAYOUT_KEY || '',
    minAmount: Number(env.PAYOUT_MIN) || 100,
  },
  // Trip audio recording (step 8b batch F). `key` = 32 random bytes, base64 (AES-256-GCM).
  // Without it recording is off. Unreported recordings are deleted `keepDays` after they end.
  recording: {
    key: env.RECORDING_KEY || '',
    maxHours: 3,
    keepDays: Number(env.RECORDING_KEEP_DAYS) || 7,
    chunkMaxBytes: 1024 * 1024,
    // No chunk for this long (app closed, phone died) ends the recording.
    idleMinutes: 10,
  },
  // Above this speed (from the driver's own GPS) drivers can only send quick replies.
  driverTypingMaxKmh: 10,
  // Route-deviation alerts (step 7): further than `meters` from the planned route for
  // `seconds` raises an alert; it clears once the driver is within `backMeters` again.
  // GPS fixes less accurate than `maxAccuracyM` are ignored so a bad signal is not an alarm.
  deviation: {
    meters: Number(env.DEVIATION_METERS) || 500,
    seconds: Number(env.DEVIATION_SECONDS) || 30,
    backMeters: Number(env.DEVIATION_BACK_METERS) || 300,
    maxAccuracyM: Number(env.DEVIATION_MAX_ACCURACY_M) || 100,
  },
  // Razorpay: cards, UPI, netbanking, wallet top-ups. rzp_test_ keys = Razorpay's sandbox (no real money).
  razorpay: {
    keyId: env.RAZORPAY_KEY_ID || '',
    keySecret: env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
    apiUrl: env.RAZORPAY_API_URL || 'https://api.razorpay.com',
  },
  // Twilio Messaging, used by Hopin's server for SOS texts. (Login OTPs are sent by
  // Supabase with its own Twilio settings in the Supabase dashboard.)
  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID || '',
    authToken: env.TWILIO_AUTH_TOKEN || '',
    // A Twilio phone number (+1...) or a Messaging Service SID (MG...).
    from: env.TWILIO_FROM || '',
    apiUrl: env.TWILIO_API_URL || 'https://api.twilio.com',
  },
  // Any SMTP server (e.g. a Gmail app password). Without it, email features refuse with a clear message.
  smtp: env.SMTP_HOST
    ? { host: env.SMTP_HOST, port: Number(env.SMTP_PORT) || 587, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.MAIL_FROM || env.SMTP_USER }
    : null,
};
