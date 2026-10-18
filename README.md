# Hopin

A ride-hailing app: riders book bikes, autos and cabs, drivers accept and drive, and the trip updates live for everyone.

**Rule for this project:** nothing in Hopin is simulated. A feature whose service isn't connected yet says so plainly and refuses; it never pretends. See `HOPIN_PLAN.md` for the step-by-step plan.

## What Hopin runs on right now

| Part | In use | Notes |
| --- | --- | --- |
| Backend | Node.js + Express 5 | REST API in `server/src/routes` |
| Real-time | Socket.IO (WebSockets) | ride status, driver location, notifications |
| Database | PostgreSQL on **Supabase** | numbered migrations in `server/migrations` (run on start); Row Level Security on every table |
| Auth | **Supabase Auth** | email + password with email verification, Google sign-in; Hopin verifies Supabase's ES256 tokens and stores no passwords |
| Maps / routing / search | OpenStreetMap tiles, OSRM, Photon → Nominatim | free public servers; provider choice is step 11 |
| Frontend | React 19 + Vite + Tailwind CSS 4 | |

## Connected vs not connected yet

| Service | State | What happens |
| --- | --- | --- |
| Cash payments | ✅ works | the driver confirms collection |
| Wallet | ✅ works | debits the real ledger balance; the balance starts at ₹0 |
| Card / UPI payments, wallet top-up | ✅ connected (Razorpay TEST mode; UPI not yet enabled on the Razorpay account) | Razorpay Checkout; Hopin sets the amount, then checks the signature and asks Razorpay to confirm the payment before marking anything paid |
| Refunds, fare disputes | ✅ works | admin refunds through Razorpay's refund API or to the Hopin wallet; never more than was paid; driver share adjusted |
| Rider–driver chat | ✅ works | in-app, stored in Postgres (`ride_messages`), live over Socket.IO, read receipts; open only while a driver is assigned, read-only after. Phone numbers are never sent to the other party |
| Route-deviation alerts | ✅ works (needs a real moving trip to see live) | during a trip, driver GPS is compared with the saved OSRM road route; >500 m for 30 s opens an alert (stored in `route_deviations`) shown to rider (with SOS), driver and admins; closes when back within 300 m or the trip ends. GPS fixes worse than 100 m are ignored; trips booked while routing was down are not watched, and the app says so |
| Scheduled rides | ✅ works | book 30 min–7 days ahead (max 5 upcoming); fare fixed at booking without surge; offered to drivers 15 min before pickup, re-offered each minute until 5 min after pickup, then cancelled with a notification; free to cancel before it goes out; cancelled with a reason if the rider is in another ride or the server missed the time |
| Saved places | ✅ works | Home, Work and up to 20 named places per user (`saved_places`); one-tap chips on the booking screen, managed in Profile |
| Safety basics (step 8b A) | ✅ works | own trip PIN; long-stop alert (6 min within 60 m, away from pickup/stops/drop) with "I'm OK"; "Reached safely?" after 10 pm–6 am trips (no answer in 10 min texts emergency contacts + alerts admins); 108 ambulance next to 112; helmet/seatbelt reminders; bike drivers send a daily helmet selfie reviewed by admins; drivers moving above 10 km/h can send only quick replies |
| Fair money (step 8b B) | ✅ works | one ledger function (`postTxn`) so every wallet equals its history; cash rides: driver keeps the cash, Hopin's 20% comes from their wallet (drivers may go below ₹0, riders never); tips ₹10–500 (wallet or Razorpay, 100% to driver); fare splits between Hopin riders (wallet or Razorpay); late driver cancel credits the rider the cancel fee from the driver; long detour after a route alert auto-opens a fare dispute; fare breakdown (driver vs Hopin) on trip page and PDF; open surge counts + "tell me when it's normal" (30 min) |
| Ways to book (step 8b C) | ✅ works | book for someone else (passenger gets driver + own code by SMS; driver sees name only); hourly rentals (packages, no fixed drop, GPS distance, extra km/min at the end, no surge/promo) + seasonal Puja packages and admin road closures with a source; parcels (size decides vehicle, receiver gets a delivery code by SMS, driver finishes only with it); accessibility requests shown before accepting, deaf-driver note and message cards; family links (accept needed, trips shared only if each person turns it on); price lock ₹49 / 7 days (pay the lower of locked and normal fare) |
| Drivers (step 8b D) | ✅ works | daily pass (wallet or Razorpay) = 100% of fares on rides accepted that day; heading home (only rides ending ≥1 km closer to home, 2 a day, off within 1 km of home); fatigue from real online sessions (10 h without a 30-min break → offline until the break; riders see driving time and "Well rested"); station queues at Howrah, Sealdah, airport (front of queue gets the pickup for 45 s, then the next; riders see their place in line) |
| Growth (step 8b E) | ✅ works | referral codes (riders ₹50 each after the first paid trip; drivers ₹200 after 20 trips); loyalty points with tiers, redeemed as wallet credit; corporate accounts: Hopin admin creates the company, company admin tops up a company wallet (Razorpay), invites employees with monthly limits, exports a CSV; business rides paid from the company wallet and refunded back to it |
| Trip recording (step 8b F) | ✅ works | rider or driver records trip audio (other person told); encrypted server-side (AES-256-GCM, `RECORDING_KEY`) into a private Supabase bucket; playable only by admins after the recorder sends it to safety, every play logged; unsent recordings deleted after 7 days |
| Monsoon waterlogging (step 8b G) | ✅ works | riders and drivers report flooded spots from their GPS (depth: ankle / knee / not passable); nearby people confirm or clear them; spots show on the map, expire after 6 h without confirmation, and add expected minutes to quoted and live ETAs (fare unchanged); admins remove false reports |
| Installable app + push (step 9) | ✅ works | add to home screen (manifest, icons, service worker with an offline page); every notification also arrives as a Web Push with the app closed (encrypted per browser, VAPID-signed); Profile → App & notifications |
| Languages (step 10) | ✅ English + हिन्दी | switch on sign-in and in the header, saved on the profile; all notifications, push and SMS to riders/drivers in their language; navigation, statuses, sign-in, SOS and ride screens translated (the rest after the UI redesign) |
| Live ETA (step 11) | ✅ works (OpenRouteService key added) | live trip ETAs from the real road route (OpenRouteService, every 30 s at most, quota-aware; falls back to OSRM, then an estimate) |
| Driver payouts (step 12) | ✅ works (manual) | drivers save UPI/bank (encrypted) and request withdrawals; an admin pays by UPI/bank and records the UTR; money held on request and returned on reject/cancel |
| Security (step 13) | ✅ | every route audited, rate limits, security headers, 0 known dependency vulnerabilities |
| Email (receipts, Supabase sign-up/reset emails) | ✅ connected | Gmail SMTP in Hopin (`SMTP_*`) and in Supabase's SMTP settings; `npm run test-email -- you@x` |
| Email verification, Google sign-in, password reset | ✅ works | via Supabase Auth; Supabase's built-in mailer sends only a few emails per hour until SMTP (step 2) |
| Phone verification + phone sign-in (SMS OTP) | ✅ connected (Twilio trial: only verified numbers) | Supabase sends codes via Twilio Verify; Hopin asks Supabase's admin API before marking a number verified. Once on, riders must verify to book and drivers to go online/accept |
| Driver verification | ✅ works | licence, RC, insurance, photo → private Supabase Storage bucket; admin approves/rejects; only fully approved, in-date drivers can go online or accept; RC/insurance tied to the vehicle plate |
| Automatic SOS texts | ✅ connected (Twilio trial: only verified numbers) | Twilio Messaging (`TWILIO_*`); each contact's real Twilio result is shown and stored ("sent to Twilio" ≠ delivered) |

