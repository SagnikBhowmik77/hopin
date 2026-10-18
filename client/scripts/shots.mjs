// Design-review screenshots of signed-in screens without real accounts.
//   node scripts/shots.mjs [scenario-prefix ...] [--w=375,1280] [--theme=light,dark] [--full]
// The app runs for real (dev server on :5190); Playwright answers its API calls with the
// realistic content in fixtures.mjs, fakes a Supabase session on localhost, stubs the live
// socket and pins the GPS to Park Street. Nothing touches the real backend or Supabase.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from './fixtures.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => (args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def).split(',');
const widths = opt('w', '375,1280').map(Number);
const themes = opt('theme', 'light,dark');
const only = args.filter((a) => !a.startsWith('--'));
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../design/screens');

// ---- API answers ------------------------------------------------------------------------
function baseApi(role, s) {
  const user = s.lang ? { ...F.users[role], language: s.lang } : F.users[role];
  const active = s.ride ?? null;
  return [
    ['GET', /^\/auth\/config$/, () => ({ supabaseUrl: 'http://localhost:5190/__sb', publishableKey: 'pk-local', providers: { google: true, phone: true, email: true } })],
    ['GET', /^\/auth\/me$/, () => ({ user })],
    ['GET', /^\/features$/, () => ({ onlinePayments: true, onlinePaymentsTestMode: false, onlinePaymentsMessage: null, email: true, sms: true, recording: true, push: true })],
    ['GET', /^\/profile\/notifications$/, () => ({ notifications: F.notifications, unread: 1 })],
    ['GET', /^\/rides\/active$/, () => ({ ride: active })],
    ['GET', /^\/geo\/reverse/, () => ({ address: F.PICKUP.address })],
    ['GET', /^\/geo\/search/, () => ({ results: F.searchResults })],
    ['GET', /^\/profile\/payment-methods$/, () => ({ upi: [{ id: 'v1', vpa: 'ananya.sen@okhdfc' }], walletBalance: user.walletBalance })],
    ['POST', /^\/rides\/quote$/, () => F.quote],
    ['GET', /^\/places$/, () => ({ places: F.savedPlaces })],
    ['GET', /^\/rides\/scheduled$/, () => ({ rides: [] })],
    ['GET', /^\/rentals\/closures$/, () => ({ closures: [] })],
    ['GET', /^\/rentals\/packages/, () => ({ packages: [] })],
    ['GET', /^\/company\/me$/, () => ({ membership: null, invite: null })],
    ['GET', /^\/waterlogging$/, () => ({ spots: [], severity: {}, hours: 6 })],
    ['GET', /^\/rides\/safety-check$/, () => ({ check: null })],
    ['GET', /^\/rides\/surge-watch$/, () => ({ watch: null })],
    ['GET', /^\/rides\/splits\/incoming$/, () => ({ splits: [] })],
    ['GET', /^\/recordings/, () => ({ enabled: true, keepDays: 7, recordings: [], liveOnRide: [] })],
    ['GET', /^\/push$/, () => ({ enabled: true, publicKey: null, devices: 0 })],
    ['GET', /^\/rides\/[^/]+\/messages$/, () => ({ messages: [], quickReplies: [], unread: 0 })],
    ['GET', /^\/rides\/[^/]+\/cancel-fee$/, () => ({ fee: 0 })],
    ['GET', /^\/rides\/[^/]+\/station$/, () => ({ place: null })],
    ['GET', /^\/rides\/(?!(?:earnings|open|active|scheduled|history)\b)[^/?]+$/, () => ({ ride: active })],
    ['GET', /^\/family$/, () => ({ sharing: true, members: [], incoming: [{ linkId: 'l1', person: { name: 'Rupa Sen', phone: '+919830011122' } }], outgoing: [] })],
    // driver
    ['GET', /^\/rides\/earnings$/, () => F.earnings],
    ['GET', /^\/driver\/verification$/, () => s.verification ?? F.verification(true)],
    ['GET', /^\/driver\/helmet$/, () => ({ required: false })],
    ['GET', /^\/driver\/pass$/, () => ({ price: 99, today: false, walletBalance: 1840 })],
    ['GET', /^\/driver\/home$/, () => ({ home: { lat: 22.4875, lng: 88.3613, address: 'Jadavpur 8B Bus Stand, Kolkata' }, headingHome: false, usesLeft: 2 })],
    ['GET', /^\/driver\/fatigue$/, () => ({ drivingMin: 95, rested: true, needsBreak: false })],
    ['GET', /^\/driver\/payouts$/, () => F.driverPayouts],
    ['GET', /^\/driver\/station$/, () => ({ queue: null })],
    ['GET', /^\/rides\/open$/, () => ({ rides: s.offers ?? [] })],
    // rider: trips, profile, help, track
    ['GET', /^\/rides\/history/, () => ({ rides: F.history })],
    ['GET', /^\/profile\/wallet$/, () => ({ txns: F.walletTxns })],
    ['GET', /^\/growth\/referral$/, () => ({ code: 'ANANYA42', rules: { reward: 50, when: 'after their first paid trip', max: 10 }, invited: 3, rewarded: 2, earned: 100, usedCode: null })],
    ['GET', /^\/growth\/loyalty$/, () => ({ points: 340, tier: { name: 'Silver', trips90: 14, next: { name: 'Gold', tripsToGo: 16 } }, rules: { redeemStep: 100, rupeesPer100: 25, rupeesPerPoint: 10 }, history: [{ kind: 'earned', trip: 'Park Street to Sector V', points: 18 }] })],
    ['GET', /^\/support\/tickets$/, () => ({ tickets: [F.admin.tickets[0]] })],
    ['GET', /^\/support\/tickets\/[^/]+$/, () => F.ticketThread],
    ['GET', /^\/track\//, () => F.track],
    // admin
    ['GET', /^\/admin\/overview$/, () => F.admin.overview],
    ['GET', /^\/admin\/insights$/, () => F.admin.insights],
    ['GET', /^\/admin\/sos$/, () => ({ alerts: F.admin.sos })],
    ['GET', /^\/admin\/tickets/, () => ({ tickets: F.admin.tickets })],
    ['GET', /^\/admin\/deviations$/, () => ({ deviations: F.admin.deviations })],
    ['GET', /^\/admin\/helmet-checks$/, () => ({ checks: F.admin.helmet })],
    ['GET', /^\/admin\/safety-checks$/, () => ({ checks: [] })],
    ['GET', /^\/admin\/recordings$/, () => ({ recordings: [] })],
    ['GET', /^\/admin\/waterlogging$/, () => ({ spots: [] })],
    ['GET', /^\/admin\/payouts$/, () => ({ payouts: F.admin.payouts })],
    ['GET', /^\/admin\/routing$/, () => F.admin.routing],
    ['GET', /^\/rentals\/admin\/packages$/, () => ({ packages: F.admin.packages })],
    ['GET', /^\/rentals\/admin\/closures$/, () => ({ closures: [] })],
    ['GET', /^\/admin\/pass-prices$/, () => ({ prices: { bike: 49, auto: 79, car: 99 } })],
    ['GET', /^\/admin\/companies$/, () => ({ companies: [{ id: 'c1', name: 'Technopolis Systems Pvt Ltd', adminName: 'Ananya Sen', members: 42, walletBalance: 68400, active: true }] })],
    ['GET', /^\/admin\/refunds$/, () => ({ duplicates: [], refunds: [] })],
    ['GET', /^\/admin\/drivers$/, () => ({ drivers: F.admin.drivers })],
    ['GET', /^\/admin\/promos$/, () => ({ promos: F.admin.promos })],
    ['GET', /^\/geo\/route/, () => ({ route: { geometry: F.ROUTE.slice(0, 3), distanceKm: 1.1, durationMin: 4 } })],
    ['GET', /^\/profile\/drivers\//, () => ({ driver: { name: 'Rakesh Mondal', rating: 4.9, ratingCount: 412 }, reviews: [] })],
  ];
}

async function mockApi(page, role, s) {
  const handlers = [...(s.api ?? []), ...baseApi(role, s)];
  const unknown = new Set();
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname.replace(/^\/api/, '');
    const h = handlers.find(([m, re]) => m === req.method() && (re.test(p) || re.test(p + url.search)));
    if (!h) {
      unknown.add(`${req.method()} ${p}`);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    const [, , fn, opts = {}] = h;
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    const out = fn(url, req);
    if (out && out.__status) return route.fulfill({ status: out.__status, contentType: 'application/json', body: JSON.stringify({ error: out.error }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  }).catch(() => {});
  await page.route('**/__sb/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  // Socket.IO over a websocket: answer the Engine.IO open and Socket.IO connect packets.
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    ws.send(`0${JSON.stringify({ sid: 'shot', upgrades: [], pingInterval: 600000, pingTimeout: 600000, maxPayload: 1e6 })}`);
    ws.onMessage((m) => {
      const msg = String(m);
      if (msg.startsWith('40')) ws.send('40{"sid":"shot-socket"}');
      // Acknowledge emits that wait for an answer (driver:online): 42<id>[...] -> 43<id>[{ok:true}]
      const ack = msg.match(/^42(\d+)\[/);
      if (ack) ws.send(`43${ack[1]}[{"ok":true}]`);
    });
  });
  return unknown;
}

// ---- interactions -------------------------------------------------------------------------
async function chooseDestination(page) {
  const box = page.getByRole('combobox', { name: /where to|कहाँ जाना है/i }).first();
  await box.click();
  await box.fill('Sector V');
  await page.getByRole('option').first().click();
}

// ---- scenarios ------------------------------------------------------------------------------
const SCENARIOS = {
  'rider-1-home': { role: 'rider', path: '/book' },
  'rider-2-choose': { role: 'rider', path: '/book', act: chooseDestination, settle: 900 },
  'rider-2b-fares-loading': { role: 'rider', path: '/book', api: [['POST', /^\/rides\/quote$/, () => F.quote, { delay: 60000 }]], act: chooseDestination, settle: 400 },
  'rider-2c-quote-error': { role: 'rider', path: '/book', api: [['POST', /^\/rides\/quote$/, () => ({ __status: 502, error: 'Could not reach the route service. Check your connection and try again.' })]], act: chooseDestination },
  'rider-3-searching': { role: 'rider', path: '/book', ride: F.ride('requested') },
  'rider-4-assigned': { role: 'rider', path: '/book', ride: F.ride('accepted') },
  'rider-5-arrived': { role: 'rider', path: '/book', ride: F.ride('arrived', { arrivedAt: new Date().toISOString() }) },
  'rider-6-ontrip': { role: 'rider', path: '/book', ride: F.ride('ongoing', { driverLocation: { lat: 22.5618, lng: 88.3874 } }) },
  'rider-7-rate': { role: 'rider', path: '/book', ride: F.ride('completed') },
  'rider-8-no-driver': { role: 'rider', path: '/book', ride: F.ride('cancelled', { cancelledBy: 'system', cancelReason: 'No drivers accepted in time' }) },
  'rider-9-payment-due': {
    role: 'rider',
    path: '/book',
    ride: F.ride('completed', {
      payment: { method: 'upi', status: 'due', ref: null, paidAt: null, upi: 'ananya.sen@okhdfc' },
      price: { baseFare: 184, surge: 1, stopCharge: 0, discount: 0, promoCode: null, fare: 184, cancellationFee: 0, due: 184 },
    }),
  },
  'rider-10-gps-off': { role: 'rider', path: '/book', gps: false },
  'rider-11-offline': { role: 'rider', path: '/book', offline: true },
  'rider-12-trips': { role: 'rider', path: '/trips', settle: 2500 },
  'rider-13-receipt': { role: 'rider', path: '/trips/r-5f2c9a10', ride: F.ride('completed', { breakdown: { driverSharePct: 80, driverFare: 147, hopinFare: 37, tip: 0, cash: true }, payment: { method: 'cash', status: 'paid', ref: 'CASH-5F2C9A10', paidAt: new Date().toISOString(), upi: null } }), settle: 1500 },
  'rider-14-profile': { role: 'rider', path: '/profile' },
  'rider-15-help': { role: 'rider', path: '/help?ticket=t1' },
  'rider-16-family': { role: 'rider', path: '/family', settle: 1200 },
  'rider-17-track': { role: 'rider', anon: true, path: '/track/tok123', settle: 1500 },

  'driver-1-offline': { role: 'driver', path: '/drive' },
  'driver-2-offers': { role: 'driver', path: '/drive', offers: [F.offer], act: (p) => p.getByRole('button', { name: /go online/i }).click(), settle: 1200 },
  'driver-3-pickup': { role: 'driver', path: '/drive', ride: F.ride('accepted') },
  'driver-4-otp': { role: 'driver', path: '/drive', ride: F.ride('arrived') },
  'driver-5-ontrip': { role: 'driver', path: '/drive', ride: F.ride('ongoing') },
  'driver-6-cash': { role: 'driver', path: '/drive', ride: F.ride('completed', { payment: { method: 'cash', status: 'due', ref: null, paidAt: null, upi: null } }) },
  'driver-7-unverified': { role: 'driver', path: '/drive', verification: F.verification(false) },
  'driver-8-documents': { role: 'driver', path: '/documents', verification: F.verification(false) },

  'hindi-1-home': { role: 'rider', path: '/book', lang: 'hi' },
  'hindi-2-choose': { role: 'rider', path: '/book', lang: 'hi', act: chooseDestination, settle: 900 },
  'hindi-3-assigned': { role: 'rider', path: '/book', lang: 'hi', ride: F.ride('accepted') },
  'hindi-4-rate': { role: 'rider', path: '/book', lang: 'hi', ride: F.ride('completed') },
  'hindi-5-driver': { role: 'driver', path: '/drive', lang: 'hi' },
  'hindi-6-onboarding': { role: 'rider', anon: true, onboarded: false, path: '/login', lang: 'hi', settle: 1500 },

  'auth-1-onboarding': { role: 'rider', anon: true, onboarded: false, path: '/login', settle: 1500 },
  'auth-2-onboarding-pay': { role: 'rider', anon: true, onboarded: false, path: '/login', act: async (p) => (await p.getByRole('button', { name: 'Next' }).click(), await p.getByRole('button', { name: 'Next' }).click()), settle: 1500 },
  'auth-3-login': { role: 'rider', anon: true, path: '/login', settle: 2000 },
  'auth-4-register': { role: 'rider', anon: true, path: '/register', settle: 2000 },

  'admin-1-safety': { role: 'admin', path: '/admin' },
  'admin-2-support': { role: 'admin', path: '/admin', act: (p) => p.getByRole('tab', { name: /support/i }).click() },
  'admin-3-drivers': { role: 'admin', path: '/admin', act: (p) => p.getByRole('tab', { name: /drivers/i }).click() },
  'admin-4-setup': { role: 'admin', path: '/admin', act: (p) => p.getByRole('tab', { name: /setup/i }).click() },
};

// ---- run ---------------------------------------------------------------------------------------
const session = (user) => ({
  access_token: 'local-shot-token',
  token_type: 'bearer',
  expires_in: 86400,
  expires_at: Math.floor(Date.now() / 1000) + 86400,
  refresh_token: 'r',
  user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, app_metadata: { provider: 'email' }, user_metadata: {} },
});

const browser = await chromium.launch();
const report = [];
for (const [name, s] of Object.entries(SCENARIOS)) {
  if (only.length && !only.some((o) => name.startsWith(o))) continue;
  const dir = path.join(OUT, name.split('-')[0]);
  mkdirSync(dir, { recursive: true });
  for (const w of widths) {
    for (const theme of themes) {
      const context = await browser.newContext({
        viewport: { width: w, height: w < 600 ? 812 : 800 },
        deviceScaleFactor: 2,
        colorScheme: theme,
        isMobile: w < 600,
        hasTouch: w < 600,
        ...(s.gps === false ? {} : { geolocation: { latitude: F.PICKUP.lat, longitude: F.PICKUP.lng, accuracy: 15 }, permissions: ['geolocation'] }),
      });
      await context.addInitScript(
        ([sess, th, onboarded, lang]) => {
          if (sess) localStorage.setItem('sb-localhost-auth-token', JSON.stringify(sess));
          if (onboarded) localStorage.setItem('hopin.onboarded', '1');
          localStorage.setItem('hopin.theme', th);
          localStorage.setItem('hopin.lang', lang);
        },
        [s.anon ? null : session(s.lang === 'hi' ? { ...F.users[s.role], language: 'hi' } : F.users[s.role]), theme, s.onboarded ?? true, s.lang ?? 'en'],
      );
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const unknown = await mockApi(page, s.role, s);
      await page.goto(`http://localhost:5190${s.path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(700);
      if (s.act) await s.act(page).catch((e) => errors.push(`action: ${e.message.split('\n')[0]}`));
      if (s.offline) {
        await context.setOffline(true);
        await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      }
      await page.waitForTimeout(s.settle ?? 900);
      // Sideways overflow of the page, or of the scrolling main area (which would clip content).
      const overflow = await page.evaluate(() => {
        const main = document.querySelector('main');
        return Math.max(document.documentElement.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0);
      });
      if (overflow > 0) {
        // Name the widest offender: the deepest element that sticks out past the viewport.
        const culprit = await page.evaluate(() => {
          const out = [...document.querySelectorAll('main *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1);
          const leaf = out.filter((el) => !out.some((o) => o !== el && el.contains(o)));
          return leaf.slice(0, 3).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} "${el.textContent.slice(0, 40)}"`).join(' | ');
        });
        errors.push(`overflow from: ${culprit}`);
      }
      const file = path.join(dir, `${name}-${w}-${theme}.png`);
      await page.screenshot({ path: file });
      // --full: <main> scrolls inside a fixed shell, so page down through it.
      if (args.includes('--full')) {
        for (let i = 2; i <= 8; i++) {
          const moved = await page.evaluate(() => {
            const m = document.querySelector('main');
            const before = m.scrollTop;
            m.scrollTop += m.clientHeight * 0.9;
            return m.scrollTop !== before;
          });
          if (!moved) break;
          await page.waitForTimeout(300);
          await page.screenshot({ path: file.replace(/\.png$/, `-p${i}.png`) });
        }
      }
      report.push(
        `${name} ${w} ${theme}: ${[errors.length && `ERRORS ${errors.join(' | ')}`, overflow > 0 && `OVERFLOW ${overflow}px`, unknown.size && `unstubbed ${[...unknown].join(', ')}`].filter(Boolean).join('; ') || 'ok'}`,
      );
      await context.close();
    }
  }
}
await browser.close();
console.log(report.join('\n'));
