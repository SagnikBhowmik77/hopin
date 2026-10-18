-- 001: initial Hopin schema.
-- Migrations run once each, in file-name order, and are recorded in schema_migrations.
-- Never edit a migration that has already run on a real database; add a new file.
-- Money is whole rupees (integer).

-- A Hopin profile. Sign-in itself lives in Supabase Auth: `id` is the Supabase
-- auth user id, and Hopin stores no passwords. The row is created when the
-- person finishes their profile after first signing in.
CREATE TABLE IF NOT EXISTS users (
  id                 uuid PRIMARY KEY,
  name               text NOT NULL,
  email              text NOT NULL UNIQUE,
  phone              text NOT NULL UNIQUE,
  -- False until the number is confirmed by SMS one-time code (step 2).
  phone_verified     boolean NOT NULL DEFAULT false,
  role               text NOT NULL CHECK (role IN ('rider', 'driver', 'admin')),
  avatar             text,
  rating             double precision NOT NULL DEFAULT 5,
  rating_count       integer NOT NULL DEFAULT 0,
  wallet_balance     integer NOT NULL DEFAULT 0 CHECK (wallet_balance >= 0),
  default_payment    text NOT NULL DEFAULT 'cash' CHECK (default_payment IN ('cash', 'wallet', 'card', 'upi')),
  emergency_contacts jsonb NOT NULL DEFAULT '[]',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicles (
  driver_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  type      text NOT NULL CHECK (type IN ('bike', 'auto', 'car')),
  model     text NOT NULL,
  plate     text NOT NULL
);

CREATE TABLE IF NOT EXISTS upi_ids (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vpa        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, vpa)
);

CREATE TABLE IF NOT EXISTS promos (
  code            text PRIMARY KEY,
  description     text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('percent', 'flat')),
  value           integer NOT NULL CHECK (value > 0),
  max_discount    integer,
  min_fare        integer NOT NULL DEFAULT 0,
  first_ride_only boolean NOT NULL DEFAULT false,
  usage_limit     integer,
  per_user_limit  integer NOT NULL DEFAULT 1,
  expires_at      timestamptz,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rides (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id          uuid NOT NULL REFERENCES users(id),
  driver_id         uuid REFERENCES users(id),
  vehicle_type      text NOT NULL CHECK (vehicle_type IN ('bike', 'auto', 'car')),
  status            text NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested', 'accepted', 'arrived', 'ongoing', 'completed', 'cancelled')),
  pickup            jsonb NOT NULL,
  stops             jsonb NOT NULL DEFAULT '[]',
  dropoff           jsonb NOT NULL,
  route             jsonb NOT NULL DEFAULT '[]',
  distance_km       double precision NOT NULL,
  duration_min      integer NOT NULL,
  base_fare         integer NOT NULL,
  surge             double precision NOT NULL DEFAULT 1,
  stop_charge       integer NOT NULL DEFAULT 0,
  discount          integer NOT NULL DEFAULT 0,
  promo_code        text REFERENCES promos(code),
  fare              integer NOT NULL,
  cancellation_fee  integer NOT NULL DEFAULT 0,
  otp               text,
  pickup_eta_min    integer,
  declined_by       jsonb NOT NULL DEFAULT '[]',
  payment_method    text NOT NULL CHECK (payment_method IN ('cash', 'wallet', 'card', 'upi')),
  upi_vpa           text,
  payment_status    text NOT NULL DEFAULT 'none' CHECK (payment_status IN ('none', 'due', 'paid')),
  payment_ref       text,
  paid_at           timestamptz,
  share_token       text NOT NULL UNIQUE,
  cancelled_by      text CHECK (cancelled_by IN ('rider', 'driver', 'system')),
  cancel_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  accepted_at       timestamptz,
  arrived_at        timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  cancelled_at      timestamptz
);
CREATE INDEX IF NOT EXISTS rides_rider_idx ON rides (rider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rides_driver_idx ON rides (driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rides_status_idx ON rides (status);
-- One live ride per rider and per driver, enforced by the database itself.
CREATE UNIQUE INDEX IF NOT EXISTS rides_one_active_rider
  ON rides (rider_id) WHERE status IN ('requested', 'accepted', 'arrived', 'ongoing');
CREATE UNIQUE INDEX IF NOT EXISTS rides_one_active_driver
  ON rides (driver_id) WHERE status IN ('accepted', 'arrived', 'ongoing');

CREATE TABLE IF NOT EXISTS promo_redemptions (
  code       text NOT NULL REFERENCES promos(code),
  user_id    uuid NOT NULL REFERENCES users(id),
  ride_id    uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, ride_id)
);

CREATE TABLE IF NOT EXISTS reviews (
  ride_id    uuid PRIMARY KEY REFERENCES rides(id) ON DELETE CASCADE,
  rider_id   uuid NOT NULL REFERENCES users(id),
  driver_id  uuid NOT NULL REFERENCES users(id),
  stars      integer NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment    text,
  tags       jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reviews_driver_idx ON reviews (driver_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_txns (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  amount     integer NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('topup', 'ride', 'earning', 'refund')),
  ride_id    uuid REFERENCES rides(id),
  -- Payment gateway reference. Unique so a replayed confirmation cannot credit twice.
  ref        text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_user_idx ON wallet_txns (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  link       text,
  read       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sos_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id     uuid NOT NULL REFERENCES rides(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  location    jsonb,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  ride_id    uuid REFERENCES rides(id),
  category   text NOT NULL CHECK (category IN ('payment', 'lost_item', 'driver', 'safety', 'app', 'other')),
  subject    text NOT NULL,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id),
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Row Level Security on every Hopin table, with no policies. Supabase publishes
-- the public schema through its Data API to anyone holding the publishable key;
-- with RLS on and no policies, that API can read and write nothing here. Hopin's
-- own server connects as the table owner, which RLS does not restrict.
ALTER TABLE users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE upi_ids           ENABLE ROW LEVEL SECURITY;
ALTER TABLE promos            ENABLE ROW LEVEL SECURITY;
ALTER TABLE rides             ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews           ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_txns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sos_alerts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_messages   ENABLE ROW LEVEL SECURITY;
