-- 003: driver verification documents.
-- Files live in the private Supabase Storage bucket "driver-documents"; this table
-- holds their metadata and the admin's decision. Every upload is a new row, so the
-- history is kept; the newest row per (driver, doc_type) is the current one.
CREATE TABLE IF NOT EXISTS driver_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type       text NOT NULL CHECK (doc_type IN ('driving_licence', 'vehicle_rc', 'insurance', 'driver_photo')),
  storage_path   text NOT NULL UNIQUE,
  mime_type      text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes     integer NOT NULL CHECK (size_bytes > 0),
  doc_number     text,
  expires_on     date,
  -- RC and insurance belong to one vehicle: the plate at upload time. A new vehicle needs new papers.
  vehicle_plate  text,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reject_reason  text,
  reviewed_by    uuid REFERENCES users(id),
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS driver_documents_current_idx ON driver_documents (driver_id, doc_type, created_at DESC);
CREATE INDEX IF NOT EXISTS driver_documents_pending_idx ON driver_documents (status, created_at) WHERE status = 'pending';

ALTER TABLE driver_documents ENABLE ROW LEVEL SECURITY;
