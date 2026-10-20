-- Keep the original billing day so month-end dates do not drift after a short month.
-- NULL remains valid while older application versions can still insert subscriptions.
ALTER TABLE subscriptions
  ADD COLUMN billing_anchor_day SMALLINT;

UPDATE subscriptions
SET billing_anchor_day = EXTRACT(DAY FROM next_billing_date)::SMALLINT;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_billing_anchor_day_valid
  CHECK (billing_anchor_day BETWEEN 1 AND 31);

CREATE TYPE payment_status AS ENUM ('pending', 'confirmed', 'skipped');

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions (id) ON DELETE RESTRICT,
  expected_date DATE NOT NULL,
  expected_amount NUMERIC(12, 2) NOT NULL,
  actual_amount NUMERIC(12, 2),
  status payment_status NOT NULL DEFAULT 'pending',
  price_changed BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payments_subscription_date_unique UNIQUE (subscription_id, expected_date),
  CONSTRAINT payments_expected_amount_non_negative CHECK (expected_amount >= 0),
  CONSTRAINT payments_actual_amount_non_negative CHECK (
    actual_amount IS NULL OR actual_amount >= 0
  ),
  CONSTRAINT payments_state_consistent CHECK (
    (
      status = 'pending'
      AND actual_amount IS NULL
      AND resolved_at IS NULL
      AND price_changed = FALSE
    )
    OR (
      status = 'confirmed'
      AND actual_amount IS NOT NULL
      AND resolved_at IS NOT NULL
      AND price_changed = (actual_amount <> expected_amount)
    )
    OR (
      status = 'skipped'
      AND actual_amount IS NULL
      AND resolved_at IS NOT NULL
      AND price_changed = FALSE
    )
  )
);

CREATE INDEX idx_payments_subscription_expected_date
  ON payments (subscription_id, expected_date DESC);
CREATE INDEX idx_payments_status_expected_date
  ON payments (status, expected_date);
