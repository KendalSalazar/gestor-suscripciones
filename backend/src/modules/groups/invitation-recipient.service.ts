import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/pool';
import { AppError } from '../../middleware/errorHandler';
import { lockGroupForWrite } from './group-lock';
import { toGroup, toGroupMember, type Group, type GroupMember, type GroupMemberRow, type GroupRow } from './group.types';
import { toInvitation, type Invitation, type InvitationRow, type InvitationStatus } from './invitation.types';

const memberLimit = 20;

type RecipientInvitationRow = InvitationRow & {
  stored_status: InvitationStatus;
  is_expired: boolean;
};

type AcceptInvitationResult = { group: Group; membership: GroupMember };

const recipientInvitationColumns = `
  gi.id, gi.group_id, g.name AS group_name, gi.email,
  inviter.name AS invited_by_name,
  CASE WHEN gi.status = 'pending' AND gi.expires_at <= statement_timestamp()
       THEN 'expired'::group_invitation_status ELSE gi.status END AS status,
  gi.status AS stored_status,
  gi.expires_at <= statement_timestamp() AS is_expired,
  gi.created_at, gi.expires_at
`;

export async function previewInvitation(userId: string, invitationId: string, token: string): Promise<Invitation> {
  return withRecipientInvitation(userId, invitationId, token, async (_client, invitation) => {
    assertPendingAndLive(invitation);
    return toInvitation(invitation);
  });
}

export async function acceptInvitation(
  userId: string,
  invitationId: string,
  token: string,
): Promise<AcceptInvitationResult> {
  return withRecipientInvitation(userId, invitationId, token, async (client, invitation, groupId) => {
    assertPendingAndLive(invitation);

    const existing = await client.query<{ role: 'owner' | 'member'; status: 'active' | 'invited' | 'removed' }>(
      `SELECT role, status FROM group_members
       WHERE group_id = $1 AND user_id = $2
       FOR UPDATE`, [groupId, userId],
    );
    const membership = existing.rows[0];
    if (membership?.status === 'active') throw new AppError(409, 'Invitation is not pending');
    if (membership && membership.role !== 'member') throw new AppError(409, 'Invitation is not pending');

    const activeCount = await client.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM group_members WHERE group_id = $1 AND status = 'active'", [groupId],
    );
    if (activeCount.rows[0].count >= memberLimit) {
      throw new AppError(409, 'Family group has reached its member limit');
    }

    if (membership) {
      const reactivated = await client.query<{ user_id: string }>(
        `UPDATE group_members SET role = 'member', status = 'active', joined_at = statement_timestamp()
         WHERE group_id = $1 AND user_id = $2 AND role = 'member' AND status IN ('invited', 'removed')
         RETURNING user_id`, [groupId, userId],
      );
      if (reactivated.rows.length !== 1) throw new AppError(409, 'Invitation is not pending');
    } else {
      await client.query(
        `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
         VALUES ($1, $2, 'member', 'active', statement_timestamp())`, [groupId, userId],
      );
    }

    const accepted = await client.query<{ id: string }>(
      `UPDATE group_invitations
       SET status = 'accepted', accepted_by = $3, resolved_at = statement_timestamp()
       WHERE group_id = $1 AND id = $2 AND status = 'pending' AND expires_at > statement_timestamp()
       RETURNING id`, [groupId, invitationId, userId],
    );
    if (accepted.rows.length !== 1) throw new AppError(409, 'Invitation is not pending');

    const groupResult = await client.query<Omit<GroupRow, 'role'>>(
      `SELECT id, name, type, owner_id, created_at FROM groups WHERE id = $1`, [groupId],
    );
    const groupRow = groupResult.rows[0];
    if (!groupRow || groupRow.type !== 'family') throw unavailableInvitation();
    const memberResult = await client.query<GroupMemberRow>(
      `SELECT gm.user_id, u.name, gm.role, gm.status, gm.joined_at
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1 AND gm.user_id = $2 AND gm.status = 'active'`, [groupId, userId],
    );
    if (!memberResult.rows[0]) throw new AppError(500, 'Invitation operation failed', false);

    return {
      group: toGroup({ ...groupRow, role: memberResult.rows[0].role }),
      membership: toGroupMember(memberResult.rows[0]),
    };
  });
}

