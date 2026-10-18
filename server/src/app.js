import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { applyLimits } from './limits.js';
import { Server } from 'socket.io';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profile.js';
import geoRoutes from './routes/geo.js';
import rideRoutes from './routes/rides.js';
import paymentRoutes, { webhookHandler } from './routes/payments.js';
import { razorpayTestMode } from './razorpay.js';
import { sosRouter, trackRouter } from './routes/safety.js';
import supportRoutes from './routes/support.js';
import adminRoutes from './routes/admin.js';
import driverRoutes from './routes/driver.js';
import placeRoutes from './routes/places.js';
import rentalRoutes from './routes/rentals.js';
import familyRoutes from './routes/family.js';
import priceLockRoutes from './routes/priceLocks.js';
import growthRoutes from './routes/growth.js';
import companyRoutes from './routes/company.js';
import recordingRoutes from './routes/recordings.js';
import waterlogRoutes from './routes/waterlog.js';
import pushRoutes from './routes/push.js';
import { pushEnabled } from './push.js';
import { recordingEnabled } from './recordings.js';
import { VEHICLES } from './fare.js';
import { ONLINE_PAYMENTS_OFF, onlinePaymentsEnabled } from './payments.js';
import { emailEnabled } from './notify.js';
import { smsEnabled } from './sms.js';
import { HttpError } from './auth.js';
import { initHub } from './hub.js';
import { config } from './config.js';

/** Builds the HTTP + Socket.IO server without listening, so tests can pick their own port. */
export function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  // Security headers (step 13). The API only serves JSON, PDFs and audio; the web app's own
  // headers (CSP etc.) are set by whatever hosts it. Cross-origin reads stay allowed because the
  // web app may live on a different domain than the API after deployment (CORS still decides).
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.appUrl }));
  applyLimits(app);

  // Razorpay signs the exact bytes it sends, so its webhook must see the raw body.
  app.post('/api/payments/razorpay/webhook', express.raw({ type: () => true, limit: '1mb' }), webhookHandler);
  app.use(express.json({ limit: '300kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/vehicles', (_req, res) => res.json({ vehicles: VEHICLES }));
  // Which optional services are actually connected, so the app never offers one that isn't.
  app.get('/api/features', (_req, res) =>
    res.json({
      onlinePayments: onlinePaymentsEnabled(),
      onlinePaymentsMessage: onlinePaymentsEnabled() ? null : ONLINE_PAYMENTS_OFF,
      // Razorpay test keys: real Razorpay sandbox, no real money moves. The app says so.
      onlinePaymentsTestMode: onlinePaymentsEnabled() && razorpayTestMode(),
      email: emailEnabled(),
      // Automatic SOS texts from Hopin's server (Twilio Messaging).
      sms: smsEnabled(),
      // Trip audio recording (needs storage + RECORDING_KEY).
      recording: recordingEnabled(),
      // Push notifications with the app closed (needs VAPID keys).
      push: pushEnabled(),
    }),
  );
  app.use('/api/auth', authRoutes);
  app.use('/api/profile', profileRoutes);
  app.use('/api/geo', geoRoutes);
  app.use('/api/rides', rideRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/sos', sosRouter);
  app.use('/api/track', trackRouter);
  app.use('/api/support', supportRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/driver', driverRoutes);
  app.use('/api/places', placeRoutes);
  app.use('/api/rentals', rentalRoutes);
  app.use('/api/family', familyRoutes);
  app.use('/api/price-locks', priceLockRoutes);
  app.use('/api/growth', growthRoutes);
  app.use('/api/company', companyRoutes);
  app.use('/api/recordings', recordingRoutes);
  app.use('/api/waterlogging', waterlogRoutes);
  app.use('/api/push', pushRoutes);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.code === '22P02') return res.status(404).json({ error: 'Not found' }); // malformed uuid
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
    // Our own HttpErrors (e.g. 503 "not set up yet") are deliberate and their message is
    // meant for the user. Anything else is an unexpected crash: log it, hide the details.
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  const server = http.createServer(app);
  initHub(new Server(server, { cors: { origin: config.appUrl } }));
  return server;
}
