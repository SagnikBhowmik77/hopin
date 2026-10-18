-- 004: online payments through Razorpay.

-- One row per Razorpay order Hopin creates. Amounts are whole rupees here
-- (Razorpay itself works in paise). The order is the unit of idempotency: the
-- checkout return and the webhook can both report the same payment, and only the
-- first one changes anything.
CREATE TABLE IF NOT EXISTS payment_orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  razorpay_order_id    text NOT NULL UNIQUE,
  user_id              uuid NOT NULL REFERENCES users(id),
  kind                 text NOT NULL CHECK (kind IN ('ride', 'topup')),
  ride_id              uuid REFERENCES rides(id),
  amount               integer NOT NULL CHECK (amount > 0),
  -- created: waiting for payment; paid: applied to the ride / wallet;
  -- needs_refund: money arrived but the ride was already paid another way (refunds: step 5).
  status               text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'needs_refund')),
  razorpay_payment_id  text UNIQUE,
  method               text,
  test_mode            boolean NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  paid_at              timestamptz,
  CHECK ((kind = 'ride') = (ride_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS payment_orders_user_idx ON payment_orders (user_id, created_at DESC);
ALTER TABLE payment_orders ENABLE ROW LEVEL SECURITY;

-- Record how a ride was actually paid: Razorpay can also report netbanking,
-- third-party wallets (Paytm, etc.), EMI and pay-later.
ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_payment_method_check;
ALTER TABLE rides ADD CONSTRAINT rides_payment_method_check
  CHECK (payment_method IN ('cash', 'wallet', 'card', 'upi', 'netbanking', 'online_wallet', 'emi', 'paylater'));
