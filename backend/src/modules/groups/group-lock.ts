import type { PoolClient } from 'pg';
import { AppError } from '../../middleware/errorHandler';

export async function lockGroupForWrite(
  client: Pick<PoolClient, 'query'>,
  groupId: string,
): Promise<{ type: 'personal' | 'family' }> {
  const result = await client.query<{ type: 'personal' | 'family' }>(
    'SELECT type FROM groups WHERE id = $1 FOR UPDATE', [groupId],
  );
  const group = result.rows[0];
  if (!group) throw new AppError(403, 'Forbidden');
  return group;
}
