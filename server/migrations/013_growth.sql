-- 013: growth (step 8b, batch E): referrals, loyalty points, corporate accounts.

-- Referrals. Rewards agreed 2026-10-12: riders ₹50 each after the new rider's first paid
-- ride (max 20 rewarded per referrer); drivers ₹200 to the referrer after 20 trips.
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code text UNIQUE;
CREATE TABLE IF NOT EXISTS referrals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id  uuid NOT NULL REFERENCES users(id),
  referred_id  uuid NOT NULL UNIQUE REFERENCES users(id),
  kind         text NOT NULL CHECK (kind IN ('rider', 'driver')),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rewarded')),
  referrer_reward integer NOT NULL DEFAULT 0,
  referred_reward integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  rewarded_at  timestamptz,
  CHECK (referrer_id <> referred_id)
);
CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals (referrer_id);
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

-- Loyalty points: a balance and its ledger, like the wallet.
ALTER TABLE users ADD COLUMN IF NOT EXISTS loyalty_points integer NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0);
CREATE TABLE IF NOT EXISTS loyalty_txns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  points      integer NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('earned', 'redeemed')),
  ride_id     uuid REFERENCES rides(id),
  ref         text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loyalty_txns_user_idx ON loyalty_txns (user_id, created_at DESC);
ALTER TABLE loyalty_txns ENABLE ROW LEVEL SECURITY;

-- Corporate accounts with a prepaid company wallet.
CREATE TABLE IF NOT EXISTS companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,
  wallet_balance  integer NOT NULL DEFAULT 0 CHECK (wallet_balance >= 0),
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS company_members (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  role           text NOT NULL CHECK (role IN ('admin', 'employee')),
  status         text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'declined', 'removed')),
  monthly_limit  integer CHECK (monthly_limit IS NULL OR monthly_limit > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- One company per person at a time.
CREATE UNIQUE INDEX IF NOT EXISTS company_members_one_company ON company_members (user_id) WHERE status IN ('invited', 'active');
ALTER TABLE company_members ENABLE ROW LEVEL SECURITY;

-- The company wallet's ledger: balance always equals the sum of these.
CREATE TABLE IF NOT EXISTS company_txns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  amount      integer NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('topup', 'ride', 'refund')),
  ride_id     uuid REFERENCES rides(id),
  user_id     uuid REFERENCES users(id),     -- who topped up / who rode
  ref         text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS company_txns_company_idx ON company_txns (company_id, created_at DESC);
ALTER TABLE company_txns ENABLE ROW LEVEL SECURITY;

-- Business rides.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);
ALTER TABLE rides ADD COLUMN IF NOT EXISTS business_note text;
ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_payment_method_check;
ALTER TABLE rides ADD CONSTRAINT rides_payment_method_check
  CHECK (payment_method IN ('cash', 'wallet', 'card', 'upi', 'netbanking', 'online_wallet', 'emi', 'paylater', 'corporate'));

ALTER TABLE wallet_txns DROP CONSTRAINT IF EXISTS wallet_txns_kind_check;
ALTER TABLE wallet_txns ADD CONSTRAINT wallet_txns_kind_check CHECK (kind IN (
  'topup', 'ride', 'earning', 'refund', 'earning_adjustment',
  'cash_earning', 'commission', 'tip', 'split', 'cancel_credit', 'cancel_penalty', 'price_lock', 'driver_pass',
  'referral', 'loyalty'));

-- Razorpay can top up a company wallet.
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_kind_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_kind_check CHECK (kind IN ('ride', 'topup', 'tip', 'split', 'price_lock', 'driver_pass', 'company_topup'));
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_check
  CHECK ((kind IN ('topup', 'price_lock', 'driver_pass', 'company_topup')) = (ride_id IS NULL)
     AND (kind = 'split') = (split_id IS NOT NULL)
     AND (kind = 'company_topup') = (company_id IS NOT NULL));
