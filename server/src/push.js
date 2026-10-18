import webpush from 'web-push';
import { config } from './config.js';
import { many, one, query } from './db.js';
import { HttpError } from './auth.js';

/**
 * Web Push (step 9): notifications that arrive with Hopin's tab closed. Each browser that turns
 * notifications on gives us a push-service endpoint plus its own encryption keys; web-push
 * encrypts every message for that browser and signs the request with Hopin's VAPID key.
 *
 * The endpoint URL comes from the browser, and the server POSTs to it, so only the real push
 * services are accepted. Otherwise anyone could make Hopin's server call any address.
 */

const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
const MAX_FAILURES = 5;

export const pushEnabled = () => Boolean(config.push.publicKey && config.push.privateKey && config.push.subject);
export const PUSH_OFF = 'Push notifications are not set up on this server.';

function allowedEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (config.push.extraHosts.includes(url.hostname)) return true;
  return url.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(url.hostname));
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export async function subscribe(user, sub, userAgent) {
  if (!pushEnabled()) throw new HttpError(503, PUSH_OFF);
  const endpoint = String(sub?.endpoint ?? '');
  const p256dh = String(sub?.keys?.p256dh ?? '');
  const auth = String(sub?.keys?.auth ?? '');
  if (!allowedEndpoint(endpoint) || endpoint.length > 1000) throw new HttpError(400, 'That is not a browser push subscription');
  if (!B64URL.test(p256dh) || !B64URL.test(auth) || p256dh.length > 200 || auth.length > 50) throw new HttpError(400, 'That is not a browser push subscription');
  // The same browser can switch accounts: the subscription follows whoever signed in last.
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4, user_agent = $5, failures = 0`,
    [user.id, endpoint, p256dh, auth, String(userAgent ?? '').slice(0, 300) || null],
  );
}

export async function unsubscribe(user, endpoint) {
  await query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [user.id, String(endpoint ?? '')]);
}

export async function deviceCount(userId) {
  return (await one('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [userId])).n;
}

/**
 * Sends to every browser the user turned notifications on in. Gone subscriptions (404/410) are
 * removed; repeated failures too. Returns how many push services accepted the message.
 */
export async function sendPush(userId, { title, body = '', link = null, tag = null }) {
  if (!pushEnabled()) return { sent: 0, failed: 0 };
  const subs = await many('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]);
  const payload = JSON.stringify({ title, body, link, tag });
  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        // web-push encrypts the message for this browser and signs the request (VAPID);
        // fetch sends it, so the same code runs against the test stand-in.
        const req = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          TTL: 10 * 60, // a ride update older than 10 minutes is not worth showing
          urgency: 'high',
          vapidDetails: { subject: config.push.subject, publicKey: config.push.publicKey, privateKey: config.push.privateKey },
        });
        const res = await fetch(req.endpoint, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw Object.assign(new Error(`push service answered ${res.status}`), { statusCode: res.status });
        sent++;
        await query('UPDATE push_subscriptions SET last_used_at = now(), failures = 0 WHERE id = $1', [s.id]);
      } catch (err) {
        failed++;
        if (err.statusCode === 404 || err.statusCode === 410 || s.failures + 1 >= MAX_FAILURES) {
          await query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
        } else {
          await query('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1', [s.id]);
          console.warn(`[push] send failed (${err.statusCode ?? err.message})`);
        }
      }
    }),
  );
  return { sent, failed };
}
