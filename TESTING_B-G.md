# Hopin: testing checklist for batches B–G

Tick each box as you go (`[ ]` → `[x]`). If something looks wrong, note the step number and what you saw.

## 0. Setup (once)

- [ ] App is running: web at http://localhost:5190, API on port 8720.
- [ ] **Three separate browser sessions** (each one keeps its own login):
  - **Rider:** normal Chrome window
  - **Driver:** Chrome Incognito window (Ctrl+Shift+N)
  - **Admin:** a second Chrome profile, or sign out and sign back in when needed
- [ ] **Fake GPS in the rider and driver windows:** F12 → ⋮ → More tools → **Sensors** → Location → enter lat/lng.
  - Park Street (pickup): `22.5535, 88.3525`
  - Driver nearby: `22.5550, 88.3500`
- [ ] Driver: documents approved (Admin → Driver review). If it's a bike, today's helmet selfie is approved too.
- [ ] Rider wallet has some money: Profile → Add money → in Razorpay choose **Netbanking** → any bank → click **Success** (test mode, no real money). Do not use 4111 1111 1111 1111: Razorpay treats it as an international card and refuses it.

**Basic ride loop, used many times below:**
1. Driver: **Go online**.
2. Rider: book.
3. Driver: **Accept** → **I have arrived at pickup** → enter the rider's OTP → **Start trip**.
4. Driver: complete the trip.

---

## B. Fair money

- [ ] **B1 Fare breakdown:** finish a ride, then go to Trips → open it. "Where the money went" shows the driver's share and Hopin's share. The PDF receipt (⬇ Download PDF receipt) shows the same.
- [ ] **B2 Tip:** on that completed trip (rider) → **Tip (100% to the driver)** → ₹20 → pay from wallet. The driver's wallet balance on the Drive page goes up by ₹20.
- [ ] **B3 Split:** on a completed trip (rider) → **Split this fare** → enter the phone number of a second rider account.
  - The second rider sees the request in Trips → **Pay from wallet** / **Decline**.
  - Paying credits the first rider.
- [ ] **B4 Cash commission:** a cash ride. After it completes, the Drive page shows the wallet dropping by Hopin's 20% (it can go below ₹0: "You owe Hopin ₹…").
- [ ] **B5 Late driver cancel:** driver accepts, waits more than 2 min, then **Cancel ride**. The rider gets a credit in the wallet, taken from the driver's wallet.
- [ ] **B6 Detour dispute:** during a trip, move the driver's fake GPS well off the route and leave it there (a route alert appears), then complete much later than planned. A fare dispute ticket appears in Help.
- [ ] **B7 Open surge:** the quote shows demand ("X riders, Y drivers nearby") when there's surge. **🔔 Tell me when prices are normal** → a notification arrives when the surge ends (hard to trigger alone; needs several waiting riders).

## C. Ways to book

- [ ] **C1 Book for someone else:** Book → "Who's riding?" → **Someone else**, with name + phone. The driver sees that passenger's name; the passenger gets an SMS.
- [ ] **C2 Rental:** Book → **⏱ Rental** → pick a package (Puja specials appear in season).
  - Book it; the driver accepts and starts.
  - Drive a few km with fake GPS, then complete.
  - The receipt shows the package plus any extra km/min.
