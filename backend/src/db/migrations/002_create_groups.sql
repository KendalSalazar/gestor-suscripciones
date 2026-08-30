CREATE TYPE group_type AS ENUM ('personal', 'family');

CREATE TABLE groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  type group_type NOT NULL,
  owner_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_groups_owner_id ON groups (owner_id);
CREATE INDEX idx_groups_type ON groups (type);
CREATE UNIQUE INDEX idx_groups_one_personal_per_owner
  ON groups (owner_id)
  WHERE type = 'personal';
