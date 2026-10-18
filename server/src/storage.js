import { config } from './config.js';

/**
 * Supabase Storage, server side only (secret key). Driver documents go in a
 * PRIVATE bucket: no public URLs exist, and files are only ever shown through
 * signed links that expire after a few minutes.
 */

export const DOCS_BUCKET = 'driver-documents';
export const MAX_DOC_BYTES = 5 * 1024 * 1024;
export const DOC_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

const base = () => `${config.supabase.url}/storage/v1`;
const headers = (extra = {}) => ({ apikey: config.supabase.secretKey, authorization: `Bearer ${config.supabase.secretKey}`, ...extra });

export const storageConfigured = () => Boolean(config.supabase.url && config.supabase.secretKey);

async function call(path, { method = 'GET', body, json, contentType, raw = false } = {}) {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: headers(json ? { 'content-type': 'application/json' } : contentType ? { 'content-type': contentType } : {}),
    body: json ? JSON.stringify(json) : body,
    signal: AbortSignal.timeout(20_000),
  });
  if (raw && res.ok) return Buffer.from(await res.arrayBuffer());
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Storage returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Creates a PRIVATE bucket if it does not exist, and makes sure it stays private. */
export async function ensureBucket(id, { fileSizeLimit, mimeTypes }) {
  const settings = { public: false, file_size_limit: fileSizeLimit, allowed_mime_types: mimeTypes };
  try {
    const bucket = await call(`/bucket/${id}`);
    if (bucket.public) await call(`/bucket/${id}`, { method: 'PUT', json: { id, ...settings } });
    return 'exists';
  } catch (err) {
    if (err.status !== 404 && err.status !== 400) throw err;
  }
  await call('/bucket', { method: 'POST', json: { id, name: id, ...settings } });
  return 'created';
}

export const uploadObject = (bucket, path, bytes, mimeType) =>
  call(`/object/${bucket}/${path}`, { method: 'POST', body: bytes, contentType: mimeType });

/** The stored bytes, read with the secret key (never through a public or signed link). */
export const downloadObject = (bucket, path) => call(`/object/${bucket}/${path}`, { raw: true });

export const removeObjects = (bucket, paths) => call(`/object/${bucket}`, { method: 'DELETE', json: { prefixes: paths } });

export const ensureDocsBucket = () => ensureBucket(DOCS_BUCKET, { fileSizeLimit: MAX_DOC_BYTES, mimeTypes: DOC_MIME_TYPES });
export const uploadDoc = (path, bytes, mimeType) => uploadObject(DOCS_BUCKET, path, bytes, mimeType);
export const removeDocs = (paths) => removeObjects(DOCS_BUCKET, paths);

/** A link to one private file that stops working after `seconds`. */
export async function signedDocUrl(path, seconds = 300) {
  const data = await call(`/object/sign/${DOCS_BUCKET}/${path}`, { method: 'POST', json: { expiresIn: seconds } });
  const rel = data.signedURL ?? data.signedUrl;
  return `${base()}${rel.startsWith('/') ? '' : '/'}${rel}`;
}

/** Checks the file's first bytes, not just the type the browser claims. */
export function sniffMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}