- [ ] **C3 Parcel:** Book → **📦 Parcel** → item, size and receiver's name and phone. The receiver gets an SMS with a delivery code.
  - The driver must enter it at the drop (**Receiver's 4-digit delivery code** → **Delivered**).
  - A wrong code is refused.
- [ ] **C4 Accessibility:** Book → **Accessibility needs** → tick one (e.g. ♿ wheelchair = Cab only). The driver sees "Rider needs: …" on the offer.
- [ ] **C5 Family:** rider → /family → **Invite** another rider's phone. They **Accept** in their /family.
  - Turn on **Share my live trips with family** for the traveller.
  - While they're on a trip, the other sees **Follow live ↗**.
- [ ] **C6 Price lock:** Book a direct trip (no stops) → under the prices, **Lock from wallet** (₹49, 7 days).
  - Quote the same trip again: it shows the locked price.
  - If the normal fare is higher, you pay the locked one.

## D. Drivers

- [ ] **D1 Daily pass:** driver → Drive page → pass card → buy (wallet or **Pay online**). Rides accepted today pay 100% to the driver; check the fare breakdown on a completed trip.
- [ ] **D2 Heading home:** Profile → **🏠 Set your home for "Heading home"** → **Use where I am now** → **Save home**.
  - Drive page → **Heading home** on: only rides toward home are offered.
  - Max twice a day.
- [ ] **D3 Station queue:** set the driver's fake GPS to Howrah `22.5839, 88.3424` and go online. The Drive page shows the queue position.
  - A rider booking from Howrah station is offered to the first driver in the queue for 45 s.
  - Declining passes it on.
- [ ] **D4 Fatigue / rested badge:** a 30-min break after 10 h of driving. Not practical to test by hand (needs 10 h online); covered by the automated test.
- [ ] **D5 Deaf driver:** Profile (driver) → **I am deaf or hard of hearing**. The rider sees this on the ride.

## E. Growth

- [ ] **E1 Referral:** rider A → Profile → "Refer & earn" → **Copy** the code.
  - A new rider B → Profile → enter it → **Use code**.
  - After B's first *paid* trip, both get ₹50 in their wallets.
- [ ] **E2 Driver referral:** ₹200 after the referred driver's 20th trip. Covered by the automated test; too many trips for a manual test.
- [ ] **E3 Loyalty:** Profile → "Hopin Rewards". Points go up after a paid trip (1 point per ₹10); redeem 100 points = ₹10 into the wallet.
- [ ] **E4 Corporate:** an admin creates a company (Admin → Companies) with a rider as company admin. That rider → Profile → **Manage company →**:
  - **Top up** the company wallet (Razorpay test mode: Netbanking → any bank → Success);
  - **Invite** another rider and set a monthly **Limit**.
  - The employee books with "business" on: paid from the company wallet.
  - Download the CSV.
  - A refund on a business ride goes back to the company wallet.

## F. Trip recording (audio)

- [ ] **F1 Record:** start a ride. Rider → **🎙 Record** → allow the microphone. The driver's screen shows "Your rider is recording audio of this trip".
- [ ] **F2 Speak** for 1–2 minutes, then **Stop** (or complete the trip; it stops by itself).
- [ ] **F3 Report:** rider → Trips → that trip → "Your trip recordings" → **Send to Hopin safety** → write what happened → Send.
  - A safety ticket appears in Help.
  - **Delete** is no longer offered.
- [ ] **F4 Admin playback:** Admin → "Trip recordings" → **▶ Play**. You hear your own voice, and "played 1×" shows.
- [ ] **F5 Delete:** record again and don't report it. Trips → **Delete** removes it. Unreported recordings would delete themselves after 7 days.
- [ ] **F6** Repeat F1 from the driver side.

## G. Monsoon waterlogging

- [ ] **G1 Report:** rider or driver → map → **🌊 Report waterlogging** → wait for "Location found" → choose a depth → **Report**. A blue circle appears on the map.
  - Use a fake GPS point on your planned route.
  - Windows Wi-Fi location is often vaguer than 200 m, so use the Sensors override.
- [ ] **G2 Merge:** report again within 150 m from the other account. The toast says it confirmed the existing spot (no second circle).
- [ ] **G3 Quote:** quote a trip whose route passes the spot. The note says "1 waterlogged spot reported on this route… about N extra min", trip times go up, and **the fare stays the same**.
- [ ] **G4 Live ETA:** during that trip, the rider sees "includes about N min for waterlogging reported ahead". Once the driver's GPS passes the spot, it disappears.
- [ ] **G5 Clear:** tap the circle → **Cleared**. The reporter's own "Cleared" removes it at once; anyone else needs a second person.
- [ ] **G6 Admin:** Admin → "Waterlogging reports" → **Remove** a spot; it disappears from the map within a minute.

---

**Found a problem?** Note the step number (e.g. "C3"), what you did, and what you saw. A screenshot helps.
