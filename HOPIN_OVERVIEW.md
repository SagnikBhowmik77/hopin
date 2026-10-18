# Hopin: what's built and what's simulated

> **Snapshot from before step 0.** Since then the app has been renamed to Hopin and every simulated item in section 3 has been removed: card/UPI and top-ups now refuse with a message, the email button only appears when email is connected, "Simulate driving" and the demo accounts are gone. See README.md for the current state.

Hopin is a full-stack ride-hailing app built from the "Cab Booking App" PDF and the project spec. **Riders** book bikes, autos and cabs. **Drivers** accept requests and drive. **Admins** watch safety alerts, support tickets and promo codes. Everyone sees the trip update live.

---

## 1. Tech stack

| Layer | Used | Spec asked for | Notes |
| --- | --- | --- | --- |
| Frontend | React 19 + Vite | Next.js / React | React is one of the allowed options |
| Styling | Tailwind CSS 4 | Tailwind CSS | Mobile responsive, dark mode follows the OS |
| Backend | Node.js + Express 5 | Express + Node | REST API |
| Real-time | Socket.IO (WebSockets) | WebSockets / Firebase | Live ride status, driver location, notifications |
| Database | PostgreSQL | Supabase / Firebase / PostgreSQL | Runs locally with embedded Postgres (PGlite); set `DATABASE_URL` to switch to Supabase. **No MongoDB.** |
| Auth | Own JWT + bcrypt, role-based | Clerk / Supabase / Appwrite | See "Not built" below |
| Payments | Stripe Checkout (+ webhook) | Stripe | Simulated until a Stripe key is added |
| Maps | Leaflet + OpenStreetMap, OSRM routing, Photon/Nominatim search | Google Maps | Free, no API key (Google Maps needs billing) |
| PDF receipts | pdfkit | Downloadable receipts | Real |
| Email | Nodemailer (SMTP) | Email receipts | Saved to a file until SMTP is configured |

---

## 2. What's built, by use case

### 1. Registration & authentication
- Sign up as a **rider** or **driver**. Fields: name, email, Indian mobile number, password of 8+ characters. Drivers also add their vehicle type, model and number plate.
- Log in with **email or mobile number** + password.
- Passwords are hashed with bcrypt. Login gives a JWT that lasts 7 days.
- Every API route checks the user's role. Admin accounts can only be created by the seed script, never through sign-up.

### 2. Profile management
- Edit name and phone, upload a profile photo (resized in the browser to 256 px), change password.
- Drivers edit their vehicle.
- Riders manage payment methods:
  - set a default (Cash / UPI / Card / Wallet);
  - add or remove saved UPI IDs;
  - see the wallet balance with top-ups and transaction history.
- Up to 3 **emergency contacts**, used by SOS.

### 3. Booking a ride
- Search an address as you type, tap the map, or use "◎ Me" (browser location).
- Pick a vehicle (Bike / Auto / Cab), apply a promo code, choose a payment method, book.
- The request goes **live to nearby online drivers** with the matching vehicle, within 15 km.
- When a driver accepts, the rider sees the driver's name, photo, rating, vehicle and plate, the **pickup ETA** and a **4-digit OTP**.
- Unanswered requests auto-cancel after 2 minutes and the rider is told.

### 4. Real-time tracking
- The driver's position streams to the rider's map about once a second.
- The ETA updates live, based on the route's average speed.
- Notifications: driver assigned, **driver arriving (within 300 m)**, driver arrived, ride started, trip completed, payment received.
- The trip can't start until the driver enters the rider's OTP. A wrong OTP is rejected.

### 5. Fare estimation
- Fares are shown upfront for all three vehicle types.
- Fare = base + per-km + per-minute, using real road distance and time from OSRM, with a minimum fare per vehicle.
- **Demand surge:** when riders already waiting outnumber free drivers within 3 km, the fare rises by +0.2× per extra waiting rider, up to 2×. It shows as a "⚡ high demand" badge.
- ₹10 for each extra stop.
- The server always recalculates the fare. A price sent from the browser is ignored.

### 6. Payments
- **Cash:** the driver taps "I collected ₹X cash".
- **Wallet:** debited automatically when the trip ends, if the balance is enough. Booking is refused up front if it isn't.
- **Card:** through Stripe Checkout (simulated without a key, see section 3).
- **UPI:** simulated (see section 3).
- Drivers are credited **80%** of every paid fare. Earnings show as today / this week / total.

### 7. Ride history & receipts
- Trip list for riders and drivers, filterable: all, completed, cancelled, payment due.
- Trip detail: route map, fare breakdown (base, surge, stops, promo, total), payment status and reference.
- **PDF receipt download.**
- **Email receipt.** Delivered only if SMTP is set up (see section 3).
- "Report an issue with this trip" opens a support ticket linked to that trip.

### 8. Cancelling a ride
- Free while searching, and for 2 minutes after a driver accepts.
- After that, or once the driver has arrived, a fee applies: **₹15 bike, ₹25 auto, ₹40 cab**.
- The rider sees the fee **before** confirming and picks a reason.
- Drivers can cancel too, and the rider is notified.

### 9. Ratings & reviews
- After the trip: 1–5 stars, quick tags ("Polite", "Safe driving", "Rash driving"…) and an optional comment.
- One review per trip. The driver's average rating updates in a single database step, so two reviews at once can't clash.
- A driver profile sheet shows rating, trip count, most-mentioned tags and recent reviews.

### 10. Multi-stop rides
- Up to **3 extra stops**.
- The route runs through every stop in order and the fare includes them.
- The driver's "Navigate" button opens Google Maps directions with all the stops. It's a plain link, no API key needed.

