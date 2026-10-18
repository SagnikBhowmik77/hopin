import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { io as connect } from 'socket.io-client';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

// --- A local stand-in for Supabase Auth's public endpoints ---------------------
// The tests never touch the real Supabase project. They make their own ES256 key
// pair, publish the public half at the same path Supabase uses, and sign tokens
// shaped like Supabase access tokens. The server verifies them with exactly the
// code it uses in production; only the key source differs.
const { privateKey, publicKey } = await generateKeyPair('ES256');
const KID = 'test-key';
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: 'ES256', use: 'sig' }] };
// Switches and records the tests use to play Supabase's and Twilio's part.
const stub = {
  phoneProvider: false, // Supabase "Phone" sign-in switched on?
  authUsers: new Map(), // Supabase Auth admin view: id -> { phone, phone_confirmed_at }
  sms: [], // messages Twilio accepted
  failSmsTo: '+919800000000', // Twilio rejects this number
  buckets: new Map(), // Supabase Storage bucket id -> settings, once created
  files: new Map(), // 'bucket/path' -> { type, bytes }
  rzpOrders: new Map(), // Razorpay order id -> order
  rzpPayments: new Map(), // Razorpay payment id -> payment (set by each test, as Checkout would)
  rzpRefunds: new Map(), // Razorpay refund id -> refund
  refundStatus: null, // status Razorpay gives new refunds (default 'processed')
  refundRefuse: false, // Razorpay refuses refunds
  pushes: [], // messages the stand-in browser push service received
  ors: { calls: [], seconds: 720, status: 200, remaining: 1999 }, // stand-in OpenRouteService
};
const authStub = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/auth/v1/.well-known/jwks.json') return res.end(JSON.stringify(jwks));
  if (req.url === '/auth/v1/settings') {
    return res.end(JSON.stringify({ external: { email: true, google: true, phone: stub.phoneProvider }, mailer_autoconfirm: false }));
  }
  const adminUser = req.url.match(/^\/auth\/v1\/admin\/users\/([\w-]+)$/);
  if (adminUser) {
    if (req.headers.apikey !== 'sb_secret_test') return (res.statusCode = 401), res.end('{"msg":"bad key"}');
    return res.end(JSON.stringify({ id: adminUser[1], phone: '', phone_confirmed_at: null, ...stub.authUsers.get(adminUser[1]) }));
  }
  // Razorpay API (basic auth with the test key id and secret).
  if (req.url.startsWith('/razorpay/v1/')) {
    if (req.headers.authorization !== `Basic ${Buffer.from('rzp_test_key:rzp_secret').toString('base64')}`) {
      return (res.statusCode = 401), res.end('{"error":{"description":"Authentication failed"}}');
    }
    const path = req.url.slice('/razorpay/v1'.length);
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'POST' && path === '/orders') {
        const b = JSON.parse(raw);
        const order = { id: `order_${stub.rzpOrders.size + 1}`, amount: b.amount, currency: b.currency, receipt: b.receipt, notes: b.notes, status: 'created' };
        stub.rzpOrders.set(order.id, order);
        return res.end(JSON.stringify(order));
      }
      const refundCall = path.match(/^\/payments\/([\w]+)\/refund$/);
      if (req.method === 'POST' && refundCall) {
        if (stub.refundRefuse) return (res.statusCode = 400), res.end('{"error":{"description":"The refund amount provided is greater than amount captured"}}');
        const b = JSON.parse(raw);
        const rf = { id: `rfnd_${stub.rzpRefunds.size + 1}`, payment_id: refundCall[1], amount: b.amount, status: stub.refundStatus ?? 'processed' };
        stub.rzpRefunds.set(rf.id, rf);
        return res.end(JSON.stringify(rf));
      }
      const refundGet = path.match(/^\/refunds\/([\w]+)$/);
      if (req.method === 'GET' && refundGet) return res.end(JSON.stringify(stub.rzpRefunds.get(refundGet[1])));
      const capture = path.match(/^\/payments\/([\w]+)\/capture$/);
      if (req.method === 'POST' && capture) {
        const p = stub.rzpPayments.get(capture[1]);
        p.status = 'captured';
        return res.end(JSON.stringify(p));
      }
      const pay = path.match(/^\/payments\/([\w]+)$/);
      if (req.method === 'GET' && pay) {
        const p = stub.rzpPayments.get(pay[1]);
        if (!p) return (res.statusCode = 400), res.end('{"error":{"description":"The id provided does not exist"}}');
        return res.end(JSON.stringify(p));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    return;
  }
  // OpenRouteService directions: needs the API key, reports remaining quota like the real one.
  if (req.method === 'POST' && req.url === '/ors/v2/directions/driving-car') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.headers.authorization !== 'ors-test-key') return (res.statusCode = 403), res.end('{"error":"Access to this API has been disallowed"}');
      stub.ors.calls.push(JSON.parse(raw));
      res.setHeader('x-ratelimit-remaining', String(stub.ors.status === 429 ? 0 : stub.ors.remaining));
      res.setHeader('x-ratelimit-reset', String(Math.floor(Date.now() / 1000) + 3600));
      res.setHeader('content-type', 'application/json');
      res.statusCode = stub.ors.status;
      if (stub.ors.status !== 200) return res.end('{"error":"Quota exceeded"}');
      res.end(JSON.stringify({ routes: [{ summary: { distance: 4200, duration: stub.ors.seconds } }] }));
    });
    return;
  }
  // A browser push service (like Google FCM). /push/gone answers 410 like an expired subscription.
  if (req.url.startsWith('/push/')) {
    const raw = [];
    req.on('data', (c) => raw.push(c));
    req.on('end', () => {
      stub.pushes.push({ path: req.url, headers: req.headers, body: Buffer.concat(raw) });
      res.statusCode = req.url === '/push/gone' ? 410 : 201;
      res.end();
    });
    return;
  }
  // Supabase Storage (secret key only). Files are kept in memory.
  if (req.url.startsWith('/storage/v1/')) {
    if (req.headers.apikey !== 'sb_secret_test') return (res.statusCode = 401), res.end('{"message":"bad key"}');
    const path = req.url.slice('/storage/v1'.length);
    let raw = [];
    req.on('data', (c) => raw.push(c));
    req.on('end', () => {
      const body = Buffer.concat(raw);
      const bucketGet = path.match(/^\/bucket\/([^/]+)$/);
      if (req.method === 'GET' && bucketGet) {
        if (!stub.buckets.has(bucketGet[1])) return (res.statusCode = 404), res.end('{"message":"Bucket not found"}');
        return res.end(JSON.stringify(stub.buckets.get(bucketGet[1])));
      }
      if (req.method === 'POST' && path === '/bucket') {
        const settings = JSON.parse(body.toString());
        stub.buckets.set(settings.id, settings);
        return res.end(JSON.stringify({ name: settings.id }));
      }
      const sign = path.match(/^\/object\/sign\/([^/]+)\/(.+)$/);
      if (req.method === 'POST' && sign) {
        if (!stub.files.has(`${sign[1]}/${sign[2]}`)) return (res.statusCode = 404), res.end('{"message":"Object not found"}');
        return res.end(JSON.stringify({ signedURL: `/object/sign/${sign[1]}/${sign[2]}?token=signed` }));
      }
      const obj = path.match(/^\/object\/([^/]+)\/(.+)$/);
      if (req.method === 'POST' && obj) {
        stub.files.set(`${obj[1]}/${obj[2]}`, { type: req.headers['content-type'], bytes: body });
        return res.end(JSON.stringify({ Key: `${obj[1]}/${obj[2]}` }));
      }
      if (req.method === 'GET' && obj) {
        const file = stub.files.get(`${obj[1]}/${obj[2]}`);
        if (!file) return (res.statusCode = 404), res.end('{"message":"Object not found"}');
        res.setHeader('content-type', file.type);
        return res.end(file.bytes);
      }
      const del = path.match(/^\/object\/([^/]+)$/);
      if (req.method === 'DELETE' && del) {
        for (const p of JSON.parse(body.toString()).prefixes) stub.files.delete(`${del[1]}/${p}`);
        return res.end('[]');
      }
      res.statusCode = 404;
      res.end('{}');
    });
    return;
  }
  if (req.method === 'POST' && /^\/twilio\/2010-04-01\/Accounts\/ACtest\/Messages\.json$/.test(req.url)) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(raw));
      if (req.headers.authorization !== `Basic ${Buffer.from('ACtest:tok').toString('base64')}`) return (res.statusCode = 401), res.end('{"message":"auth"}');
      if (form.To === stub.failSmsTo) return (res.statusCode = 400), res.end('{"message":"Invalid To number"}');
      stub.sms.push(form);
      res.statusCode = 201;
      res.end(JSON.stringify({ sid: `SM${stub.sms.length}`, status: 'queued' }));
    });
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((r) => authStub.listen(0, '127.0.0.1', r));
const SUPABASE_URL = `http://127.0.0.1:${authStub.address().port}`;

const testVapid = (await import('web-push')).default.generateVAPIDKeys();

// Config is read at import time, so set the environment before loading the app.
// Explicit values also stop server/.env (real Supabase keys) from being used here.
Object.assign(process.env, {
  HOPIN_OFFLINE_GEO: '1',
  DEVIATION_SECONDS: '1',
  // No night checks unless a test turns them on (it changes config.nightCheck itself).
  NIGHT_CHECK_START_HOUR: '0',
  NIGHT_CHECK_END_HOUR: '0',
  REQUEST_TIMEOUT_MS: '1500',
  FREE_CANCEL_MS: '50',
  DATABASE_URL: '',
  SMTP_HOST: '',
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_AUTH_TOKEN: 'tok',
  TWILIO_FROM: '+15005550006',
  TWILIO_API_URL: `${SUPABASE_URL}/twilio`,
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_secret',
  RAZORPAY_WEBHOOK_SECRET: 'whsec',
  RAZORPAY_API_URL: `${SUPABASE_URL}/razorpay`,
  RECORDING_KEY: crypto.randomBytes(32).toString('base64'),
  // Real VAPID keys made for this run; the push service is the local stand-in above.
  VAPID_PUBLIC_KEY: testVapid.publicKey,
  VAPID_PRIVATE_KEY: testVapid.privateKey,
  VAPID_SUBJECT: 'mailto:tests@hopin.test',
  PUSH_EXTRA_HOSTS: '127.0.0.1',
  PAYOUT_KEY: crypto.randomBytes(32).toString('base64'),
  ORS_API_KEY: 'ors-test-key',
  ORS_URL: `${SUPABASE_URL}/ors`,
  // Real limits are tested on their own below; the rest of the suite makes many requests from one IP.
  RATE_LIMIT_SCALE: '1000',
});
const { connectDb, disconnectDb, many, query, tx } = await import('../src/db.js');
const { resetProvidersCache } = await import('../src/supabase.js');
const setPhoneProvider = (on) => {
  stub.phoneProvider = on;
  resetProvidersCache();
};
const { createServer } = await import('../src/app.js');
const { creditWallet } = await import('../src/payments.js');
const { config } = await import('../src/config.js');
/** The signature Razorpay Checkout returns for a successful payment. */
const sign = (orderId, paymentId) => crypto.createHmac('sha256', 'rzp_secret').update(`${orderId}|${paymentId}`).digest('hex');

