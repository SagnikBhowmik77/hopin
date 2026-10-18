-- 015: monsoon waterlogging reports (step 8b, batch G).
-- Crowd reports from riders and drivers, made from the phone's GPS. A report near an existing one
-- confirms it instead. Reports expire some hours after their last confirmation, or when people nearby
-- say the water has cleared. Used to show spots on the map and to pad ETAs (never the fare).

CREATE TABLE IF NOT EXISTS waterlog_reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lat               double precision NOT NULL,
  lng               double precision NOT NULL,
  severity          text NOT NULL CHECK (severity IN ('ankle', 'knee', 'impassable')),
  note              text,
  reported_by       uuid NOT NULL REFERENCES users(id),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cleared', 'expired', 'removed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  closed_at         timestamptz,
  closed_by         uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS waterlog_reports_active ON waterlog_reports (expires_at) WHERE status = 'active';
ALTER TABLE waterlog_reports ENABLE ROW LEVEL SECURITY;

-- One vote per person per report: 'still' (still flooded, keeps it alive) or 'cleared'.
CREATE TABLE IF NOT EXISTS waterlog_votes (
  report_id  uuid NOT NULL REFERENCES waterlog_reports(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  vote       text NOT NULL CHECK (vote IN ('still', 'cleared')),
  severity   text CHECK (severity IN ('ankle', 'knee', 'impassable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, user_id)
);
ALTER TABLE waterlog_votes ENABLE ROW LEVEL SECURITY;
