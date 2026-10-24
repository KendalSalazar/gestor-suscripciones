import { subscriptionLogger } from '../../config/logger';
import { pool } from '../../db/pool';
import { AppError } from '../../middleware/errorHandler';
import type { Membership } from './subscription.types';
import type { PoolClient } from 'pg';

type MembershipRow = {
  group_id: string;
  user_id: string;
  role: 'owner' | 'member';
  status: 'active';
};

export async function getActiveMembership(
  userId: string,
  groupId: string,
  operation = 'subscription_access',
  database: Pick<PoolClient, 'query'> = pool,
): Promise<Membership> {
  const result = await database.query<MembershipRow>(
    `SELECT group_id, user_id, role, status
     FROM group_members
     WHERE user_id = $1 AND group_id = $2 AND status = 'active'`,
    [userId, groupId],
  );

  const membership = result.rows[0];
  if (!membership) {
    // Return the same 403 for a missing group and a non-member to avoid exposing group existence.
    subscriptionLogger.warn('Access denied', { userId, groupId, operation });
    throw new AppError(403, 'Forbidden');
  }

  return {
    groupId: membership.group_id,
    userId: membership.user_id,
    role: membership.role,
    status: membership.status,
  };
}

export function assertOwner(membership: Membership, operation = 'write'): void {
  if (membership.role !== 'owner') {
    subscriptionLogger.warn('Access denied', {
      userId: membership.userId,
      groupId: membership.groupId,
      operation,
    });
    throw new AppError(403, 'Forbidden');
  }
}