/** Signs a token shaped like a Supabase access token. */
function supabaseToken({ sub = crypto.randomUUID(), email, key = privateKey, issuer = `${SUPABASE_URL}/auth/v1`, expiresIn = '1h', extra = {} } = {}) {
  return new SignJWT({ email, role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: {}, ...extra })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

// Test-only setup: puts money in a wallet of the throwaway in-memory database the
// same way a confirmed gateway payment will (step 4). Never used by the app itself.
let fixtureSeq = 0;
const fundWallet = (userId, amount) => tx(({ query: q }) => creditWallet(q, userId, amount, `TEST-FIXTURE-${++fixtureSeq}`));

let server;
let base;
const sockets = [];

// Park Street -> Salt Lake Sector V, Kolkata, via Sealdah.
const PICKUP = { address: 'Park Street', lat: 22.5535, lng: 88.3525 };
const STOP = { address: 'Sealdah', lat: 22.5678, lng: 88.3708 };
const DROPOFF = { address: 'Salt Lake Sector V', lat: 22.5726, lng: 88.4339 };
const NEAR_PICKUP = { lat: 22.555, lng: 88.35 };

before(async () => {
  await connectDb({ memory: true });
  await query(`INSERT INTO promos (code, description, kind, value, max_discount, first_ride_only, per_user_limit)
               VALUES ('WELCOME50', 'half off', 'percent', 50, 75, true, 1), ('FLAT500', 'too big', 'flat', 500, NULL, false, 5)`);
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  sockets.forEach((s) => s.close());
  await new Promise((r) => server.close(r));
  await new Promise((r) => authStub.close(r));
  await disconnectDb();
});

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

let seq = 0;
/** Signs in a fresh Supabase identity and completes the Hopin profile. Returns { token, user }. */
/**
 * Test-only setup: gives a test driver approved, in-date documents directly in the
 * throwaway database, so ride tests can drive. The real upload-and-review flow is
 * tested on its own below.
 */
async function approveDocs(driverId) {
  const { plate, type } = (await query('SELECT plate, type FROM vehicles WHERE driver_id = $1', [driverId])).rows[0];
  // Bike drivers also need today's helmet selfie; tested on its own below.
  if (type === 'bike') {
    await query(`INSERT INTO helmet_checks (driver_id, storage_path, mime_type, taken_on, status) VALUES ($1, $2, 'image/jpeg', $3::date, 'approved')`, [
      driverId, `fixture/${driverId}/helmet`, new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
    ]);
  }
  for (const type of ['driving_licence', 'vehicle_rc', 'insurance', 'driver_photo']) {
    await query(
      `INSERT INTO driver_documents (driver_id, doc_type, storage_path, mime_type, size_bytes, expires_on, vehicle_plate, status)
       VALUES ($1, $2, $3, 'image/jpeg', 1, $4, $5, 'approved')`,
      [driverId, type, `fixture/${driverId}/${type}`, ['driving_licence', 'insurance'].includes(type) ? '2099-01-01' : null, ['vehicle_rc', 'insurance'].includes(type) ? plate : null],
    );
  }
}

async function register(role, vehicleType = 'car', { approved = true } = {}) {
  const n = ++seq;
  const token = await supabaseToken({ email: `${role}${n}@hopin.test` });
  const { status, body } = await api('POST', '/api/auth/profile', {
    token,
    body: {
      name: `${role} ${n}`,
      phone: `9${String(n).padStart(9, '0')}`,
      role,
      vehicle: role === 'driver' ? { type: vehicleType, model: 'Test car', plate: `WB0${n} XX 0000` } : undefined,
    },
  });
  assert.equal(status, 201, JSON.stringify(body));
  if (role === 'driver' && approved) await approveDocs(body.user.id);
  return { token, user: body.user };
}

/** Admins can't be created through the API (only `npm run create-admin`), so tests insert the profile row. */
async function admin() {
  const sub = crypto.randomUUID();
  await query(`INSERT INTO users (id, name, email, phone, role) VALUES ($1, 'Admin', 'admin@hopin.test', '+919999999999', 'admin')`, [sub]);
  return { token: await supabaseToken({ sub, email: 'admin@hopin.test' }) };
}

/** Another admin; each call makes a new one (email and phone must be unique). */
let reviewerSeq = 0;
async function admin2() {
  const sub = crypto.randomUUID();
  const n = ++reviewerSeq;
  const email = `reviewer${n}@hopin.test`;
  await query(`INSERT INTO users (id, name, email, phone, role) VALUES ($1, 'Reviewer', $2, $3, 'admin')`, [sub, email, `+9199999990${String(n).padStart(2, '0')}`]);
  return { token: await supabaseToken({ sub, email }) };
}

async function socketFor(token) {
  const s = connect(base, { auth: { token }, transports: ['websocket'] });
  sockets.push(s);
  await new Promise((resolve, reject) => {
    s.once('connect', resolve);
    s.once('connect_error', reject);
  });
  return s;
}

const nextEvent = (s, event, timeoutMs = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    s.once(event, (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });

async function online(token, point = NEAR_PICKUP) {
  const s = await socketFor(token);
  assert.equal((await s.timeout(2000).emitWithAck('driver:online', point)).ok, true);
  return s;
}

const book = (token, extra = {}) =>
  api('POST', '/api/rides', { token, body: { pickup: PICKUP, dropoff: DROPOFF, vehicleType: 'car', paymentMethod: 'cash', ...extra } });

/** Takes a booked ride through accept -> arrive -> start. Returns the OTP-bearing rider view. */
async function driveToOngoing(rideId, rider, driver) {
  assert.equal((await api('POST', `/api/rides/${rideId}/accept`, { token: driver.token })).status, 200);
  const view = (await api('GET', `/api/rides/${rideId}`, { token: rider.token })).body.ride;
  assert.equal((await api('POST', `/api/rides/${rideId}/arrive`, { token: driver.token })).status, 200);
  assert.equal((await api('POST', `/api/rides/${rideId}/start`, { token: driver.token, body: { otp: view.otp } })).status, 200);
  return view;
}

test('only genuine, unexpired Supabase tokens are accepted', async () => {
  const email = 'checker@hopin.test';
  const otherKey = (await generateKeyPair('ES256')).privateKey;
  const cases = [
    ['no token', null],
    ['garbage', 'not-a-jwt'],
    ['signed with a different key', await supabaseToken({ email, key: otherKey })],
    ['wrong issuer', await supabaseToken({ email, issuer: 'https://evil.example/auth/v1' })],
    ['expired', await supabaseToken({ email, expiresIn: '-1m' })],
    ['anonymous session', await supabaseToken({ email, extra: { is_anonymous: true } })],
  ];
  for (const [label, token] of cases) {
    assert.equal((await api('GET', '/api/auth/me', { token })).status, 401, label);
  }
  // The live connection is guarded the same way.
  await assert.rejects(socketFor(await supabaseToken({ email, key: otherKey })), /unauthorized/);
});

test('first sign-in: profile required, validated, created once; email comes from the token', async () => {
  const sub = crypto.randomUUID();
  const token = await supabaseToken({ sub, email: 'New.Person@Hopin.test', extra: { user_metadata: { full_name: 'New Person' }, app_metadata: { provider: 'google' } } });

  const me = (await api('GET', '/api/auth/me', { token })).body;
  assert.equal(me.user, null);
  assert.equal(me.needsProfile, true);
  assert.deepEqual(me.identity, { email: 'new.person@hopin.test', name: 'New Person', provider: 'google' });
  const blocked = await api('GET', '/api/rides/active', { token });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'PROFILE_REQUIRED');
  await assert.rejects(socketFor(token), /unauthorized/, 'no profile, no live connection');

  const make = (body) => api('POST', '/api/auth/profile', { token, body: { name: 'New Person', phone: '9811111111', role: 'rider', ...body } });
  assert.equal((await make({ phone: '12345' })).status, 400);
  assert.equal((await make({ role: 'admin' })).status, 400, 'nobody can make themselves admin');
  assert.equal((await make({ role: 'driver' })).status, 400, 'drivers need a vehicle');
  const taken = await register('rider');
  assert.equal((await make({ phone: taken.user.phone })).status, 409, 'mobile numbers are unique');

  const ok = await make({ email: 'spoofed@evil.example' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.id, sub);
  assert.equal(ok.body.user.email, 'new.person@hopin.test', 'email is taken from the verified token, never the body');
  assert.equal(ok.body.user.phoneVerified, false, 'phone stays unverified until SMS OTP (step 2)');
  assert.equal((await make({})).status, 409, 'only one profile per account');
  assert.equal((await api('GET', '/api/rides/active', { token })).status, 200);

  const changed = await api('PATCH', '/api/profile', { token, body: { phone: '9822222222' } });
  assert.equal(changed.body.user.phone, '+919822222222');
  assert.equal(changed.body.user.phoneVerified, false);
});

test('auth config exposes only public settings and the providers Supabase reports', async () => {
  const cfg = (await api('GET', '/api/auth/config')).body;
  assert.deepEqual(cfg, {
    supabaseUrl: SUPABASE_URL,
    publishableKey: 'sb_publishable_test',
    providers: { email: true, google: true, phone: false, emailConfirmRequired: true },
  });
});

test('phone verification: trusted only when Supabase confirms it; required only once SMS is on', async () => {
  const rider = await register('rider');
  const driver = await register('driver', 'car');
  assert.equal(rider.user.phoneVerified, false);

  // SMS not switched on in Supabase: nobody can verify, so nobody is blocked.
  const before = await book(rider.token);
  assert.equal(before.status, 201);
  await api('POST', `/api/rides/${before.body.ride.id}/cancel`, { token: rider.token });
  assert.equal((await api('POST', '/api/auth/phone/sync', { token: rider.token })).status, 503);

  setPhoneProvider(true);
  try {
    const blocked = await book(rider.token);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'PHONE_UNVERIFIED');
    const ds = await socketFor(driver.token);
    const ack = await ds.timeout(2000).emitWithAck('driver:online', NEAR_PICKUP);
    assert.deepEqual([ack.ok, ack.code], [false, 'PHONE_UNVERIFIED'], 'unverified drivers cannot go online');

    // The app claiming success is not enough: Supabase has no confirmed phone yet.
    assert.equal((await api('POST', '/api/auth/phone/sync', { token: rider.token })).status, 409);
    stub.authUsers.set(rider.user.id, { phone: '919833333333', phone_confirmed_at: null });
    assert.equal((await api('POST', '/api/auth/phone/sync', { token: rider.token })).status, 409, 'sent but not confirmed');

    // Supabase confirms the number (rider entered the SMS code) -> Hopin marks it verified.
    stub.authUsers.set(rider.user.id, { phone: '919833333333', phone_confirmed_at: new Date().toISOString() });
    const synced = await api('POST', '/api/auth/phone/sync', { token: rider.token });
    assert.equal(synced.status, 200);
    assert.equal(synced.body.user.phone, '+919833333333');
    assert.equal(synced.body.user.phoneVerified, true);
    const after = await book(rider.token);
    assert.equal(after.status, 201, 'verified riders can book');
    await api('POST', `/api/rides/${after.body.ride.id}/cancel`, { token: rider.token });

    // Changing the number in Hopin makes it unverified again.
    const changed = await api('PATCH', '/api/profile', { token: rider.token, body: { phone: '9844444444' } });
    assert.equal(changed.body.user.phoneVerified, false);
    assert.equal((await book(rider.token)).status, 403);

    // A foreign number confirmed in Supabase is refused.
    stub.authUsers.set(driver.user.id, { phone: '14155550100', phone_confirmed_at: new Date().toISOString() });
    assert.equal((await api('POST', '/api/auth/phone/sync', { token: driver.token })).status, 409);
  } finally {
    setPhoneProvider(false);
  }
});

test('driver verification: private uploads, admin review, and only fully approved drivers can drive', async () => {
  const { ensureDocsBucket } = await import('../src/storage.js');
  assert.equal(await ensureDocsBucket(), 'created');
  assert.equal(stub.buckets.get('driver-documents').public, false, 'the documents bucket is private');
  assert.equal(await ensureDocsBucket(), 'exists');

  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const PDF = Buffer.from('%PDF-1.4 policy');
  const upload = async (token, type, bytes, params = {}) => {
    const res = await fetch(`${base}/api/driver/documents/${type}?${new URLSearchParams(params)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    return { status: res.status, body: await res.json() };
  };

  const driver = await register('driver', 'auto', { approved: false });
  const rider = await register('rider');
  const boss = await admin2();
  const state = async () => (await api('GET', '/api/driver/verification', { token: driver.token })).body;

  let v = await state();
  assert.equal(v.canDrive, false);
  assert.deepEqual(v.items.map((i) => i.state), ['missing', 'missing', 'missing', 'missing']);
  const ds = await socketFor(driver.token);
  const ack = await ds.timeout(2000).emitWithAck('driver:online', NEAR_PICKUP);
  assert.deepEqual([ack.ok, ack.code], [false, 'DRIVER_NOT_VERIFIED']);
  const ride = (await book(rider.token, { vehicleType: 'auto' })).body.ride;
  const blockedAccept = await api('POST', `/api/rides/${ride.id}/accept`, { token: driver.token });
  assert.deepEqual([blockedAccept.status, blockedAccept.body.code], [403, 'DRIVER_NOT_VERIFIED']);
  await api('POST', `/api/rides/${ride.id}/cancel`, { token: rider.token });

  // File checks: real type from the bytes, size limit, required details.
  assert.equal((await upload(driver.token, 'driving_licence', Buffer.alloc(0))).status, 400);
  assert.equal((await upload(driver.token, 'driving_licence', Buffer.from('not an image'), { number: 'WB0620190012345', expires: '2099-01-01' })).status, 400);
  assert.equal((await upload(driver.token, 'driving_licence', Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]), { number: 'WB0620190012345', expires: '2099-01-01' })).status, 413);
  assert.equal((await upload(driver.token, 'driving_licence', JPEG, { number: 'WB0620190012345' })).status, 400, 'expiry required');
  assert.equal((await upload(driver.token, 'driving_licence', JPEG, { number: 'WB0620190012345', expires: '2001-01-01' })).status, 400, 'already expired');
  assert.equal((await upload(rider.token, 'driving_licence', JPEG, { number: 'WB0620190012345', expires: '2099-01-01' })).status, 403, 'riders cannot upload');

  const dl = await upload(driver.token, 'driving_licence', JPEG, { number: 'wb06 20190012345', expires: '2099-01-01' });
  assert.equal(dl.status, 201);
  await upload(driver.token, 'vehicle_rc', PDF);
  await upload(driver.token, 'insurance', PDF, { number: 'POL-123456', expires: '2099-06-30' });
  v = (await upload(driver.token, 'driver_photo', PNG)).body;
  assert.deepEqual(v.items.map((i) => i.state), ['pending', 'pending', 'pending', 'pending']);
  assert.match(v.message, /being reviewed/);
  const licence = v.items[0].doc;
  assert.equal(licence.number, 'WB06 20190012345');
  assert.equal(v.items[1].doc.number, driver.user.vehicle.plate, 'RC number is the vehicle plate');
  assert.ok([...stub.files.keys()].some((p) => p.startsWith(`driver-documents/${driver.user.id}/driving_licence-`) && p.endsWith('.jpg')));

  // Admin review: list, open with short-lived links, reject with reason, approve.
  const list = (await api('GET', '/api/admin/drivers', { token: boss.token })).body.drivers;
  const row = list.find((d) => d.id === driver.user.id);
  assert.equal(row.pendingDocs, 4);
  assert.equal((await api('GET', '/api/admin/drivers', { token: rider.token })).status, 403);
  const detail = (await api('GET', `/api/admin/drivers/${driver.user.id}`, { token: boss.token })).body;
  assert.match(detail.verification.items[0].doc.url, /\/storage\/v1\/object\/sign\/driver-documents\/.+token=/);
  const own = (await api('GET', `/api/driver/documents/${licence.id}/url`, { token: driver.token })).body;
  assert.equal(own.expiresInSeconds, 300);

  assert.equal((await api('POST', `/api/admin/documents/${licence.id}/review`, { token: boss.token, body: { decision: 'reject', reason: 'no' } })).status, 400, 'a reason is required');
  const notified = nextEvent(ds, 'notify');
  await api('POST', `/api/admin/documents/${licence.id}/review`, { token: boss.token, body: { decision: 'reject', reason: 'Photo is blurry, please re-upload' } });
  assert.match((await notified).body, /blurry/);
  assert.equal((await state()).items[0].state, 'rejected');

  const again = (await upload(driver.token, 'driving_licence', JPEG, { number: 'WB0620190012345', expires: '2099-01-01' })).body;
  assert.equal((await api('POST', `/api/admin/documents/${licence.id}/review`, { token: boss.token, body: { decision: 'approve' } })).status, 409, 'old version cannot be reviewed');
  for (const item of again.items) {
    assert.equal((await api('POST', `/api/admin/documents/${item.doc.id}/review`, { token: boss.token, body: { decision: 'approve' } })).status, 200);
  }
  v = await state();
  assert.equal(v.canDrive, true);
  assert.equal((await ds.timeout(2000).emitWithAck('driver:online', NEAR_PICKUP)).ok, true, 'approved drivers can go online');

  // A different vehicle needs its own RC and insurance.
  await api('PUT', '/api/profile/vehicle', { token: driver.token, body: { type: 'auto', model: 'Bajaj RE', plate: 'WB99ZZ9999' } });
  v = await state();
  assert.equal(v.canDrive, false);
  assert.deepEqual(v.items.map((i) => i.state), ['approved', 'wrong_vehicle', 'wrong_vehicle', 'approved']);

  // Expired papers stop driving too.
  await api('PUT', '/api/profile/vehicle', { token: driver.token, body: { type: 'auto', model: 'Test car', plate: driver.user.vehicle.plate } });
  await query(`UPDATE driver_documents SET expires_on = '2001-01-01' WHERE driver_id = $1 AND doc_type = 'insurance'`, [driver.user.id]);
  v = await state();
  assert.equal(v.items[2].state, 'expired');
  assert.equal(v.canDrive, false);
});

test('quotes: three vehicle types, extra stops cost more, promo codes discount or explain why not', async () => {
  const rider = await register('rider');
  const quote = (body) => api('POST', '/api/rides/quote', { token: rider.token, body: { pickup: PICKUP, dropoff: DROPOFF, ...body } });

  const plain = (await quote()).body;
  assert.deepEqual(plain.options.map((o) => o.type), ['bike', 'auto', 'car']);
  const fares = plain.options.map((o) => o.price.fare);
  assert.ok(fares[0] < fares[1] && fares[1] < fares[2], 'bike < auto < cab');

  const withStop = (await quote({ stops: [STOP] })).body;
  assert.equal(withStop.options[2].price.stopCharge, 10);
  assert.ok(withStop.options[2].price.fare > plain.options[2].price.fare);

  const promo = (await quote({ promoCode: 'welcome50' })).body.options[2];
  assert.equal(promo.promo.code, 'WELCOME50');
  assert.equal(promo.price.discount, Math.min(75, Math.round(promo.price.subtotal / 2)));

  const bogus = (await quote({ promoCode: 'NOPE' })).body.options[0];
  assert.match(bogus.promoError, /not a valid/);
  const capped = (await quote({ promoCode: 'FLAT500' })).body.options[0];
  assert.equal(capped.price.fare, 0, 'discount can never push the fare below zero');
});

test('full cash trip: offer, accept race, OTP, live location, payment, earnings, review, receipt', async () => {
  const rider = await register('rider');
  const d1 = await register('driver', 'car');
  const d2 = await register('driver', 'car');
  const biker = await register('driver', 'bike');
  const rs = await socketFor(rider.token);
  const s1 = await online(d1.token);
  const s2 = await online(d2.token);
  const sb = await online(biker.token);
  let bikerOffered = false;
  sb.on('ride:offer', () => (bikerOffered = true));

  const offer1 = nextEvent(s1, 'ride:offer');
  const offer2 = nextEvent(s2, 'ride:offer');
  const created = await book(rider.token, { stops: [STOP], promoCode: 'WELCOME50', fare: 1 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.offeredTo, 2);
  const ride = created.body.ride;
  assert.equal(ride.price.promoCode, 'WELCOME50');
  assert.ok(ride.price.fare > 1, 'client-sent fare is ignored');
  const offer = await offer1;
  await offer2;
  assert.equal(offer.otp, null, 'drivers never see the OTP');
  assert.equal(offer.stops.length, 1);

  assert.equal((await book(rider.token)).status, 409, 'one live ride per rider (DB unique index)');

  const accepted = nextEvent(rs, 'ride:update');
  const [a, b] = await Promise.all([1, 2].map((i) => api('POST', `/api/rides/${ride.id}/accept`, { token: (i === 1 ? d1 : d2).token })));
  assert.deepEqual([a.status, b.status].sort(), [200, 409], 'exactly one driver wins');
  const [winner, ws] = a.status === 200 ? [d1, s1] : [d2, s2];
  assert.equal((a.status === 200 ? a : b).body.ride.otp, null);
  const riderView = await accepted;
  assert.equal(riderView.status, 'accepted');
  assert.match(riderView.otp, /^\d{4}$/);
  assert.equal(riderView.driver.vehicle.plate, winner.user.vehicle.plate);
  assert.equal(bikerOffered, false, 'bike drivers are not offered cab rides');

  const located = nextEvent(rs, 'ride:location');
  const arriving = new Promise((resolve) => rs.on('notify', (n) => /arriving/.test(n.title) && resolve(n)));
  ws.emit('driver:location', { lat: 22.5537, lng: 88.3526 });
  const loc = await located;
  assert.equal(loc.rideId, ride.id);
  assert.ok(loc.etaMin >= 1);
  assert.match((await arriving).body, /300 m/);

  assert.equal((await api('POST', `/api/rides/${ride.id}/start`, { token: winner.token, body: { otp: riderView.otp } })).status, 409, 'arrive first');
  await api('POST', `/api/rides/${ride.id}/arrive`, { token: winner.token });
  const wrong = riderView.otp === '1000' ? '1001' : '1000';
  assert.equal((await api('POST', `/api/rides/${ride.id}/start`, { token: winner.token, body: { otp: wrong } })).status, 400);
  assert.equal((await api('POST', `/api/rides/${ride.id}/start`, { token: winner.token, body: { otp: riderView.otp } })).status, 200);
  assert.equal((await api('POST', `/api/rides/${ride.id}/cancel`, { token: rider.token })).status, 409, 'no cancelling mid-trip');

  const done = (await api('POST', `/api/rides/${ride.id}/complete`, { token: winner.token })).body.ride;
  assert.equal(done.status, 'completed');
  assert.equal(done.payment.status, 'due');
  assert.equal((await api('POST', `/api/rides/${ride.id}/collect-cash`, { token: winner.token })).status, 200);
  assert.equal((await api('POST', `/api/rides/${ride.id}/collect-cash`, { token: winner.token })).status, 409, 'cannot be paid twice');

  const earnings = (await api('GET', '/api/rides/earnings', { token: winner.token })).body;
  assert.equal(earnings.earnings.today, Math.round(done.price.fare * 0.8));
  // The driver keeps the cash; Hopin's 20% comes out of their wallet (it may go below zero).
  assert.equal(earnings.walletBalance, Math.round(done.price.fare * 0.8) - done.price.fare, "Hopin's share of a cash fare is taken from the wallet");
  const receipt = (await api('GET', `/api/rides/${ride.id}`, { token: rider.token })).body.ride.breakdown;
  assert.deepEqual(
    [receipt.cash, receipt.paid, receipt.driverFare, receipt.hopinFare, receipt.driverSharePct],
    [true, done.price.fare, Math.round(done.price.fare * 0.8), done.price.fare - Math.round(done.price.fare * 0.8), 80],
  );

  const review = await api('POST', `/api/rides/${ride.id}/review`, { token: rider.token, body: { stars: 4, comment: 'Smooth ride', tags: ['Polite', 'Made up'] } });
  assert.equal(review.status, 200);
  assert.deepEqual(review.body.ride.review.tags, ['Polite']);
  assert.equal((await api('POST', `/api/rides/${ride.id}/review`, { token: rider.token, body: { stars: 1 } })).status, 409, 'one review per trip');
  const profile = (await api('GET', `/api/profile/drivers/${winner.user.id}`, { token: rider.token })).body;
  assert.equal(profile.driver.rating, 4);
  assert.equal(profile.reviews[0].comment, 'Smooth ride');

  const pdf = await api('GET', `/api/rides/${ride.id}/receipt.pdf`, { token: rider.token });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
  const mail = await api('POST', `/api/rides/${ride.id}/receipt/email`, { token: rider.token });
  assert.equal(mail.status, 503, 'without SMTP, email is refused - never faked');
  assert.match(mail.body.error, /Email is not set up/);

  const history = (await api('GET', '/api/rides/history', { token: rider.token })).body.rides;
  assert.equal(history[0].id, ride.id);
  assert.equal(history[0].payment.status, 'paid');
  assert.equal((await book(rider.token, { promoCode: 'WELCOME50' })).status, 400, 'first-ride promo cannot be reused');
});

test('without a payment gateway, card/UPI/top-up are refused and cash still works', async () => {
  const saved = { ...config.razorpay };
  Object.assign(config.razorpay, { keyId: '', keySecret: '' }); // as if no Razorpay keys were set
  try {
    const features = (await api('GET', '/api/features')).body;
    assert.deepEqual([features.onlinePayments, features.email, features.onlinePaymentsTestMode], [false, false, false]);
    assert.match(features.onlinePaymentsMessage, /not set up/);

    const rider = await register('rider');
    for (const paymentMethod of ['card', 'upi']) {
      const res = await book(rider.token, { paymentMethod, upiVpa: 'asha@okhdfc' });
      assert.equal(res.status, 503, `${paymentMethod} booking refused`);
    }
    const top = await api('POST', '/api/payments/razorpay/order', { token: rider.token, body: { kind: 'topup', amount: 500 } });
    assert.equal(top.status, 503, 'top-up refused, balance untouched');
    assert.equal((await api('GET', '/api/auth/me', { token: rider.token })).body.user.walletBalance, 0);
    const cash = await book(rider.token, { paymentMethod: 'cash' });
    assert.equal(cash.status, 201);
    await api('POST', `/api/rides/${cash.body.ride.id}/cancel`, { token: rider.token });
  } finally {
    Object.assign(config.razorpay, saved);
  }
});

test('Razorpay: server-set amounts, signature + Razorpay confirmation, exactly-once, double payments flagged', async () => {
  const features = (await api('GET', '/api/features')).body;
  assert.deepEqual([features.onlinePayments, features.onlinePaymentsTestMode], [true, true]);

  const rider = await register('rider');
  const driver = await register('driver', 'car');
  await online(driver.token);

  // A finished ride booked with UPI, so the fare is due.
  const { body } = await book(rider.token, { paymentMethod: 'upi', upiVpa: 'asha@okhdfc' });
  const rideId = body.ride.id;
  await driveToOngoing(rideId, rider, driver);
  const done = (await api('POST', `/api/rides/${rideId}/complete`, { token: driver.token })).body.ride;
  assert.equal(done.payment.status, 'due');

  const order = await api('POST', '/api/payments/razorpay/order', { token: rider.token, body: { kind: 'ride', rideId, amount: 1 } });
  assert.equal(order.status, 201);
  assert.equal(order.body.amountPaise, done.price.fare * 100, 'the amount comes from the ride, not the request');
  assert.equal(order.body.keyId, 'rzp_test_key');
  assert.equal(order.body.testMode, true);
  const orderId = order.body.orderId;
  const verify = (paymentId, signature = sign(orderId, paymentId), token = rider.token) =>
    api('POST', '/api/payments/razorpay/verify', { token, body: { orderId, paymentId, signature } });

  // What Razorpay Checkout would produce, in its sandbox.
  stub.rzpPayments.set('pay_wrongamt', { id: 'pay_wrongamt', order_id: orderId, amount: 100, currency: 'INR', status: 'captured', method: 'upi' });
  stub.rzpPayments.set('pay_failed', { id: 'pay_failed', order_id: orderId, amount: done.price.fare * 100, currency: 'INR', status: 'failed', method: 'upi' });
  stub.rzpPayments.set('pay_ok', { id: 'pay_ok', order_id: orderId, amount: done.price.fare * 100, currency: 'INR', status: 'authorized', method: 'upi' });

  assert.equal((await verify('pay_ok', 'forged-signature')).status, 400, 'forged signature refused');
  const stranger = await register('rider');
  assert.equal((await verify('pay_ok', undefined, stranger.token)).status, 404, 'someone else cannot settle this order');
  assert.equal((await verify('pay_wrongamt')).status, 400, 'wrong amount refused');
  assert.equal((await verify('pay_failed')).status, 402, 'failed payment does not count');
  assert.equal((await api('GET', `/api/rides/${rideId}`, { token: rider.token })).body.ride.payment.status, 'due');

  const ok = await verify('pay_ok');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'paid');
  assert.equal(stub.rzpPayments.get('pay_ok').status, 'captured', 'an authorized payment is captured by the server');
  assert.deepEqual([ok.body.ride.payment.status, ok.body.ride.payment.method, ok.body.ride.payment.ref], ['paid', 'upi', 'pay_ok']);
  const driverWallet = (await api('GET', '/api/auth/me', { token: driver.token })).body.user.walletBalance;
  assert.equal(driverWallet, Math.round(done.price.fare * 0.8), 'driver credited 80%');

  // The same payment reported again (checkout retry, then the webhook) changes nothing.
  assert.equal((await verify('pay_ok')).status, 200);
  const hook = (payload, secret = 'whsec') =>
    fetch(`${base}/api/payments/razorpay/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', secret).update(payload).digest('hex') },
      body: payload,
    });
  const captured = (p) => JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: p } } });
  assert.equal((await hook(captured(stub.rzpPayments.get('pay_ok')))).status, 200);
  assert.equal((await hook(captured(stub.rzpPayments.get('pay_ok')), 'wrong-secret')).status, 400, 'unsigned webhook refused');
  assert.equal((await api('GET', '/api/auth/me', { token: driver.token })).body.user.walletBalance, driverWallet, 'no double credit');

  // Wallet top-up confirmed by the webhook alone (the rider closed the tab).
  const top = (await api('POST', '/api/payments/razorpay/order', { token: rider.token, body: { kind: 'topup', amount: 500 } })).body;
  assert.equal((await api('POST', '/api/payments/razorpay/order', { token: rider.token, body: { kind: 'topup', amount: 20 } })).status, 400);
  const topPay = { id: 'pay_top', order_id: top.orderId, amount: 50000, currency: 'INR', status: 'captured', method: 'card' };
  stub.rzpPayments.set('pay_top', topPay);
  await hook(captured(topPay));
  await hook(captured(topPay));
  assert.equal((await api('GET', '/api/auth/me', { token: rider.token })).body.user.walletBalance, 500, 'credited exactly once');

  // Paid twice (cash collected, then an online payment lands): flagged for refund, never double-counted.
  const second = (await book(rider.token, { paymentMethod: 'cash' })).body.ride;
  await driveToOngoing(second.id, rider, driver);
  const fare2 = (await api('POST', `/api/rides/${second.id}/complete`, { token: driver.token })).body.ride.price.fare;
  const late = (await api('POST', '/api/payments/razorpay/order', { token: rider.token, body: { kind: 'ride', rideId: second.id } })).body;
  await api('POST', `/api/rides/${second.id}/collect-cash`, { token: driver.token });
  stub.rzpPayments.set('pay_late', { id: 'pay_late', order_id: late.orderId, amount: fare2 * 100, currency: 'INR', status: 'captured', method: 'card' });
  const dup = await api('POST', '/api/payments/razorpay/verify', { token: rider.token, body: { orderId: late.orderId, paymentId: 'pay_late', signature: sign(late.orderId, 'pay_late') } });
  assert.equal(dup.body.status, 'needs_refund');
  assert.equal(dup.body.ride.payment.ref.startsWith('CASH-'), true, 'the ride stays paid by cash');
});

