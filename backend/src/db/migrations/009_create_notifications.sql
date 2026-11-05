CREATE TYPE notification_type AS ENUM ('payment_due', 'payment_overdue', 'amount_changed');

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  payment_id UUID NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
  type notification_type NOT NULL,
  -- Millisecond precision keeps the database ordering stable in ISO cursors.
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ(3),
  CONSTRAINT notifications_user_payment_type_unique UNIQUE (user_id, payment_id, type)
);

CREATE INDEX idx_notifications_user_created
  ON notifications (user_id, created_at DESC, id DESC);

CREATE INDEX idx_notifications_user_unread_created
  ON notifications (user_id, created_at DESC, id DESC)
  WHERE read_at IS NULL;
