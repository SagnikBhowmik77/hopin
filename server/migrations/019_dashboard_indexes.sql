-- Indexes for the admin dashboard and receipts: daily trip counts, paid totals,
-- the SOS list and the support queue. No data changes.
CREATE INDEX IF NOT EXISTS rides_completed_at_idx ON rides (completed_at) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS rides_paid_at_idx ON rides (paid_at) WHERE payment_status = 'paid';
CREATE INDEX IF NOT EXISTS sos_alerts_status_idx ON sos_alerts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets (status, created_at DESC);