test('refunds: disputes, Razorpay or wallet, never more than paid, driver share adjusted, failures freed', async () => {
  const rider = await register('rider');
  const driver = await register('driver', 'car');
  const boss = await admin2();
  await online(driver.token);
  const hook = (payload) =>
    fetch(`${base}/api/payments/razorpay/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', 'whsec').update(payload).digest('hex') },
      body: payload,
    });
  const earnings = async () => (await api('GET', '/api/rides/earnings', { token: driver.token })).body.earnings.total;
  const walletOf = async (u) => (await api('GET', '/api/auth/me', { token: u.token })).body.user.walletBalance;
  const refund = (body, token = boss.token) => api('POST', '/api/admin/refunds', { token, body: { reason: 'Driver took a longer route', ...body } });

  // A ride paid through Razorpay.
  const { body } = await book(rider.token, { paymentMethod: 'card' });
  const rideId = body.ride.id;
  await driveToOngoing(rideId, rider, driver);
  const fare = (await api('POST', `/api/rides/${rideId}/complete`, { token: driver.token })).body.ride.price.fare;
  const order = (await api('POST', '/api/payments/razorpay/order', { token: rider.token, body: { kind: 'ride', rideId } })).body;
  stub.rzpPayments.set('pay_r1', { id: 'pay_r1', order_id: order.orderId, amount: fare * 100, currency: 'INR', status: 'captured', method: 'card' });
  await api('POST', '/api/payments/razorpay/verify', { token: rider.token, body: { orderId: order.orderId, paymentId: 'pay_r1', signature: sign(order.orderId, 'pay_r1') } });
  const earned = await earnings();

  // The rider disputes the fare.
  assert.equal((await api('POST', '/api/support/tickets', { token: rider.token, body: { category: 'fare_dispute', subject: 'Overcharged', message: 'Took a long route' } })).status, 400, 'a dispute needs a trip');
  const ticket = (await api('POST', '/api/support/tickets', { token: rider.token, body: { category: 'fare_dispute', subject: 'Overcharged', message: 'Took a long route', rideId } })).body.ticket;

  assert.deepEqual((await api('GET', `/api/admin/refundable?rideId=${rideId}`, { token: boss.token })).body, { paid: fare, refunded: 0, remaining: fare, original: 'razorpay' });
  assert.equal((await refund({ rideId, amount: 20, destination: 'original' }, rider.token)).status, 403, 'only admins refund');
  assert.equal((await refund({ rideId, amount: 20, destination: 'original', reason: 'x' })).status, 400, 'a reason is required');

  // Partial refund back to the card through Razorpay.
  const notified = new Promise((resolve) => socketFor(rider.token).then((s) => s.on('notify', (n) => /Refund of/.test(n.title) && resolve(n))));
  await new Promise((r) => setTimeout(r, 50));
  const r1 = await refund({ rideId, amount: 20, destination: 'original', ticketId: ticket.id });
  assert.equal(r1.status, 201);
  assert.deepEqual([r1.body.refund.status, r1.body.refund.razorpayRefundId, r1.body.refund.driverAdjustment], ['processed', 'rfnd_1', 16]);
  assert.equal(stub.rzpRefunds.get('rfnd_1').amount, 2000, 'Razorpay was asked for exactly ₹20');
  assert.match((await notified).body, /original payment method/);
  assert.equal(await earnings(), earned - 16, "driver's 80% share of the refund is taken back");
  const thread = (await api('GET', `/api/support/tickets/${ticket.id}`, { token: rider.token })).body;
  assert.equal(thread.ticket.status, 'resolved');
  assert.match(thread.messages.at(-1).body, /refunded ₹20/);

  // Never more than was paid.
  assert.equal((await refund({ rideId, amount: fare, destination: 'wallet' })).status, 400);

  // Razorpay refusing a refund frees the amount again.
  stub.refundRefuse = true;
  assert.equal((await refund({ rideId, amount: 10, destination: 'original' })).status, 502);
  stub.refundRefuse = false;
  assert.equal((await api('GET', `/api/admin/refundable?rideId=${rideId}`, { token: boss.token })).body.remaining, fare - 20);

  // A pending Razorpay refund that later fails gives the driver's share back.
  stub.refundStatus = 'pending';
  const pending = (await refund({ rideId, amount: 10, destination: 'original' })).body.refund;
  stub.refundStatus = null;
  assert.equal(pending.status, 'pending');
  const before = await earnings();
  await hook(JSON.stringify({ event: 'refund.failed', payload: { refund: { entity: { ...stub.rzpRefunds.get(pending.razorpayRefundId), status: 'failed' } } } }));
  assert.equal(await earnings(), before + 8, 'reversal of the ₹8 driver adjustment');

  // The rest to the wallet; then nothing is left.
  const left = fare - 20;
  const walletBefore = await walletOf(rider);
  assert.equal((await refund({ rideId, amount: left, destination: 'wallet' })).body.refund.status, 'processed');
  assert.equal(await walletOf(rider), walletBefore + left);
  assert.equal((await refund({ rideId, amount: 1, destination: 'wallet' })).status, 400);
  const seen = (await api('GET', `/api/rides/${rideId}`, { token: rider.token })).body.ride.refunds;
  assert.deepEqual(seen.map((x) => [x.amount, x.status]), [
    [20, 'processed'],
    [10, 'failed'],
    [10, 'failed'],
    [left, 'processed'],
  ]);

  // Cash trips can only be refunded to the wallet.
  const cash = (await book(rider.token, { paymentMethod: 'cash' })).body.ride;
  await driveToOngoing(cash.id, rider, driver);
  await api('POST', `/api/rides/${cash.id}/complete`, { token: driver.token });
  await api('POST', `/api/rides/${cash.id}/collect-cash`, { token: driver.token });
  assert.equal((await refund({ rideId: cash.id, amount: 5, destination: 'original' })).status, 400);
  assert.equal((await refund({ rideId: cash.id, amount: 5, destination: 'wallet' })).status, 201);

  // A duplicate payment (paid twice) is refunded in full without touching the driver.
  const dupRide = (await book(rider.token, { paymentMethod: 'cash' })).body.ride;
  await driveToOngoing(dupRide.id, rider, driver);
  const fare3 = (await api('POST', `/api/rides/${dupRide.id}/complete`, { token: driver.token })).body.ride.price.fare;
  const late = (await api('POST', '/api/payments/razorpay/order', { token: rider.token, body: { kind: 'ride', rideId: dupRide.id } })).body;
  await api('POST', `/api/rides/${dupRide.id}/collect-cash`, { token: driver.token });
  stub.rzpPayments.set('pay_dup', { id: 'pay_dup', order_id: late.orderId, amount: fare3 * 100, currency: 'INR', status: 'captured', method: 'card' });
  await api('POST', '/api/payments/razorpay/verify', { token: rider.token, body: { orderId: late.orderId, paymentId: 'pay_dup', signature: sign(late.orderId, 'pay_dup') } });
  const dups = (await api('GET', '/api/admin/refunds', { token: boss.token })).body.duplicates;
  const dup = dups.find((d) => d.paymentId === 'pay_dup');
  assert.equal(dup.amount, fare3);
  const driverBefore = await earnings();
  const dr = (await refund({ paymentOrderId: dup.id, amount: fare3, destination: 'original', reason: 'Paid twice for one ride' })).body.refund;
  assert.deepEqual([dr.status, dr.driverAdjustment], ['processed', 0]);
  assert.equal(await earnings(), driverBefore, 'duplicate refunds never touch driver earnings');
  assert.equal((await api('GET', '/api/admin/refunds', { token: boss.token })).body.duplicates.some((d) => d.id === dup.id), false, 'no longer waiting');
});

test('wallet: auto-debit on completion, insufficient balance is refused up front', async () => {
  const rider = await register('rider');
  const driver = await register('driver', 'auto');
  await online(driver.token);

  assert.equal((await book(rider.token, { vehicleType: 'auto', paymentMethod: 'wallet' })).status, 400);
  await fundWallet(rider.user.id, 1000);

  const { body } = await book(rider.token, { vehicleType: 'auto', paymentMethod: 'wallet' });
  await driveToOngoing(body.ride.id, rider, driver);
  const done = (await api('POST', `/api/rides/${body.ride.id}/complete`, { token: driver.token })).body.ride;
  assert.equal(done.payment.status, 'paid');
  const me = (await api('GET', '/api/auth/me', { token: rider.token })).body.user;
  assert.equal(me.walletBalance, 1000 - done.price.fare);
  const d = (await api('GET', '/api/auth/me', { token: driver.token })).body.user;
  assert.equal(d.walletBalance, Math.round(done.price.fare * 0.8), 'driver payout credited');
});

test('late cancellation charges a fee; UPI is refused without a gateway, the wallet pays it', async () => {
  const rider = await register('rider');
  const driver = await register('driver', 'car');
  await online(driver.token);
  const { body } = await book(rider.token, { paymentMethod: 'cash' });
  await api('POST', `/api/rides/${body.ride.id}/accept`, { token: driver.token });
  await new Promise((r) => setTimeout(r, 80)); // past FREE_CANCEL_MS
  assert.equal((await api('GET', `/api/rides/${body.ride.id}/cancel-fee`, { token: rider.token })).body.fee, 40);
  const cancel = await api('POST', `/api/rides/${body.ride.id}/cancel`, { token: rider.token, body: { reason: 'Changed plans' } });
  assert.equal(cancel.body.cancellationFee, 40);
  assert.equal(cancel.body.ride.payment.status, 'due');
  const upi = await api('POST', `/api/payments/rides/${body.ride.id}/pay`, { token: rider.token, body: { method: 'upi' } });
  assert.equal(upi.status, 400, 'UPI goes through Razorpay checkout, not this endpoint');
  assert.equal((await api('GET', `/api/rides/${body.ride.id}`, { token: rider.token })).body.ride.payment.status, 'due', 'still due, not faked as paid');

  await fundWallet(rider.user.id, 100);
  const pay = await api('POST', `/api/payments/rides/${body.ride.id}/pay`, { token: rider.token, body: { method: 'wallet' } });
  assert.equal(pay.status, 200);
  assert.equal(pay.body.ride.payment.status, 'paid');
  assert.match(pay.body.ride.payment.ref, /^WALLET-/);
  assert.equal((await api('GET', '/api/auth/me', { token: rider.token })).body.user.walletBalance, 60);

  // A cancel inside the grace window is free.
  const again = await book(rider.token);
  assert.equal((await api('POST', `/api/rides/${again.body.ride.id}/cancel`, { token: rider.token })).body.cancellationFee, 0);
});

test('surge only kicks in when waiting riders outnumber free drivers nearby', async () => {
  // Mumbai, far from every other test's drivers and requests.
  const A = { address: 'Bandra', lat: 19.0596, lng: 72.8295 };
  const B = { address: 'Andheri', lat: 19.1136, lng: 72.8697 };
  const quoteBike = async (token) =>
    (await api('POST', '/api/rides/quote', { token, body: { pickup: A, dropoff: B } })).body.options.find((o) => o.type === 'bike').price.surge;

  const [r1, r2, r3] = await Promise.all([register('rider'), register('rider'), register('rider')]);
  assert.equal(await quoteBike(r3.token), 1, 'nobody waiting, no surge');
  const b1 = await api('POST', '/api/rides', { token: r1.token, body: { pickup: A, dropoff: B, vehicleType: 'bike', paymentMethod: 'cash' } });
  const b2 = await api('POST', '/api/rides', { token: r2.token, body: { pickup: A, dropoff: B, vehicleType: 'bike', paymentMethod: 'cash' } });
  assert.equal(b2.body.ride.price.surge, 1.2, 'second rider pays for the first one waiting');
  assert.equal(await quoteBike(r3.token), 1.4);
  for (const [b, r] of [[b1, r1], [b2, r2]]) await api('POST', `/api/rides/${b.body.ride.id}/cancel`, { token: r.token });
  assert.equal(await quoteBike(r3.token), 1);
});

test('an unanswered request expires and the rider is told', async () => {
  const rider = await register('rider');
  const rs = await socketFor(rider.token);
  const update = nextEvent(rs, 'ride:update', 4000);
  const { body } = await book(rider.token, { vehicleType: 'bike' });
  const expired = await update;
  assert.equal(expired.id, body.ride.id);
  assert.equal(expired.status, 'cancelled');
  assert.equal(expired.cancelledBy, 'system');
});

test('SOS reaches admins live, share link tracks the driver, support tickets round-trip', async () => {
  const rider = await register('rider');
  const driver = await register('driver', 'car');
  const boss = await admin();
  const adminSocket = await socketFor(boss.token);
  const ds = await online(driver.token);
  await api('PUT', '/api/profile/emergency-contacts', {
    token: rider.token,
    body: { contacts: [{ name: 'Mom', phone: '9812345678' }, { name: 'Bad number', phone: '9800000000' }] },
  });

  const { body } = await book(rider.token);
  await driveToOngoing(body.ride.id, rider, driver);
  ds.emit('driver:location', { lat: 22.56, lng: 88.39 });
  await new Promise((r) => setTimeout(r, 50));

  const sosEvent = nextEvent(adminSocket, 'sos');
  const sos = await api('POST', '/api/sos', { token: rider.token, body: { rideId: body.ride.id, location: { lat: 22.56, lng: 88.39 } } });
  assert.equal(sos.status, 201);
  assert.equal(sos.body.contacts[0].phone, '+919812345678');
  assert.equal((await sosEvent).rideId, body.ride.id);

  // Automatic SOS texts: each contact's real outcome, failures included. The rider sees sent/failed;
  // Twilio's own error text is kept on the alert for admins, not shown in the app.
  assert.equal(sos.body.smsEnabled, true);
  assert.deepEqual(
    sos.body.smsResults.map((r) => [r.name, r.status]),
    [
      ['Mom', 'sent'],
      ['Bad number', 'failed'],
    ],
  );
  assert.equal(sos.body.smsResults[1].error, undefined);
  const text = stub.sms.find((m) => m.To === '+919812345678');
  assert.ok(text.Body.includes(sos.body.trackUrl), 'the text carries the live-tracking link');
  const stored = await query('SELECT sms_results FROM sos_alerts WHERE id = $1', [sos.body.alertId]);
  assert.equal(stored.rows[0].sms_results.length, 2, 'outcomes are stored for admins');
  assert.match(stored.rows[0].sms_results[1].error, /Invalid To number/, 'with the provider error, for admins');

  const token = sos.body.trackUrl.split('/track/')[1];
  const track = (await api('GET', `/api/track/${token}`)).body;
  assert.equal(track.status, 'ongoing');
  assert.deepEqual(track.driverLocation, { lat: 22.56, lng: 88.39 });
  assert.equal(track.riderName, 'rider');
  assert.equal((await api('GET', '/api/track/not-a-token')).status, 404);

  const overview = (await api('GET', '/api/admin/overview', { token: boss.token })).body;
  assert.ok(overview.open_sos >= 1);
  // Dashboard insights: 7 days of real counts, the vehicle mix, and live rides with their points.
  const insights = (await api('GET', '/api/admin/insights', { token: boss.token })).body;
  assert.equal(insights.days.length, 7);
  assert.ok(insights.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day) && Number.isInteger(d.completed) && Number.isInteger(d.paid)));
  assert.ok(Array.isArray(insights.vehicles) && Array.isArray(insights.live.drivers) && Array.isArray(insights.live.rides));
  assert.ok(insights.live.rides.every((r) => typeof r.pickup.lat === 'number'));
  assert.equal((await api('GET', '/api/admin/insights', { token: rider.token })).status, 403);
  assert.equal((await api('POST', `/api/admin/sos/${sos.body.alertId}/resolve`, { token: boss.token })).status, 200);

  const ticketEvent = nextEvent(adminSocket, 'ticket');
  const t = await api('POST', '/api/support/tickets', {
    token: rider.token,
    body: { category: 'lost_item', subject: 'Left my umbrella', message: 'Blue umbrella on the back seat', rideId: body.ride.id },
  });
  assert.equal(t.status, 201);
  assert.equal((await ticketEvent).id, t.body.ticket.id);

  const rs = await socketFor(rider.token);
  const replyNote = nextEvent(rs, 'notify');
  const reply = await api('POST', `/api/support/tickets/${t.body.ticket.id}/messages`, { token: boss.token, body: { body: 'Driver has it, will return it tomorrow.' } });
  assert.equal(reply.body.ticket.status, 'in_progress');
  assert.equal(reply.body.messages.length, 2);
  assert.match((await replyNote).title, /Support replied/);
});

test('chat: only the assigned rider and driver, live, read receipts, no phone numbers anywhere', async () => {
  const rider = await register('rider');
  const driver = await register('driver', 'car');
  const otherDriver = await register('driver', 'car');
  const boss = await admin2();
  const ds = await online(driver.token);
  const rs = await socketFor(rider.token);
  const offer = nextEvent(ds, 'ride:offer');
  const { body } = await book(rider.token);
  const rideId = body.ride.id;
  assert.equal((await offer).rider.phone, undefined, 'offers carry no rider number');
  const say = (who, text) => api('POST', `/api/rides/${rideId}/messages`, { token: who.token, body: { body: text } });

  assert.equal((await say(rider, 'hello?')).status, 409, 'no chat before a driver accepts');
  assert.equal((await api('POST', `/api/rides/${rideId}/accept`, { token: driver.token })).status, 200);

  for (const who of [rider, driver]) {
    const view = (await api('GET', `/api/rides/${rideId}`, { token: who.token })).body.ride;
    assert.equal(view.rider.phone, undefined);
    assert.equal(view.driver.phone, undefined);
  }

  const incoming = nextEvent(rs, 'chat:message');
  const sent = await say(driver, '  At the gate, white Swift.  ');
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.body, 'At the gate, white Swift.');
  const live = await incoming;
  assert.equal(live.id, sent.body.message.id);
  assert.equal(live.senderId, driver.user.id);
  assert.equal(live.readAt, null);

  const receipt = nextEvent(ds, 'chat:read');
  assert.equal((await api('POST', `/api/rides/${rideId}/messages/read`, { token: rider.token })).body.read, 1);
  assert.deepEqual((await receipt).ids, [live.id]);
  assert.equal((await api('POST', `/api/rides/${rideId}/messages/read`, { token: driver.token })).body.read, 0, 'own messages are not marked');
  assert.equal((await say(rider, 'Coming down')).status, 201);

  assert.equal((await say(rider, '   ')).status, 400);
  assert.equal((await say(rider, 'x'.repeat(501))).status, 400);
  assert.equal((await say(otherDriver, 'hi')).status, 404, 'another driver cannot see or write in it');
  assert.equal((await api('GET', `/api/rides/${rideId}/messages`, { token: otherDriver.token })).status, 404);
  assert.equal((await api('POST', `/api/rides/${rideId}/messages`, { token: boss.token, body: { body: 'hi' } })).status, 403, 'admins read, never write');

  const forAdmin = await api('GET', `/api/rides/${rideId}/messages`, { token: boss.token });
  assert.deepEqual(forAdmin.body.messages.map((m) => m.body), ['At the gate, white Swift.', 'Coming down']);
  assert.ok(forAdmin.body.messages[0].readAt);

  await api('POST', `/api/rides/${rideId}/cancel`, { token: rider.token, body: { reason: 'Plans changed' } });
  assert.equal((await say(rider, 'sorry')).status, 409, 'read-only once the trip is over');
  const after = await api('GET', `/api/rides/${rideId}/messages`, { token: rider.token });
  assert.equal(after.body.open, false);
  assert.equal(after.body.messages.length, 2);
});

test('route deviation: alert after staying off route, rider/driver/admins told, clears, never on estimated routes', async () => {
  const rider = await register('rider');
  const driver = await register('driver', 'car');
  const boss = await admin2();
  const ds = await online(driver.token);
  const rs = await socketFor(rider.token);
  const as = await socketFor(boss.token);
  const { body } = await book(rider.token);
  const rideId = body.ride.id;
  assert.equal(body.ride.routeWatched, false, 'offline routing gives a straight-line estimate, which is never watched');

  // Test-only fixture in the throwaway database: a road route, as OSRM would have saved it.
  const line = [[PICKUP.lat, PICKUP.lng], [22.5600, 88.3800], [DROPOFF.lat, DROPOFF.lng]];
  await query('UPDATE rides SET route = $2, route_estimated = false WHERE id = $1', [rideId, JSON.stringify(line)]);
  await driveToOngoing(rideId, rider, driver);
  assert.equal((await api('GET', `/api/rides/${rideId}`, { token: rider.token })).body.ride.routeWatched, true);

  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const at = async (point, ms = 150) => {
    ds.emit('driver:location', point);
    await pause(ms);
  };
  const FAR = { lat: 22.5435, lng: 88.3525, accuracy: 10 }; // ~1.1 km south of the route
  const ON = { lat: 22.5600, lng: 88.3800, accuracy: 10 };
  const count = async () => (await query('SELECT count(*)::int AS n FROM route_deviations WHERE ride_id = $1', [rideId])).rows[0].n;

  // Poor GPS fixes never count, however far off they look.
  await at({ ...FAR, accuracy: 400 }, 1100);
  await at({ ...FAR, accuracy: 400 });
  assert.equal(await count(), 0);

  // Briefly off route (less than the time threshold): no alert.
  await at(FAR, 300);
  await at(ON);
  await at(FAR, 300);
  assert.equal(await count(), 0, 'returning to the route restarts the clock');

  // Staying off: alert.
  const riderAlert = nextEvent(rs, 'ride:deviation');
  const driverAlert = nextEvent(ds, 'ride:deviation');
  const adminAlert = nextEvent(as, 'deviation');
  const riderNote = nextEvent(rs, 'notify');
  await at(FAR, 1100);
  await at(FAR);
  const alert = await riderAlert;
  assert.equal(alert.status, 'open');
  assert.ok(alert.distanceM > 1000 && alert.distanceM < 1300, `distance ${alert.distanceM}`);
  assert.equal((await driverAlert).id, alert.id);
  assert.equal((await adminAlert).id, alert.id);
  assert.match((await riderNote).title, /left the planned route/);
  assert.deepEqual((await api('GET', `/api/rides/${rideId}`, { token: rider.token })).body.ride.alerts.map((a) => a.id), [alert.id]);

  const list = await api('GET', '/api/admin/deviations', { token: boss.token });
  const row = list.body.deviations.find((d) => d.id === alert.id);
  assert.equal(row.status, 'open');
  assert.ok(row.driver.plate);
  assert.ok(row.trackPath.startsWith('/track/'));
  assert.equal((await api('GET', '/api/admin/overview', { token: boss.token })).body.open_deviations >= 1, true);
  assert.equal((await api('GET', '/api/admin/deviations', { token: rider.token })).status, 403);

  // Back on the route: the same alert closes.
  const cleared = nextEvent(rs, 'ride:deviation');
  await at(ON);
  const back = await cleared;
  assert.equal(back.id, alert.id);
  assert.equal(back.status, 'resolved');
  assert.equal(back.resolution, 'back_on_route');
  assert.equal((await api('GET', `/api/rides/${rideId}`, { token: rider.token })).body.ride.alerts.length, 0);

  // Off again, then the trip ends: a second alert, closed by the trip ending.
  // A driver standing still off the route sends one fix and then nothing: still alerted on time.
  const second = nextEvent(rs, 'ride:deviation');
  await at(FAR);
  const again = await second;
  assert.notEqual(again.id, alert.id);
  const ended = nextEvent(rs, 'ride:deviation');
  assert.equal((await api('POST', `/api/rides/${rideId}/complete`, { token: driver.token })).status, 200);
  assert.equal((await ended).resolution, 'trip_ended');
  assert.equal(await count(), 2);

  assert.equal((await api('POST', `/api/admin/deviations/${alert.id}/check`, { token: boss.token })).status, 200);
  assert.equal((await api('POST', `/api/admin/deviations/${alert.id}/check`, { token: boss.token })).status, 409);
});

test('scheduled rides: no surge, offered before pickup, free to cancel, cancelled with a reason when they cannot go', async () => {
  const { runScheduler } = await import('../src/routes/rides.js');
  const rider = await register('rider');
  const driver = await register('driver', 'car');
  const rs = await socketFor(rider.token);
  const ds = await online(driver.token);
  const at = (min) => new Date(Date.now() + min * 60_000).toISOString();
  const status = async (id) => (await api('GET', `/api/rides/${id}`, { token: rider.token })).body.ride;

  assert.equal((await book(rider.token, { scheduledFor: at(5) })).status, 400, 'at least 30 min ahead');
  assert.equal((await book(rider.token, { scheduledFor: at(8 * 24 * 60) })).status, 400, 'at most 7 days ahead');
  const quote = await api('POST', '/api/rides/quote', { token: rider.token, body: { pickup: PICKUP, dropoff: DROPOFF, scheduledFor: at(35) } });
  assert.ok(quote.body.options.every((o) => o.price.surge === 1), 'future demand is unknown: no surge');

  const s = await book(rider.token, { scheduledFor: at(35) });
  let early = 0;
  const countEarly = (o) => o.id === s.body.ride.id && early++;
  ds.on('ride:offer', countEarly);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.ride.status, 'scheduled');
  assert.equal(s.body.offeredTo, 0, 'not offered to anyone yet');
  assert.ok(s.body.ride.scheduledFor);

  // A scheduled ride does not stop the rider riding now.
  const nowRide = await book(rider.token);
  assert.equal(nowRide.status, 201);
  await api('POST', `/api/rides/${nowRide.body.ride.id}/cancel`, { token: rider.token });
  assert.deepEqual((await api('GET', '/api/rides/scheduled', { token: rider.token })).body.rides.map((r) => r.id), [s.body.ride.id]);

  // Too early: stays scheduled.
  await runScheduler();
  assert.equal((await status(s.body.ride.id)).status, 'scheduled');
  assert.equal(early, 0, 'drivers are not offered it before its time');
  ds.off('ride:offer', countEarly);

  // 15 minutes before pickup it goes out to drivers.
  const offer = nextEvent(ds, 'ride:offer');
  const note = nextEvent(rs, 'notify');
  await runScheduler(Date.now() + 25 * 60_000);
  const o = await offer;
  assert.equal(o.id, s.body.ride.id);
  assert.ok(o.scheduledFor, 'the driver sees it is a scheduled pickup');
  assert.match((await note).title, /Finding your driver/);
  assert.equal((await status(s.body.ride.id)).status, 'requested');
  assert.equal((await api('POST', `/api/rides/${s.body.ride.id}/accept`, { token: driver.token })).status, 200);
  await api('POST', `/api/rides/${s.body.ride.id}/cancel`, { token: driver.token, body: { reason: 'test over' } });

  // Cancelling before it goes out is free.
  const s2 = await book(rider.token, { scheduledFor: at(40) });
  const cancelled = await api('POST', `/api/rides/${s2.body.ride.id}/cancel`, { token: rider.token });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.cancellationFee, 0);

  // Already in another ride at that time: cancelled with the reason, never silently.
  const s3 = await book(rider.token, { scheduledFor: at(35) });
  const busy = await book(rider.token);
  const busyNote = nextEvent(rs, 'notify');
  await runScheduler(Date.now() + 25 * 60_000);
  const s3view = await status(s3.body.ride.id);
  assert.equal(s3view.status, 'cancelled');
  assert.match(s3view.cancelReason, /another ride/);
  assert.match((await busyNote).title, /Scheduled ride cancelled/);
  await api('POST', `/api/rides/${busy.body.ride.id}/cancel`, { token: rider.token });

  // The server was off past the pickup time: cancelled, not sent late.
  const s4 = await book(rider.token, { scheduledFor: at(35) });
  await runScheduler(Date.now() + 45 * 60_000);
  assert.match((await status(s4.body.ride.id)).cancelReason, /could not look for a driver/);

  // At most five upcoming.
  for (let i = 0; i < 5; i++) assert.equal((await book(rider.token, { scheduledFor: at(60 + i) })).status, 201);
  assert.equal((await book(rider.token, { scheduledFor: at(70) })).status, 409);
});

test('saved places: Home/Work replaced not duplicated, own places listed, private to their owner', async () => {
  const rider = await register('rider');
  const other = await register('rider');
  const save = (who, body) => api('POST', '/api/places', { token: who.token, body });
  assert.equal((await save(rider, { kind: 'home' })).status, 400, 'needs a location');
  assert.equal((await save(rider, { kind: 'castle', ...PICKUP })).status, 400);
  assert.equal((await save(rider, { kind: 'other', ...STOP })).status, 400, 'custom places need a name');

  const home = await save(rider, { kind: 'home', ...PICKUP });
  assert.equal(home.status, 201);
  assert.equal(home.body.place.name, 'Home');
  const moved = await save(rider, { kind: 'home', ...STOP });
  assert.equal(moved.body.place.id, home.body.place.id, 'one Home, updated in place');
  assert.equal(moved.body.place.address, 'Sealdah');
  await save(rider, { kind: 'other', name: 'Gym', ...DROPOFF });
  await save(rider, { kind: 'work', ...DROPOFF });

  const list = (await api('GET', '/api/places', { token: rider.token })).body.places;
  assert.deepEqual(list.map((p) => p.name), ['Home', 'Work', 'Gym']);
  assert.equal((await api('GET', '/api/places', { token: other.token })).body.places.length, 0);
  assert.equal((await api('DELETE', `/api/places/${list[2].id}`, { token: other.token })).status, 404, 'cannot delete someone else’s');
  assert.equal((await api('DELETE', `/api/places/${list[2].id}`, { token: rider.token })).status, 200);
  assert.equal((await api('GET', '/api/places', { token: rider.token })).body.places.length, 2);
});

test('safety basics: own trip PIN, no typing while driving, long-stop alert with "I\'m OK"', async () => {
  const rider = await register('rider');
  const driver = await register('driver', 'car');
  const pin = (p) => api('PUT', '/api/profile/trip-pin', { token: rider.token, body: { pin: p } });
  for (const bad of ['12', 'abcd', '1111', '1234', '4321']) assert.equal((await pin(bad)).status, 400, `rejects ${bad}`);
  assert.equal((await pin('7391')).body.user.tripPin, '7391');
  assert.equal((await api('PUT', '/api/profile/trip-pin', { token: driver.token, body: { pin: '7391' } })).status, 403);

  const ds = await online(driver.token);
  const rs = await socketFor(rider.token);
  const { body } = await book(rider.token);
  const rideId = body.ride.id;
  assert.equal((await api('POST', `/api/rides/${rideId}/accept`, { token: driver.token })).status, 200);
  assert.equal((await api('GET', `/api/rides/${rideId}`, { token: rider.token })).body.ride.otp, '7391', "the rider's own PIN is the trip code");

  // Moving (two fixes ~35 m apart, 1.1 s apart): quick replies only.
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const say = (who, text) => api('POST', `/api/rides/${rideId}/messages`, { token: who.token, body: { body: text } });
  ds.emit('driver:location', { lat: 22.5500, lng: 88.3500 });
  await pause(1100);
  ds.emit('driver:location', { lat: 22.5503, lng: 88.3502 });
  await pause(150);
  const typed = await say(driver, 'I am at the gate');
  assert.deepEqual([typed.status, typed.body.code], [409, 'DRIVER_MOVING']);
  assert.equal((await say(driver, "I'm nearby")).status, 201, 'quick replies always work');
  assert.ok((await api('GET', `/api/rides/${rideId}/messages`, { token: driver.token })).body.quickReplies.includes("I'm nearby"));
  // Stopped: typing allowed again.
  await pause(1100);
  ds.emit('driver:location', { lat: 22.5503, lng: 88.3502 });
  await pause(150);
  assert.equal((await say(driver, 'I am at the gate')).status, 201);

  // Long stop during the trip (threshold shortened to 1 s for the test).
  const savedMinutes = config.longStop.minutes;
  config.longStop.minutes = 1 / 60;
  try {
    assert.equal((await api('POST', `/api/rides/${rideId}/arrive`, { token: driver.token })).status, 200);
    assert.equal((await api('POST', `/api/rides/${rideId}/start`, { token: driver.token, body: { otp: '7391' } })).status, 200);
    const MIDWAY = { lat: 22.5600, lng: 88.3800 }; // far from pickup, stops and drop
    const alertEv = nextEvent(rs, 'ride:deviation');
    const note = nextEvent(rs, 'notify');
    ds.emit('driver:location', MIDWAY);
    const alert = await alertEv;
    assert.deepEqual([alert.kind, alert.status], ['long_stop', 'open']);
    assert.match((await note).title, /stopped/);

    assert.equal((await api('POST', `/api/rides/${rideId}/alerts/${alert.id}/ok`, { token: driver.token })).status, 403, 'only the rider answers');
    const ok = await api('POST', `/api/rides/${rideId}/alerts/${alert.id}/ok`, { token: rider.token });
    assert.deepEqual([ok.status, ok.body.alerts.length], [200, 0]);
    // Still standing there: no new alert after "I'm OK".
    ds.emit('driver:location', MIDWAY);
    await pause(1300);
    const count = async () => (await query(`SELECT count(*)::int AS n FROM route_deviations WHERE ride_id = $1 AND kind = 'long_stop'`, [rideId])).rows[0].n;
    assert.equal(await count(), 1);

    // Moves on, then stops again somewhere else: a new alert, closed when the trip ends.
    const second = nextEvent(rs, 'ride:deviation');
    ds.emit('driver:location', { lat: 22.5650, lng: 88.4000 });
    const again = await second;
    assert.equal(again.kind, 'long_stop');
    assert.notEqual(again.id, alert.id);
    const ended = nextEvent(rs, 'ride:deviation');
    await api('POST', `/api/rides/${rideId}/complete`, { token: driver.token });
    assert.equal((await ended).resolution, 'trip_ended');
    assert.equal(await count(), 2);
  } finally {
    config.longStop.minutes = savedMinutes;
  }
});

test('night ride check: asked at once; no answer texts contacts and alerts admins; "I\'m safe" closes it', async () => {
  const { runSafetyChecks } = await import('../src/safetyChecks.js');
  const saved = { ...config.nightCheck };
  Object.assign(config.nightCheck, { startHour: 0, endHour: 24, replyMinutes: 0.01 }); // every hour counts; 0.6 s to answer
  try {
    const rider = await register('rider');
    const driver = await register('driver', 'car');
    const boss = await admin2();
    await api('PUT', '/api/profile/emergency-contacts', { token: rider.token, body: { contacts: [{ name: 'Mom', phone: '9812345678' }] } });
    await online(driver.token);
    const rs = await socketFor(rider.token);
    const as = await socketFor(boss.token);

    const trip = async () => {
      const { body } = await book(rider.token);
      await driveToOngoing(body.ride.id, rider, driver);
      return body.ride.id;
    };
    const rideId = await trip();
    const asked = nextEvent(rs, 'safety:check');
    await api('POST', `/api/rides/${rideId}/complete`, { token: driver.token });
    assert.equal((await asked).rideId, rideId);
    assert.equal((await api('GET', '/api/rides/safety-check', { token: rider.token })).body.check.rideId, rideId);

    assert.equal(await runSafetyChecks(), 0, 'not before the time is up');
    await new Promise((r) => setTimeout(r, 800));
    const adminEv = nextEvent(as, 'safety-check');
    assert.equal(await runSafetyChecks(), 1);
    const escalated = await adminEv;
    assert.equal(escalated.rideId, rideId);
    assert.equal(escalated.smsResults[0].name, 'Mom');
    assert.notEqual(escalated.smsResults[0].status, 'failed');
    assert.ok((await api('GET', '/api/admin/safety-checks', { token: boss.token })).body.checks.some((c) => c.rideId === rideId));
    assert.equal(await runSafetyChecks(), 0, 'escalated only once');

    const safe = await api('POST', `/api/rides/${rideId}/safe`, { token: rider.token });
    assert.equal(safe.status, 200);
    assert.ok(safe.body.check.confirmedAt);
    assert.equal((await api('POST', `/api/rides/${rideId}/safe`, { token: rider.token })).status, 409);

    // Answering in time: nobody is texted.
    const second = await trip();
    await api('POST', `/api/rides/${second}/complete`, { token: driver.token });
    assert.equal((await api('POST', `/api/rides/${second}/safe`, { token: rider.token })).status, 200);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(await runSafetyChecks(), 0);
  } finally {
    Object.assign(config.nightCheck, saved);
  }
});

test('helmet selfie: bike drivers need one a day, admins review, a rejection takes them offline', async () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const selfie = async (token, bytes) => {
    const res = await fetch(`${base}/api/driver/helmet`, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: bytes });
    return { status: res.status, body: await res.json() };
  };
  const biker = await register('driver', 'bike');
  await query('DELETE FROM helmet_checks WHERE driver_id = $1', [biker.user.id]);
  const cabbie = await register('driver', 'car');
  const boss = await admin2();
  const ds = await socketFor(biker.token);
  const goOnline = () => ds.timeout(2000).emitWithAck('driver:online', NEAR_PICKUP);

  assert.equal((await goOnline()).code, 'HELMET_SELFIE_REQUIRED');
  assert.deepEqual(
    (({ required, canDrive }) => [required, canDrive])((await api('GET', '/api/driver/helmet', { token: biker.token })).body),
    [true, false],
  );
  assert.equal((await api('GET', '/api/driver/helmet', { token: cabbie.token })).body.required, false, 'cab drivers do not need one');
  assert.equal((await selfie(cabbie.token, JPEG)).status, 400);
  assert.equal((await selfie(biker.token, Buffer.from('%PDF-1.4 x'))).status, 400, 'photos only');

  const sent = await selfie(biker.token, JPEG);
  assert.equal(sent.status, 201);
  assert.deepEqual([sent.body.canDrive, sent.body.today.status], [true, 'pending']);
  assert.equal((await goOnline()).ok, true, 'can drive while the selfie waits for review');

  const pending = (await api('GET', '/api/admin/helmet-checks', { token: boss.token })).body.checks.find((c) => c.driver.id === biker.user.id);
  assert.ok(pending.url, 'admins get a short-lived link to look at it');
  const review = (id, body) => api('POST', `/api/admin/helmet-checks/${id}/review`, { token: boss.token, body });
  assert.equal((await review(pending.id, { approve: false })).status, 400, 'a rejection needs a reason');
  const kicked = nextEvent(ds, 'driver:forced-offline');
  assert.equal((await review(pending.id, { approve: false, reason: 'No helmet visible' })).status, 200);
  assert.match((await kicked).reason, /No helmet visible/);
  assert.equal((await goOnline()).code, 'HELMET_SELFIE_REQUIRED');
  assert.equal((await review(pending.id, { approve: true })).status, 409, 'already reviewed');

  await selfie(biker.token, JPEG);
  assert.equal((await goOnline()).ok, true);
  const second = (await api('GET', '/api/admin/helmet-checks', { token: boss.token })).body.checks.find((c) => c.driver.id === biker.user.id && c.status === 'pending');
  assert.equal((await review(second.id, { approve: true })).status, 200);
});

test('fair money: tips, fare splits, late driver-cancel credit, open surge with a watch', async () => {
  const { runSurgeWatches } = await import('../src/routes/rides.js');
  const rider = await register('rider');
  const friend = await register('rider');
  const driver = await register('driver', 'car');
  await fundWallet(rider.user.id, 2000);
  await online(driver.token);
  const wallet = async (who) => (await api('GET', '/api/auth/me', { token: who.token })).body.user.walletBalance;

  // A completed, wallet-paid trip.
  const { body } = await book(rider.token, { paymentMethod: 'wallet' });
  const rideId = body.ride.id;
  await driveToOngoing(rideId, rider, driver);
  const done = (await api('POST', `/api/rides/${rideId}/complete`, { token: driver.token })).body.ride;
  assert.equal(done.payment.status, 'paid');
  const fare = done.price.fare;

  // Tips: ₹10–500, once, 100% to the driver.
  const tip = (amount) => api('POST', `/api/rides/${rideId}/tip`, { token: rider.token, body: { amount } });
  assert.equal((await tip(5)).status, 400);
  assert.equal((await tip(600)).status, 400);
  const [riderBefore, driverBefore] = [await wallet(rider), await wallet(driver)];
  assert.equal((await tip(50)).status, 200);
  assert.equal(await wallet(rider), riderBefore - 50);
  assert.equal(await wallet(driver), driverBefore + 50);
  assert.equal((await tip(20)).status, 409, 'one tip per trip');
  const view = (await api('GET', `/api/rides/${rideId}`, { token: rider.token })).body.ride;
  assert.deepEqual([view.tip, view.breakdown.driverFare, view.breakdown.hopinFare], [50, Math.round(fare * 0.8), fare - Math.round(fare * 0.8)]);

  // Online tip on a trip that was already tipped is flagged for refund, never lost.
  const order = await api('POST', '/api/payments/razorpay/order', { token: rider.token, body: { kind: 'tip', rideId, amount: 30 } });
  assert.equal(order.status, 409, 'cannot even start paying a second tip');

  // Fare split: ask a friend by phone; they pay into the requester's wallet.
  const ask = (phone, amount) => api('POST', `/api/rides/${rideId}/splits`, { token: rider.token, body: { phone, amount } });
  assert.equal((await ask('8123456789', 50)).status, 404, 'must be a Hopin rider');
  assert.equal((await ask(friend.user.phone, fare)).status, 400, 'the requester keeps part of the fare');
  const half = Math.floor(fare / 2);
  const split = await ask(friend.user.phone, half);
  assert.equal(split.status, 201);
  assert.equal((await ask(friend.user.phone, 10)).status, 409, 'one request per person');
  const incoming = (await api('GET', '/api/rides/splits/incoming', { token: friend.token })).body.splits;
  assert.deepEqual(incoming.map((s) => [s.amount, s.requester.name]), [[half, rider.user.name]]);
  const splitId = split.body.split.id;
  assert.equal((await api('POST', `/api/rides/splits/${splitId}/pay`, { token: friend.token })).status, 400, "friend's wallet is empty");
  await fundWallet(friend.user.id, half);
  const requesterBefore = await wallet(rider);
  assert.equal((await api('POST', `/api/rides/splits/${splitId}/pay`, { token: friend.token })).status, 200);
  assert.equal(await wallet(friend), 0);
  assert.equal(await wallet(rider), requesterBefore + half);
  assert.equal((await api('POST', `/api/rides/splits/${splitId}/pay`, { token: friend.token })).status, 409, 'paid once');
  assert.equal((await api('GET', `/api/rides/${rideId}`, { token: driver.token })).body.ride.splits.length, 0, 'drivers do not see splits');

  // A driver cancelling late: rider credited the cancel fee, taken from the driver.
  const second = (await book(rider.token)).body.ride.id;
  assert.equal((await api('POST', `/api/rides/${second}/accept`, { token: driver.token })).status, 200);
  await new Promise((r) => setTimeout(r, 80)); // past FREE_CANCEL_MS
  const [r0, d0] = [await wallet(rider), await wallet(driver)];
  const cancel = await api('POST', `/api/rides/${second}/cancel`, { token: driver.token, body: { reason: 'Car trouble' } });
  assert.equal(cancel.body.riderCredit, 40, 'cab cancel fee');
  assert.equal(await wallet(rider), r0 + 40);
  assert.equal(await wallet(driver), d0 - 40);

  // Open surge: the real counts behind the price, and a watch that tells the rider when it's over.
  const DUM_DUM = { address: 'Dum Dum', lat: 22.642, lng: 88.4312 };
  const FAR_DROP = { address: 'Bangur', lat: 22.6123, lng: 88.4183 };
  const busy = [await register('rider'), await register('rider')];
  const waiting = [];
  for (const b of busy) {
    waiting.push((await api('POST', '/api/rides', { token: b.token, body: { pickup: DUM_DUM, dropoff: FAR_DROP, vehicleType: 'auto', paymentMethod: 'cash' } })).body.ride.id);
  }
  const quote = await api('POST', '/api/rides/quote', { token: friend.token, body: { pickup: DUM_DUM, dropoff: FAR_DROP } });
  const auto = quote.body.options.find((o) => o.type === 'auto');
  assert.deepEqual([auto.demand.waiting, auto.demand.freeDrivers, auto.price.surge > 1], [2, 0, true]);
  assert.equal((await api('POST', '/api/rides/surge-watch', { token: friend.token, body: { pickup: { address: 'Shyambazar', lat: 22.6, lng: 88.37 }, vehicleType: 'auto' } })).status, 409, 'no surge there');
  const watch = await api('POST', '/api/rides/surge-watch', { token: friend.token, body: { pickup: DUM_DUM, vehicleType: 'auto' } });
  assert.equal(watch.status, 201);
  await runSurgeWatches();
  assert.equal((await api('GET', '/api/rides/surge-watch', { token: friend.token })).body.watch.status, 'watching', 'still busy');
  const fs = await socketFor(friend.token);
  const normal = nextEvent(fs, 'notify');
  for (let i = 0; i < waiting.length; i++) await api('POST', `/api/rides/${waiting[i]}/cancel`, { token: busy[i].token });
  await runSurgeWatches();
  assert.match((await normal).title, /back to normal/);
  assert.equal((await api('GET', '/api/rides/surge-watch', { token: friend.token })).body.watch, null);
});

test('online tip and split share through Razorpay: confirmed once, credited once', async () => {
  const rider = await register('rider');
  const friend = await register('rider');
  const driver = await register('driver', 'car');
  await online(driver.token);
  const { body } = await book(rider.token);
  const rideId = body.ride.id;
  await driveToOngoing(rideId, rider, driver);
  await api('POST', `/api/rides/${rideId}/complete`, { token: driver.token });
  await api('POST', `/api/rides/${rideId}/collect-cash`, { token: driver.token });
  const wallet = async (who) => (await api('GET', '/api/auth/me', { token: who.token })).body.user.walletBalance;
  const pay = async (who, orderBody, paymentId) => {
    const order = await api('POST', '/api/payments/razorpay/order', { token: who.token, body: orderBody });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    stub.rzpPayments.set(paymentId, { id: paymentId, order_id: order.body.orderId, amount: order.body.amountPaise, currency: 'INR', status: 'captured', method: 'card' });
    const v = () => api('POST', '/api/payments/razorpay/verify', { token: who.token, body: { orderId: order.body.orderId, paymentId, signature: sign(order.body.orderId, paymentId) } });
    return [await v(), await v()];
  };

  const driverBefore = await wallet(driver);
  const [tipped, replay] = await pay(rider, { kind: 'tip', rideId, amount: 40 }, 'pay_tip_1');
  assert.deepEqual([tipped.status, tipped.body.status, replay.status], [200, 'paid', 200]);
  assert.equal(await wallet(driver), driverBefore + 40, 'credited once, even when confirmed twice');
  assert.equal(await wallet(rider), 0, "an online tip does not touch the rider's wallet");

  const split = (await api('POST', `/api/rides/${rideId}/splits`, { token: rider.token, body: { phone: friend.user.phone, amount: 25 } })).body.split;
  const [paid] = await pay(friend, { kind: 'split', splitId: split.id }, 'pay_split_1');
  assert.equal(paid.body.status, 'paid');
  assert.equal(await wallet(rider), 25, 'share lands in the requester wallet');
  assert.equal((await api('POST', '/api/payments/razorpay/order', { token: friend.token, body: { kind: 'split', splitId: split.id } })).status, 409, 'already paid');
});

test('book for someone else, accessibility requests and parcels with a delivery code', async () => {
  const rider = await register('rider');
  const cabbie = await register('driver', 'car');
  const biker = await register('driver', 'bike');
  await api('PUT', '/api/profile/trip-pin', { token: rider.token, body: { pin: '7391' } });
  await api('PUT', '/api/profile/driver-deaf', { token: cabbie.token, body: { deaf: true } });
  const cs = await online(cabbie.token);
  await online(biker.token);
  const smsTo = (phone) => stub.sms.filter((m) => m.To === phone);

  // Someone else rides: they get a random code by SMS, not the booker's PIN; the driver sees their name only.
  assert.equal((await book(rider.token, { passenger: { name: 'Ma', phone: '12' } })).status, 400);
  assert.equal((await book(rider.token, { accessibility: ['wheelchair'], vehicleType: 'auto' })).status, 400, 'a wheelchair needs a cab');
  const offer = nextEvent(cs, 'ride:offer');
  const booked = await book(rider.token, { passenger: { name: 'Ma', phone: '9812345678' }, accessibility: ['wheelchair', 'hearing'] });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  const o = await offer;
  assert.deepEqual([o.passenger, o.accessibility], [{ name: 'Ma' }, ['wheelchair', 'hearing']], 'driver: name and needs, never the number');
  const id = booked.body.ride.id;
  assert.equal((await api('POST', `/api/rides/${id}/accept`, { token: cabbie.token })).status, 200);
  const view = (await api('GET', `/api/rides/${id}`, { token: rider.token })).body.ride;
  assert.notEqual(view.otp, '7391', "someone else's ride gets its own code");
  assert.equal(view.passenger.phone, '+919812345678');
  assert.equal(view.driver.deaf, true, 'riders are told the driver is deaf or hard of hearing');
  assert.ok(smsTo('+919812345678').some((m) => m.Body.includes(view.otp)), 'passenger texted the code');
  await api('POST', `/api/rides/${id}/cancel`, { token: rider.token });

  // Parcel: size decides the vehicle; delivery needs the receiver's code.
  const parcel = (vehicleType, extra = {}) =>
    book(rider.token, {
      kind: 'parcel',
      vehicleType,
      parcel: { receiverName: 'Rahul', receiverPhone: '9833333333', item: 'Documents envelope', size: 'small', confirmAllowed: true, ...extra },
    });
  assert.equal((await parcel('bike', { size: 'large' })).status, 400, 'a large parcel needs a cab');
  assert.equal((await parcel('bike', { confirmAllowed: false })).status, 400, 'restricted-items confirmation required');
  const p = await parcel('bike');
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const pid = p.body.ride.id;
  assert.equal(p.body.ride.parcel.deliveryOtp.length, 4, 'the sender sees the delivery code');
  await driveToOngoing(pid, rider, biker);
  const driverView = (await api('GET', `/api/rides/${pid}`, { token: biker.token })).body.ride;
  assert.deepEqual([driverView.parcel.deliveryOtp, driverView.parcel.receiverPhone], [undefined, undefined], 'driver gets the code from the receiver');
  assert.ok(smsTo('+919833333333').some((m) => m.Body.includes(p.body.ride.parcel.deliveryOtp)), 'receiver texted the code');
  assert.equal((await api('POST', `/api/rides/${pid}/complete`, { token: biker.token, body: { deliveryOtp: '0000' } })).status, 400);
  const done = await api('POST', `/api/rides/${pid}/complete`, { token: biker.token, body: { deliveryOtp: p.body.ride.parcel.deliveryOtp } });
  assert.equal(done.status, 200);
  assert.equal(done.body.ride.kind, 'parcel');
});

test('hourly rentals: package price, GPS distance, extra time charged; seasonal packages and road closures', async () => {
  const rider = await register('rider');
  const driver = await register('driver', 'car');
  const boss = await admin2();
  const ds = await online(driver.token);
  const packages = (await api('GET', '/api/rentals/packages', { token: rider.token })).body.packages;
  assert.equal(packages.length, 6, 'the six agreed standard packages');
  const oneHourCab = packages.find((x) => x.vehicleType === 'car' && x.hours === 1);
  assert.deepEqual([oneHourCab.price, oneHourCab.km, oneHourCab.extraKmRate, oneHourCab.extraMinRate], [289, 10, 15, 2]);

  const rent = (body) => api('POST', '/api/rides', { token: rider.token, body: { kind: 'rental', pickup: PICKUP, vehicleType: 'car', paymentMethod: 'cash', ...body } });
  assert.equal((await rent({ packageId: oneHourCab.id, vehicleType: 'auto' })).status, 400, 'package is for a cab');
  const booked = await rent({ packageId: oneHourCab.id, promoCode: 'WELCOME50' });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  const mine = booked.body.ride;
  assert.deepEqual([mine.kind, mine.price.fare, mine.price.surge, mine.price.discount, mine.rental.hours], ['rental', 289, 1, 0, 1], 'no surge, no promo');
  await driveToOngoing(mine.id, rider, driver);

  // GPS distance: two fixes 50 m apart, 2 s apart (90 km/h) count; an impossible jump does not.
  ds.emit('driver:location', { lat: 22.5535, lng: 88.3525, accuracy: 10 });
  await new Promise((r) => setTimeout(r, 2000));
  ds.emit('driver:location', { lat: 22.55395, lng: 88.3525, accuracy: 10 });
  await new Promise((r) => setTimeout(r, 1100));
  ds.emit('driver:location', { lat: 22.6535, lng: 88.3525, accuracy: 10 }); // 11 km in 1 s
  await new Promise((r) => setTimeout(r, 200));
  // Test-only fixture in the throwaway database: the rental started 90 minutes ago (30 min over the package).
  await query(`UPDATE rides SET started_at = now() - interval '90 minutes' WHERE id = $1`, [mine.id]);
  const done = (await api('POST', `/api/rides/${mine.id}/complete`, { token: driver.token })).body.ride;
  assert.ok(done.rental.actualKm > 0.04 && done.rental.actualKm < 0.06, `measured ${done.rental.actualKm} km`);
  assert.equal(done.rental.extra, 60, '30 extra minutes at ₹2');
  assert.equal(done.price.fare, 289 + 60);

  // Admin: a seasonal Puja package shows only on its dates; closures need a source.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const pkg = (body) => api('POST', '/api/rentals/admin/packages', { token: boss.token, body: { vehicleType: 'car', hours: 4, km: 30, price: 999, extraKmRate: 15, extraMinRate: 2, ...body } });
  assert.equal((await pkg({ name: 'Puja pandal hopping', seasonal: true })).status, 400, 'needs dates');
  assert.equal((await pkg({ name: 'Puja pandal hopping', seasonal: true, availableFrom: today, availableTo: today })).status, 201);
  assert.equal((await pkg({ name: 'Next year Puja', seasonal: true, availableFrom: '2099-10-01', availableTo: '2099-10-05' })).status, 201);
  const names = (await api('GET', '/api/rentals/packages', { token: rider.token })).body.packages.map((x) => x.name);
  assert.ok(names.includes('Puja pandal hopping') && !names.includes('Next year Puja'));
  assert.equal((await api('POST', '/api/rentals/admin/packages', { token: rider.token, body: {} })).status, 403);

  const closure = (body) => api('POST', '/api/rentals/admin/closures', { token: boss.token, body: { title: 'Park Street no-entry', lat: 22.5535, lng: 88.3525, radiusM: 400, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3600e3).toISOString(), ...body } });
  assert.equal((await closure({})).status, 400, 'a closure needs a source');
  assert.equal((await closure({ source: 'Kolkata Traffic Police notice' })).status, 201);
  assert.equal((await api('GET', '/api/rentals/closures', { token: rider.token })).body.closures[0].title, 'Park Street no-entry');
});

test('family: invite and accept; trips are visible only to people the rider chose to share with', async () => {
  const me = await register('rider');
  const mum = await register('rider');
  const driver = await register('driver', 'car');
  await online(driver.token);
  assert.equal((await api('POST', '/api/family', { token: me.token, body: { phone: '8123456780' } })).status, 404, 'must be a Hopin rider');
  assert.equal((await api('POST', '/api/family', { token: me.token, body: { phone: mum.user.phone } })).status, 201);
  assert.equal((await api('POST', '/api/family', { token: me.token, body: { phone: mum.user.phone } })).status, 409);
  const invite = (await api('GET', '/api/family', { token: mum.token })).body.incoming[0];
  assert.equal(invite.person.name, me.user.name);
  assert.equal((await api('POST', `/api/family/${invite.linkId}/answer`, { token: me.token, body: { accept: true } })).status, 409, 'only the invited person answers');
  assert.equal((await api('POST', `/api/family/${invite.linkId}/answer`, { token: mum.token, body: { accept: true } })).status, 200);

  // Mum is riding, but has not chosen to share: nothing is visible.
  const { body } = await book(mum.token);
  await driveToOngoing(body.ride.id, mum, driver);
  let family = (await api('GET', '/api/family', { token: me.token })).body;
  assert.deepEqual([family.members.length, family.members[0].sharesTrips, family.members[0].liveTrip], [1, false, null]);

  // She turns sharing on: the live trip appears, with a live-map link.
  await api('PUT', '/api/family/sharing', { token: mum.token, body: { share: true } });
  family = (await api('GET', '/api/family', { token: me.token })).body;
  assert.equal(family.members[0].liveTrip.status, 'ongoing');
  assert.ok(family.members[0].liveTrip.trackPath.startsWith('/track/'));
  const ms = await socketFor(me.token);
  const ended = nextEvent(ms, 'notify');
  await api('POST', `/api/rides/${body.ride.id}/complete`, { token: driver.token });
  assert.match((await ended).title, /ride has ended/);

  // Either side can remove the link.
  assert.equal((await api('DELETE', `/api/family/${invite.linkId}`, { token: me.token })).status, 200);
  assert.equal((await api('GET', '/api/family', { token: mum.token })).body.members.length, 0);
});

test('price lock: ₹49 freezes the no-surge fare for a route; the rider pays the lower of locked and normal', async () => {
  const rider = await register('rider');
  await fundWallet(rider.user.id, 500);
  const BEHALA = { address: 'Behala', lat: 22.4986, lng: 88.3109 };
  const TOLLY = { address: 'Tollygunge', lat: 22.4983, lng: 88.3456 };
  const lock = (body = {}) => api('POST', '/api/price-locks', { token: rider.token, body: { pickup: BEHALA, dropoff: TOLLY, vehicleType: 'auto', ...body } });
  const quote = () => api('POST', '/api/rides/quote', { token: rider.token, body: { pickup: BEHALA, dropoff: TOLLY } }).then((r) => r.body.options.find((o) => o.type === 'auto'));
  const offer = (await quote()).lockOffer;
  assert.deepEqual([offer.fee, offer.days], [49, 7]);

  const bought = await lock();
  assert.equal(bought.status, 201);
  assert.equal(bought.body.lock.lockedFare, offer.lockedFare);
  assert.equal((await api('GET', '/api/auth/me', { token: rider.token })).body.user.walletBalance, 500 - 49);
  assert.equal((await quote()).lock.lockedFare, offer.lockedFare);

  // Two other riders waiting and no autos nearby: surge. The lock holder still pays the locked fare.
  const others = [await register('rider'), await register('rider')];
  const waiting = [];
  for (const o of others) waiting.push((await api('POST', '/api/rides', { token: o.token, body: { pickup: BEHALA, dropoff: TOLLY, vehicleType: 'auto', paymentMethod: 'cash' } })).body.ride.id);
  const q = await quote();
  assert.ok(q.price.lockSaving > 0 && q.price.fare === offer.lockedFare, 'quote shows the locked fare');
  const ride = (await api('POST', '/api/rides', { token: rider.token, body: { pickup: BEHALA, dropoff: TOLLY, vehicleType: 'auto', paymentMethod: 'cash' } })).body.ride;
  assert.equal(ride.price.fare, offer.lockedFare);
  assert.ok(ride.lockSaving > 0);
  await api('POST', `/api/rides/${ride.id}/cancel`, { token: rider.token });
  for (let i = 0; i < waiting.length; i++) await api('POST', `/api/rides/${waiting[i]}/cancel`, { token: others[i].token });

  // Online purchase through Razorpay; at most three active locks.
  const order = await api('POST', '/api/payments/razorpay/order', { token: rider.token, body: { kind: 'price_lock', pickup: TOLLY, dropoff: BEHALA, vehicleType: 'car' } });
  assert.equal(order.body.amountPaise, 4900);
  stub.rzpPayments.set('pay_lock_1', { id: 'pay_lock_1', order_id: order.body.orderId, amount: 4900, currency: 'INR', status: 'captured', method: 'card' });
  const v = await api('POST', '/api/payments/razorpay/verify', { token: rider.token, body: { orderId: order.body.orderId, paymentId: 'pay_lock_1', signature: sign(order.body.orderId, 'pay_lock_1') } });
  assert.equal(v.body.status, 'paid');
  assert.equal((await api('GET', '/api/price-locks', { token: rider.token })).body.locks.length, 2);
  assert.equal((await lock({ vehicleType: 'car' })).status, 201);
  assert.equal((await lock({ vehicleType: 'bike' })).status, 409, 'three active locks at most');
});

test('daily pass: bought from the wallet or online, rides accepted that day pay the driver 100%', async () => {
  const rider = await register('rider');
  const driver = await register('driver', 'car');
  const broke = await register('driver', 'auto');
  const boss = await admin2();
  const wallet = async (who) => (await api('GET', '/api/auth/me', { token: who.token })).body.user.walletBalance;
  assert.equal((await api('GET', '/api/driver/pass', { token: driver.token })).body.price, 79, 'agreed cab price');
  assert.equal((await api('POST', '/api/driver/pass', { token: driver.token })).status, 400, 'empty wallet');
  await fundWallet(driver.user.id, 100);
  assert.equal((await api('POST', '/api/driver/pass', { token: driver.token })).status, 201);
  assert.equal(await wallet(driver), 21);
  assert.equal((await api('POST', '/api/driver/pass', { token: driver.token })).status, 409, 'one pass a day');

  await online(driver.token);
  const { body } = await book(rider.token);
  await driveToOngoing(body.ride.id, rider, driver);
  await api('POST', `/api/rides/${body.ride.id}/complete`, { token: driver.token });
  await api('POST', `/api/rides/${body.ride.id}/collect-cash`, { token: driver.token });
  assert.equal(await wallet(driver), 21, 'no commission taken from the wallet on a pass day');
  assert.equal((await api('GET', `/api/rides/${body.ride.id}`, { token: rider.token })).body.ride.breakdown.driverSharePct, 100);

  // Online through Razorpay.
  const order = await api('POST', '/api/payments/razorpay/order', { token: broke.token, body: { kind: 'driver_pass' } });
  assert.equal(order.body.amountPaise, 4900, 'auto pass');
  stub.rzpPayments.set('pay_pass_1', { id: 'pay_pass_1', order_id: order.body.orderId, amount: 4900, currency: 'INR', status: 'captured', method: 'card' });
  const v = await api('POST', '/api/payments/razorpay/verify', { token: broke.token, body: { orderId: order.body.orderId, paymentId: 'pay_pass_1', signature: sign(order.body.orderId, 'pay_pass_1') } });
  assert.equal(v.body.status, 'paid');
  assert.ok((await api('GET', '/api/driver/pass', { token: broke.token })).body.today);

  // Admins set prices; riders cannot.
  assert.equal((await api('PUT', '/api/admin/pass-prices', { token: boss.token, body: { prices: { bike: 29, auto: 0, car: 79 } } })).status, 400);
  assert.equal((await api('PUT', '/api/admin/pass-prices', { token: rider.token, body: { prices: {} } })).status, 403);
  assert.deepEqual((await api('PUT', '/api/admin/pass-prices', { token: boss.token, body: { prices: { bike: 29, auto: 49, car: 79 } } })).body.prices, { bike: 29, auto: 49, car: 79 });
});

test('heading home: only rides that bring the driver closer, twice a day, off on arrival', async () => {
  const rider = await register('rider');
  const driver = await register('driver', 'auto');
  const GARIA = { address: 'Garia', lat: 22.4625, lng: 88.3973 };
  const JADAVPUR = { address: 'Jadavpur', lat: 22.4995, lng: 88.3712 };
  const SONARPUR = { address: 'Sonarpur', lat: 22.43, lng: 88.43 };
  const SALT_LAKE = { address: 'Salt Lake', lat: 22.58, lng: 88.42 };
  assert.equal((await api('POST', '/api/driver/heading-home', { token: driver.token, body: { on: true } })).status, 400, 'set home first');
  await api('PUT', '/api/driver/home', { token: driver.token, body: { home: SALT_LAKE } });
  assert.equal((await api('POST', '/api/driver/heading-home', { token: driver.token, body: { on: true } })).status, 409, 'go online first');
  const ds = await online(driver.token, GARIA);
  const on = await api('POST', '/api/driver/heading-home', { token: driver.token, body: { on: true } });
  assert.deepEqual([on.body.headingHome, on.body.usesLeft], [true, 1]);

  const offers = [];
  ds.on('ride:offer', (o) => offers.push(o.dropoff.address));
  const away = (await api('POST', '/api/rides', { token: rider.token, body: { pickup: GARIA, dropoff: SONARPUR, vehicleType: 'auto', paymentMethod: 'cash' } })).body.ride;
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(offers, [], 'a ride away from home is not offered');
  await api('POST', `/api/rides/${away.id}/cancel`, { token: rider.token });
  const toward = (await api('POST', '/api/rides', { token: rider.token, body: { pickup: GARIA, dropoff: JADAVPUR, vehicleType: 'auto', paymentMethod: 'cash' } })).body.ride;
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(offers, ['Jadavpur'], 'a ride toward home is offered');
  await api('POST', `/api/rides/${toward.id}/cancel`, { token: rider.token });

  // Close to home: switches itself off.
  const home = nextEvent(ds, 'driver:home-reached');
  ds.emit('driver:location', { lat: 22.578, lng: 88.419 });
  await home;
  assert.equal((await api('GET', '/api/driver/home', { token: driver.token })).body.headingHome, false);
  // Second use, then the daily limit.
  assert.equal((await api('POST', '/api/driver/heading-home', { token: driver.token, body: { on: true } })).body.usesLeft, 0);
  await api('POST', '/api/driver/heading-home', { token: driver.token, body: { on: false } });
  assert.equal((await api('POST', '/api/driver/heading-home', { token: driver.token, body: { on: true } })).status, 409, 'twice a day');
});

test('fatigue: no going online after 10 h without a 30-minute break; "Well rested" after a long break', async () => {
  const tired = await register('driver', 'car');
  const fresh = await register('driver', 'car');
  const rider = await register('rider');
  // Test-only fixtures in the throwaway database: past online sessions.
  const session = (id, startedAgoMin, endedAgoMin) =>
    query(`INSERT INTO driver_sessions (driver_id, started_at, last_seen_at, ended_at) VALUES ($1, now() - $2 * interval '1 minute', now() - $3 * interval '1 minute', now() - $3 * interval '1 minute')`, [
      id, startedAgoMin, endedAgoMin,
    ]);
  await session(tired.user.id, 11 * 60, 5); // 10 h 55 min driving, stopped 5 min ago
  const s = await socketFor(tired.token);
  const ack = await s.timeout(2000).emitWithAck('driver:online', NEAR_PICKUP);
  assert.deepEqual([ack.ok, ack.code], [false, 'NEEDS_BREAK']);
  assert.match(ack.error, /10 h 55 min without a 30-minute break/);
  assert.equal((await api('GET', '/api/driver/fatigue', { token: tired.token })).body.needsBreak, true);
  // After a 30-minute break it can go online again.
  await query(`UPDATE driver_sessions SET ended_at = now() - interval '40 minutes', last_seen_at = now() - interval '40 minutes' WHERE driver_id = $1`, [tired.user.id]);
  assert.equal((await s.timeout(2000).emitWithAck('driver:online', NEAR_PICKUP)).ok, true);
  await s.timeout(2000).emitWithAck('driver:offline', null);

  // Last break 7 hours: "Well rested", shown to the rider.
  await session(fresh.user.id, 9 * 60, 7 * 60);
  await online(fresh.token);
  const { body } = await book(rider.token);
  assert.equal((await api('POST', `/api/rides/${body.ride.id}/accept`, { token: fresh.token })).status, 200);
  const view = (await api('GET', `/api/rides/${body.ride.id}`, { token: rider.token })).body.ride;
  assert.equal(view.driver.id, fresh.user.id);
  assert.equal(view.driver.rested, true);
  assert.ok(view.driver.drivingMin < 5);
  await api('POST', `/api/rides/${body.ride.id}/cancel`, { token: rider.token });
});

test('station queue: the driver who arrived first gets the station pickup first; declining passes it on', async () => {
  const rider = await register('rider');
  const first = await register('driver', 'bike');
  const second = await register('driver', 'bike');
  const HOWRAH = { address: 'Howrah Station', lat: 22.5838, lng: 88.3426 };
  const DROP = { address: 'Burrabazar', lat: 22.5866, lng: 88.3528 };
  const s1 = await online(first.token, HOWRAH);
  await new Promise((r) => setTimeout(r, 20));
  const s2 = await online(second.token, { lat: 22.5841, lng: 88.3422 });
  assert.deepEqual((await api('GET', '/api/driver/station', { token: first.token })).body.queue, { station: 'Howrah Station', position: 1, total: 2 });
  assert.equal((await api('GET', '/api/driver/station', { token: second.token })).body.queue.position, 2);

  let secondOffers = 0;
  s2.on('ride:offer', () => secondOffers++);
  const offer = nextEvent(s1, 'ride:offer');
  const ride = (await api('POST', '/api/rides', { token: rider.token, body: { pickup: HOWRAH, dropoff: DROP, vehicleType: 'bike', paymentMethod: 'cash' } })).body.ride;
  assert.equal((await offer).station.name, 'Howrah Station');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(secondOffers, 0, 'only the front of the queue is offered it');
  assert.equal((await api('POST', `/api/rides/${ride.id}/accept`, { token: second.token })).status, 409, 'reserved for the front of the queue');
  assert.deepEqual((await api('GET', `/api/rides/${ride.id}/station`, { token: rider.token })).body.queue, { station: 'Howrah Station', place: 1, waiting: 1, driversQueued: 2 });

  // The first driver declines: it goes to the next, and they drop to the back.
  const passed = nextEvent(s2, 'ride:offer');
  await api('POST', `/api/rides/${ride.id}/decline`, { token: first.token });
  assert.equal((await passed).id, ride.id);
  assert.equal((await api('GET', '/api/driver/station', { token: first.token })).body.queue.position, 2);
  assert.equal((await api('POST', `/api/rides/${ride.id}/accept`, { token: second.token })).status, 200);
});

test('referrals: ₹50 each after the new rider\'s first paid trip; driver referrer paid after 20 trips', async () => {
  const { rewardDriverReferral } = await import('../src/growth.js');
  const amit = await register('rider');
  const neha = await register('rider');
  const latecomer = await register('rider');
  const driver = await register('driver', 'car');
  const wallet = async (who) => (await api('GET', '/api/auth/me', { token: who.token })).body.user.walletBalance;
  const code = (await api('GET', '/api/growth/referral', { token: amit.token })).body.code;
  assert.match(code, /^[A-Z]{4}\d{4}$/);
  const apply = (who, c) => api('POST', '/api/growth/referral/apply', { token: who.token, body: { code: c } });
  assert.equal((await apply(amit, code)).status, 400, 'not your own code');
  assert.equal((await apply(neha, 'ZZZZ0000')).status, 404);
  assert.equal((await apply(driver, code)).status, 400, "a rider's code is for riders");
  assert.equal((await apply(neha, code)).status, 201);
  assert.equal((await apply(neha, code)).status, 409, 'once');

  // Neha's first paid trip rewards both.
  await fundWallet(neha.user.id, 500);
  const [a0, n0] = [await wallet(amit), await wallet(neha)];
  await online(driver.token);
  const { body } = await book(neha.token, { paymentMethod: 'wallet' });
  await driveToOngoing(body.ride.id, neha, driver);
  const done = (await api('POST', `/api/rides/${body.ride.id}/complete`, { token: driver.token })).body.ride;
  assert.equal(await wallet(amit), a0 + 50);
  assert.equal(await wallet(neha), n0 - done.price.fare + 50);
  const stats = (await api('GET', '/api/growth/referral', { token: amit.token })).body;
  assert.deepEqual([stats.invited, stats.rewarded, stats.earned], [1, 1, 50]);

  // After a first trip it is too late to use a code.
  const ride2 = (await book(latecomer.token)).body.ride.id;
  await driveToOngoing(ride2, latecomer, driver);
  await api('POST', `/api/rides/${ride2}/complete`, { token: driver.token });
  assert.equal((await apply(latecomer, code)).status, 409);

  // Drivers: the referrer is paid once the new driver has 20 completed trips.
  const veteran = await register('driver', 'car');
  const rookie = await register('driver', 'car');
  const vcode = (await api('GET', '/api/growth/referral', { token: veteran.token })).body.code;
  assert.equal((await apply(rookie, vcode)).status, 201);
  await rewardDriverReferral(rookie.user.id);
  assert.equal(await wallet(veteran), 0, 'not before 20 trips');
  // Test-only fixture in the throwaway database: 20 completed trips for the new driver (copies of a real one).
  await query(
    `INSERT INTO rides SELECT (jsonb_populate_record(NULL::rides, to_jsonb(r) || jsonb_build_object('id', gen_random_uuid(), 'share_token', md5(random()::text || g), 'driver_id', $2::uuid))).*
     FROM rides r, generate_series(1, 20) g WHERE r.id = $1`,
    [body.ride.id, rookie.user.id],
  );
  await rewardDriverReferral(rookie.user.id);
  assert.equal(await wallet(veteran), 200);
  await rewardDriverReferral(rookie.user.id);
  assert.equal(await wallet(veteran), 200, 'paid once');
});

test('loyalty: points on paid personal trips, tiers by trips, redeem 100 points for ₹10', async () => {
  const rider = await register('rider');
  const driver = await register('driver', 'car');
  await online(driver.token);
  const { body } = await book(rider.token);
  await driveToOngoing(body.ride.id, rider, driver);
  const done = (await api('POST', `/api/rides/${body.ride.id}/complete`, { token: driver.token })).body.ride;
  await api('POST', `/api/rides/${body.ride.id}/collect-cash`, { token: driver.token });
  let l = (await api('GET', '/api/growth/loyalty', { token: rider.token })).body;
  assert.equal(l.points, Math.floor(done.price.fare / 10), '1 point per ₹10 (Blue tier)');
  assert.deepEqual([l.tier.name, l.tier.trips90, l.tier.next.name, l.tier.next.tripsToGo], ['Blue', 1, 'Silver', 9]);

  // Test-only fixture: enough points to redeem (ledger and balance kept consistent).
  await query(`INSERT INTO loyalty_txns (user_id, points, kind, ref) VALUES ($1, 200, 'earned', 'TEST-FIXTURE-POINTS')`, [rider.user.id]);
  await query('UPDATE users SET loyalty_points = loyalty_points + 200 WHERE id = $1', [rider.user.id]);
  const redeem = (points) => api('POST', '/api/growth/loyalty/redeem', { token: rider.token, body: { points } });
  assert.equal((await redeem(150)).status, 400, 'blocks of 100');
  assert.equal((await redeem(100_000)).status, 400, 'not more than you have');
  const before = (await api('GET', '/api/auth/me', { token: rider.token })).body.user.walletBalance;
  assert.equal((await redeem(200)).body.credited, 20);
  assert.equal((await api('GET', '/api/auth/me', { token: rider.token })).body.user.walletBalance, before + 20);
  l = (await api('GET', '/api/growth/loyalty', { token: rider.token })).body;
  assert.equal(l.points, Math.floor(done.price.fare / 10));
  const points = (await query('SELECT COALESCE(SUM(points), 0)::int AS s FROM loyalty_txns WHERE user_id = $1', [rider.user.id])).rows[0].s;
  assert.equal(points, l.points, 'points balance equals its ledger');
});

test('corporate: company wallet pays business rides within limits; CSV; refunds go back to the company', async () => {
  const boss = await admin2();
  const manager = await register('rider');
  const employee = await register('rider');
  const driver = await register('driver', 'car');
  const create = await api('POST', '/api/admin/companies', { token: boss.token, body: { name: 'Acme Kolkata', adminPhone: manager.user.phone } });
  assert.equal(create.status, 201);
  assert.equal((await api('POST', '/api/admin/companies', { token: manager.token, body: { name: 'X', adminPhone: manager.user.phone } })).status, 403);

  // Empty company wallet: business booking refused with the reason.
  const biz = (who, extra = {}) => book(who.token, { paymentMethod: 'corporate', businessNote: 'Client visit', ...extra });
  assert.match((await biz(manager)).body.error, /Acme Kolkata's wallet has ₹0/);
  // Top up through Razorpay.
  const order = await api('POST', '/api/payments/razorpay/order', { token: manager.token, body: { kind: 'company_topup', amount: 1000 } });
  assert.equal(order.status, 201);
  stub.rzpPayments.set('pay_co_1', { id: 'pay_co_1', order_id: order.body.orderId, amount: 100000, currency: 'INR', status: 'captured', method: 'card' });
  await api('POST', '/api/payments/razorpay/verify', { token: manager.token, body: { orderId: order.body.orderId, paymentId: 'pay_co_1', signature: sign(order.body.orderId, 'pay_co_1') } });
  assert.equal((await api('GET', '/api/company', { token: manager.token })).body.company.walletBalance, 1000);
  assert.equal((await api('POST', '/api/payments/razorpay/order', { token: employee.token, body: { kind: 'company_topup', amount: 1000 } })).status, 403);

  // Invite with a monthly limit; the employee accepts.
  assert.equal((await api('POST', '/api/company/members', { token: manager.token, body: { phone: employee.user.phone, monthlyLimit: 300 } })).status, 201);
  assert.equal((await biz(employee)).status, 403, 'not until they accept');
  const invite = (await api('GET', '/api/company/me', { token: employee.token })).body.invite;
  assert.equal(invite.company, 'Acme Kolkata');
  await api('POST', `/api/company/invites/${invite.id}/answer`, { token: employee.token, body: { accept: true } });

  // A business ride: the company pays, the employee's wallet is untouched, the driver earns as usual.
  await online(driver.token);
  const r = await biz(employee);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await driveToOngoing(r.body.ride.id, employee, driver);
  const done = (await api('POST', `/api/rides/${r.body.ride.id}/complete`, { token: driver.token })).body.ride;
  assert.equal(done.payment.status, 'paid');
  const co = (await api('GET', '/api/company', { token: manager.token })).body;
  assert.equal(co.company.walletBalance, 1000 - done.price.fare);
  assert.equal(co.members.find((m) => m.person.id === employee.user.id).spentThisMonth, done.price.fare);
  assert.equal((await api('GET', '/api/auth/me', { token: employee.token })).body.user.walletBalance, 0);
  assert.equal((await api('GET', '/api/growth/loyalty', { token: employee.token })).body.points, 0, 'business rides earn no personal points');

  // Over the monthly limit: refused.
  if (done.price.fare * 2 > 300) assert.match((await biz(employee)).body.error, /monthly business limit/);

  // CSV for the company admin only, with the expense note.
  const csv = await fetch(`${base}/api/company/rides.csv`, { headers: { authorization: `Bearer ${manager.token}` } }).then((x) => x.text());
  assert.match(csv, /Client visit/);
  assert.equal((await api('GET', '/api/company/rides.csv', { token: employee.token })).status, 403);

  // Refunds of business rides go back to the company wallet.
  const refund = (destination) => api('POST', '/api/admin/refunds', { token: boss.token, body: { rideId: r.body.ride.id, amount: 20, destination, reason: 'Driver took a longer route' } });
  assert.equal((await refund('wallet')).status, 400);
  assert.equal((await refund('original')).status, 201);
  assert.equal((await api('GET', '/api/company', { token: manager.token })).body.company.walletBalance, 1000 - done.price.fare + 20);
});

test('detour review: a long detour after a route alert opens a fare dispute with the evidence', async () => {
  const rider = await register('rider');
  const driver = await register('driver', 'car');
  await online(driver.token);
  const { body } = await book(rider.token);
  const rideId = body.ride.id;
  await driveToOngoing(rideId, rider, driver);
  // Test-only fixture in the throwaway database: a route alert fired, and the trip started 40 min before a 20-min plan ends.
  await query(`UPDATE rides SET duration_min = 20, started_at = now() - interval '40 minutes' WHERE id = $1`, [rideId]);
  await query(
    `INSERT INTO route_deviations (ride_id, driver_id, rider_id, kind, started_at, lat, lng, distance_m, max_distance_m)
     VALUES ($1, $2, $3, 'off_route', now() - interval '30 minutes', 22.5, 88.3, 900, 1400)`,
    [rideId, driver.user.id, rider.user.id],
  );
  await api('POST', `/api/rides/${rideId}/complete`, { token: driver.token });
  const tickets = (await api('GET', '/api/support/tickets', { token: rider.token })).body.tickets;
  const t = tickets.find((x) => x.rideId === rideId || x.ride?.id === rideId) ?? tickets[0];
  assert.equal(t.category, 'fare_dispute');
  assert.match(t.subject, /20 min longer/);
  const thread = (await api('GET', `/api/support/tickets/${t.id}`, { token: rider.token })).body;
  assert.match(thread.messages[0].body, /Opened automatically by Hopin.*1\.4 km.*40 min against 20 min/);

  // A normal trip opens nothing.
  const quiet = (await book(rider.token)).body.ride.id;
  await driveToOngoing(quiet, rider, driver);
  await api('POST', `/api/rides/${quiet}/complete`, { token: driver.token });
  assert.equal((await api('GET', '/api/support/tickets', { token: rider.token })).body.tickets.length, 1);
});

test('trip recording: encrypted chunks, the other person is told, only reported audio is playable and plays are logged', async () => {
  const { runRecordingCleanup } = await import('../src/recordings.js');
  const putChunk = (token, id, n, bytes) =>
    fetch(`${base}/api/recordings/${id}/chunks/${n}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: bytes });
  // A WebM file starts with the EBML magic number; later chunks are just more of the stream.
  const first = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('opus-audio-part-0')]);
  const second = Buffer.from('opus-audio-part-1');
  const storedFor = (recId) => [...stub.files.keys()].filter((k) => k.startsWith('trip-recordings/') && k.includes(recId));

  assert.equal((await api('GET', '/api/features')).body.recording, true);
  const rider = await register('rider');
  const driver = await register('driver', 'car');
  const stranger = await register('rider');
  const ops = await admin2();
  const driverSocket = await online(driver.token);
  const rideId = (await book(rider.token)).body.ride.id;
  assert.equal((await api('POST', '/api/recordings', { token: rider.token, body: { rideId, mimeType: 'audio/webm' } })).status, 409, 'nothing to record before a driver accepts');
  assert.equal((await api('POST', `/api/rides/${rideId}/accept`, { token: driver.token })).status, 200);

  assert.equal((await api('POST', '/api/recordings', { token: stranger.token, body: { rideId, mimeType: 'audio/webm' } })).status, 404);
  assert.equal((await api('POST', '/api/recordings', { token: rider.token, body: { rideId, mimeType: 'video/mp4' } })).status, 400);
  const told = nextEvent(driverSocket, 'ride:recording');
  const started = await api('POST', '/api/recordings', { token: rider.token, body: { rideId, mimeType: 'audio/webm;codecs=opus' } });
  assert.equal(started.status, 201);
  const recId = started.body.recording.id;
  assert.deepEqual(await told, { rideId, role: 'rider', active: true }, 'the driver is told the rider is recording');
  assert.deepEqual((await api('GET', `/api/recordings?rideId=${rideId}`, { token: driver.token })).body.liveOnRide, ['rider']);
  assert.deepEqual((await api('GET', `/api/recordings?rideId=${rideId}`, { token: stranger.token })).body.liveOnRide, []);

  // Chunks: the first must really be audio, they arrive in order, and a retry is harmless.
  assert.equal((await putChunk(rider.token, recId, 0, Buffer.from('%PDF-1.4 not audio'))).status, 400);
  assert.equal((await putChunk(stranger.token, recId, 0, first)).status, 404);
  assert.equal((await putChunk(rider.token, recId, 0, first)).status, 200);
  assert.equal((await putChunk(rider.token, recId, 2, second)).status, 409);
  assert.equal((await putChunk(rider.token, recId, 1, second)).status, 200);
  const retry = await putChunk(rider.token, recId, 1, second);
  assert.equal((await retry.json()).recording.chunks, 2);

  // What is stored is ciphertext, not the audio.
  const stored = storedFor(recId);
  assert.equal(stored.length, 2);
  for (const k of stored) assert.ok(!stub.files.get(k).bytes.includes(Buffer.from('opus-audio-part')), 'stored chunks are encrypted');

  // Not reported: nobody can play it, and admins don't see it.
  assert.equal((await api('GET', `/api/admin/recordings/${recId}/audio`, { token: ops.token })).status, 403);
  assert.ok(!(await api('GET', '/api/admin/recordings', { token: ops.token })).body.recordings.some((r) => r.id === recId));

  // Sent to Hopin safety: held, a safety ticket opens, and the recorder can no longer delete it.
  assert.equal((await api('POST', `/api/recordings/${recId}/report`, { token: rider.token, body: { reason: 'no' } })).status, 400);
  const reported = await api('POST', `/api/recordings/${recId}/report`, { token: rider.token, body: { reason: 'Driver shouted at me and refused the route' } });
  assert.equal(reported.body.recording.held, true);
  const ticket = (await api('GET', `/api/support/tickets/${reported.body.recording.ticketId}`, { token: rider.token })).body;
  assert.equal(ticket.ticket.category, 'safety');
  assert.match(ticket.messages[0].body, /refused the route/);
  assert.equal((await api('DELETE', `/api/recordings/${recId}`, { token: rider.token })).status, 409);
  assert.equal((await api('GET', `/api/admin/recordings/${recId}/audio`, { token: rider.token })).status, 403, 'riders cannot use admin playback');

  const played = await api('GET', `/api/admin/recordings/${recId}/audio`, { token: ops.token });
  assert.equal(played.status, 200);
  assert.deepEqual(played.body, Buffer.concat([first, second]), 'admins hear exactly what was recorded');
  const listed = (await api('GET', '/api/admin/recordings', { token: ops.token })).body.recordings.find((r) => r.id === recId);
  assert.equal(listed.plays, 1, 'the play is logged');
  assert.equal(listed.by.role, 'rider');

  // The driver records too, stops, and deletes it: the files go.
  const mine = (await api('POST', '/api/recordings', { token: driver.token, body: { rideId, mimeType: 'audio/webm' } })).body.recording.id;
  assert.equal((await putChunk(driver.token, mine, 0, first)).status, 200);
  const stopped = (await api('POST', `/api/recordings/${mine}/stop`, { token: driver.token })).body.recording;
  assert.equal(stopped.status, 'complete');
  assert.ok(new Date(stopped.deleteAfter) - Date.now() > 6.9 * 86400_000, 'kept 7 days unless reported');
  assert.equal((await putChunk(driver.token, mine, 1, second)).status, 409, 'a stopped recording takes no more audio');
  assert.equal((await api('DELETE', `/api/recordings/${mine}`, { token: driver.token })).status, 200);
  assert.equal(storedFor(mine).length, 0);

  // Cleanup: an unreported recording past its keep date is deleted; a reported one is not.
  const old = (await api('POST', '/api/recordings', { token: driver.token, body: { rideId, mimeType: 'audio/webm' } })).body.recording.id;
  await putChunk(driver.token, old, 0, first);
  await api('POST', `/api/recordings/${old}/stop`, { token: driver.token });
  // Test-only fixture in the throwaway database: the 7 days have passed for both recordings.
  await query(`UPDATE trip_recordings SET delete_after = now() - interval '1 minute', ended_at = now() WHERE id = ANY($1)`, [[old, recId]]);
  // A recording on the finished trip whose phone went quiet ends by itself.
  const { otp } = (await api('GET', `/api/rides/${rideId}`, { token: rider.token })).body.ride;
  assert.equal((await api('POST', `/api/rides/${rideId}/arrive`, { token: driver.token })).status, 200);
  assert.equal((await api('POST', `/api/rides/${rideId}/start`, { token: driver.token, body: { otp } })).status, 200);
  const quiet = (await api('POST', '/api/recordings', { token: rider.token, body: { rideId, mimeType: 'audio/webm' } })).body.recording.id;
  await putChunk(rider.token, quiet, 0, first);
  await api('POST', `/api/rides/${rideId}/complete`, { token: driver.token });
  await query(`UPDATE trip_recordings SET last_chunk_at = now() - interval '3 minutes' WHERE id = $1`, [quiet]);
  await runRecordingCleanup();
  const status = Object.fromEntries((await many('SELECT id, status FROM trip_recordings WHERE id = ANY($1)', [[old, recId, quiet]])).map((r) => [r.id, r.status]));
  assert.deepEqual(status, { [old]: 'deleted', [recId]: 'complete', [quiet]: 'complete' });
  assert.equal(storedFor(old).length, 0);
  assert.equal(storedFor(recId).length, 2, 'the reported recording is kept');
  assert.equal((await api('POST', '/api/recordings', { token: rider.token, body: { rideId, mimeType: 'audio/webm' } })).status, 409, 'no new recordings after the trip');
});

