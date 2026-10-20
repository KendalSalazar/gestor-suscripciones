import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

describeWithDatabase('payment generation with PostgreSQL', () => {
  let database: Pool;
  let runDuePayments: typeof import('./payment-generation.service').runDuePayments;
  let userId: string | undefined;
  let groupId: string | undefined;
  let subscriptionId: string | undefined;

  beforeAll(async () => {
    const databaseModule = await import('../../db/pool');
    database = databaseModule.pool;
    ({ runDuePayments } = await import('./payment-generation.service'));

    const user = await database.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3) RETURNING id`,
      [`phase4-test-${randomUUID()}@example.com`, 'unused-test-hash', 'Phase 4 Test'],
    );
    userId = user.rows[0].id;

    const group = await database.query<{ id: string }>(
      `INSERT INTO groups (name, type, owner_id)
       VALUES ($1, 'personal', $2) RETURNING id`,
      ['Phase 4 Test', userId],
    );
    groupId = group.rows[0].id;

    await database.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'owner', 'active', NOW())`,
      [groupId, userId],
    );

    const subscription = await database.query<{ id: string }>(
      `INSERT INTO subscriptions (
         group_id, name, provider, expected_cost, billing_cycle, next_billing_date
       ) VALUES ($1, $2, $3, $4, 'monthly', $5) RETURNING id`,
      [groupId, 'Phase 4 Test', 'Test', '17.99', '2026-08-15'],
    );
    subscriptionId = subscription.rows[0].id;
  });

  afterAll(async () => {
    if (!database) return;
    try {
      if (subscriptionId) {
        await database.query('DELETE FROM payments WHERE subscription_id = $1', [subscriptionId]);
        await database.query('DELETE FROM subscriptions WHERE id = $1', [subscriptionId]);
      }
      if (groupId) {
        await database.query('DELETE FROM group_members WHERE group_id = $1', [groupId]);
        await database.query('DELETE FROM groups WHERE id = $1', [groupId]);
      }
      if (userId) {
        await database.query('DELETE FROM users WHERE id = $1', [userId]);
      }
    } finally {
      await database.end();
    }
  });

  it('creates due payments and advances the billing date together', async () => {
    const result = await runDuePayments('2026-10-15', subscriptionId);
    expect(result).toEqual({
      subscriptionsProcessed: 1,
      paymentsCreated: 3,
      subscriptionsStillDue: 0,
    });

    const payments = await database.query<{ expected_date: string; expected_amount: string }>(
      `SELECT expected_date::text AS expected_date, expected_amount
       FROM payments WHERE subscription_id = $1 ORDER BY expected_date`,
      [subscriptionId],
    );
    expect(payments.rows).toEqual([
      { expected_date: '2026-08-15', expected_amount: '17.99' },
      { expected_date: '2026-09-15', expected_amount: '17.99' },
      { expected_date: '2026-10-15', expected_amount: '17.99' },
    ]);

    const subscription = await database.query<{
      next_billing_date: string;
      billing_anchor_day: number;
    }>(
      `SELECT next_billing_date::text AS next_billing_date, billing_anchor_day
       FROM subscriptions WHERE id = $1`,
      [subscriptionId],
    );
    expect(subscription.rows[0]).toEqual({
      next_billing_date: '2026-11-15',
      billing_anchor_day: 15,
    });
  });

  it('does not duplicate payments when run again', async () => {
    const result = await runDuePayments('2026-10-15', subscriptionId);
    expect(result.paymentsCreated).toBe(0);

    const count = await database.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM payments WHERE subscription_id = $1',
      [subscriptionId],
    );
    expect(count.rows[0].count).toBe('3');
  });

  it('ignores an inactive subscription even when its date is due', async () => {
    await database.query(
      `UPDATE subscriptions SET active = FALSE, next_billing_date = DATE '2026-10-15'
       WHERE id = $1`,
      [subscriptionId],
    );

    const result = await runDuePayments('2026-10-15', subscriptionId);
    expect(result.subscriptionsProcessed).toBe(0);
    expect(result.paymentsCreated).toBe(0);

    const date = await database.query<{ next_billing_date: string }>(
      'SELECT next_billing_date::text AS next_billing_date FROM subscriptions WHERE id = $1',
      [subscriptionId],
    );
    expect(date.rows[0].next_billing_date).toBe('2026-10-15');
  });

  it('rolls back an inserted payment if advancing the date fails', async () => {
    await database.query(
      `UPDATE subscriptions
       SET active = TRUE, next_billing_date = DATE '9999-12-31', billing_anchor_day = 31
       WHERE id = $1`,
      [subscriptionId],
    );

    await expect(runDuePayments('9999-12-31', subscriptionId))
      .rejects.toThrow('Billing date is out of range');

    const count = await database.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM payments WHERE subscription_id = $1',
      [subscriptionId],
    );
    expect(count.rows[0].count).toBe('3');
  });

  it('limits a long catch-up and continues it on the next run', async () => {
    await database.query(
      `UPDATE subscriptions
       SET active = TRUE, next_billing_date = DATE '2020-01-15', billing_anchor_day = 15
       WHERE id = $1`,
      [subscriptionId],
    );

    const firstRun = await runDuePayments('2026-10-15', subscriptionId);
    expect(firstRun).toEqual({
      subscriptionsProcessed: 1,
      paymentsCreated: 24,
      subscriptionsStillDue: 1,
    });

    const secondRun = await runDuePayments('2026-10-15', subscriptionId);
    expect(secondRun).toEqual({
      subscriptionsProcessed: 1,
      paymentsCreated: 24,
      subscriptionsStillDue: 1,
    });

    const date = await database.query<{ next_billing_date: string }>(
      'SELECT next_billing_date::text AS next_billing_date FROM subscriptions WHERE id = $1',
      [subscriptionId],
    );
    expect(date.rows[0].next_billing_date).toBe('2024-01-15');
  });
});
