-- 006: in-app chat between a rider and their driver, so neither needs the other's number.

CREATE TABLE IF NOT EXISTS ride_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id     uuid NOT NULL REFERENCES rides(id),
  sender_id   uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Set when the other party opens the chat.
  read_at     timestamptz
);
CREATE INDEX IF NOT EXISTS ride_messages_ride_idx ON ride_messages (ride_id, created_at);
ALTER TABLE ride_messages ENABLE ROW LEVEL SECURITY;