export async function declineInvitation(userId: string, invitationId: string, token: string): Promise<Invitation> {
  return withRecipientInvitation(userId, invitationId, token, async (client, invitation, groupId) => {
    assertPendingAndLive(invitation);
    const declined = await client.query<{ id: string }>(
      `UPDATE group_invitations
       SET status = 'declined', resolved_at = statement_timestamp()
       WHERE group_id = $1 AND id = $2 AND status = 'pending' AND expires_at > statement_timestamp()
       RETURNING id`, [groupId, invitationId],
    );
    if (declined.rows.length !== 1) throw new AppError(409, 'Invitation is not pending');

    const updated = await readRecipientInvitation(client, groupId, invitationId, userId, createHash('sha256').update(token).digest('hex'));
    if (!updated) throw unavailableInvitation();
    return toInvitation(updated);
  });
}

async function withRecipientInvitation<T>(
  userId: string,
  invitationId: string,
  token: string,
  operation: (client: PoolClient, invitation: RecipientInvitationRow, groupId: string) => Promise<T>,
): Promise<T> {
  const tokenHash = createHash('sha256').update(token).digest('hex');
  let groupId: string | undefined;
  try {
    const located = await pool.query<{ group_id: string }>(
      `SELECT gi.group_id
       FROM group_invitations gi JOIN users recipient ON recipient.id = $3
       WHERE gi.id = $1 AND gi.token_hash = $2 AND gi.email = LOWER(BTRIM(recipient.email))`,
      [invitationId, tokenHash, userId],
    );
    groupId = located.rows[0]?.group_id;
    if (!groupId) throw unavailableInvitation();
  } catch (error) {
    throw safeRecipientError(error);
  }

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw safeRecipientError(error);
  }
  try {
    await client.query('BEGIN');
    let group: { type: 'personal' | 'family' };
    try {
      group = await lockGroupForWrite(client, groupId);
    } catch (error) {
      if (error instanceof AppError && error.status === 403) throw unavailableInvitation();
      throw error;
    }
    if (group.type !== 'family') throw unavailableInvitation();

    const invitation = await readRecipientInvitation(client, groupId, invitationId, userId, tokenHash);
    if (!invitation) throw unavailableInvitation();
    const result = await operation(client, invitation, groupId);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw safeRecipientError(error);
  } finally {
    client.release();
  }
}

async function readRecipientInvitation(
  client: Pick<PoolClient, 'query'>,
  groupId: string,
  invitationId: string,
  userId: string,
  tokenHash: string,
): Promise<RecipientInvitationRow | undefined> {
  const result = await client.query<RecipientInvitationRow>(
    `SELECT ${recipientInvitationColumns}
     FROM group_invitations gi
     JOIN groups g ON g.id = gi.group_id
     JOIN users inviter ON inviter.id = gi.invited_by
     JOIN users recipient ON recipient.id = $3
     WHERE gi.group_id = $1 AND gi.id = $2 AND gi.token_hash = $4
       AND gi.email = LOWER(BTRIM(recipient.email))
     FOR UPDATE OF gi`, [groupId, invitationId, userId, tokenHash],
  );
  return result.rows[0];
}

function assertPendingAndLive(invitation: RecipientInvitationRow): void {
  if (invitation.stored_status !== 'pending' || invitation.is_expired) {
    throw new AppError(409, 'Invitation is not pending');
  }
}

function unavailableInvitation(): AppError {
  return new AppError(404, 'Invitation unavailable');
}

function safeRecipientError(error: unknown): AppError {
  return error instanceof AppError ? error : new AppError(500, 'Invitation operation failed', false);
}