test('waterlogging: GPS reports merge, pad the ETA (never the fare), can be cleared, expire and be taken down', async () => {
  const { expireSpots } = await import('../src/waterlog.js');
  const rider = await register('rider');
  const driver = await register('driver', 'car');
  const other = await register('rider');
  const ops = await admin2();
  const at = (lat, lng, extra = {}) => ({ lat, lng, accuracy: 25, ...extra });
  const quote = async () => (await api('POST', '/api/rides/quote', { token: rider.token, body: { pickup: PICKUP, dropoff: DROPOFF } })).body;
  const listed = async () => (await api('GET', '/api/waterlogging', { token: rider.token })).body.spots.map((s) => s.id);
  // Offline test routing draws a straight line from PICKUP to DROPOFF; MID is on it, halfway.
  const MID = [22.56305, 88.3932];
  const QUARTER = [22.5583, 88.3729];
  const before = await quote();
  assert.equal(before.waterlog.delayMin, 0);

  assert.equal((await api('POST', '/api/waterlogging', { token: rider.token, body: at(...MID, { severity: 'knee', accuracy: 500 }) })).status, 400, 'a vague GPS fix cannot report');
  assert.equal((await api('POST', '/api/waterlogging', { token: rider.token, body: at(...MID) })).status, 400, 'depth is required');
  assert.equal((await api('POST', '/api/waterlogging', { token: ops.token, body: at(...MID, { severity: 'knee' }) })).status, 403);
  const made = await api('POST', '/api/waterlogging', { token: rider.token, body: at(...MID, { severity: 'knee', note: 'Near the petrol pump' }) });
  assert.equal(made.status, 201);
  const spotId = made.body.spot.id;
  assert.equal(made.body.spot.label, 'Knee deep');

  // A report ~60 m away confirms the same spot, and the deeper depth wins.
  const merged = await api('POST', '/api/waterlogging', { token: driver.token, body: at(22.5634, 88.3936, { severity: 'impassable' }) });
  assert.equal(merged.status, 200);
  assert.equal(merged.body.merged, true);
  assert.equal(merged.body.spot.id, spotId);
  assert.equal(merged.body.spot.severity, 'impassable');
  assert.equal(merged.body.spot.confirmations, 1);
  assert.deepEqual(await listed(), [spotId]);

  // The quote's trip time goes up by the expected delay; the fare does not change.
  const after = await quote();
  assert.equal(after.waterlog.delayMin, 15);
  assert.equal(after.waterlog.impassable, true);
  for (const o of after.options) {
    const b = before.options.find((x) => x.type === o.type);
    assert.equal(o.etaMin, b.etaMin + 15, `${o.type} ETA padded`);
    assert.equal(o.waterlogDelayMin, 15);
    assert.equal(o.price.fare, b.price.fare, `${o.type} fare unchanged`);
  }

  // Live trip ETA: only spots still ahead of the driver count.
  const ws = await online(driver.token);
  const rs = await socketFor(rider.token);
  const rideId = (await book(rider.token)).body.ride.id;
  await driveToOngoing(rideId, rider, driver);
  assert.equal((await api('POST', '/api/waterlogging', { token: other.token, body: at(...QUARTER, { severity: 'ankle' }) })).status, 201);
  const etaAt = async (lat, lng) => {
    const next = nextEvent(rs, 'ride:location');
    ws.emit('driver:location', { lat, lng, accuracy: 10 });
    return (await next).waterlogDelayMin;
  };
  assert.equal(await etaAt(22.5537, 88.3526), 17, 'both spots are ahead at the start');
  assert.equal(await etaAt(22.5607, 88.383), 15, 'past the first spot, only the second counts');

  // Clearing: you must be nearby; one stranger is not enough; the reporter's own "cleared" is.
  assert.equal((await api('POST', `/api/waterlogging/${spotId}/vote`, { token: other.token, body: at(PICKUP.lat, PICKUP.lng, { vote: 'cleared' }) })).status, 403);
  const one1 = await api('POST', `/api/waterlogging/${spotId}/vote`, { token: other.token, body: at(...MID, { vote: 'cleared' }) });
  assert.equal(one1.body.spot.status, 'active');
  assert.equal(one1.body.spot.clearedVotes, 1);
  const cleared = await api('POST', `/api/waterlogging/${spotId}/vote`, { token: rider.token, body: at(...MID, { vote: 'cleared' }) });
  assert.equal(cleared.body.spot.status, 'cleared');
  assert.equal((await quote()).waterlog.delayMin, 2, 'only the ankle-deep spot is left');
  assert.equal((await api('POST', `/api/waterlogging/${spotId}/vote`, { token: driver.token, body: at(...MID, { vote: 'still' }) })).status, 409);

  // Expiry: unconfirmed spots end by themselves.
  // Test-only fixture in the throwaway database: the 6 hours have passed.
  await query(`UPDATE waterlog_reports SET expires_at = now() - interval '1 minute' WHERE status = 'active'`);
  assert.ok((await expireSpots()) >= 1);
  assert.deepEqual(await listed(), []);

  // Admins take down a false report.
  const fake = (await api('POST', '/api/waterlogging', { token: driver.token, body: at(22.6, 88.4, { severity: 'impassable' }) })).body.spot.id;
  assert.equal((await api('DELETE', `/api/admin/waterlogging/${fake}`, { token: rider.token })).status, 403);
  assert.equal((await api('DELETE', `/api/admin/waterlogging/${fake}`, { token: ops.token })).status, 200);
  assert.equal((await api('DELETE', `/api/admin/waterlogging/${fake}`, { token: ops.token })).status, 404);
  assert.deepEqual(await listed(), []);
  assert.ok((await api('GET', '/api/admin/waterlogging', { token: ops.token })).body.spots.some((s) => s.id === fake && s.status === 'removed'));
  await api('POST', `/api/rides/${rideId}/complete`, { token: driver.token });
});

