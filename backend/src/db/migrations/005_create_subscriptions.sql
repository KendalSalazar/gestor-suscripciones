CREATE TYPE billing_cycle AS ENUM ('weekly', 'monthly', 'quarterly', 'yearly');

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  provider VARCHAR(255) NOT NULL,
  expected_cost NUMERIC(12, 2) NOT NULL,
  billing_cycle billing_cycle NOT NULL,
  next_billing_date DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT subscriptions_expected_cost_non_negative CHECK (expected_cost >= 0)
);

CREATE INDEX idx_subscriptions_group_id ON subscriptions (group_id);
CREATE INDEX idx_subscriptions_group_active ON subscriptions (group_id, active);
CREATE INDEX idx_subscriptions_next_billing_date ON subscriptions (next_billing_date);
