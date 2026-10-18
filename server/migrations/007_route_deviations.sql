-- 007: route-deviation alerts.

-- True when the routing service was unreachable at booking and the "route" is just straight
-- lines between the points. Deviation checks are skipped for those rides (they would be false alarms).
ALTER TABLE rides ADD COLUMN IF NOT EXISTS route_estimated boolean NOT NULL DEFAULT false;

-- One row per time a driver stayed too far from the planned route during a trip.
CREATE TABLE IF NOT EXISTS route_deviations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id         uuid NOT NULL REFERENCES rides(id),
  driver_id       uuid NOT NULL REFERENCES users(id),
  rider_id        uuid NOT NULL REFERENCES users(id),
  -- When the driver first went past the threshold, and when the alert was raised.
  started_at      timestamptz NOT NULL,
  alerted_at      timestamptz NOT NULL DEFAULT now(),
  -- Driver position and distance from the route when the alert was raised.
  lat             double precision NOT NULL,
  lng             double precision NOT NULL,
  distance_m      integer NOT NULL,
  max_distance_m  integer NOT NULL,
  resolved_at     timestamptz,
  resolution      text CHECK (resolution IN ('back_on_route', 'trip_ended')),
  -- An admin looked at it.
  checked_by      uuid REFERENCES users(id),
  checked_at      timestamptz
);
-- At most one open alert per ride.
CREATE UNIQUE INDEX IF NOT EXISTS route_deviations_open_idx ON route_deviations (ride_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS route_deviations_recent_idx ON route_deviations (alerted_at DESC);
ALTER TABLE route_deviations ENABLE ROW LEVEL SECURITY;
