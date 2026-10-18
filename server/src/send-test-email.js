// Sends one real email through the SMTP settings in server/.env, to prove they work.
// Run with: npm run test-email -- you@example.com
import nodemailer from 'nodemailer';
import { config } from './config.js';

const to = process.argv[2];
if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
  console.error('Usage: npm run test-email -- you@example.com');
  process.exit(1);
}
if (!config.smtp) {
  console.error('✖ SMTP is not set up: fill SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in server/.env');
  process.exit(1);
}

const transport = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.port === 465,
  auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
});

try {
  await transport.verify();
  console.log(`✔ Logged in to ${config.smtp.host}:${config.smtp.port} as ${config.smtp.user}`);
  const info = await transport.sendMail({
    from: config.smtp.from,
    to,
    subject: 'Hopin test email',
    text: `This is a test from your Hopin server, sent ${new Date().toISOString()}.\nIf you can read this, receipts and other Hopin emails will work.`,
  });
  console.log(`✔ Accepted by the mail server for ${info.accepted.join(', ')} (message id ${info.messageId}).`);
  if (info.rejected.length) console.log(`✖ Rejected: ${info.rejected.join(', ')}`);
  console.log('Check that inbox (and spam) to confirm it arrived.');
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exit(1);
}
