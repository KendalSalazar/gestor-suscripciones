  CREATE TYPE payment_share_status AS ENUM ('pending', 'confirmed', 'skipped');

CREATE TABLE payment_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  share_amount NUMERIC(12, 2) NOT NULL,
  share_percentage NUMERIC(7, 4) NOT NULL,
  actual_amount NUMERIC(12, 2),
  status payment_share_status NOT NULL DEFAULT 'pending',
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_shares_payment_user_unique UNIQUE (payment_id, user_id),
  -- Explicit finite bounds also reject PostgreSQL NUMERIC NaN.
  CONSTRAINT payment_shares_share_amount_valid CHECK (share_amount BETWEEN 0 AND 9999999999.99),
  CONSTRAINT payment_shares_percentage_valid CHECK (share_percentage BETWEEN 0 AND 100),
  CONSTRAINT payment_shares_actual_amount_valid CHECK (
    actual_amount IS NULL OR actual_amount BETWEEN 0 AND 9999999999.99
  ),
  CONSTRAINT payment_shares_state_consistent CHECK (
    (
      status IN ('pending', 'skipped')
      AND actual_amount IS NULL
      AND confirmed_at IS NULL
    )
    OR (
      status = 'confirmed'
      AND actual_amount IS NOT NULL
      AND confirmed_at IS NOT NULL
    )
  )
);

-- UNIQUE(payment_id, user_id) already supports payment-level lookups.
CREATE INDEX idx_payment_shares_user_status_payment
  ON payment_shares (user_id, status, payment_id);

-- These are row-level invariants. The later transactional services must create
-- a family snapshot with exact totals and no shares for personal payments.
-- No backfill or change to existing payments is performed by this migration.
