-- 005: refunds and fare disputes.

-- Every refund an admin issues. Money goes either back through Razorpay to the
-- original card/UPI/bank ('original'), or into the rider's Hopin wallet ('wallet').
CREATE TABLE IF NOT EXISTS refunds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id             uuid REFERENCES rides(id),
  -- Set for a refund of a duplicate Razorpay payment (payment_orders.status = 'needs_refund').
  payment_order_id    uuid REFERENCES payment_orders(id),
  rider_id            uuid NOT NULL REFERENCES users(id),
  ticket_id           uuid REFERENCES support_tickets(id),
  amount              integer NOT NULL CHECK (amount > 0),
  destination         text NOT NULL CHECK (destination IN ('original', 'wallet')),
  -- Razorpay reports refunds as pending until the bank confirms; wallet refunds are processed at once.
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
  razorpay_refund_id  text UNIQUE,
  reason              text NOT NULL,
  failure_reason      text,
  -- How much was taken back from the driver's earnings (0 for duplicate payments).
  driver_adjustment   integer NOT NULL DEFAULT 0,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz,
  CHECK (ride_id IS NOT NULL OR payment_order_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS refunds_ride_idx ON refunds (ride_id);
CREATE INDEX IF NOT EXISTS refunds_rider_idx ON refunds (rider_id, created_at DESC);
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;

-- Driver earnings can now be reduced when a trip is refunded.
ALTER TABLE wallet_txns DROP CONSTRAINT IF EXISTS wallet_txns_kind_check;
ALTER TABLE wallet_txns ADD CONSTRAINT wallet_txns_kind_check
  CHECK (kind IN ('topup', 'ride', 'earning', 'refund', 'earning_adjustment'));

-- A duplicate payment that has been refunded in full.
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_status_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_status_check
  CHECK (status IN ('created', 'paid', 'needs_refund', 'refunded'));

-- Fare disputes are their own kind of support ticket.
ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_category_check;
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_category_check
  CHECK (category IN ('payment', 'fare_dispute', 'lost_item', 'driver', 'safety', 'app', 'other'));
