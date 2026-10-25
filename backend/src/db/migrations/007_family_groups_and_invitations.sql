-- Keep the preflight and schema change on the same stable data set. The runner
-- executes this file in one transaction. This initial lock allows reads; later
-- schema changes can take stronger locks that also make readers wait.
LOCK TABLE groups, group_members, subscriptions, payments IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  missing_owner_count BIGINT;
  multiple_owner_count BIGINT;
  inactive_owner_count BIGINT;
  family_payment_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO missing_owner_count
  FROM groups g
  WHERE NOT EXISTS (
    SELECT 1 FROM group_members gm
    WHERE gm.group_id = g.id AND gm.user_id = g.owner_id
      AND gm.role = 'owner' AND gm.status = 'active'
  );

  SELECT COUNT(*) INTO multiple_owner_count
  FROM (
    SELECT group_id FROM group_members
    WHERE role = 'owner' AND status = 'active'
    GROUP BY group_id HAVING COUNT(*) > 1
  ) duplicated;

  SELECT COUNT(*) INTO inactive_owner_count
  FROM group_members
  WHERE role = 'owner' AND status <> 'active';

  -- Before migration 008 no family payment has a verifiable share snapshot.
  SELECT COUNT(*) INTO family_payment_count
  FROM payments p
  JOIN subscriptions s ON s.id = p.subscription_id
  JOIN groups g ON g.id = s.group_id
  WHERE g.type = 'family';

  IF missing_owner_count > 0 OR multiple_owner_count > 0
     OR inactive_owner_count > 0 OR family_payment_count > 0 THEN
    RAISE EXCEPTION
      'Migration 007 precondition failed: matching_active_owner_missing=%, groups_with_multiple_active_owners=%, inactive_owner_memberships=%, existing_family_payments=%',
      missing_owner_count, multiple_owner_count, inactive_owner_count, family_payment_count;
  END IF;
END
$$;

-- This enforces at most one active owner. Keeping one owner, and matching
-- groups.owner_id, also requires the transactional services of later blocks.
CREATE UNIQUE INDEX idx_group_members_one_active_owner
  ON group_members (group_id)
  WHERE role = 'owner' AND status = 'active';

ALTER TABLE group_members
  ADD CONSTRAINT group_members_owner_is_active
  CHECK (role <> 'owner' OR status = 'active');

CREATE TYPE group_invitation_status AS ENUM ('pending', 'accepted', 'declined', 'revoked', 'expired');

CREATE TABLE group_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
  invited_by UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  email TEXT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  status group_invitation_status NOT NULL DEFAULT 'pending',
  accepted_by UUID REFERENCES users (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  CONSTRAINT group_invitations_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT group_invitations_email_normalized CHECK (
    -- Match String.trim() whitespace, including Unicode spaces and the BOM.
    email = LOWER(BTRIM(email,
      U&'\0009\000A\000B\000C\000D\0020\00A0\1680'
      || U&'\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A'
      || U&'\2028\2029\202F\205F\3000\FEFF'
    )) AND CHAR_LENGTH(email) BETWEEN 1 AND 254
  ),
  CONSTRAINT group_invitations_token_hash_valid CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT group_invitations_expiry_valid CHECK (expires_at > created_at),
  CONSTRAINT group_invitations_resolution_consistent CHECK (
    (status = 'pending' AND resolved_at IS NULL)
    OR (status <> 'pending' AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT group_invitations_acceptance_consistent CHECK (
    (status = 'accepted' AND accepted_by IS NOT NULL)
    OR (status <> 'accepted' AND accepted_by IS NULL)
  )
);

-- Expiration is checked in the service. A time-dependent index predicate cannot
-- release a pending invitation automatically; the service must mark it expired.
CREATE UNIQUE INDEX idx_group_invitations_one_pending_email
  ON group_invitations (group_id, email)
  WHERE status = 'pending';

CREATE INDEX idx_group_invitations_group_created
  ON group_invitations (group_id, created_at DESC, id DESC);

CREATE INDEX idx_group_invitations_pending_email
  ON group_invitations (email)
  WHERE status = 'pending';
