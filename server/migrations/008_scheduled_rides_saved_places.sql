-- 008: scheduled rides and saved places.

-- A scheduled ride waits as 'scheduled' and becomes a normal 'requested' ride shortly before pickup.
ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_status_check;
ALTER TABLE rides ADD CONSTRAINT rides_status_check
  CHECK (status IN ('scheduled', 'requested', 'accepted', 'arrived', 'ongoing', 'completed', 'cancelled'));
ALTER TABLE rides ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
-- When the ride was offered to drivers. For a scheduled ride that is later than created_at.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS requested_at timestamptz;
UPDATE rides SET requested_at = created_at WHERE requested_at IS NULL AND status <> 'scheduled';
CREATE INDEX IF NOT EXISTS rides_scheduled_idx ON rides (scheduled_for) WHERE status = 'scheduled';

-- Places a user saved for one-tap booking. At most one Home and one Work each.
CREATE TABLE IF NOT EXISTS saved_places (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('home', 'work', 'other')),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  address     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_places_user_idx ON saved_places (user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS saved_places_one_home_work ON saved_places (user_id, kind) WHERE kind IN ('home', 'work');
ALTER TABLE saved_places ENABLE ROW LEVEL SECURITY;
