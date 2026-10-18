-- 014: trip audio recording (step 8b, batch F; audio only, agreed 2026-10-11).
-- Audio is encrypted on the server before it is stored in a private bucket. Nobody can listen
-- unless the recording is reported; admins listen only to reported ones, and every listen is logged.
-- Unreported recordings are deleted 7 days after they end.

CREATE TABLE IF NOT EXISTS trip_recordings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id       uuid NOT NULL REFERENCES rides(id),
  user_id       uuid NOT NULL REFERENCES users(id),   -- who recorded
  role          text NOT NULL CHECK (role IN ('rider', 'driver')),
  mime          text NOT NULL,
  chunks        integer NOT NULL DEFAULT 0,
  bytes         bigint NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'recording' CHECK (status IN ('recording', 'complete', 'deleted')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  last_chunk_at timestamptz,
  ended_at      timestamptz,
  delete_after  timestamptz,                          -- set when it ends; ignored while held
  held          boolean NOT NULL DEFAULT false,       -- reported: kept until an admin releases it
  held_reason   text,
  ticket_id     uuid REFERENCES support_tickets(id),
  deleted_at    timestamptz
);
-- One recording at a time per person per ride.
CREATE UNIQUE INDEX IF NOT EXISTS trip_recordings_one_live ON trip_recordings (ride_id, user_id) WHERE status = 'recording';
CREATE INDEX IF NOT EXISTS trip_recordings_cleanup ON trip_recordings (delete_after) WHERE status = 'complete' AND NOT held;
ALTER TABLE trip_recordings ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS recording_access_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id  uuid NOT NULL REFERENCES trip_recordings(id),
  admin_id      uuid NOT NULL REFERENCES users(id),
  accessed_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE recording_access_log ENABLE ROW LEVEL SECURITY;
