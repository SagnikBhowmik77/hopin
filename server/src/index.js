import { config } from './config.js';
import { connectDb, disconnectDb } from './db.js';
import { createServer } from './app.js';
import { resumeExpiries, startScheduler } from './routes/rides.js';
import { closeStaleSessions } from './drivers.js';
import { onlinePaymentsEnabled } from './payments.js';
import { razorpayTestMode } from './razorpay.js';
import { smsEnabled } from './sms.js';
import { DOCS_BUCKET, ensureDocsBucket, storageConfigured } from './storage.js';
import { RECORDINGS_BUCKET, ensureRecordingsBucket, recordingEnabled } from './recordings.js';

await connectDb();
if (storageConfigured()) {
  try {
    console.log(`[storage] private bucket "${DOCS_BUCKET}" ${await ensureDocsBucket()}`);
  } catch (err) {
    console.error(`[storage] could not prepare the documents bucket: ${err.message}`);
  }
} else {
  console.log('[storage] OFF - driver document uploads need SUPABASE_URL and SUPABASE_SECRET_KEY');
}
if (recordingEnabled()) {
  try {
    console.log(`[recording] private bucket "${RECORDINGS_BUCKET}" ${await ensureRecordingsBucket()} (audio encrypted with RECORDING_KEY)`);
  } catch (err) {
    console.error(`[recording] could not prepare the recordings bucket: ${err.message}`);
  }
} else {
  console.log('[recording] OFF - trip recording needs Supabase storage and a 32-byte base64 RECORDING_KEY');
}
// Driver sessions cut off by a restart end at the last moment they were known to be live.
await closeStaleSessions();
const pending = await resumeExpiries();
if (pending) console.log(`[rides] resumed ${pending} open request(s) from the last run`);
startScheduler();
console.log(`[rides] scheduled rides are offered to drivers ${config.schedule.leadMin} min before pickup`);

const server = createServer();
server.listen(config.port, () => {
  console.log(`[hopin] API + sockets on http://localhost:${config.port}`);
  console.log(`[hopin] sign-in: ${config.supabase.url ? `Supabase Auth (${new URL(config.supabase.url).hostname})` : 'OFF - set SUPABASE_URL and keys in .env'}`);
  console.log(
    `[hopin] online payments: ${onlinePaymentsEnabled() ? `Razorpay (${razorpayTestMode() ? 'TEST mode - no real money' : 'LIVE mode'})${config.razorpay.webhookSecret ? '' : ' - webhook secret not set'}` : 'OFF - set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET'}`,
  );
  console.log(`[hopin] email: ${config.smtp ? `SMTP ${config.smtp.host}` : 'OFF - set SMTP_* to send email'}`);
  console.log(`[hopin] SOS SMS: ${smsEnabled() ? 'Twilio' : 'OFF - set TWILIO_* to text emergency contacts automatically'}`);
  console.log(`[hopin] live trip ETAs: ${config.ors.key ? 'OpenRouteService (falls back to OSRM)' : 'OSRM - set ORS_API_KEY for OpenRouteService'}`);
});

async function shutdown() {
  server.close();
  await disconnectDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
