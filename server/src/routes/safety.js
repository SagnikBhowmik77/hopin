import { Router } from 'express';
import { HttpError, requireAuth, requireRole } from '../auth.js';
import { many, one, query } from '../db.js';
import { sendSms, smsEnabled } from '../sms.js';
import { isLatLng } from '../geo.js';
import { driverPresence, emitToAdmins, loadRide } from '../hub.js';
import { config } from '../config.js';
import { notify } from '../notify.js';
import { smsText } from '../messages.js';

export const sosRouter = Router();
export const trackRouter = Router();

/**
 * SOS: records the alert, pushes it live to the admin dashboard, texts the
 * emergency contacts through Twilio (when SMS is set up) and returns a public
 * live-tracking link. The app also offers the phone's own dialer / SMS app
 * (tel: and sms: links) as a fallback.
 */
sosRouter.post('/', requireAuth, requireRole('rider', 'driver'), async (req, res) => {
  const r = await loadRide(String(req.body?.rideId ?? '')).catch(() => null);
  if (!r || (r.rider_id !== req.user.id && r.driver_id !== req.user.id)) throw new HttpError(404, 'Ride not found');
  if (!['accepted', 'arrived', 'ongoing'].includes(r.status)) throw new HttpError(409, 'SOS is available during an active ride');
  const loc = req.body?.location;
  const location = isLatLng(loc) ? { lat: loc.lat, lng: loc.lng } : null;

  const alert = await one(`INSERT INTO sos_alerts (ride_id, user_id, location) VALUES ($1, $2, $3) RETURNING *`, [
    r.id,
    req.user.id,
    location ? JSON.stringify(location) : null,
  ]);
  const trackUrl = `${config.appUrl}/track/${r.share_token}`;
  emitToAdmins('sos', {
    id: alert.id,
    rideId: r.id,
    user: { name: req.user.name, phone: req.user.phone, role: req.user.role },
    driver: r.driver_name ? { name: r.driver_name, phone: r.driver_phone, plate: r.v_plate } : null,
    location,
    trackUrl,
    createdAt: alert.created_at,
  });
  const admins = await many(`SELECT id FROM users WHERE role = 'admin'`);
  for (const a of admins) await notify(a.id, '🚨 SOS alert', `${req.user.name} (${req.user.role}) triggered SOS on an active ride.`, '/admin');

  const message = smsText(req.user.language, 'sos', { name: req.user.name, vehicle: `${r.v_model ?? ''} ${r.v_plate ?? ''}`.trim(), track: trackUrl });
  const contacts = req.user.emergency_contacts ?? [];

  // Automatic texts through Twilio when SMS is set up. "queued" means Twilio accepted
  // the message - not that it was delivered - and the app says exactly that.
  const smsResults = [];
  if (smsEnabled()) {
    for (const c of contacts) {
      try {
        const sent = await sendSms(c.phone, message);
        smsResults.push({ name: c.name, phone: c.phone, status: sent.status, sid: sent.sid });
      } catch (err) {
        smsResults.push({ name: c.name, phone: c.phone, status: 'failed', error: err.message });
      }
    }
    await query('UPDATE sos_alerts SET sms_results = $2 WHERE id = $1', [alert.id, JSON.stringify(smsResults)]);
  }

  // The rider sees only whether each text went out; the provider's error stays on the alert for admins.
  const sent = smsResults.map((s) => ({ name: s.name, phone: s.phone, status: s.status === 'failed' ? 'failed' : 'sent' }));
  res.status(201).json({ alertId: alert.id, trackUrl, message, contacts, smsEnabled: smsEnabled(), smsResults: sent, emergencyNumber: '112' });
});

/** Public, read-only live view behind an unguessable token. Stops working once the ride ends. */
trackRouter.get('/:token', async (req, res) => {
  const r = await one(
    `SELECT r.*, du.name AS driver_name, v.type AS v_type, v.model AS v_model, v.plate AS v_plate, ru.name AS rider_name
     FROM rides r JOIN users ru ON ru.id = r.rider_id LEFT JOIN users du ON du.id = r.driver_id LEFT JOIN vehicles v ON v.driver_id = r.driver_id
     WHERE r.share_token = $1`,
    [req.params.token],
  );
  if (!r) throw new HttpError(404, 'This link is not valid');
  const ended = ['completed', 'cancelled'].includes(r.status);
  const endedAt = r.completed_at ?? r.cancelled_at;
  if (ended && Date.now() - new Date(endedAt).getTime() > 60 * 60 * 1000) throw new HttpError(410, 'This trip has ended');
  const live = r.driver_id && !ended ? driverPresence(r.driver_id) : null;
  res.json({
    status: r.status,
    riderName: r.rider_name.split(' ')[0],
    driver: r.driver_name ? { name: r.driver_name.split(' ')[0], vehicle: { type: r.v_type, model: r.v_model, plate: r.v_plate } } : null,
    pickup: r.pickup,
    stops: r.stops,
    dropoff: r.dropoff,
    route: r.route,
    driverLocation: live && isLatLng(live) ? { lat: live.lat, lng: live.lng } : null,
    updatedAt: new Date().toISOString(),
  });
});