`GET /api/features` reports this live, and the app only offers what is reported as connected.

## Run it

```bash
npm run setup          # install server + client dependencies
npm run create-admin   # create your admin account (asks in the terminal)
npm run dev:api        # API + WebSockets on http://localhost:8720
npm run dev:web        # web app on http://localhost:5190
npm test               # 45 end-to-end tests on an in-memory database (never touches Supabase)
```

Riders and drivers sign up in the app (Supabase Auth), then complete a Hopin profile. Drivers need real location from their device to go online; there is no manual or simulated position.

## Layout

```
server/src
  schema.sql        tables, one-active-ride constraints
  db.js             Postgres pool (Supabase) or embedded PGlite behind one interface
  hub.js            Socket.IO: presence, dispatch, surge, live location
  fare.js promos.js payments.js receipt.js notify.js geo.js
  create-admin.js   terminal command to create an admin
  routes/           auth, profile, rides, payments, safety (SOS + track), support, admin
client/src
  pages/            Book (rider), Drive (driver), Trips, Profile, Help, Admin, Track, Family, Documents, AuthPage
  components/       MapView, PlaceInput, RideBits, DriverSheet, Shell, Onboarding, ui
  ds/               design system: tokens in styles.css, components, BottomSheet, Anim (Lottie), Layout
  i18n/             en.js / hi.js keys, phrases.hi.js (Hindi for plain-English screen text)
client/scripts
  fetch-media.js    downloads + processes the free media into public/media (npm run media)
  shots.mjs         design-review screenshots of every screen, no backend needed (npm run shots)
  sheet.mjs         tiles screenshots into one contact sheet for review
```

## Design system

Kolkata yellow-taxi brand: warm paper background, ink text, taxi yellow (`--accent #ffc21a`) only for
the one main action on a screen. Bricolage Grotesque for headings, Mukta (with Devanagari) for text.
Icons are lucide-react only; vehicles use `ds/icons.jsx` (lucide has no auto-rickshaw, so one is drawn
on its grid). Every screen is built from `src/ds`: Button, Input, Chip, Badge, Notice, Card, Tabs,
Switch, Modal, BottomSheet (draggable, snap points, pinned footer; a side panel on desktop),
Skeleton/ListSkeleton (no spinners for content), EmptyState, Page/Section, Anim, Illustration.
Touch targets are at least 44 px; colours meet WCAG AA in light and dark; motion stays under 250 ms
and respects reduced motion. `/design-preview` (dev builds only) shows every component and state.

`npm run shots` drives the real app in Playwright at 375 and 1280 px, light and dark, with realistic
Kolkata data mocked at the network layer (API, Socket.IO, Supabase session, GPS). It reports page
errors, sideways overflow and any API call a screen makes that isn't mocked. Screens land in
`design/screens/`.

## Media

All free, all served from `client/public/media` (no hotlinking); `npm run media` rebuilds them and
`public/media/CREDITS.md` lists every source and licence.

- Login background: a 10-second clip of Kolkata's yellow taxis (Pexels), graded warm, 720p, muted,
  WebM (936 KB) + H.264 MP4 (1.2 MB) + poster (79 KB). It plays only without reduced motion,
  Save-Data or a 2G/3G connection; otherwise the poster shows. Login screen total stays under 1.5 MB.
- Onboarding (first visit only): three Pexels photos as AVIF + WebP at 480/960/1440 w with a
  blurred inline placeholder.
- Lottie (LottieFiles, loaded only when shown, each under 25 KB): searching, payment success, trip
  complete, empty trips, no internet; recoloured to the brand.
- unDraw illustrations recoloured to the accent: no drivers, no tickets, no family members.
