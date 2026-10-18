-- 018: each person's language (step 10; decided 2026-10-17: English and Hindi for now).
-- Notifications, push messages and texts Hopin sends to them use it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_language_check;
ALTER TABLE users ADD CONSTRAINT users_language_check CHECK (language IN ('en', 'hi'));