test('languages: every message in English and Hindi, a saved choice, notifications in the recipient\'s language', async () => {
  const { MESSAGE_KEYS, SMS_KEYS, message, smsText } = await import('../src/messages.js');
  // Sample values for any placeholder a message might use.
  const vars = new Proxy({}, { get: (_t, k) => ({ kind: 'trip', vehicle: 'car', doc: 'insurance', texted: 2, eta: 5, time: 'Mon 9:00', amount: 120, fare: 300 })[k] ?? 'X' });
  const devanagari = /[ऀ-ॿ]/;
  for (const key of MESSAGE_KEYS) {
    const [enTitle, enBody] = message('en', key, vars);
    const [hiTitle, hiBody] = message('hi', key, vars);
    assert.ok(enTitle && enBody !== undefined && hiTitle && hiBody !== undefined, key);
    assert.ok(devanagari.test(hiTitle + hiBody), `${key} has Hindi text`);
    assert.ok(!/undefined|\[object/.test(enTitle + enBody + hiTitle + hiBody), `${key} fills every placeholder`);
  }
  for (const key of SMS_KEYS) {
    assert.ok(devanagari.test(smsText('hi', key, vars)), `${key} SMS in Hindi`);
    assert.ok(!/undefined/.test(smsText('en', key, vars) + smsText('hi', key, vars)), key);
  }
  assert.equal(message('fr', 'driverArriving')[0], 'Your driver is arriving', 'unknown languages fall back to English');

  // A new account keeps the language chosen on the sign-in screen.
  const token = await supabaseToken({ email: 'hindi-rider@hopin.test' });
  const created = await api('POST', '/api/auth/profile', { token, body: { name: 'Asha Devi', phone: '9123400001', role: 'rider', language: 'hi' } });
  assert.equal(created.body.user.language, 'hi');

  const rider = await register('rider');
  assert.equal(rider.user.language, 'en');
  assert.equal((await api('PATCH', '/api/profile', { token: rider.token, body: { language: 'fr' } })).status, 400);
  assert.equal((await api('PATCH', '/api/profile', { token: rider.token, body: { language: 'hi' } })).body.user.language, 'hi');

  // Asha (Hindi) is invited by an English-speaking rider: the invite reaches her in Hindi.
  const inviter = await register('rider');
  assert.equal((await api('POST', '/api/family', { token: inviter.token, body: { phone: '9123400001' } })).status, 201);
  const note = (await query(`SELECT n.title, n.body FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.phone LIKE '%9123400001' ORDER BY n.created_at DESC LIMIT 1`)).rows[0];
  assert.equal(note.title, 'फ़ैमिली आमंत्रण');
  assert.match(note.body, new RegExp(`${inviter.user.name} आपको अपनी Hopin फ़ैमिली`));
});

test('security: headers on every API response, rate limits on sign-in and actions', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('strict-transport-security'), 'HSTS for when it is served over HTTPS');
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.ok(res.headers.get('ratelimit-policy'), 'the real server is rate limited');

  // The limits themselves, at their real values, on a separate app (the test server runs them x1000).
  const express = (await import('express')).default;
  const { applyLimits } = await import('../src/limits.js');
  const saved = config.rateLimit.scale;
  config.rateLimit.scale = 1;
  const app = express();
  applyLimits(app);
  app.all('/api/*path', (_req, r) => r.json({ ok: true }));
  config.rateLimit.scale = saved;
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const url = `http://localhost:${srv.address().port}`;
  try {
    const signIns = [];
    for (let i = 0; i < 41; i++) signIns.push((await fetch(`${url}/api/auth/profile`, { method: 'POST' })).status);
    assert.equal(signIns.filter((s) => s === 200).length, 40);
    const blocked = await fetch(`${url}/api/auth/profile`, { method: 'POST' });
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).error, /Too many sign-in attempts/);
    // Opening the app reads the sign-in settings every time: never caught by the sign-in limit.
    for (let i = 0; i < 60; i++) assert.equal((await fetch(`${url}/api/auth/config`)).status, 200);
    assert.equal((await fetch(`${url}/api/sos`, { method: 'POST' })).status, 200, 'SOS is not caught by the sign-in limit');

    for (let i = 0; i < 30; i++) await fetch(`${url}/api/rides`, { method: 'POST' });
    assert.equal((await fetch(`${url}/api/rides`, { method: 'POST' })).status, 429, 'booking spam is stopped');
    assert.equal((await fetch(`${url}/api/rides/quote`, { method: 'POST' })).status, 200, 'quotes have their own, larger allowance');
  } finally {
    srv.close();
  }
});

