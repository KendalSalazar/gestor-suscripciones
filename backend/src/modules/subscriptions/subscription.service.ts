import { pool } from '../../db/pool';
import { subscriptionLogger } from '../../config/logger';
import { AppError } from '../../middleware/errorHandler';
import type { QueryResult, QueryResultRow } from 'pg';
import { assertOwner, getActiveMembership } from './membership';
import type { CreateSubscriptionInput, UpdateSubscriptionInput } from './subscription.schemas';
import type { Subscription, SubscriptionRow } from './subscription.types';
import { toSubscription } from './subscription.types';

export type SubscriptionFilters = {
  active?: boolean;
};

const subscriptionColumns = `
  id,
  group_id,
  name,
  provider,
  expected_cost,
  billing_cycle,
  next_billing_date,
  active,
  created_at
`;

async function subscriptionQuery<Row extends QueryResultRow>(
  operation: string,
  sql: string,
  values: unknown[],
): Promise<QueryResult<Row>> {
  try {
    return await pool.query<Row>(sql, values);
  } catch (error) {
    subscriptionLogger.error('Subscription database operation failed', {
      operation,
      code: typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
      message: error instanceof Error ? error.message : 'Unknown database error',
    });
    throw error;
  }
}

export async function listSubscriptions(
  userId: string,
  groupId: string,
  filters: SubscriptionFilters = {},
): Promise<Subscription[]> {
  await getActiveMembership(userId, groupId, 'list');

  const result = await subscriptionQuery<SubscriptionRow>(
    'list',
    `SELECT ${subscriptionColumns}
     FROM subscriptions
     -- Always scope subscription reads to the authorized group.
     WHERE group_id = $1
       AND ($2::boolean IS NULL OR active = $2)
     ORDER BY created_at DESC`,
    [groupId, filters.active ?? null],
  );

  return result.rows.map(toSubscription);
}

export async function getSubscription(
  userId: string,
  groupId: string,
  subscriptionId: string,
): Promise<Subscription> {
  await getActiveMembership(userId, groupId, 'get');

  const result = await subscriptionQuery<SubscriptionRow>(
    'get',
    `SELECT ${subscriptionColumns}
     FROM subscriptions
     -- Pair the id with group_id so a guessed id cannot cross group boundaries.
     WHERE group_id = $1 AND id = $2`,
    [groupId, subscriptionId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new AppError(404, 'Subscription not found');
  }

  return toSubscription(row);
}

export async function createSubscription(
  userId: string,
  groupId: string,
  input: CreateSubscriptionInput,
): Promise<Subscription> {
  const membership = await getActiveMembership(userId, groupId, 'create');
  assertOwner(membership, 'create');

  const result = await subscriptionQuery<SubscriptionRow>(
    'create',
    `INSERT INTO subscriptions (
       group_id, name, provider, expected_cost, billing_cycle, next_billing_date
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${subscriptionColumns}`,
    [
      groupId,
      input.name,
      input.provider,
      input.expectedCost,
      input.billingCycle,
      input.nextBillingDate,
    ],
  );

  const subscription = toSubscription(result.rows[0]);
  subscriptionLogger.info('Subscription created', {
    userId,
    groupId,
    subscriptionId: subscription.id,
  });
  return subscription;
}

export async function updateSubscription(
  userId: string,
  groupId: string,
  subscriptionId: string,
  input: UpdateSubscriptionInput,
): Promise<Subscription> {
  const membership = await getActiveMembership(userId, groupId, 'update');
  assertOwner(membership, 'update');

  const allowedFields = [
    ['name', 'name'],
    ['provider', 'provider'],
    ['expectedCost', 'expected_cost'],
    ['billingCycle', 'billing_cycle'],
    ['nextBillingDate', 'next_billing_date'],
    ['active', 'active'],
  ] as const;
  const values: unknown[] = [groupId, subscriptionId];
  const assignments: string[] = [];

  for (const [inputField, column] of allowedFields) {
    const value = input[inputField];
    if (value !== undefined) {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
  }

  if (assignments.length === 0) {
    throw new AppError(400, 'At least one field must be provided');
  }

  const result = await subscriptionQuery<SubscriptionRow>(
    'update',
    `UPDATE subscriptions
     SET ${assignments.join(', ')}
     -- Keep writes scoped to the authorized group as well as the subscription id.
     WHERE group_id = $1 AND id = $2
     RETURNING ${subscriptionColumns}`,
    values,
  );

  const row = result.rows[0];
  if (!row) {
    throw new AppError(404, 'Subscription not found');
  }

  const subscription = toSubscription(row);
  subscriptionLogger.info('Subscription updated', { userId, groupId, subscriptionId });
  return subscription;
}

export async function deleteSubscription(
  userId: string,
  groupId: string,
  subscriptionId: string,
): Promise<void> {
  const membership = await getActiveMembership(userId, groupId, 'delete');
  assertOwner(membership, 'delete');

  const result = await subscriptionQuery<{ id: string }>(
    'delete',
    `DELETE FROM subscriptions
     -- Keep deletes scoped to the authorized group as well as the subscription id.
     WHERE group_id = $1 AND id = $2
     RETURNING id`,
    [groupId, subscriptionId],
  );

  if (!result.rows[0]) {
    throw new AppError(404, 'Subscription not found');
  }

  subscriptionLogger.info('Subscription deleted', { userId, groupId, subscriptionId });
}
