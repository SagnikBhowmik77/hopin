import { config } from './config.js';

/**
 * Outgoing SMS through Twilio Programmable Messaging (used for SOS texts).
 *
 * Twilio's reply only means it ACCEPTED the message ("queued"/"accepted"), not that
 * the phone received it - delivery is reported later. Callers must describe it that way.
 */

export const smsEnabled = () => Boolean(config.twilio.accountSid && config.twilio.authToken && config.twilio.from);

export async function sendSms(to, body) {
  if (!smsEnabled()) throw new Error('SMS is not set up (TWILIO_* keys missing)');
  const { accountSid, authToken, from, apiUrl } = config.twilio;
  const params = new URLSearchParams({ To: to, Body: body });
  if (from.startsWith('MG')) params.set('MessagingServiceSid', from);
  else params.set('From', from);
  const res = await fetch(`${apiUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params,
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Twilio returned ${res.status}`);
  return { sid: data.sid, status: data.status };
}
