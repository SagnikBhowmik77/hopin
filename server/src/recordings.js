import crypto from 'node:crypto';
import { config } from './config.js';
import { many, one, query, tx } from './db.js';
import { HttpError } from './auth.js';
import { emitToAdmins, emitToUser } from './hub.js';
import { downloadObject, ensureBucket, removeObjects, storageConfigured, uploadObject } from './storage.js';

/**
 * Trip audio recording (step 8b, batch F). The rider or the driver records from their own
 * phone; the other person is told. Each 30-second chunk is encrypted here (AES-256-GCM,
 * key in RECORDING_KEY) before it goes to the PRIVATE Supabase bucket, so the stored files
 * are useless without the server's key.
 *
 * Nobody can play a recording, not even the person who made it, unless they send it to the
 * Hopin safety team. That holds it and opens a safety ticket; only admins can then play it,
 * and every play is logged. Anything not sent is deleted `keepDays` after it ends.
 */

export const RECORDINGS_BUCKET = 'trip-recordings';
const LIVE_RIDE = ['accepted', 'arrived', 'ongoing'];
// What browsers' MediaRecorder produces: Chrome/Firefox WebM or Ogg Opus, Safari MP4/AAC.
const MIME_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4'];
// Chunks that arrive this long after the trip ended are still accepted (the last one is in flight).
const LATE_CHUNK_MS = 2 * 60_000;

function key() {
  const k = Buffer.from(config.recording.key, 'base64');
  return k.length === 32 ? k : null;
}

export const recordingEnabled = () => storageConfigured() && Boolean(key());

export const RECORDING_OFF = 'Trip recording is not set up on this server.';

export function ensureRecordingsBucket() {
  // Stored chunks are ciphertext, so the bucket only ever holds opaque bytes.
  return ensureBucket(RECORDINGS_BUCKET, { fileSizeLimit: config.recording.chunkMaxBytes + 1024, mimeTypes: ['application/octet-stream'] });
}

