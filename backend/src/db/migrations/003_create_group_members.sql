CREATE TYPE member_role AS ENUM ('owner', 'member');
CREATE TYPE member_status AS ENUM ('active', 'invited', 'removed');

CREATE TABLE group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role member_role NOT NULL,
  status member_status NOT NULL DEFAULT 'invited',
  joined_at TIMESTAMPTZ,
  CONSTRAINT group_members_unique_user_per_group UNIQUE (group_id, user_id),
  CONSTRAINT group_members_active_has_joined_at CHECK (
    status <> 'active' OR joined_at IS NOT NULL
  )
);

CREATE INDEX idx_group_members_group_id ON group_members (group_id);
CREATE INDEX idx_group_members_user_id ON group_members (user_id);
CREATE INDEX idx_group_members_status ON group_members (status);
