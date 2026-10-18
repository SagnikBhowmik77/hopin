# Deploying Hopin (free tiers)

| Part | Host | Why |
|---|---|---|
| Frontend (React build) | Vercel | static files + headers from `client/vercel.json` |
| API + Socket.IO | Render (free web service) | keeps WebSockets open; config in `render.yaml` |
| Database, sign-in, storage | Supabase (already live) | nothing to move |

**Free-tier limit:** Render's free service sleeps after 15 minutes with no traffic and takes about
50 seconds to wake. While it sleeps, timed jobs (the "reached safely?" night-ride check, scheduled
ride offers, recording clean-up) wait until the next request wakes it. Fine for a demo; for real
riders move the API to an always-on host before launch.

## 1. API on Render

1. Render dashboard → **New → Blueprint** → pick the GitHub repo. It reads `render.yaml`.
2. Fill every variable it asks for with the values from `server/.env`, except:
   - `APP_URL`: the Vercel URL from step 2 (put a placeholder now, fix it after step 2).
   - Do **not** copy `PORT`; Render sets it.
3. Deploy. Check `https://<service>.onrender.com/api/health` returns `{"ok":true}`.

## 2. Frontend on Vercel

1. Vercel → **Add New → Project** → same repo → **Root Directory: `client`** (framework: Vite).
2. Environment variable `VITE_API_URL` = `https://<service>.onrender.com` (no trailing slash).
3. Deploy, then copy the production URL (e.g. `https://hopin.vercel.app`).

## 3. Connect them

1. Render → hopin-api → Environment → set `APP_URL` to the Vercel URL → save (it redeploys).
   CORS, Socket.IO, share links and email links all use it.
2. Supabase → Authentication → URL Configuration: set **Site URL** to the Vercel URL and add
   `https://<vercel-url>/**` to **Redirect URLs** (Google and email sign-in return there).
3. Razorpay dashboard (test mode) → Webhooks: URL
   `https://<service>.onrender.com/api/payments/razorpay/webhook`, events `payment.captured`,
   `order.paid`, `refund.processed`, `refund.failed`; put its secret in `RAZORPAY_WEBHOOK_SECRET` on Render.

## 4. Check

- `cd client && npm run build && node scripts/csp-check.mjs /login` checks the security headers locally.
- Open the Vercel URL on a phone: sign in, book, accept as a driver in another browser,
  pay with a Razorpay test card, finish the ride.
- Rotate any key that was ever pasted into a chat before real riders use it.
