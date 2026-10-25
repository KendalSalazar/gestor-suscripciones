import { pool } from '../../db/pool';
import { subscriptionLogger } from '../../config/logger';
import { AppError } from '../../middleware/errorHandler';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { lockGroupForWrite } from '../groups/group-lock';
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
  database: Pick<PoolClient, 'query'> = pool,
): Promise<QueryResult<Row>> {
  try {
    return await database.query<Row>(sql, values);
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await getActiveMembership(userId, groupId, 'create', client);
    await lockGroupForWrite(client, groupId);
    const membership = await getActiveMembership(userId, groupId, 'create', client);
    assertOwner(membership, 'create');

    const result = await subscriptionQuery<SubscriptionRow>(
      'create',
      `INSERT INTO subscriptions (
         group_id, name, provider, expected_cost, billing_cycle, next_billing_date, billing_anchor_day
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${subscriptionColumns}`,
      [
        groupId,
        input.name,
        input.provider,
        input.expectedCost,
        input.billingCycle,
        input.nextBillingDate,
        Number(input.nextBillingDate.slice(8, 10)),
      ],
      client,
    );

    const subscription = toSubscription(result.rows[0]);
    await client.query('COMMIT');
    subscriptionLogger.info('Subscription created', {
      userId,
      groupId,
      subscriptionId: subscription.id,
    });
    return subscription;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSubscription(
  userId: string,
  groupId: string,
  subscriptionId: string,
  input: UpdateSubscriptionInput,
): Promise<Subscription> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await getActiveMembership(userId, groupId, 'update', client);
    await lockGroupForWrite(client, groupId);
    const membership = await getActiveMembership(userId, groupId, 'update', client);
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

    if (input.nextBillingDate !== undefined) {
      // An explicit date edit establishes a new reference day without timezone conversion.
      values.push(Number(input.nextBillingDate.slice(8, 10)));
      assignments.push(`billing_anchor_day = $${values.length}`);
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
      client,
    );

    const row = result.rows[0];
    if (!row) {
      throw new AppError(404, 'Subscription not found');
    }

    const subscription = toSubscription(row);
    await client.query('COMMIT');
    subscriptionLogger.info('Subscription updated', { userId, groupId, subscriptionId });
    return subscription;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSubscription(
  userId: string,
  groupId: string,
  subscriptionId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await getActiveMembership(userId, groupId, 'delete', client);
    await lockGroupForWrite(client, groupId);
    const membership = await getActiveMembership(userId, groupId, 'delete', client);
    assertOwner(membership, 'delete');

    let result: QueryResult<{ id: string }>;
    try {
      result = await subscriptionQuery<{ id: string }>(
        'delete',
        `DELETE FROM subscriptions
         -- Keep deletes scoped to the authorized group as well as the subscription id.
         WHERE group_id = $1 AND id = $2
         RETURNING id`,
        [groupId, subscriptionId],
        client,
      );
    } catch (error) {
      if (typeof error === 'object' && error !== null
        && 'code' in error && error.code === '23503'
        && 'constraint' in error && error.constraint === 'payments_subscription_id_fkey') {
        throw new AppError(409, 'Subscription has payment history; deactivate it instead');
      }
      throw error;
    }

    if (!result.rows[0]) {
      throw new AppError(404, 'Subscription not found');
    }

    await client.query('COMMIT');
    subscriptionLogger.info('Subscription deleted', { userId, groupId, subscriptionId });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
