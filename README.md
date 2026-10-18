<div align="center">

<img src="client/public/icons/icon-192.png" width="72" alt="Hopin logo" />

# Hopin

**Kolkata's own ride app. Bikes, autos and cabs with upfront fares, live tracking, OTP-verified pickups and a real SOS button.**

React 19 · Express 5 · Socket.IO · PostgreSQL (Supabase) · Razorpay · English + हिन्दी · installable PWA

| | Link |
|---|---|
| Frontend (Vercel) | _add after deploying_ |
| Backend API (Render) | _add after deploying_ |
| Demo video | _add link_ |
| Source | https://github.com/SagnikBhowmik77/hopin |

<img src="docs/screenshots/rider-2-choose-desktop.webp" width="900" alt="Choosing a ride on desktop: bike, auto and cab fares beside a map of Kolkata" />

</div>

---

## Contents

1. [Introduction](#1-introduction)
2. [Research](#2-research)
3. [Tech stack and why](#3-tech-stack-and-why)
4. [Libraries](#4-libraries)
5. [Architecture](#5-architecture)
6. [How the app works](#6-how-the-app-works)
7. [Functionality with screenshots](#7-functionality-with-screenshots)
8. [Run it locally](#8-run-it-locally)
9. [Deployment](#9-deployment)
10. [Conclusion](#10-conclusion)

---

## 1. Introduction

Hopin is a full-stack ride-hailing platform built for Kolkata. It has three apps in one codebase:

- **Rider app:** book a bike, auto or cab, see the fare before booking, follow the driver live on a map, chat, pay by cash, wallet, card or UPI, and get a PDF receipt.
- **Driver app:** go online, receive nearby ride requests, navigate to the pickup, start the trip only with the rider's 4-digit code, collect payment and request payouts.
- **Admin console:** a live city map, SOS and route alerts, driver document checks, support tickets, refunds, promotions and payouts.

One rule shaped the whole project: **nothing is simulated.** Every number on screen comes from the database or a live connection. Payments go through Razorpay (test mode), SMS through Twilio, and sign-in through Supabase Auth. If a service is not connected, the app says so instead of pretending.

## 2. Research

Kolkata already has Uber, Ola, Rapido and the state-backed Yatri Sathi, alongside yellow taxis and shared autos. Before building, I listed the problems riders and drivers most often raise about ride apps, and designed a feature against each one:

| Commonly reported problem | What Hopin does about it |
|---|---|
| Fares change after booking, and surge pricing is a black box | The fare is fixed when you book. Surge shows the real numbers behind it ("14 riders, 6 drivers nearby"), and you can ask to be told when it's back to normal. A price lock holds a fare for 7 days. |
| Safety, especially for women travelling at night | SOS texts your emergency contacts with your live location and alerts admins. A trip that leaves the planned road route raises an alert. After a 10 pm–6 am trip Hopin asks "Reached safely?" and alerts contacts if there's no answer. Trip PIN, audio recording, and 112/108 buttons. |
| Drivers lose a large share of each fare to commission | Drivers choose: an 80/20 split, or a daily pass (₹29 bike, ₹49 auto, ₹79 cab) and keep 100% that day. Every receipt shows where the money went. |
| The driver cancels late and the rider is stranded | A late driver cancellation credits the rider automatically, paid by the driver. |
| Monsoon waterlogging makes ETAs meaningless | Riders and drivers report flooded streets from their GPS. Others confirm or clear them, and ETAs add the expected delay. |
| Many riders and most drivers prefer Hindi or Bengali | Full English and Hindi, including SMS and push notifications in each user's language. |
| Chaotic pickups at Howrah, Sealdah and the airport | Fair first-in-line queues for drivers at those stations. |
| Patchy mobile data | An installable PWA with an offline page, skeleton loading, and push notifications that work with the app closed. |

The research also set limits. Ride insurance, ambulance tie-ups and metro ticketing need business partnerships, so Hopin does not fake them. It offers the government 108 ambulance number instead.

## 3. Tech stack and why

| Layer | Choice | Why this and not something else |
|---|---|---|
| Frontend | **React 19 + Vite** | The component model suits three apps that share one design system. Vite builds in seconds and splits every page into its own chunk, so riders on slow phones only download the screen they open. |
| Styling | **Tailwind CSS 4** + own design system (`client/src/ds`) | Utility classes keep styles next to markup. Design tokens give one source for colour, spacing and dark mode, all checked for WCAG AA contrast. |
| Backend | **Node.js + Express 5** | Same language as the frontend. Express 5 handles async errors natively, which keeps route code short. |
| Real-time | **Socket.IO** | Driver location, ride offers and status changes must reach phones instantly. Socket.IO adds reconnection, a room per user (and one for admins), and a fallback when WebSockets are blocked. |
| Database | **PostgreSQL on Supabase** | Rides, wallets and payouts are money: they need transactions, constraints (one active ride per person) and joins, which is why a document database like MongoDB was ruled out. Supabase gives hosted Postgres with Row Level Security, free. |
| Auth | **Supabase Auth** | Email, Google and phone OTP sign-in without storing a single password in Hopin. The server verifies Supabase's signed tokens. |
| Payments | **Razorpay** | Indian cards, UPI and netbanking, with signature-verified checkout, a refunds API and webhooks. |
| SMS | **Twilio** | Phone verification codes and SOS texts, with the real delivery result stored. |
| Maps | **OpenStreetMap + Leaflet**, **OSRM** and **OpenRouteService** routing, **Photon/Nominatim** search | Free and open, with no Google Maps billing account needed. |
| Hosting | **Vercel** (frontend) + **Render** (API) | Both free. Vercel serves the static files from a CDN. Render keeps the WebSocket server running, which Vercel's serverless functions cannot. |

## 4. Libraries

**Frontend (`client/package.json`)**

| Library | What it does in Hopin |
|---|---|
| `react`, `react-dom` | UI |
| `react-router-dom` | Pages and deep links (`/trips/:id`, `/track/:token`) |
| `@supabase/supabase-js` | Sign-in and session refresh |
| `socket.io-client` | Live ride updates and driver location |
| `leaflet`, `react-leaflet` | Maps, routes and markers |
| `framer-motion` | Short (under 250 ms) transitions and the draggable bottom sheet; respects reduced motion |
| `lottie-react` | Small animations (searching, payment done), loaded only when shown |
| `lucide-react` | Every icon |
| `tailwindcss`, `@tailwindcss/vite` | Styling |
| `@fontsource-variable/bricolage-grotesque`, `@fontsource/mukta` | Self-hosted fonts; Mukta covers Devanagari for Hindi |
| `playwright` (dev) | Screenshot harness that drives every screen at phone and desktop sizes |

**Backend (`server/package.json`)**

| Library | What it does in Hopin |
|---|---|
| `express` | REST API (`server/src/routes`) |
| `socket.io` | Real-time hub: presence, dispatch, live location (`server/src/hub.js`) |
| `pg` | PostgreSQL connection pool to Supabase |
| `@electric-sql/pglite` | Postgres in memory for the test suite, so tests never touch real data |
| `jose` | Verifies Supabase's ES256 sign-in tokens |
| `helmet`, `cors`, `express-rate-limit` | Security headers, the allowed origin, per-IP rate limits |
| `pdfkit` | PDF receipts |
| `nodemailer` | Receipt and notification emails over SMTP |
| `web-push` | Push notifications to closed apps (VAPID) |

Razorpay, Twilio, OpenRouteService and OSRM are called over their HTTP APIs directly, without SDKs.

## 5. Architecture

```mermaid
flowchart LR
  subgraph Phone["Rider / Driver / Admin (browser or installed PWA)"]
    UI["React app<br/>pages + design system"]
    SW["Service worker<br/>offline page + push"]
  end

  subgraph Vercel["Vercel CDN"]
    Static["Built frontend<br/>+ security headers"]
  end

  subgraph Render["Render: Node.js"]
    API["Express REST API<br/>auth, rides, payments, safety, admin"]
    Hub["Socket.IO hub<br/>dispatch, live location, status"]
    Jobs["Timers<br/>scheduled rides, safety checks, clean-up"]
  end

  subgraph Supabase
    DB[("PostgreSQL<br/>19 migrations, RLS")]
    Auth["Auth<br/>email, Google, phone OTP"]
    Store["Private storage<br/>driver documents, encrypted audio"]
  end

  Razorpay["Razorpay<br/>cards, UPI, refunds"]
  Twilio["Twilio<br/>OTP + SOS SMS"]
  Maps["OpenStreetMap tiles<br/>OSRM / ORS routing<br/>Photon search"]

  UI -- "loads app" --> Static
  UI -- "HTTPS /api" --> API
  UI <-- "WebSocket" --> Hub
  UI -- "sign in" --> Auth
  UI -- "map tiles" --> Maps
  API --> DB
  Hub --> DB
  Jobs --> DB
  API -- "verify token" --> Auth
  API --> Store
  API <--> Razorpay
  API --> Twilio
  API --> Maps
  API -- "Web Push" --> SW
```

**How a request is protected:**
1. Every API call carries the Supabase access token.
2. The server verifies its signature with `jose`.
3. It loads the Hopin profile and role.
4. The route checks the role and ownership; for example, a rider can only see their own rides.
5. All SQL is parameterised.

Rate limits sit in front of sign-in, booking and search.

**Data model highlights** (`server/migrations`):
- `users`
- `rides`: one active ride per rider and per driver, enforced by the database
- `wallet_txns`: every balance equals its history
- payments: `payment_orders`, `refunds`
- safety: `sos_alerts`, `route_deviations`, `safety_checks`
- also `driver_documents`, `support_tickets`, `ride_messages`, `trip_recordings`, `waterlog_reports`, `payouts`

## 6. How the app works

### A ride from start to finish

```mermaid
sequenceDiagram
  autonumber
  actor R as Rider
  participant S as Hopin server
  actor D as Driver
  participant P as Razorpay

  R->>S: Pickup + drop (searched on OpenStreetMap)
  S-->>R: Road route + fares for bike, auto, cab
  R->>S: Book cab
  S->>D: Offer to nearby online, verified drivers (Socket.IO)
  D->>S: Accept
  S-->>R: Driver, vehicle, plate, ETA, 4-digit start code
  loop every few seconds
    D->>S: GPS position
    S-->>R: Driver moves on the map
  end
  D->>S: Arrived
  R-->>D: Says the start code
  D->>S: Start trip with code
  Note over S: Watches the route. 500 m off for 30 s<br/>opens an alert for rider and admins
  D->>S: Complete trip
  alt Cash
    D->>S: Collected cash
  else Card / UPI / Wallet
    R->>P: Pay in Razorpay Checkout
    P-->>S: Signed payment, confirmed with Razorpay
  end
  S-->>R: Receipt (PDF + email), rate the driver
  S-->>D: Earnings credited to driver wallet
```

### The three apps, in plain words

1. **Sign in** with email, Google or mobile number (OTP). New users pick rider or driver and choose a language.
2. **Rider:**
   1. Type where you're going and compare bike, auto and cab fares.
   2. Book, then watch the driver arrive.
   3. Give the driver the start code.
   4. Ride with SOS, trip sharing and chat at hand.
   5. Pay, then rate the driver.
3. **Driver:**
   1. Upload licence, RC, insurance and photo; an admin approves them.
   2. Go online (this needs real GPS) and accept an offer.
   3. Pick up the rider and start the trip with their code.
   4. Drop them off, then collect or confirm payment.
   5. Withdraw earnings by UPI or bank transfer.
4. **Admin:** watch the live map and answer SOS and route alerts first. Then review documents and helmet selfies, handle tickets and refunds, and set rental packages, promos and payouts.
5. **Family and sharing:** anyone with a ride's share link can follow it live without an account, and family members who opt in see each other's trips.

## 7. Functionality with screenshots

> Screenshots are taken by `client/scripts/shots.mjs`, which drives the real app with sample Kolkata data so no real rider's details appear.

### Sign in and onboarding

| Onboarding | Sign in | Desktop sign in |
|---|---|---|
| <img src="docs/screenshots/auth-1-onboarding.webp" width="230" alt="Onboarding slide with a yellow taxi" /> | <img src="docs/screenshots/auth-3-login.webp" width="230" alt="Sign-in screen with Google, mobile and email" /> | <img src="docs/screenshots/auth-3-login-desktop.webp" width="420" alt="Desktop sign-in with Kolkata taxi video" /> |

New users see three short slides on their first visit, then sign in with email, Google or a mobile OTP. The background is a real clip of Kolkata's yellow taxis, and it switches to a still image on slow connections.

### Booking a ride (rider)

| Where to? | Choose a ride | Finding a driver |
|---|---|---|
| <img src="docs/screenshots/rider-1-home.webp" width="230" alt="Home screen asking where to" /> | <img src="docs/screenshots/rider-2-choose.webp" width="230" alt="Bike, auto and cab fares" /> | <img src="docs/screenshots/rider-3-searching.webp" width="230" alt="Searching for a cab" /> |

Search uses OpenStreetMap. Fares come from the real road distance and time and are shown before booking. Riders can also book a rental or a parcel delivery, and save places like Home and Work.

### The trip

| Driver on the way | Driver arrived | On the trip |
|---|---|---|
| <img src="docs/screenshots/rider-4-assigned.webp" width="230" alt="Driver arriving in 4 minutes with start code" /> | <img src="docs/screenshots/rider-5-arrived.webp" width="230" alt="Driver is here" /> | <img src="docs/screenshots/rider-6-ontrip.webp" width="230" alt="4 minutes to destination with SOS" /> |

The rider sees the driver's name, rating, car and plate, and a 4-digit **start code**. The trip can't begin until the driver enters that code, which stops riders getting into the wrong car. SOS is always one tap away during the trip.

### Paying, rating and receipts

| Pay | Rate | Receipt |
|---|---|---|
| <img src="docs/screenshots/rider-9-payment-due.webp" width="230" alt="Pay with wallet, UPI or card" /> | <img src="docs/screenshots/rider-7-rate.webp" width="230" alt="Rate your trip" /> | <img src="docs/screenshots/rider-13-receipt.webp" width="230" alt="Trip receipt with fare breakdown" /> |

Card and UPI payments go through Razorpay Checkout. The server checks the payment signature and asks Razorpay to confirm before marking anything paid. Receipts show exactly how much went to the driver and how much to Hopin.

### Safety, help and family

| Live share link | Help and SOS | Family |
|---|---|---|
| <img src="docs/screenshots/rider-17-track.webp" width="230" alt="Public live tracking page" /> | <img src="docs/screenshots/rider-15-help.webp" width="230" alt="Help with 112 police and 108 ambulance" /> | <img src="docs/screenshots/rider-16-family.webp" width="230" alt="Family trip sharing" /> |

### Driver app

| Offline | Ride requests | Start with OTP |
|---|---|---|
| <img src="docs/screenshots/driver-1-offline.webp" width="230" alt="Driver offline with earnings" /> | <img src="docs/screenshots/driver-2-offers.webp" width="230" alt="Incoming ride request for ₹184" /> | <img src="docs/screenshots/driver-4-otp.webp" width="230" alt="Driver enters the rider's code" /> |

| On the trip | Collect cash | Documents |
|---|---|---|
| <img src="docs/screenshots/driver-5-ontrip.webp" width="230" alt="Driver dropping at Technopolis" /> | <img src="docs/screenshots/driver-6-cash.webp" width="230" alt="I collected ₹184 cash" /> | <img src="docs/screenshots/driver-8-documents.webp" width="230" alt="Licence, RC and insurance review status" /> |

Drivers can only go online after an admin approves their licence, RC, insurance and photo, and only with a real GPS position. There is no manual or fake location.

### Hindi

| Choose a ride (हिन्दी) | Driver (हिन्दी) |
|---|---|
| <img src="docs/screenshots/hindi-2-choose.webp" width="230" alt="Choose a ride in Hindi" /> | <img src="docs/screenshots/hindi-5-driver.webp" width="230" alt="Driver screen in Hindi" /> |

### Admin console

<img src="docs/screenshots/admin-1-safety-desktop.webp" width="900" alt="Admin: alerts, live stats, live map of drivers and rides, things needing a person" />

<img src="docs/screenshots/admin-2-insights-desktop.webp" width="900" alt="Admin: completed trips over 7 days, vehicle mix, recent activity, SOS alerts" />

- **Live map:** every online driver and every ride in progress.
- **Needs a person:** open SOS alerts, route alerts, riders not home after a night trip, helmet selfies and tickets.
- **Below that:** completed trips for the last 7 days, the vehicle mix and recent activity.

All of it comes from the database and refreshes every 20 seconds.

### Desktop and dark mode

| Trips | Dark mode on a trip |
|---|---|
| <img src="docs/screenshots/rider-12-trips-desktop.webp" width="440" alt="Trips page on desktop" /> | <img src="docs/screenshots/rider-6-ontrip-desktop-dark.webp" width="440" alt="On-trip screen in dark mode" /> |

## 8. Run it locally

You need Node.js 22+ and a free Supabase project. Copy `server/.env.example` to `server/.env` and fill it in.

```bash
npm run setup          # install server + client
npm run create-admin   # create your admin account
npm run dev:api        # API + WebSockets on http://localhost:8720
npm run dev:web        # app on http://localhost:5190
npm test               # 45 end-to-end tests on an in-memory database
```

The tests cover sign-up, booking, dispatch, the start code, completion, payments, refunds, SOS, route alerts, admin access and more. They run against a throwaway in-memory Postgres.

## 9. Deployment

The frontend runs on Vercel (`client/vercel.json`) and the API on Render (`render.yaml`); the database and auth stay on Supabase. [DEPLOY.md](DEPLOY.md) has the step-by-step guide.

## 10. Conclusion

Hopin shows that a ride-hailing app can be built end to end with free and open tools and still be real. It has actual sign-in, actual payments (in test mode), actual SMS, and live maps. Its database enforces the rules that matter, like one active ride at a time and wallets that always add up.

**What I learned:**
- Real-time systems are mostly about the unhappy paths: no drivers, a lost connection, GPS off, a payment half done.
- Money must live in one ledger with database constraints.
- Safety features only help if they work without the rider having to do anything.

**What's next:**
- An always-on server, so night-ride safety checks never wait for the free tier to wake up.
- Bengali as a third language.
- An own routing server, so routes can avoid flooded streets instead of only adding the delay.
- Partnerships that code can't replace: ride insurance and an ambulance tie-up.

More detail: [technical reference](docs/TECHNICAL.md) · [build plan](HOPIN_PLAN.md) · [feature overview](HOPIN_OVERVIEW.md) · [media credits](client/public/media/CREDITS.md)
