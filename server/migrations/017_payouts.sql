-- 017: driver payouts, paid by hand (step 12; decided 2026-10-17: no RazorpayX yet).
-- A driver saves where to be paid (UPI ID or bank account, encrypted on the server with PAYOUT_KEY)
-- and asks to withdraw. The amount leaves their wallet at once (kind 'payout') so it can't be spent
-- twice. An admin sends the money from Hopin's own bank/UPI and records the UTR; a rejected or
-- cancelled request puts the money back (kind 'payout_reversal').

CREATE TABLE IF NOT EXISTS payout_methods (
  driver_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('upi', 'bank')),
  details_enc  text NOT NULL,          -- AES-256-GCM sealed JSON: {vpa} or {holder, account, ifsc}
  label        text NOT NULL,          -- safe to show: 'UPI ra***@okhdfc' / 'HDFC0001234 ····6789'
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payout_methods ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS payout_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id     uuid NOT NULL REFERENCES users(id),
  amount        integer NOT NULL CHECK (amount > 0),
  kind          text NOT NULL CHECK (kind IN ('upi', 'bank')),
  details_enc   text NOT NULL,          -- where to send it, frozen at request time
  label         text NOT NULL,
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'paid', 'rejected', 'cancelled')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  closed_by     uuid REFERENCES users(id),
  reference     text,                   -- UTR / UPI reference of the transfer an admin made
  reject_reason text
);
-- One open request per driver at a time.
CREATE UNIQUE INDEX IF NOT EXISTS payout_requests_one_open ON payout_requests (driver_id) WHERE status = 'requested';
CREATE UNIQUE INDEX IF NOT EXISTS payout_requests_reference ON payout_requests (reference) WHERE reference IS NOT NULL;
ALTER TABLE payout_requests ENABLE ROW LEVEL SECURITY;

-- Every admin view of a driver's full bank/UPI details is logged.
CREATE TABLE IF NOT EXISTS payout_detail_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES payout_requests(id),
  admin_id    uuid NOT NULL REFERENCES users(id),
  viewed_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payout_detail_views ENABLE ROW LEVEL SECURITY;

ALTER TABLE wallet_txns DROP CONSTRAINT IF EXISTS wallet_txns_kind_check;
ALTER TABLE wallet_txns ADD CONSTRAINT wallet_txns_kind_check CHECK (kind IN (
  'topup', 'ride', 'earning', 'refund', 'earning_adjustment',
  'cash_earning', 'commission', 'tip', 'split', 'cancel_credit', 'cancel_penalty', 'price_lock', 'driver_pass',
  'referral', 'loyalty', 'payout', 'payout_reversal'));
