import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

type PaymentInput = {
  subscriptionId: string;
  expectedDate: string;
  expectedAmount: string;
  actualAmount: string | null;
  status: 'pending' | 'confirmed' | 'skipped';
  priceChanged: boolean;
  resolvedAt: string | null;
};

describeWithDatabase('migration 006 constraints with PostgreSQL', () => {
  let database: Pool;
  const prefix = `phase4-constraints-${randomUUID()}`;
  const ownerId = randomUUID();
  const groupId = randomUUID();
  const subscriptionIds = [randomUUID(), randomUUID()];
  const paymentIds: string[] = [];
  const resolvedAt = '2090-01-02T12:00:00.000Z';
  let paymentSequence = 0;

  beforeAll(async () => {
    database = (await import('../../db/pool')).pool;
    const migration = await database.query(
      'SELECT filename FROM schema_migrations WHERE filename = $1', ['006_create_payments.sql'],
    );
    if (migration.rows.length !== 1) throw new Error('Apply migration 006 before running database tests');

    await database.query(
      'INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)',
      [ownerId, `${prefix}@example.com`, 'unused-test-hash', prefix],
    );
    await database.query(
      "INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, 'personal', $3)",
      [groupId, prefix, ownerId],
    );
    await database.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'owner', 'active', NOW())`, [groupId, ownerId],
    );
    for (const id of subscriptionIds) {
      await database.query(
        `INSERT INTO subscriptions (
           id, group_id, name, provider, expected_cost, billing_cycle,
           next_billing_date, billing_anchor_day, active
         ) VALUES ($1, $2, $3, 'Test', '17.99', 'monthly', '9999-12-31', 31, FALSE)`,
        [id, groupId, prefix],
      );
    }
  });

  afterAll(async () => {
    if (!database) return;
    try {
      // UUID lists belong exclusively to this suite, including partially created fixtures.
      await database.query('DELETE FROM payments WHERE id = ANY($1::uuid[])', [paymentIds]);
      await database.query('DELETE FROM subscriptions WHERE id = ANY($1::uuid[])', [subscriptionIds]);
      await database.query('DELETE FROM group_members WHERE group_id = $1', [groupId]);
      await database.query('DELETE FROM groups WHERE id = $1', [groupId]);
      await database.query('DELETE FROM users WHERE id = $1', [ownerId]);
      const remaining = await database.query<{ count: string }>(
        `SELECT (
           (SELECT COUNT(*) FROM payments WHERE id = ANY($1::uuid[])) +
           (SELECT COUNT(*) FROM subscriptions WHERE id = ANY($2::uuid[])) +
           (SELECT COUNT(*) FROM group_members WHERE group_id = $3) +
           (SELECT COUNT(*) FROM groups WHERE id = $3) +
           (SELECT COUNT(*) FROM users WHERE id = $4)
         )::text AS count`, [paymentIds, subscriptionIds, groupId, ownerId],
      );
      expect(remaining.rows[0].count).toBe('0');
    } finally {
      await database.end();
    }
  });

  async function insertPayment(overrides: Partial<PaymentInput> = {}) {
    const id = randomUUID();
    paymentIds.push(id);
    paymentSequence += 1;
    const input: PaymentInput = {
      subscriptionId: subscriptionIds[0],
      expectedDate: new Date(Date.UTC(2090, 0, paymentSequence)).toISOString().slice(0, 10),
      expectedAmount: '17.99',
      actualAmount: null,
      status: 'pending',
      priceChanged: false,
      resolvedAt: null,
      ...overrides,
    };
    const result = await database.query<{
      id: string;
      expected_date: string;
      expected_amount: string;
      actual_amount: string | null;
      status: string;
      price_changed: boolean;
      resolved_at: Date | null;
    }>(
      `INSERT INTO payments (
         id, subscription_id, expected_date, expected_amount,
         actual_amount, status, price_changed, resolved_at
       ) VALUES ($1, $2, $3::date, $4::numeric, $5::numeric, $6, $7, $8::timestamptz)
       RETURNING id, expected_date::text AS expected_date, expected_amount,
                 actual_amount, status, price_changed, resolved_at`,
      [id, input.subscriptionId, input.expectedDate, input.expectedAmount,
        input.actualAmount, input.status, input.priceChanged, input.resolvedAt],
    );
    return result.rows[0];
  }

  it('rejects duplicate subscription/date pairs', async () => {
    const payment = await insertPayment();
    await expect(insertPayment({ expectedDate: payment.expected_date })).rejects.toMatchObject({
      code: '23505', constraint: 'payments_subscription_date_unique',
    });
  });

  it('allows the same date on different subscriptions', async () => {
    const payment = await insertPayment();
    const other = await insertPayment({ subscriptionId: subscriptionIds[1], expectedDate: payment.expected_date });
    expect(other.id).not.toBe(payment.id);
    expect(other.expected_date).toBe(payment.expected_date);
  });

  const invalidAmounts: [string, Partial<PaymentInput>, string][] = [
    ['negative expected amount', { expectedAmount: '-0.01' }, 'payments_expected_amount_non_negative'],
    ['negative actual amount', {
      actualAmount: '-0.01', status: 'confirmed', priceChanged: true, resolvedAt,
    }, 'payments_actual_amount_non_negative'],
  ];
  it.each(invalidAmounts)('rejects %s', async (_label, input, constraint) => {
    await expect(insertPayment(input)).rejects.toMatchObject({ code: '23514', constraint });
  });

  const inconsistentStates: [string, Partial<PaymentInput>][] = [
    ['pending with actual amount', { actualAmount: '17.99' }],
    ['pending with resolution date', { resolvedAt }],
    ['pending with price change', { priceChanged: true }],
    ['confirmed without actual amount', { status: 'confirmed', resolvedAt }],
    ['confirmed without resolution date', { status: 'confirmed', actualAmount: '17.99' }],
    ['equal confirmed amounts marked changed', {
      status: 'confirmed', actualAmount: '17.99', resolvedAt, priceChanged: true,
    }],
    ['different confirmed amounts marked unchanged', {
      status: 'confirmed', actualAmount: '19.99', resolvedAt,
    }],
    ['skipped with actual amount', { status: 'skipped', actualAmount: '0.00', resolvedAt }],
    ['skipped without resolution date', { status: 'skipped' }],
    ['skipped with price change', { status: 'skipped', priceChanged: true, resolvedAt }],
  ];
  it.each(inconsistentStates)('rejects %s', async (_label, input) => {
    await expect(insertPayment(input)).rejects.toMatchObject({
      code: '23514', constraint: 'payments_state_consistent',
    });
  });

  const validStates: [string, Partial<PaymentInput>][] = [
    ['zero pending amount', { expectedAmount: '0.00' }],
    ['zero confirmed amounts', { expectedAmount: '0.00', actualAmount: '0.00', status: 'confirmed', resolvedAt }],
    ['equal confirmed amounts', { actualAmount: '17.99', status: 'confirmed', resolvedAt }],
    ['higher confirmed amount', { actualAmount: '19.99', status: 'confirmed', priceChanged: true, resolvedAt }],
    ['lower confirmed amount', { actualAmount: '0.00', status: 'confirmed', priceChanged: true, resolvedAt }],
    ['skipped payment', { status: 'skipped', resolvedAt }],
  ];
  it.each(validStates)('accepts %s and preserves decimal values', async (_label, input) => {
    const stored = await insertPayment(input);
    expect(stored).toMatchObject({
      expected_amount: input.expectedAmount ?? '17.99',
      actual_amount: input.actualAmount ?? null,
      status: input.status ?? 'pending',
      price_changed: input.priceChanged ?? false,
    });
    expect(stored.resolved_at?.toISOString() ?? null).toBe(input.resolvedAt ?? null);
  });

  it('rejects a payment without an existing subscription', async () => {
    await expect(insertPayment({ subscriptionId: randomUUID() })).rejects.toMatchObject({
      code: '23503', constraint: 'payments_subscription_id_fkey',
    });
  });

  it('restricts raw deletion of a subscription with payment history', async () => {
    const payment = await insertPayment();
    await expect(database.query('DELETE FROM subscriptions WHERE id = $1', [subscriptionIds[0]]))
      .rejects.toMatchObject({ code: '23503', constraint: 'payments_subscription_id_fkey' });
    const history = await database.query('SELECT id FROM payments WHERE id = $1', [payment.id]);
    expect(history.rows).toEqual([{ id: payment.id }]);
  });

  it.each([0, 32])('rejects billing anchor %s', async (anchor) => {
    await expect(database.query(
      'UPDATE subscriptions SET billing_anchor_day = $2 WHERE id = $1', [subscriptionIds[0], anchor],
    )).rejects.toMatchObject({ code: '23514', constraint: 'subscriptions_billing_anchor_day_valid' });
  });

  it.each([1, 31, null])('accepts billing anchor %s for migration compatibility', async (anchor) => {
    const result = await database.query<{ billing_anchor_day: number | null }>(
      `UPDATE subscriptions SET billing_anchor_day = $2 WHERE id = $1
       RETURNING billing_anchor_day`, [subscriptionIds[0], anchor],
    );
    expect(result.rows[0].billing_anchor_day).toBe(anchor);
  });
});