### 11. Promo codes
- Percent or flat discount, with optional max discount, minimum fare, first-ride-only, total uses, uses per rider, and expiry date.
- Checked on the server when quoting and again when booking.
- Admins create and enable/disable codes.
- Seeded codes: `WELCOME50`, `RAAHI20`, `WEEKEND15`.

### 12. Emergency SOS
- Available during an accepted or ongoing ride.
- Pressing SOS:
  - saves the alert and pushes it **live to the admin dashboard**;
  - gives one-tap buttons to **call 112** and to **text a live-tracking link** to emergency contacts.
- **Share trip:** a public `/track/<link>` page shows the live car position, with no login. The link stops working an hour after the trip ends.

### 13. Help center & support
- FAQ, plus tickets by category (payment, lost item, driver, safety, app, other), optionally tied to a trip.
- Threaded chat with support. Admin replies notify the user.
- The admin dashboard has the ticket inbox, status changes, the SOS queue, live stats (riders, drivers, online now, live rides, trips today, money collected today) and promo management.

### Driver dashboard (spec feature)
- Online/offline toggle and a live request feed with a chime.
- Accept / decline. If two drivers accept at once, **only one wins**.
- Position comes from GPS or a tap on the map.
- Arrive → OTP → start → complete → collect cash.

### Quality
- **9 automated end-to-end tests** against a real (in-memory) Postgres. They cover:
  - sign-up rules;
  - quotes, stops and promos;
  - the full trip, including two drivers racing to accept;
  - wallet;
  - cancellation fee;
  - surge;
  - request expiry;
  - SOS, share link and tickets;
  - access control.
- Also checked by hand in the browser: rider, driver and admin tabs running together, and the phone layout.

---

## 3. What is simulated or not fully real

### Simulated: these look real in the app but no money or message moves

| Feature | What happens now | What makes it real |
| --- | --- | --- |
| **Card payments** | No Stripe key, so paying by card records a **test payment** with a reference like `CARD-SIM-…`. The app and the PDF say "test payment, no money moved". | Add a free Stripe **test-mode** key as `STRIPE_SECRET_KEY` in `server/.env`. Cards then go through real Stripe Checkout. For live money you'd need a real Stripe account. |
| **Wallet top-ups** | Same: without Stripe the balance just increases, labelled as a simulated test credit. | Same Stripe key. |
| **UPI payments** | **Always simulated** (`UPI-SIM-…`), even with Stripe, because Stripe doesn't offer UPI in India. | An Indian payment gateway such as Razorpay or Cashfree. Not built. |
| **Email receipts** | No mail server, so the email is written to `server/.data/outbox/*.eml` and the app says **"not sent"**. | Add SMTP settings (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`) — e.g. a Gmail app password. |
| **Stripe webhook** | The code is there but inactive. Payments are confirmed when Stripe redirects back instead. | Set `STRIPE_WEBHOOK_SECRET` (from `stripe listen` or the Stripe dashboard). |
| **Driver payouts** | Earnings are tracked in the app's wallet ledger only. Nothing goes to a bank. | Something like Stripe Connect or RazorpayX. Not built. |
| **Driver movement in testing** | The "Simulate driving along the route" checkbox moves the car along the route automatically, so you can test on one computer. | Real drivers just use GPS. The checkbox is a test helper. |
| **Test accounts and data** | `npm run seed` creates local test logins (password `raahi1234`) and the 3 promo codes. The login page shows quick-login buttons in dev mode only. | Delete or change these before deploying. |

### Real but limited

| Feature | Limitation |
| --- | --- |
| **SOS** | The admin alert is real. Calling 112 and texting contacts use your phone's own dialer and SMS app (`tel:`/`sms:` links), so **you still press send**. Nothing auto-sends SMS and no emergency service is contacted automatically (that needs a paid SMS gateway like Twilio). |
| **Cash payments** | The driver self-reports that cash was collected. There is no independent check. |
| **Maps, routing, search** | Use free public servers (OpenStreetMap tiles, OSRM demo, Photon/Nominatim). Fine for a demo, but rate-limited and not for real traffic. Photon was down on your network, so search falls back to Nominatim (max 1 request per second). For production, self-host or use a paid provider. |
| **Live ETA** | Estimated from straight-line distance × 1.35 at the route's average speed, not recalculated by the routing server every second. |
| **Profile photos** | Stored inside the database as small images, not in cloud storage like Supabase Storage. |
| **Driver presence** | Who is online and where is kept in server memory. After a server restart drivers go online again, which the app does automatically. |
| **Database** | Local embedded Postgres by default. Supabase works by setting `DATABASE_URL`, but **hasn't been tested against a real Supabase project**. |

### Not built

- **Clerk / social login** (Google, etc.): needs an account with Clerk or a Supabase Auth project.
- **Phone OTP login** and **email verification**: need a paid SMS service or a configured mail server.
- **Refunds**, **in-app chat between rider and driver**, **scheduled rides**.
- **Deployment and CI/CD** (Vercel and so on): the app runs locally only.
- **Saved cards**: cards are entered on Stripe's page each time. Hopin never sees or stores card numbers, by design.
- **Next.js**: the frontend is React + Vite instead (the spec allows either).

---

## 4. How to run

```bash
npm run setup      # install everything + create test accounts
npm run dev:api    # API on http://localhost:8720
npm run dev:web    # app on http://localhost:5190
npm test           # 9 end-to-end tests
```

Open two browser tabs, since each tab has its own login. Use one as the **Rider** and one as the **Cab driver**. In the driver tab go online, then book from the rider tab.

Optional settings are listed in `server/.env.example`.