test('live ETA: road time from OpenRouteService, refreshed at most every 30 s, estimate when the quota runs out', async () => {
  const { resetLiveEta } = await import('../src/liveEta.js');
  resetLiveEta();
  const rider = await register('rider');
  const driver = await register('driver', 'car');
  const ops = await admin2();
  const ws = await online(driver.token);
  const rs = await socketFor(rider.token);
  const rideId = (await book(rider.token)).body.ride.id;
  assert.equal((await api('POST', `/api/rides/${rideId}/accept`, { token: driver.token })).status, 200);
  const locate = async (lat, lng) => {
    const next = nextEvent(rs, 'ride:location');
    ws.emit('driver:location', { lat, lng, accuracy: 10 });
    return next;
  };
  stub.ors.calls.length = 0;
  stub.ors.seconds = 720;

  const first = await locate(22.56, 88.345);
  assert.equal(first.etaMin, 12, 'the road time OpenRouteService gave');
  assert.equal(first.etaSource, 'openrouteservice');
  assert.deepEqual(stub.ors.calls[0].coordinates, [[88.345, 22.56], [PICKUP.lng, PICKUP.lat]], 'from the driver to the pickup, lng/lat');

  // Within 30 s: no new request, even though the driver moved.
  assert.equal((await locate(22.558, 88.347)).etaMin, 12);
  assert.equal(stub.ors.calls.length, 1, 'quota is saved between refreshes');

  // After the refresh interval the next update triggers a new lookup in the background.
  const saved = config.ors.refreshMs;
  config.ors.refreshMs = 0;
  stub.ors.seconds = 300;
  await locate(22.556, 88.349);
  for (let i = 0; i < 50 && stub.ors.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await locate(22.555, 88.35)).etaMin, 5, 'refreshed road time');
  assert.equal((await api('GET', '/api/admin/routing', { token: ops.token })).body.orsRemaining, 1999);

  // Quota used up: falls back to the straight-line estimate and stops calling ORS until it resets.
  stub.ors.status = 429;
  await locate(22.5545, 88.351);
  for (let i = 0; i < 50 && stub.ors.calls.length < 4; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 30));
  const fallback = await locate(22.554, 88.3515);
  assert.equal(fallback.etaSource, 'estimate');
  assert.ok(fallback.etaMin >= 1);
  const routing = (await api('GET', '/api/admin/routing', { token: ops.token })).body;
  assert.equal(routing.orsRemaining, 0);
  assert.notEqual(routing.provider, 'openrouteservice');
  assert.equal((await api('GET', '/api/admin/routing', { token: rider.token })).status, 403);
  const callsAtLimit = stub.ors.calls.length;
  await locate(22.5538, 88.352);
  assert.equal(stub.ors.calls.length, callsAtLimit, 'no ORS calls while the quota is used up');

  config.ors.refreshMs = saved;
  stub.ors.status = 200;
  resetLiveEta();
  await api('POST', `/api/rides/${rideId}/cancel`, { token: rider.token });
});

