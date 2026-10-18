import nodemailer from 'nodemailer';
import { config } from './config.js';
import { one } from './db.js';
import { emitToUser } from './hub.js';
import { HttpError } from './auth.js';
import { sendPush } from './push.js';

/** Stores an in-app notification and pushes it live to every open tab of that user. */
export async function notify(userId, title, body = '', link = null) {
  const row = await one(
    'INSERT INTO notifications (user_id, title, body, link) VALUES ($1, $2, $3, $4) RETURNING *',
    [userId, title, body, link],
  );
  emitToUser(userId, 'notify', toNotification(row));
  // Also to their phone/desktop with Hopin closed (step 9). Never holds up the caller.
  sendPush(userId, { title, body, link, tag: row.id }).catch((err) => console.warn('[push] failed', err.message));
  return row;
}

export const toNotification = (n) => ({ id: n.id, title: n.title, body: n.body, link: n.link, read: n.read, createdAt: n.created_at });

export const emailEnabled = () => Boolean(config.smtp);
export const EMAIL_OFF = 'Email is not set up yet, so nothing can be sent. Download the receipt instead.';

let transport = null;

/** Sends through the configured SMTP server. Without one it refuses rather than pretending. */
export async function sendEmail({ to, subject, text, attachments = [] }) {
  if (!config.smtp) throw new HttpError(503, EMAIL_OFF);
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  await transport.sendMail({ from: config.smtp.from, to, subject, text, attachments });
  return { delivered: true };
}
