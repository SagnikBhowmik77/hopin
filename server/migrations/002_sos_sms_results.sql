-- 002: what happened to each automatic SOS text, as reported by Twilio.
-- [{ "name": "...", "phone": "+91...", "status": "queued" | "failed", "sid": "SM...", "error": "..." }]
-- Empty array = no automatic texts were attempted (SMS not set up, or no contacts).
ALTER TABLE sos_alerts ADD COLUMN IF NOT EXISTS sms_results jsonb NOT NULL DEFAULT '[]';