test('payouts: details encrypted, money held on request, returned on cancel/reject, paid only with a unique UTR', async () => {
  const driver = await register('driver', 'car');
  const driver2 = await register('driver', 'auto');
  const rider = await register('rider');
  const ops = await admin2();
  const balance = async (id) => Number((await query('SELECT wallet_balance FROM users WHERE id = $1', [id])).rows[0].wallet_balance);
  const mine = async () => (await api('GET', '/api/driver/payouts', { token: driver.token })).body;

  assert.equal((await api('GET', '/api/driver/payouts', { token: rider.token })).status, 403);
  const start = await mine();
  assert.equal(start.enabled, true);
  assert.equal(start.method, null);
  assert.equal((await api('POST', '/api/driver/payouts', { token: driver.token, body: { amount: 100 } })).status, 400, 'needs a payout method first');

  assert.equal((await api('PUT', '/api/driver/payout-method', { token: driver.token, body: { kind: 'upi', vpa: 'not-a-upi' } })).status, 400);
  assert.equal((await api('PUT', '/api/driver/payout-method', { token: driver.token, body: { kind: 'bank', holder: 'Ravi Kumar', account: '1234567890123', ifsc: 'BAD' } })).status, 400);
  const saved = await api('PUT', '/api/driver/payout-method', { token: driver.token, body: { kind: 'bank', holder: 'Ravi Kumar', account: '1234 5678 9012 3', ifsc: 'hdfc0001234' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.method.label, 'HDFC0001234 ····0123');
  const stored = (await query('SELECT details_enc FROM payout_methods WHERE driver_id = $1', [driver.user.id])).rows[0].details_enc;
  assert.ok(!stored.includes('1234567890123') && !Buffer.from(stored, 'base64').includes(Buffer.from('1234567890123')), 'account number is encrypted at rest');

  await fundWallet(driver.user.id, 500);
  assert.equal((await api('POST', '/api/driver/payouts', { token: driver.token, body: { amount: 50 } })).status, 400, 'below the minimum');
  assert.equal((await api('POST', '/api/driver/payouts', { token: driver.token, body: { amount: 600 } })).status, 409, 'more than the wallet');
  const first = await api('POST', '/api/driver/payouts', { token: driver.token, body: { amount: 300 } });
  assert.equal(first.status, 201);
  assert.equal(await balance(driver.user.id), 200, 'held as soon as it is requested');
  assert.equal((await api('POST', '/api/driver/payouts', { token: driver.token, body: { amount: 100 } })).status, 409, 'one waiting request at a time');

  assert.equal((await api('POST', `/api/driver/payouts/${first.body.payout.id}/cancel`, { token: driver.token })).body.payout.status, 'cancelled');
  assert.equal(await balance(driver.user.id), 500, 'cancelling puts it back');

  const second = (await api('POST', '/api/driver/payouts', { token: driver.token, body: { amount: 400 } })).body.payout;
  assert.equal((await api('GET', '/api/admin/payouts', { token: driver.token })).status, 403);
  const listed = (await api('GET', '/api/admin/payouts?status=requested', { token: ops.token })).body.payouts.find((p) => p.id === second.id);
  assert.equal(listed.driver.name, driver.user.name);
  assert.equal(listed.label, 'HDFC0001234 ····0123');
  const details = (await api('GET', `/api/admin/payouts/${second.id}/details`, { token: ops.token })).body.details;
  assert.deepEqual(details, { kind: 'bank', holder: 'Ravi Kumar', account: '1234567890123', ifsc: 'HDFC0001234' });
  assert.equal((await api('GET', '/api/admin/payouts', { token: ops.token })).body.payouts.find((p) => p.id === second.id).detailViews, 1, 'viewing details is logged');

  assert.equal((await api('POST', `/api/admin/payouts/${second.id}/paid`, { token: ops.token, body: { reference: '12' } })).status, 400, 'a real UTR is required');
  const paid = await api('POST', `/api/admin/payouts/${second.id}/paid`, { token: ops.token, body: { reference: 'utr404912345678' } });
  assert.equal(paid.body.payout.status, 'paid');
  assert.equal(paid.body.payout.reference, 'UTR404912345678');
  assert.equal(await balance(driver.user.id), 100);
  assert.equal((await api('POST', `/api/admin/payouts/${second.id}/paid`, { token: ops.token, body: { reference: 'UTR999999999' } })).status, 409, 'cannot be paid twice');
  assert.equal((await api('POST', `/api/driver/payouts/${second.id}/cancel`, { token: driver.token })).status, 409, 'a paid request cannot be cancelled');
  const note = (await query(`SELECT title, body FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [driver.user.id])).rows[0];
  assert.equal(note.title, '₹400 sent to you');
  assert.match(note.body, /UTR404912345678/);

  // Rejected: the money goes back with the reason.
  const third = (await api('POST', '/api/driver/payouts', { token: driver.token, body: { amount: 100 } })).body.payout;
  assert.equal(await balance(driver.user.id), 0);
  assert.equal((await api('POST', `/api/admin/payouts/${third.id}/reject`, { token: ops.token, body: { reason: 'x' } })).status, 400);
  assert.equal((await api('POST', `/api/admin/payouts/${third.id}/reject`, { token: ops.token, body: { reason: 'Bank says the account name does not match' } })).body.payout.status, 'rejected');
  assert.equal(await balance(driver.user.id), 100);

  // The same transfer reference can't be used for two payouts.
  await fundWallet(driver2.user.id, 200);
  await api('PUT', '/api/driver/payout-method', { token: driver2.token, body: { kind: 'upi', vpa: 'Ravi.K@okicici' } });
  assert.equal((await mine()).method.kind, 'bank');
  const other = (await api('POST', '/api/driver/payouts', { token: driver2.token, body: { amount: 150 } })).body.payout;
  assert.equal(other.label, 'UPI ra***@okicici');
  assert.equal((await api('POST', `/api/admin/payouts/${other.id}/paid`, { token: ops.token, body: { reference: 'UTR404912345678' } })).status, 409);
  assert.equal((await api('POST', `/api/driver/payouts/${other.id}/cancel`, { token: driver.token })).status, 409, "drivers can't cancel someone else's");
});

test('push: only real push-service endpoints, messages encrypted + VAPID-signed, every notification pushed, dead subscriptions dropped', async () => {
  const { notify } = await import('../src/notify.js');
  const rider = await register('rider');
  const other = await register('rider');
  // A browser's push keys: an ECDH P-256 key pair and a 16-byte auth secret, as PushManager makes them.
  const browserKeys = () => {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  };
  const sub = (path) => ({ endpoint: `${SUPABASE_URL}/push/${path}`, keys: browserKeys() });
  const waitForPushes = async (n) => {
    for (let i = 0; i < 50 && stub.pushes.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    return stub.pushes.length;
  };

  const info = (await api('GET', '/api/push', { token: rider.token })).body;
  assert.equal(info.enabled, true);
  assert.equal(info.publicKey, process.env.VAPID_PUBLIC_KEY);
  assert.equal(info.devices, 0);
  assert.equal((await api('GET', '/api/features')).body.push, true);

  // The server will POST to the endpoint, so arbitrary addresses are refused.
  for (const endpoint of ['https://evil.example/push', 'http://169.254.169.254/latest/meta-data', 'not a url']) {
    assert.equal((await api('POST', '/api/push/subscribe', { token: rider.token, body: { subscription: { endpoint, keys: browserKeys() } } })).status, 400, endpoint);
  }
  assert.equal((await api('POST', '/api/push/subscribe', { token: rider.token, body: { subscription: { endpoint: `${SUPABASE_URL}/push/x`, keys: { p256dh: 'bad key!', auth: 'x' } } } })).status, 400);

  const laptop = sub(`laptop-${rider.user.id}`);
  assert.equal((await api('POST', '/api/push/subscribe', { token: rider.token, body: { subscription: laptop } })).body.devices, 1);
  assert.equal((await api('POST', '/api/push/subscribe', { token: rider.token, body: { subscription: laptop } })).body.devices, 1, 'subscribing twice keeps one device');

  stub.pushes.length = 0;
  const tested = (await api('POST', '/api/push/test', { token: rider.token })).body;
  assert.deepEqual(tested, { sent: 1, failed: 0 });
  const [msg] = stub.pushes;
  assert.equal(msg.path, `/push/laptop-${rider.user.id}`);
  assert.match(msg.headers.authorization, /^vapid t=.+, k=/, 'signed with Hopin\'s VAPID key');
  assert.equal(msg.headers['content-encoding'], 'aes128gcm', 'encrypted for that browser');
  assert.equal(msg.headers.ttl, '600');
  assert.ok(!msg.body.includes(Buffer.from('notifications are on')), 'the push service cannot read the message');

  // Every in-app notification is also pushed.
  await notify(rider.user.id, 'Your driver has arrived', 'Meet them at the pickup', '/book');
  assert.equal(await waitForPushes(2), 2);

  // An expired subscription (410 from the push service) is removed.
  await api('POST', '/api/push/subscribe', { token: rider.token, body: { subscription: sub('gone') } });
  assert.equal((await api('GET', '/api/push', { token: rider.token })).body.devices, 2);
  assert.deepEqual((await api('POST', '/api/push/test', { token: rider.token })).body, { sent: 1, failed: 1 });
  assert.equal((await api('GET', '/api/push', { token: rider.token })).body.devices, 1);

  // The same browser signing in as someone else moves the subscription to them.
  await api('POST', '/api/push/subscribe', { token: other.token, body: { subscription: laptop } });
  assert.equal((await api('GET', '/api/push', { token: rider.token })).body.devices, 0);
  assert.equal((await api('POST', '/api/push/unsubscribe', { token: other.token, body: { endpoint: laptop.endpoint } })).body.devices, 0);
  assert.equal((await api('GET', '/api/push')).status, 401);
});

test('access control: strangers, wrong roles and non-admins are kept out', async () => {
  const owner = await register('rider');
  const stranger = await register('rider');
  const { body } = await book(owner.token);
  assert.equal((await api('GET', `/api/rides/${body.ride.id}`, { token: stranger.token })).status, 404);
  assert.equal((await api('POST', `/api/rides/${body.ride.id}/cancel`, { token: stranger.token })).status, 404);
  assert.equal((await api('POST', `/api/rides/${body.ride.id}/accept`, { token: stranger.token })).status, 403);
  assert.equal((await api('GET', '/api/admin/overview', { token: owner.token })).status, 403);
  assert.equal((await api('POST', '/api/rides/not-a-uuid/cancel', { token: owner.token })).status, 404);
  assert.equal((await api('GET', '/api/rides/active')).status, 401);
  await api('POST', `/api/rides/${body.ride.id}/cancel`, { token: owner.token });
});

test('ledger: after everything above, every wallet balance equals the sum of its history', async () => {
  const off = await many(
    `SELECT u.id, u.role, u.wallet_balance,
            COALESCE((SELECT SUM(amount) FROM wallet_txns w WHERE w.user_id = u.id AND w.kind <> 'cash_earning'), 0)::int AS ledger
     FROM users u`,
  );
  const mismatched = off.filter((u) => u.wallet_balance !== u.ledger);
  assert.deepEqual(mismatched, [], 'no wallet may drift from its ledger');
  assert.ok(off.every((u) => u.role === 'driver' || u.wallet_balance >= 0), 'riders never go below zero');
  const companies = await many(`SELECT c.name, c.wallet_balance, COALESCE((SELECT SUM(amount) FROM company_txns t WHERE t.company_id = c.id), 0)::int AS ledger FROM companies c`);
  assert.deepEqual(companies.filter((c) => c.wallet_balance !== c.ledger), [], 'no company wallet may drift from its ledger');
});
