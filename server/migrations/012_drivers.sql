-- 012: drivers (step 8b, batch D): daily pass (100% earnings), heading home, fatigue limits, station queues.

-- Business settings an admin can change.
CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
-- Daily pass prices agreed 2026-10-12.
INSERT INTO settings (key, value) VALUES ('driver_pass_prices', '{"bike": 29, "auto": 49, "car": 79}') ON CONFLICT (key) DO NOTHING;

-- One row per driver per India day: the pass (if bought) and heading-home uses.
CREATE TABLE IF NOT EXISTS driver_days (
  driver_id      uuid NOT NULL REFERENCES users(id),
  day            date NOT NULL,
  pass_price     integer,
  pass_ref       text UNIQUE,
  pass_bought_at timestamptz,
  home_uses      integer NOT NULL DEFAULT 0 CHECK (home_uses >= 0),
  PRIMARY KEY (driver_id, day)
);
ALTER TABLE driver_days ENABLE ROW LEVEL SECURITY;

-- Rides accepted on a pass day pay the driver 100%.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS commission_free boolean NOT NULL DEFAULT false;

-- Where "heading home" heads to.
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_place jsonb;

-- Online sessions, for the fatigue rule. last_seen_at is refreshed while online, so a
-- session cut short by a server restart is closed at the last moment it was known to be live.
CREATE TABLE IF NOT EXISTS driver_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id     uuid NOT NULL REFERENCES users(id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS driver_sessions_one_open ON driver_sessions (driver_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS driver_sessions_recent ON driver_sessions (driver_id, started_at DESC);
ALTER TABLE driver_sessions ENABLE ROW LEVEL SECURITY;

-- Pickup points with a first-come driver queue.
CREATE TABLE IF NOT EXISTS stations (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL UNIQUE,
  lat       double precision NOT NULL,
  lng       double precision NOT NULL,
  radius_m  integer NOT NULL CHECK (radius_m BETWEEN 100 AND 3000),
  active    boolean NOT NULL DEFAULT true
);
ALTER TABLE stations ENABLE ROW LEVEL SECURITY;
INSERT INTO stations (name, lat, lng, radius_m) VALUES
  ('Howrah Station', 22.5839, 88.3424, 400),
  ('Sealdah Station', 22.5678, 88.3708, 400),
  ('Kolkata Airport', 22.6520, 88.4463, 1000)
ON CONFLICT (name) DO NOTHING;

ALTER TABLE wallet_txns DROP CONSTRAINT IF EXISTS wallet_txns_kind_check;
ALTER TABLE wallet_txns ADD CONSTRAINT wallet_txns_kind_check CHECK (kind IN (
  'topup', 'ride', 'earning', 'refund', 'earning_adjustment',
  'cash_earning', 'commission', 'tip', 'split', 'cancel_credit', 'cancel_penalty', 'price_lock', 'driver_pass'));

ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_kind_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_kind_check CHECK (kind IN ('ride', 'topup', 'tip', 'split', 'price_lock', 'driver_pass'));
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_check
  CHECK ((kind IN ('topup', 'price_lock', 'driver_pass')) = (ride_id IS NULL) AND (kind = 'split') = (split_id IS NOT NULL));
