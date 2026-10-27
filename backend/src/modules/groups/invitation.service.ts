import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/pool';
import { AppError } from '../../middleware/errorHandler';
import { assertOwner, getActiveMembership } from '../subscriptions/membership';
import { lockGroupForWrite } from './group-lock';
import type { CreateInvitationInput } from './group.schemas';
import { toInvitation, type CreatedInvitation, type Invitation, type InvitationRow } from './invitation.types';

const invitationColumns = `
  gi.id, gi.group_id, g.name AS group_name, gi.email,
  u.name AS invited_by_name,
  CASE WHEN gi.status = 'pending' AND gi.expires_at <= statement_timestamp()
       THEN 'expired'::group_invitation_status ELSE gi.status END AS status,
  gi.created_at, gi.expires_at
`;

export async function listInvitations(userId: string, groupId: string): Promise<Invitation[]> {
  try {
    const membership = await getActiveMembership(userId, groupId, 'list_invitations');
    assertOwner(membership, 'list_invitations');
    const groups = await pool.query<{ type: 'personal' | 'family' }>(
      'SELECT type FROM groups WHERE id = $1', [groupId],
    );
    if (!groups.rows[0]) throw new AppError(403, 'Forbidden');
    if (groups.rows[0].type !== 'family') throw new AppError(409, 'Operation requires a family group');

    const result = await pool.query<InvitationRow>(
      `SELECT ${invitationColumns}
       FROM group_invitations gi
       JOIN groups g ON g.id = gi.group_id
       JOIN users u ON u.id = gi.invited_by
       WHERE gi.group_id = $1
       ORDER BY gi.created_at DESC, gi.id DESC
       LIMIT 100`, [groupId],
    );
    return result.rows.map(toInvitation);
  } catch (error) {
    throw safeInvitationError(error);
  }
}

export async function createInvitation(
  userId: string,
  groupId: string,
  input: CreateInvitationInput,
): Promise<CreatedInvitation> {
  const client = await pool.connect().catch((error: unknown) => { throw safeInvitationError(error); });
  try {
    await client.query('BEGIN');
    await getActiveMembership(userId, groupId, 'create_invitation', client);
    const group = await lockGroupForWrite(client, groupId);
    const membership = await getActiveMembership(userId, groupId, 'create_invitation', client);
    assertOwner(membership, 'create_invitation');
    if (group.type !== 'family') throw new AppError(409, 'Operation requires a family group');

    // Consult only the authenticated account, never whether the invited account
    // exists globally. The second lookup is limited to active members of this group.
    const owner = await client.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
    if (!owner.rows[0]) throw new AppError(403, 'Forbidden');
    if (owner.rows[0].email.trim().toLowerCase() === input.email) throw new AppError(409, 'Cannot invite yourself');
    const members = await client.query<{ is_active_member: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM group_members gm
         JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = $1 AND gm.status = 'active' AND u.email = $2
       ) AS is_active_member`, [groupId, input.email],
    );
    if (members.rows[0].is_active_member) throw new AppError(409, 'User is already an active group member');

    const pending = await client.query<{ id: string; expired: boolean }>(
      `SELECT id, expires_at <= statement_timestamp() AS expired
       FROM group_invitations
       WHERE group_id = $1 AND email = $2 AND status = 'pending'
       FOR UPDATE`, [groupId, input.email],
    );
    if (pending.rows[0]) {
      if (!pending.rows[0].expired) throw new AppError(409, 'Invitation already pending');
      const expired = await client.query<{ id: string }>(
        `UPDATE group_invitations SET status = 'expired', resolved_at = statement_timestamp()
         WHERE group_id = $1 AND id = $2 AND status = 'pending' AND expires_at <= statement_timestamp()
         RETURNING id`, [groupId, pending.rows[0].id],
      );
      if (expired.rows.length !== 1) throw new AppError(409, 'Invitation is not pending');
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO group_invitations (group_id, invited_by, email, token_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, statement_timestamp(), statement_timestamp() + INTERVAL '7 days')
       RETURNING id`, [groupId, userId, input.email, tokenHash],
    );
    const invitation = await readInvitation(client, groupId, inserted.rows[0].id);
    await client.query('COMMIT');
    return { invitation, token };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (typeof error === 'object' && error !== null
      && 'code' in error && error.code === '23505'
      && 'constraint' in error && error.constraint === 'idx_group_invitations_one_pending_email') {
      throw new AppError(409, 'Invitation already pending');
    }
    throw safeInvitationError(error);
  } finally {
    client.release();
  }
}

export async function revokeInvitation(userId: string, groupId: string, invitationId: string): Promise<Invitation> {
  const client = await pool.connect().catch((error: unknown) => { throw safeInvitationError(error); });
  try {
    await client.query('BEGIN');
    await getActiveMembership(userId, groupId, 'revoke_invitation', client);
    const group = await lockGroupForWrite(client, groupId);
    const membership = await getActiveMembership(userId, groupId, 'revoke_invitation', client);
    assertOwner(membership, 'revoke_invitation');
    if (group.type !== 'family') throw new AppError(409, 'Operation requires a family group');

    // UPDATE acquires the invitation row lock after the group lock. A new owner
    // may manage old invitations, so invited_by is deliberately not a predicate.
    const updated = await client.query<{ id: string }>(
      `UPDATE group_invitations SET status = 'revoked', resolved_at = statement_timestamp()
       WHERE group_id = $1 AND id = $2 AND status = 'pending' AND expires_at > statement_timestamp()
       RETURNING id`, [groupId, invitationId],
    );
    if (updated.rows.length !== 1) {
      const existing = await client.query<{ status: string }>(
        'SELECT status FROM group_invitations WHERE group_id = $1 AND id = $2', [groupId, invitationId],
      );
      if (!existing.rows[0]) throw new AppError(404, 'Invitation not found');
      throw new AppError(409, 'Invitation is not pending');
    }
    const invitation = await readInvitation(client, groupId, invitationId);
    await client.query('COMMIT');
    return invitation;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw safeInvitationError(error);
  } finally {
    client.release();
  }
}

async function readInvitation(database: Pick<PoolClient, 'query'>, groupId: string, invitationId: string): Promise<Invitation> {
  const result = await database.query<InvitationRow>(
    `SELECT ${invitationColumns}
     FROM group_invitations gi
     JOIN groups g ON g.id = gi.group_id
     JOIN users u ON u.id = gi.invited_by
     WHERE gi.group_id = $1 AND gi.id = $2`, [groupId, invitationId],
  );
  if (!result.rows[0]) throw new AppError(500, 'Invitation operation failed', false);
  return toInvitation(result.rows[0]);
}

function safeInvitationError(error: unknown): AppError {
  // Driver messages/details may repeat an email or code; neither is safe for
  // the shared error handler's response or log. Keep only our fixed domain errors.
  return error instanceof AppError ? error : new AppError(500, 'Invitation operation failed', false);
}
