-- 010: fair money (step 8b, batch B): a clean ledger, cash commission, tips, fare splits,
-- driver-cancel credit, open surge watches.

-- Ledger kinds. Every kind moves the wallet except 'cash_earning', which only records
-- cash a driver collected by hand (it never entered the wallet).
ALTER TABLE wallet_txns DROP CONSTRAINT IF EXISTS wallet_txns_kind_check;
ALTER TABLE wallet_txns ADD CONSTRAINT wallet_txns_kind_check CHECK (kind IN (
  'topup', 'ride', 'earning', 'refund', 'earning_adjustment',
  'cash_earning', 'commission', 'tip', 'split', 'cancel_credit', 'cancel_penalty'));

-- Past cash rides: the driver kept the whole fare and no commission was taken, so record
-- the full amount collected, outside the wallet. Wallet balances are unchanged.
UPDATE wallet_txns w SET kind = 'cash_earning',
  amount = CASE WHEN w.kind = 'earning' THEN (CASE WHEN r.status = 'cancelled' THEN r.cancellation_fee ELSE r.fare END) ELSE w.amount END
FROM rides r
WHERE w.ride_id = r.id AND r.payment_method = 'cash' AND w.kind IN ('earning', 'earning_adjustment');

-- Drivers can owe Hopin (cash commission, cancel penalties): their wallet may go below zero.
-- Riders never can.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_wallet_balance_check;
ALTER TABLE users ADD CONSTRAINT users_wallet_balance_check CHECK (wallet_balance >= 0 OR role = 'driver');

-- Tips: one per ride, 100% to the driver.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS tip integer NOT NULL DEFAULT 0 CHECK (tip >= 0);
ALTER TABLE rides ADD COLUMN IF NOT EXISTS tipped_at timestamptz;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS tip_ref text;

-- Fare splits: the rider who paid asks another Hopin rider for a share, paid into the requester's wallet.
CREATE TABLE IF NOT EXISTS fare_splits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id       uuid NOT NULL REFERENCES rides(id),
  requester_id  uuid NOT NULL REFERENCES users(id),
  payer_id      uuid NOT NULL REFERENCES users(id),
  amount        integer NOT NULL CHECK (amount > 0),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'declined', 'cancelled')),
  ref           text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  CHECK (requester_id <> payer_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fare_splits_one_live ON fare_splits (ride_id, payer_id) WHERE status IN ('pending', 'paid');
CREATE INDEX IF NOT EXISTS fare_splits_payer_idx ON fare_splits (payer_id, created_at DESC);
ALTER TABLE fare_splits ENABLE ROW LEVEL SECURITY;

-- Razorpay can now also pay a tip or a split share.
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS split_id uuid REFERENCES fare_splits(id);
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_kind_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_kind_check CHECK (kind IN ('ride', 'topup', 'tip', 'split'));
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_check CHECK ((kind = 'topup') = (ride_id IS NULL) AND (kind = 'split') = (split_id IS NOT NULL));

-- "Tell me when prices are normal": watched for 30 minutes.
CREATE TABLE IF NOT EXISTS surge_watches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id      uuid NOT NULL REFERENCES users(id),
  vehicle_type  text NOT NULL,
  pickup        jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'watching' CHECK (status IN ('watching', 'notified', 'expired', 'cancelled')),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS surge_watches_one_per_rider ON surge_watches (rider_id) WHERE status = 'watching';
ALTER TABLE surge_watches ENABLE ROW LEVEL SECURITY;
