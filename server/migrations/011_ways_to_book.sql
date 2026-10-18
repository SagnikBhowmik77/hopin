-- 011: ways to book (step 8b, batch C): booking for someone else, hourly rentals (incl. Puja
-- packages and road closures), parcel delivery, accessibility, family profiles, price lock.

-- What kind of booking a ride is.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'trip';
ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_kind_check;
ALTER TABLE rides ADD CONSTRAINT rides_kind_check CHECK (kind IN ('trip', 'rental', 'parcel'));

-- Booked for someone else: who actually rides. Their number is only used to text them the trip.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS passenger_name text;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS passenger_phone text;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS passenger_sms jsonb;

-- Rentals: the package as booked, and the distance measured from the driver's GPS during the trip.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS rental jsonb;            -- { packageId, name, hours, km, price, extraKmRate, extraMinRate }
ALTER TABLE rides ADD COLUMN IF NOT EXISTS actual_km numeric(8, 2);
ALTER TABLE rides ADD COLUMN IF NOT EXISTS rental_extra integer NOT NULL DEFAULT 0;

-- Parcels: the receiver, what it is, and the code the receiver gives the driver at delivery.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS parcel jsonb;            -- { receiverName, receiverPhone, item, size }
ALTER TABLE rides ADD COLUMN IF NOT EXISTS delivery_otp text;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS delivery_sms jsonb;

-- Accessibility requests made at booking.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS accessibility text[] NOT NULL DEFAULT '{}';
ALTER TABLE rides ADD COLUMN IF NOT EXISTS price_lock_id uuid;
-- How much the price lock saved on this ride (fare = normal price - lock_saving).
ALTER TABLE rides ADD COLUMN IF NOT EXISTS lock_saving integer NOT NULL DEFAULT 0;

-- Drivers can tell riders they are deaf or hard of hearing; riders choose to share live trips with family.
ALTER TABLE users ADD COLUMN IF NOT EXISTS driver_deaf boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS share_trips_with_family boolean NOT NULL DEFAULT false;

-- Rental packages. Admins edit them and add seasonal (Puja) packages with dates.
CREATE TABLE IF NOT EXISTS rental_packages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  vehicle_type    text NOT NULL CHECK (vehicle_type IN ('auto', 'car')),
  hours           integer NOT NULL CHECK (hours BETWEEN 1 AND 12),
  km              integer NOT NULL CHECK (km BETWEEN 1 AND 300),
  price           integer NOT NULL CHECK (price > 0),
  extra_km_rate   numeric(6, 2) NOT NULL CHECK (extra_km_rate >= 0),
  extra_min_rate  numeric(6, 2) NOT NULL CHECK (extra_min_rate >= 0),
  seasonal        boolean NOT NULL DEFAULT false,   -- e.g. Durga Puja pandal hopping
  available_from  date,
  available_to    date,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT seasonal OR (available_from IS NOT NULL AND available_to IS NOT NULL AND available_from <= available_to))
);
ALTER TABLE rental_packages ENABLE ROW LEVEL SECURITY;

-- Standard packages, priced from the vehicle rates minus 10% (agreed 2026-10-12). Business settings, editable in admin.
INSERT INTO rental_packages (name, vehicle_type, hours, km, price, extra_km_rate, extra_min_rate)
SELECT v.* FROM (VALUES
  ('1 hour · 10 km', 'auto', 1, 10, 209, 11.0, 1.5),
  ('2 hours · 20 km', 'auto', 2, 20, 389, 11.0, 1.5),
  ('4 hours · 40 km', 'auto', 4, 40, 749, 11.0, 1.5),
  ('1 hour · 10 km', 'car', 1, 10, 289, 15.0, 2.0),
  ('2 hours · 20 km', 'car', 2, 20, 529, 15.0, 2.0),
  ('4 hours · 40 km', 'car', 4, 40, 1019, 15.0, 2.0)
) AS v(name, vehicle_type, hours, km, price, extra_km_rate, extra_min_rate)
WHERE NOT EXISTS (SELECT 1 FROM rental_packages);

-- Road closures entered by admins from police notices (e.g. Puja no-entry zones).
CREATE TABLE IF NOT EXISTS road_closures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  note        text,
  source      text NOT NULL,          -- where the information came from, e.g. the police notice
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  radius_m    integer NOT NULL CHECK (radius_m BETWEEN 50 AND 5000),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL CHECK (ends_at > starts_at),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS road_closures_time_idx ON road_closures (ends_at);
ALTER TABLE road_closures ENABLE ROW LEVEL SECURITY;

-- Family links: invited by phone, accepted by the other person.
CREATE TABLE IF NOT EXISTS family_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_id  uuid NOT NULL REFERENCES users(id),
  member_id   uuid NOT NULL REFERENCES users(id),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'removed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  CHECK (inviter_id <> member_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS family_links_live ON family_links (LEAST(inviter_id, member_id), GREATEST(inviter_id, member_id)) WHERE status IN ('pending', 'accepted');
ALTER TABLE family_links ENABLE ROW LEVEL SECURITY;

-- Price locks: a fee freezes today's no-surge fare for one route and vehicle.
CREATE TABLE IF NOT EXISTS price_locks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id      uuid NOT NULL REFERENCES users(id),
  vehicle_type  text NOT NULL,
  pickup        jsonb NOT NULL,
  dropoff       jsonb NOT NULL,
  locked_fare   integer NOT NULL CHECK (locked_fare > 0),
  fee           integer NOT NULL CHECK (fee > 0),
  payment_ref   text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_locks_rider_idx ON price_locks (rider_id, expires_at);
ALTER TABLE price_locks ENABLE ROW LEVEL SECURITY;

ALTER TABLE wallet_txns DROP CONSTRAINT IF EXISTS wallet_txns_kind_check;
ALTER TABLE wallet_txns ADD CONSTRAINT wallet_txns_kind_check CHECK (kind IN (
  'topup', 'ride', 'earning', 'refund', 'earning_adjustment',
  'cash_earning', 'commission', 'tip', 'split', 'cancel_credit', 'cancel_penalty', 'price_lock'));

-- Razorpay can pay for a price lock; the lock's details travel in `meta` until the payment is confirmed.
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS meta jsonb;
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_kind_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_kind_check CHECK (kind IN ('ride', 'topup', 'tip', 'split', 'price_lock'));
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_check
  CHECK ((kind IN ('topup', 'price_lock')) = (ride_id IS NULL) AND (kind = 'split') = (split_id IS NOT NULL));
