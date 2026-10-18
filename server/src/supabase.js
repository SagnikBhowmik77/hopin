import { config } from './config.js';

/**
 * Small helpers for Supabase Auth's HTTP API. Admin calls use the secret key and
 * only ever run on the server.
 */

async function call(path, { key, method = 'GET', body } = {}) {
  const res = await fetch(`${config.supabase.issuer}${path}`, {
    method,
    headers: { apikey: key, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.message || data.error_description || `Supabase returned ${res.status}`);
  return data;
}

// Which sign-in methods are switched on, read from Supabase itself (cached 1 minute).
let providersCache = { at: 0, value: null };
export async function enabledProviders() {
  if (providersCache.value && Date.now() - providersCache.at < 60_000) return providersCache.value;
  const s = await call('/settings', { key: config.supabase.publishableKey });
  const value = {
    email: Boolean(s.external?.email),
    google: Boolean(s.external?.google),
    // On only when a phone provider (Twilio) is configured in the Supabase dashboard.
    phone: Boolean(s.external?.phone),
    emailConfirmRequired: !s.mailer_autoconfirm,
  };
  providersCache = { at: Date.now(), value };
  return value;
}

/** Test hook: forget cached provider settings. */
export function resetProvidersCache() {
  providersCache = { at: 0, value: null };
}

/** The Supabase Auth user record (server-only; needs the secret key). */
export function adminGetUser(id) {
  if (!config.supabase.secretKey) throw new Error('SUPABASE_SECRET_KEY is not set');
  return call(`/admin/users/${encodeURIComponent(id)}`, { key: config.supabase.secretKey });
}

export function adminCreateUser(body) {
  return call('/admin/users', { key: config.supabase.secretKey, method: 'POST', body });
}

export function adminDeleteUser(id) {
  return call(`/admin/users/${encodeURIComponent(id)}`, { key: config.supabase.secretKey, method: 'DELETE' });
}
