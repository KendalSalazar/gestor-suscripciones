import { pool } from '../../db/pool';
import { AppError } from '../../middleware/errorHandler';
import { assertOwner, getActiveMembership } from '../subscriptions/membership';
import { lockGroupForWrite } from './group-lock';
import type { TransferOwnershipInput } from './group.schemas';
import { toGroup, toGroupMember, type Group, type GroupMember, type GroupMemberRow, type GroupRow } from './group.types';

export async function listMembers(userId: string, groupId: string): Promise<GroupMember[]> {
  await getActiveMembership(userId, groupId, 'list_group_members');
  const groups = await pool.query<{ type: 'personal' | 'family' }>(
    'SELECT type FROM groups WHERE id = $1', [groupId],
  );
  const group = groups.rows[0];
  if (!group) throw new AppError(403, 'Forbidden');
  if (group.type !== 'family') throw new AppError(409, 'Operation requires a family group');

  const result = await pool.query<GroupMemberRow>(
    `SELECT gm.user_id, u.name, gm.role, gm.status, gm.joined_at
     FROM group_members gm
     JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = $1 AND gm.status = 'active'
     ORDER BY CASE WHEN gm.role = 'owner' THEN 0 ELSE 1 END, gm.user_id ASC
     LIMIT 20`, [groupId],
  );
  return result.rows.map(toGroupMember);
}

export async function transferOwnership(
  userId: string,
  groupId: string,
  input: TransferOwnershipInput,
): Promise<Group> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await getActiveMembership(userId, groupId, 'transfer_ownership', client);
    const group = await lockGroupForWrite(client, groupId);
    const membership = await getActiveMembership(userId, groupId, 'transfer_ownership', client);
    assertOwner(membership, 'transfer_ownership');
    if (group.type !== 'family') throw new AppError(409, 'Operation requires a family group');
    if (input.newOwnerId === userId) throw new AppError(409, 'New owner must be a different active member');

    const destination = await client.query<{ user_id: string; role: 'owner' | 'member' }>(
      `SELECT user_id, role FROM group_members
       WHERE group_id = $1 AND user_id = $2 AND status = 'active' AND role = 'member'
       FOR UPDATE`, [groupId, input.newOwnerId],
    );
    if (!destination.rows[0] || destination.rows[0].role !== 'member') {
      throw new AppError(409, 'New owner must be a different active member');
    }

    // Demote before promoting so the partial unique owner index remains valid.
    // The group lock serializes coordinated writers until all three updates commit.
    const demoted = await client.query<{ user_id: string }>(
      `UPDATE group_members SET role = 'member'
       WHERE group_id = $1 AND user_id = $2 AND role = 'owner' AND status = 'active'
       RETURNING user_id`, [groupId, userId],
    );
    if (demoted.rows.length !== 1) throw new AppError(409, 'Group ownership could not be transferred');

    const promoted = await client.query<{ user_id: string }>(
      `UPDATE group_members SET role = 'owner'
       WHERE group_id = $1 AND user_id = $2 AND role = 'member' AND status = 'active'
       RETURNING user_id`, [groupId, input.newOwnerId],
    );
    if (promoted.rows.length !== 1) throw new AppError(409, 'Group ownership could not be transferred');

    const updated = await client.query<Omit<GroupRow, 'role'>>(
      `UPDATE groups SET owner_id = $3
       WHERE id = $1 AND owner_id = $2 AND type = 'family'
       RETURNING id, name, type, owner_id, created_at`, [groupId, userId, input.newOwnerId],
    );
    const row = updated.rows[0];
    if (!row) throw new AppError(409, 'Group ownership could not be transferred');
    const result = toGroup({ ...row, role: 'member' });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function leaveGroup(userId: string, groupId: string): Promise<void> {
  return removeActiveMembership(userId, groupId, userId, false);
}

export async function removeMember(ownerUserId: string, groupId: string, targetUserId: string): Promise<void> {
  return removeActiveMembership(ownerUserId, groupId, targetUserId, true);
}

async function removeActiveMembership(
  requesterId: string,
  groupId: string,
  targetUserId: string,
  requireOwner: boolean,
): Promise<void> {
  const client = await pool.connect();
  const operation = requireOwner ? 'remove_group_member' : 'leave_group';
  try {
    await client.query('BEGIN');
    await getActiveMembership(requesterId, groupId, operation, client);
    const group = await lockGroupForWrite(client, groupId);
    const membership = await getActiveMembership(requesterId, groupId, operation, client);
    if (requireOwner) assertOwner(membership, operation);
    if (group.type !== 'family') throw new AppError(409, 'Operation requires a family group');

    const selected = await client.query<{ user_id: string; role: 'owner' | 'member' }>(
      `SELECT user_id, role FROM group_members
       WHERE group_id = $1 AND user_id = $2 AND status = 'active'
       FOR UPDATE`, [groupId, targetUserId],
    );
    const target = selected.rows[0];
    if (!target) throw new AppError(404, 'Member not found');
    if (target.role === 'owner') throw new AppError(409, 'Owner must transfer ownership before leaving');

    // The shared group lock coordinates this check with generation and share
    // confirmation. Only this member's pending share of a pending parent blocks.
    const obligations = await client.query<{ has_pending_shares: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM payment_shares ps
         JOIN payments p ON p.id = ps.payment_id
         JOIN subscriptions s ON s.id = p.subscription_id
         WHERE s.group_id = $1 AND ps.user_id = $2
           AND ps.status = 'pending' AND p.status = 'pending'
       ) AS has_pending_shares`, [groupId, targetUserId],
    );
    if (obligations.rows[0].has_pending_shares) throw new AppError(409, 'Member has pending payment shares');

    const updated = await client.query<{ user_id: string }>(
      `UPDATE group_members SET status = 'removed'
       WHERE group_id = $1 AND user_id = $2 AND status = 'active' AND role = 'member'
       RETURNING user_id`, [groupId, targetUserId],
    );
    if (updated.rows.length !== 1) throw new AppError(409, 'Member could not be removed');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
