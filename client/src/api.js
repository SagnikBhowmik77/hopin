// The access token comes from the live Supabase session (see session.jsx), which
// refreshes it automatically before it expires.
let getToken = async () => null;
export function setTokenProvider(fn) {
  getToken = fn;
}
export const currentToken = () => getToken();

// Empty in dev (Vite proxies /api). In production set VITE_API_URL to the API host,
// e.g. https://hopin-api.onrender.com, when the frontend is hosted separately.
export const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
export const apiUrl = (path) => `${API_URL}/api${path}`;

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const token = await getToken();
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      signal,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Cannot reach Hopin. Is the server running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data.code);
  return data;
}

export const post = (path, body) => api(path, { method: 'POST', body: body ?? {} });

/** Fetches an authenticated file (e.g. a PDF receipt) and saves it. */
export async function download(path, filename) {
  const res = await fetch(apiUrl(path), { headers: { authorization: `Bearer ${await getToken()}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || 'Download failed');
  }
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
