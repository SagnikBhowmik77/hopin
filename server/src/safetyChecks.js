import { config } from './config.js';
import { many, one, query } from './db.js';
import { emitToAdmins, emitToUser } from './hub.js';
import { notify } from './notify.js';
import { sendSms, smsEnabled } from './sms.js';
import { languageOf, notifyIn, smsText } from './messages.js';

/**
 * "Reached safely?" after a night ride. When a trip ends between nightCheck.startHour and
 * endHour (India time), the rider is asked at once. If they do not tap "I'm safe" within
 * replyMinutes, their emergency contacts are texted (Twilio) and admins are alerted.
 * Checks live in the database and are processed by the scheduler, so a restart loses nothing.
 */

const istHour = (date) => Number(new Date(date).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false })) % 24;

export function isNightIST(date) {
  const { startHour, endHour } = config.nightCheck;
  const h = istHour(date);
  return startHour <= endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

export const toSafetyCheck = (c) =>
  c && {
    id: c.id,
    rideId: c.ride_id,
    dueAt: c.due_at,
    confirmedAt: c.confirmed_at,
    escalatedAt: c.escalated_at,
    smsResults: c.sms_results ?? [],
  };

/** Called when a trip completes. Starts the check if it was a night ride. */
export async function startNightCheck(ride) {
  if (!isNightIST(ride.completed_at ?? new Date())) return null;
  const c = await one(
    `INSERT INTO safety_checks (ride_id, rider_id, due_at) VALUES ($1, $2, now() + $3 * interval '1 minute')
     ON CONFLICT (ride_id) DO NOTHING RETURNING *`,
    [ride.id, ride.rider_id, config.nightCheck.replyMinutes],
  );
  if (!c) return null;
  emitToUser(ride.rider_id, 'safety:check', toSafetyCheck(c));
  await notifyIn(ride.rider_id, 'reachedSafely', { minutes: config.nightCheck.replyMinutes }, '/book');
  return c;
}

/** The rider's check still waiting for an answer, if any. */
export const pendingCheckFor = async (riderId) =>
  toSafetyCheck(await one('SELECT * FROM safety_checks WHERE rider_id = $1 AND confirmed_at IS NULL ORDER BY created_at DESC LIMIT 1', [riderId]));

/** "I'm safe". Works even after escalation, so admins and contacts can see the rider answered. */
export async function confirmSafe(rideId, riderId) {
  const c = await one('UPDATE safety_checks SET confirmed_at = now() WHERE ride_id = $1 AND rider_id = $2 AND confirmed_at IS NULL RETURNING *', [
    rideId,
    riderId,
  ]).catch(() => null);
  if (c?.escalated_at) emitToAdmins('safety-check', toSafetyCheck(c));
  return toSafetyCheck(c);
}

/** Escalates every check whose time is up. Run by the scheduler. */
export async function runSafetyChecks() {
  const due = await many(
    `UPDATE safety_checks SET escalated_at = now()
     WHERE due_at <= now() AND confirmed_at IS NULL AND escalated_at IS NULL RETURNING *`,
  );
  for (const c of due) {
    const r = await one(
      `SELECT u.name, u.emergency_contacts, r.dropoff, r.completed_at, v.plate
       FROM rides r JOIN users u ON u.id = r.rider_id LEFT JOIN vehicles v ON v.driver_id = r.driver_id WHERE r.id = $1`,
      [c.ride_id],
    );
    // Texted in the rider's language: their contacts are usually family.
    const lang = await languageOf(c.rider_id);
    const ended = new Date(r.completed_at).toLocaleTimeString(lang === 'hi' ? 'hi-IN' : 'en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
    const message = smsText(lang, 'nightCheck', { name: r.name, time: ended, place: String(r.dropoff?.address ?? '').split(',')[0], plate: r.plate ?? (lang === 'hi' ? 'पता नहीं' : 'unknown') });
    const smsResults = [];
    if (smsEnabled()) {
      for (const contact of r.emergency_contacts ?? []) {
        try {
          const sent = await sendSms(contact.phone, message);
          smsResults.push({ name: contact.name, phone: contact.phone, status: sent.status, sid: sent.sid });
        } catch (err) {
          smsResults.push({ name: contact.name, phone: contact.phone, status: 'failed', error: err.message });
        }
      }
      await query('UPDATE safety_checks SET sms_results = $2 WHERE id = $1', [c.id, JSON.stringify(smsResults)]);
    }
    const view = toSafetyCheck({ ...c, sms_results: smsResults });
    emitToAdmins('safety-check', view);
    const admins = await many(`SELECT id FROM users WHERE role = 'admin'`);
    for (const a of admins) await notify(a.id, 'Night ride not confirmed', `${r.name} has not confirmed reaching safely after a night ride.`, '/admin');
    const texted = smsResults.filter((s) => s.status !== 'failed').length;
    await notifyIn(c.rider_id, 'couldNotReach', { texted, noContacts: smsEnabled() }, '/book');
  }
  return due.length;
}
