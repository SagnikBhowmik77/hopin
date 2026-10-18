-- 009: safety basics (step 8b, batch A).

-- A rider's own 4-digit trip PIN, used instead of a random code when set.
ALTER TABLE users ADD COLUMN IF NOT EXISTS trip_pin text CHECK (trip_pin ~ '^[0-9]{4}$');

-- Route alerts now also cover long unplanned stops.
ALTER TABLE route_deviations ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'off_route';
ALTER TABLE route_deviations DROP CONSTRAINT IF EXISTS route_deviations_kind_check;
ALTER TABLE route_deviations ADD CONSTRAINT route_deviations_kind_check CHECK (kind IN ('off_route', 'long_stop'));
ALTER TABLE route_deviations DROP CONSTRAINT IF EXISTS route_deviations_resolution_check;
ALTER TABLE route_deviations ADD CONSTRAINT route_deviations_resolution_check
  CHECK (resolution IN ('back_on_route', 'moving_again', 'rider_ok', 'trip_ended'));
-- One open alert of each kind per ride (replaces "one open alert per ride").
DROP INDEX IF EXISTS route_deviations_open_idx;
CREATE UNIQUE INDEX IF NOT EXISTS route_deviations_open_kind_idx ON route_deviations (ride_id, kind) WHERE resolved_at IS NULL;

-- "Reached safely?" after a night ride: if the rider does not confirm by due_at,
-- their emergency contacts are texted and admins alerted.
CREATE TABLE IF NOT EXISTS safety_checks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id       uuid NOT NULL UNIQUE REFERENCES rides(id),
  rider_id      uuid NOT NULL REFERENCES users(id),
  due_at        timestamptz NOT NULL,
  confirmed_at  timestamptz,
  escalated_at  timestamptz,
  sms_results   jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS safety_checks_due_idx ON safety_checks (due_at) WHERE confirmed_at IS NULL AND escalated_at IS NULL;
ALTER TABLE safety_checks ENABLE ROW LEVEL SECURITY;

-- Daily helmet selfie for bike drivers, reviewed by admins.
CREATE TABLE IF NOT EXISTS helmet_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id      uuid NOT NULL REFERENCES users(id),
  storage_path   text NOT NULL,
  mime_type      text NOT NULL,
  taken_on       date NOT NULL,  -- India date
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reject_reason  text,
  reviewed_by    uuid REFERENCES users(id),
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS helmet_checks_driver_idx ON helmet_checks (driver_id, created_at DESC);
ALTER TABLE helmet_checks ENABLE ROW LEVEL SECURITY;
