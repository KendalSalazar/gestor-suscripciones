import { pool } from '../../db/pool';
import { AppError } from '../../middleware/errorHandler';
import { assertOwner, getActiveMembership } from '../subscriptions/membership';
import { lockGroupForWrite } from './group-lock';
import type { GroupInput } from './group.schemas';
import { toGroup, type Group, type GroupRow } from './group.types';

type GroupDataRow = Omit<GroupRow, 'role'>;

export async function listGroups(userId: string): Promise<Group[]> {
  const result = await pool.query<GroupRow>(
    `SELECT g.id, g.name, g.type, g.owner_id, gm.role, g.created_at
     FROM groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.user_id = $1 AND gm.status = 'active'
     ORDER BY CASE WHEN g.type = 'personal' THEN 0 ELSE 1 END,
              g.created_at ASC, g.id ASC`, [userId],
  );
  return result.rows.map(toGroup);
}

export async function createGroup(userId: string, input: GroupInput): Promise<Group> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<GroupDataRow>(
      `INSERT INTO groups (name, type, owner_id)
       VALUES ($1, 'family', $2)
       RETURNING id, name, type, owner_id, created_at`, [input.name, userId],
    );
    const group = inserted.rows[0];
    await client.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'owner', 'active', NOW())`, [group.id, userId],
    );
    const result = toGroup({ ...group, role: 'owner' });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateGroup(userId: string, groupId: string, input: GroupInput): Promise<Group> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await getActiveMembership(userId, groupId, 'update_group', client);
    const group = await lockGroupForWrite(client, groupId);
    const membership = await getActiveMembership(userId, groupId, 'update_group', client);
    assertOwner(membership, 'update_group');
    if (group.type !== 'family') throw new AppError(409, 'Operation requires a family group');

    const updated = await client.query<GroupDataRow>(
      `UPDATE groups
       SET name = $2
       WHERE id = $1 AND type = 'family'
       RETURNING id, name, type, owner_id, created_at`, [groupId, input.name],
    );
    const row = updated.rows[0];
    if (!row) throw new AppError(403, 'Forbidden');
    const result = toGroup({ ...row, role: membership.role });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