/** iv (12) | tag (16) | ciphertext. The recording id and chunk number are bound in, so chunks can't be swapped. */
export function sealChunk(recordingId, seq, bytes) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(`${recordingId}:${seq}`));
  const body = Buffer.concat([c.update(bytes), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function openChunk(recordingId, seq, sealed) {
  const d = crypto.createDecipheriv('aes-256-gcm', key(), sealed.subarray(0, 12));
  d.setAAD(Buffer.from(`${recordingId}:${seq}`));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
}

/** The first chunk must really be audio in the container the browser said, not any file. */
function looksLike(mime, bytes) {
  if (mime === 'audio/webm') return bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3;
  if (mime === 'audio/ogg') return bytes.subarray(0, 4).toString('latin1') === 'OggS';
  if (mime === 'audio/mp4') return bytes.subarray(4, 8).toString('latin1') === 'ftyp';
  return false;
}

const chunkPath = (rec, seq) => `${rec.ride_id}/${rec.id}/${String(seq).padStart(5, '0')}.bin`;

export const toRecording = (r) =>
  r && {
    id: r.id,
    rideId: r.ride_id,
    role: r.role,
    status: r.status,
    chunks: r.chunks,
    seconds: r.ended_at || r.last_chunk_at ? Math.round((new Date(r.ended_at ?? r.last_chunk_at) - new Date(r.started_at)) / 1000) : 0,
    bytes: Number(r.bytes),
    startedAt: r.started_at,
    endedAt: r.ended_at,
    deleteAfter: r.held ? null : r.delete_after,
    held: r.held,
    ticketId: r.ticket_id,
  };

const otherParty = (ride, userId) => (ride.rider_id === userId ? ride.driver_id : ride.rider_id);

function tell(ride, userId, role, active) {
  const other = otherParty(ride, userId);
  const payload = { rideId: ride.id, role, active };
  if (other) emitToUser(other, 'ride:recording', payload);
  emitToUser(userId, 'ride:recording', payload);
}

/** Who is recording this ride right now. Only the rider and driver of the ride may ask. */
export async function liveOn(rideId, viewerId) {
  const rows = await many(
    `SELECT t.role FROM trip_recordings t JOIN rides r ON r.id = t.ride_id
     WHERE t.ride_id = $1 AND t.status = 'recording' AND $2 IN (r.rider_id, r.driver_id)`,
    [rideId, viewerId],
  );
  return rows.map((r) => r.role);
}

export async function startRecording(user, rideId, mimeType) {
  if (!recordingEnabled()) throw new HttpError(503, RECORDING_OFF);
  const mime = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (!MIME_TYPES.includes(mime)) throw new HttpError(400, 'This phone records audio in a format Hopin does not accept');
  const ride = await one('SELECT id, rider_id, driver_id, status FROM rides WHERE id = $1', [rideId]);
  if (!ride || (ride.rider_id !== user.id && ride.driver_id !== user.id)) throw new HttpError(404, 'Ride not found');
  if (!LIVE_RIDE.includes(ride.status)) throw new HttpError(409, 'You can record only while a driver is on the way or the trip is on');
  const role = ride.rider_id === user.id ? 'rider' : 'driver';

  const rec = await tx(async ({ query: q }) => {
    // A recording left open by a closed tab ends here; its chunks are one complete file.
    await q(
      `UPDATE trip_recordings SET status = CASE WHEN chunks = 0 THEN 'deleted' ELSE 'complete' END,
         ended_at = coalesce(last_chunk_at, now()), deleted_at = CASE WHEN chunks = 0 THEN now() END,
         delete_after = now() + $3 * interval '1 day'
       WHERE ride_id = $1 AND user_id = $2 AND status = 'recording'`,
      [rideId, user.id, config.recording.keepDays],
    );
    return (await q('INSERT INTO trip_recordings (ride_id, user_id, role, mime) VALUES ($1, $2, $3, $4) RETURNING *', [rideId, user.id, role, mime])).rows[0];
  });
  tell(ride, user.id, role, true);
  return rec;
}

export async function addChunk(user, recordingId, seq, bytes) {
  if (!recordingEnabled()) throw new HttpError(503, RECORDING_OFF);
  const rec = await one(
    `SELECT t.*, coalesce(r.completed_at, r.cancelled_at) AS ride_ended_at
     FROM trip_recordings t JOIN rides r ON r.id = t.ride_id WHERE t.id = $1 AND t.user_id = $2`,
    [recordingId, user.id],
  );
  if (!rec) throw new HttpError(404, 'Recording not found');
  if (!Number.isInteger(seq) || seq < 0) throw new HttpError(400, 'Bad chunk number');
  if (seq < rec.chunks) return rec; // a retry of a chunk that already arrived
  if (rec.status !== 'recording') throw new HttpError(409, 'This recording has ended');
  if (seq > rec.chunks) throw new HttpError(409, `Expected chunk ${rec.chunks}`);
  if (!bytes.length) throw new HttpError(400, 'Empty chunk');
  if (bytes.length > config.recording.chunkMaxBytes) throw new HttpError(413, 'Chunk is too large');
  if (seq === 0 && !looksLike(rec.mime, bytes)) throw new HttpError(400, 'That is not an audio recording');
  const ended = rec.ride_ended_at && Date.now() - new Date(rec.ride_ended_at) > LATE_CHUNK_MS;
  const tooLong = Date.now() - new Date(rec.started_at) > config.recording.maxHours * 3600_000 + LATE_CHUNK_MS;
  if (ended || tooLong) {
    await finish(rec.id);
    throw new HttpError(409, 'This recording has ended');
  }

  try {
    await uploadObject(RECORDINGS_BUCKET, chunkPath(rec, seq), sealChunk(rec.id, seq, bytes), 'application/octet-stream');
  } catch (err) {
    throw new HttpError(502, `Could not store the recording (${err.message})`);
  }
  const next = await one(
    `UPDATE trip_recordings SET chunks = chunks + 1, bytes = bytes + $3, last_chunk_at = now()
     WHERE id = $1 AND chunks = $2 AND status = 'recording' RETURNING *`,
    [rec.id, seq, bytes.length],
  );
  if (!next) throw new HttpError(409, 'This recording changed while the chunk was uploading; try again');
  return next;
}

/** Ends a recording. One with no audio at all is simply removed. */
export async function finish(recordingId) {
  const rec = await one(
    `UPDATE trip_recordings SET status = CASE WHEN chunks = 0 THEN 'deleted' ELSE 'complete' END,
       ended_at = coalesce(last_chunk_at, now()),
       deleted_at = CASE WHEN chunks = 0 THEN now() END,
       delete_after = now() + $2 * interval '1 day'
     WHERE id = $1 AND status = 'recording' RETURNING *`,
    [recordingId, config.recording.keepDays],
  );
  if (rec) {
    const ride = await one('SELECT id, rider_id, driver_id FROM rides WHERE id = $1', [rec.ride_id]);
    tell(ride, rec.user_id, rec.role, false);
  }
  return rec;
}

export async function stopRecording(user, recordingId) {
  const rec = await one('SELECT * FROM trip_recordings WHERE id = $1 AND user_id = $2', [recordingId, user.id]);
  if (!rec) throw new HttpError(404, 'Recording not found');
  return (await finish(rec.id)) ?? rec;
}

export async function myRecordings(userId, rideId) {
  const rows = rideId
    ? await many(`SELECT * FROM trip_recordings WHERE user_id = $1 AND ride_id = $2 AND status <> 'deleted' ORDER BY started_at`, [userId, rideId])
    : await many(`SELECT * FROM trip_recordings WHERE user_id = $1 AND status <> 'deleted' ORDER BY started_at DESC LIMIT 30`, [userId]);
  return rows.map(toRecording);
}

/** "Send to Hopin safety": keeps the recording and opens a safety ticket with the reason. */
export async function reportRecording(user, recordingId, reason) {
  const text = String(reason ?? '').trim().slice(0, 1000);
  if (text.length < 5) throw new HttpError(400, 'Tell the safety team briefly what happened');
  const rec = await one('SELECT * FROM trip_recordings WHERE id = $1 AND user_id = $2', [recordingId, user.id]);
  if (!rec || rec.status === 'deleted') throw new HttpError(404, 'Recording not found');
  if (rec.held) return rec;
  const held = await tx(async ({ query: q }) => {
    const t = (
      await q(`INSERT INTO support_tickets (user_id, ride_id, category, subject) VALUES ($1, $2, 'safety', 'Trip recording sent to the safety team') RETURNING id`, [
        user.id,
        rec.ride_id,
      ])
    ).rows[0];
    await q('INSERT INTO ticket_messages (ticket_id, author_id, body) VALUES ($1, $2, $3)', [t.id, user.id, text]);
    return (await q('UPDATE trip_recordings SET held = true, held_reason = $2, ticket_id = $3 WHERE id = $1 RETURNING *', [rec.id, text, t.id])).rows[0];
  });
  emitToAdmins('recording', { id: held.id, rideId: held.ride_id });
  return held;
}

async function wipe(id) {
  const rec = await one('SELECT * FROM trip_recordings WHERE id = $1', [id]);
  const paths = Array.from({ length: rec.chunks }, (_, i) => chunkPath(rec, i));
  if (paths.length) await removeObjects(RECORDINGS_BUCKET, paths);
  await query(`UPDATE trip_recordings SET status = 'deleted', deleted_at = now() WHERE id = $1`, [id]);
}

/** The person who made it can delete it any time, unless they already sent it to safety. */
export async function deleteRecording(user, recordingId) {
  const rec = await one('SELECT * FROM trip_recordings WHERE id = $1 AND user_id = $2', [recordingId, user.id]);
  if (!rec || rec.status === 'deleted') throw new HttpError(404, 'Recording not found');
  if (rec.held) throw new HttpError(409, 'This recording is with the safety team and can only be removed by them');
  await finish(rec.id);
  await wipe(rec.id);
}

// --- admins -------------------------------------------------------------------------

export async function heldRecordings() {
  const rows = await many(
    `SELECT t.*, u.name AS user_name, r.pickup, r.dropoff, r.status AS ride_status,
       (SELECT count(*)::int FROM recording_access_log l WHERE l.recording_id = t.id) AS plays
     FROM trip_recordings t JOIN users u ON u.id = t.user_id JOIN rides r ON r.id = t.ride_id
     WHERE t.held AND t.status <> 'deleted' ORDER BY t.started_at DESC LIMIT 100`,
  );
  return rows.map((r) => ({
    ...toRecording(r),
    mime: r.mime,
    reason: r.held_reason,
    by: { id: r.user_id, name: r.user_name, role: r.role },
    ride: { id: r.ride_id, status: r.ride_status, pickup: r.pickup?.address ?? null, dropoff: r.dropoff?.address ?? null },
    plays: r.plays,
  }));
}

/** Decrypts every chunk into one playable file. Only for held recordings; the play is logged first. */
export async function audioFor(adminId, recordingId) {
  if (!recordingEnabled()) throw new HttpError(503, RECORDING_OFF);
  const rec = await one('SELECT * FROM trip_recordings WHERE id = $1', [recordingId]);
  if (!rec || rec.status === 'deleted') throw new HttpError(404, 'Recording not found');
  if (!rec.held) throw new HttpError(403, 'Only recordings sent to the safety team can be played');
  await query('INSERT INTO recording_access_log (recording_id, admin_id) VALUES ($1, $2)', [rec.id, adminId]);
  const parts = [];
  for (let i = 0; i < rec.chunks; i++) parts.push(openChunk(rec.id, i, await downloadObject(RECORDINGS_BUCKET, chunkPath(rec, i))));
  return { mime: rec.mime, bytes: Buffer.concat(parts) };
}

/** Case closed: the safety team deletes the recording for good. */
export async function adminDeleteRecording(recordingId) {
  const rec = await one('SELECT * FROM trip_recordings WHERE id = $1', [recordingId]);
  if (!rec || rec.status === 'deleted') throw new HttpError(404, 'Recording not found');
  await finish(rec.id);
  await wipe(rec.id);
}

/**
 * Scheduler tick: ends recordings whose trip is over, that hit the time limit, or whose phone
 * went quiet; then deletes unreported recordings past their keep date.
 */
export async function runRecordingCleanup() {
  const stale = await many(
    `SELECT t.id FROM trip_recordings t JOIN rides r ON r.id = t.ride_id
     WHERE t.status = 'recording' AND (
       (r.status IN ('completed', 'cancelled') AND coalesce(t.last_chunk_at, t.started_at) < now() - interval '2 minutes')
       OR t.started_at < now() - $1 * interval '1 hour' - interval '2 minutes'
       OR coalesce(t.last_chunk_at, t.started_at) < now() - $2 * interval '1 minute')`,
    [config.recording.maxHours, config.recording.idleMinutes],
  );
  for (const { id } of stale) await finish(id);

  const expired = await many(`SELECT id FROM trip_recordings WHERE status = 'complete' AND NOT held AND delete_after <= now() LIMIT 50`);
  for (const { id } of expired) await wipe(id);
  return { ended: stale.length, deleted: expired.length };
}
