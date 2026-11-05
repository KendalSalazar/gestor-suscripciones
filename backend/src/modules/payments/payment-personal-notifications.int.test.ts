import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { isolatedPool } = vi.hoisted(() => ({ isolatedPool: { value: undefined as Pool | undefined } }));
vi.mock('../../db/pool', () => ({
  get pool() {
    if (!isolatedPool.value) throw new Error('Isolated PostgreSQL pool is not ready');
    return isolatedPool.value;
  },
}));

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

describeWithDatabase('personal payment difference notifications with isolated PostgreSQL', () => {
  const schema = `phase6_test_${randomUUID().replaceAll('-', '')}`;
  const prefix = `phase6-test-${randomUUID()}`;
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const personalGroupId = randomUUID();
  const otherGroupId = randomUUID();
  const familyGroupId = randomUUID();
  const personalSubscriptionId = randomUUID();
  const familySubscriptionId = randomUUID();
  let admin: Pool;
  let database: Pool;
  let schemaCreated = false;
  let payments: typeof import('./payment.service');
  let sequence = 0;

  beforeAll(async () => {
    if (!/^phase6_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    const { env } = await import('../../config/env');
    admin = new Pool({ connectionString: env.databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const isolatedUrl = new URL(env.databaseUrl);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema},pg_catalog`);
    database = new Pool({ connectionString: isolatedUrl.toString(), max: 5, connectionTimeoutMillis: 5_000 });
    isolatedPool.value = database;

    const client = await database.connect();
    try {
      const current = await client.query<{ name: string }>('SELECT current_schema() AS name');
      if (current.rows[0].name !== schema) throw new Error('Unexpected PostgreSQL search_path');
      await client.query('BEGIN');
      const directory = path.join(__dirname, '../../db/migrations');
      for (const filename of fs.readdirSync(directory).filter((name) => /^00[1-9]_.*\.sql$/.test(name)).sort()) {
        const source = fs.readFileSync(path.join(directory, filename), 'utf8');
        // PostgreSQL 16 supplies gen_random_uuid; do not modify global extensions.
        await client.query(source.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\r?\n/, ''));
      }
      for (const [id, label] of [[ownerId, 'owner'], [memberId, 'member']]) {
        await client.query('INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)',
          [id, `${prefix}-${label}@example.com`, 'unused-test-hash', `${prefix}-${label}`]);
      }
      for (const [id, type, owner] of [
        [personalGroupId, 'personal', ownerId], [otherGroupId, 'personal', memberId], [familyGroupId, 'family', ownerId],
      ]) {
        await client.query('INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, $3, $4)',
          [id, prefix, type, owner]);
        await client.query(
          "INSERT INTO group_members (group_id, user_id, role, status, joined_at) VALUES ($1, $2, 'owner', 'active', NOW())",
          [id, owner],
        );
      }
      await client.query(
        "INSERT INTO group_members (group_id, user_id, role, status, joined_at) VALUES ($1, $2, 'member', 'active', NOW())",
        [personalGroupId, memberId],
      );
      for (const [id, groupId] of [
        [personalSubscriptionId, personalGroupId], [familySubscriptionId, familyGroupId],
      ]) {
        await client.query(
          `INSERT INTO subscriptions (id, group_id, name, provider, expected_cost, billing_cycle, next_billing_date, active)
           VALUES ($1, $2, $3, 'Test', '17.99', 'monthly', '9999-12-31', FALSE)`, [id, groupId, prefix],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    payments = await import('./payment.service');
  });

  afterAll(async () => {
    try {
      if (database) await database.end();
    } finally {
      isolatedPool.value = undefined;
      if (admin) {
        try {
          if (schemaCreated) {
            if (!/^phase6_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
            const remaining = await admin.query<{ count: string }>(
              'SELECT COUNT(*)::text AS count FROM pg_namespace WHERE nspname = $1', [schema],
            );
            expect(remaining.rows[0].count).toBe('0');
          }
        } finally {
          await admin.end();
        }
      }
    }
  });

  async function pendingPayment(expectedAmount = '17.99', subscriptionId = personalSubscriptionId): Promise<string> {
    const id = randomUUID();
    sequence += 1;
    await database.query(
      `INSERT INTO payments (id, subscription_id, expected_date, expected_amount)
       VALUES ($1, $2, (DATE '2090-01-01' + $3::integer), $4::numeric)`,
      [id, subscriptionId, sequence, expectedAmount],
    );
    return id;
  }

  async function notifications(paymentId: string) {
    return (await database.query<{ user_id: string; type: string; read_at: Date | null }>(
      'SELECT user_id, type, read_at FROM notifications WHERE payment_id = $1 ORDER BY type', [paymentId],
    )).rows;
  }

  it.each([
    ['default', '17.99', undefined, '17.99', false],
    ['equal decimal representation', '17.90', '17.9', '17.90', false],
    ['greater amount', '17.99', '18.00', '18.00', true],
    ['smaller amount', '17.99', '17.00', '17.00', true],
    ['zero instead of a positive amount', '17.99', '0', '0.00', true],
    ['equal zero amounts', '0.00', '0', '0.00', false],
  ] as const)('confirms %s and records a notice only for a difference', async (_name, expected, actual, stored, changed) => {
    const paymentId = await pendingPayment(expected);
    const result = await payments.confirmPayment(ownerId, personalGroupId, paymentId, actual);
    expect(result).toMatchObject({ status: 'confirmed', expectedAmount: expected, actualAmount: stored, priceChanged: changed });
    expect(await notifications(paymentId)).toEqual(changed
      ? [{ user_id: ownerId, type: 'amount_changed', read_at: null }]
      : []);
    const subscription = await database.query<{ expected_cost: string }>(
      'SELECT expected_cost FROM subscriptions WHERE id = $1', [personalSubscriptionId],
    );
    expect(subscription.rows[0].expected_cost).toBe('17.99');
  });

  it('skips without generating a difference notice', async () => {
    const paymentId = await pendingPayment();
    expect((await payments.skipPayment(ownerId, personalGroupId, paymentId)).status).toBe('skipped');
    expect(await notifications(paymentId)).toEqual([]);
  });

  it('keeps one notice when a confirmation is repeated or races another confirmation', async () => {
    const paymentId = await pendingPayment();
    const results = await Promise.allSettled([
      payments.confirmPayment(ownerId, personalGroupId, paymentId, '18.00'),
      payments.confirmPayment(ownerId, personalGroupId, paymentId, '18.00'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected'))
      .toMatchObject({ status: 'rejected', reason: { status: 409 } });
    await expect(payments.confirmPayment(ownerId, personalGroupId, paymentId, '18.00'))
      .rejects.toMatchObject({ status: 409 });
    expect(await notifications(paymentId)).toEqual([{ user_id: ownerId, type: 'amount_changed', read_at: null }]);
  });

  it('does not expose or mutate a payment or notice for unauthorized users', async () => {
    const paymentId = await pendingPayment();
    await expect(payments.confirmPayment(memberId, personalGroupId, paymentId, '18.00'))
      .rejects.toMatchObject({ status: 403 });
    await expect(payments.confirmPayment(memberId, otherGroupId, paymentId, '18.00'))
      .rejects.toMatchObject({ status: 404 });
    const stored = await database.query('SELECT status, actual_amount, price_changed FROM payments WHERE id = $1', [paymentId]);
    expect(stored.rows).toEqual([{ status: 'pending', actual_amount: null, price_changed: false }]);
    expect(await notifications(paymentId)).toEqual([]);
  });

  it('keeps direct family confirmation blocked without adding a notice', async () => {
    const paymentId = await pendingPayment('17.99', familySubscriptionId);
    await expect(payments.confirmPayment(ownerId, familyGroupId, paymentId, '18.00'))
      .rejects.toMatchObject({ status: 409 });
    expect(await notifications(paymentId)).toEqual([]);
    expect((await database.query('SELECT status FROM payments WHERE id = $1', [paymentId])).rows)
      .toEqual([{ status: 'pending' }]);
  });

  it('rolls back a confirmation if the difference notice fails, preserving earlier read history', async () => {
    const paymentId = await pendingPayment();
    await database.query(
      `INSERT INTO notifications (user_id, payment_id, type, read_at)
       VALUES ($1, $2, 'payment_due', '2090-01-02T12:00:00Z')`, [ownerId, paymentId],
    );
    const beforePayment = (await database.query('SELECT to_jsonb(p)::text AS snapshot FROM payments p WHERE id = $1', [paymentId])).rows;
    const beforeNotices = await notifications(paymentId);
    // The constraint exists only in this suite's private schema; older rows remain valid.
    await database.query(`ALTER TABLE notifications ADD CONSTRAINT phase6_forced_difference_failure
                          CHECK (type <> 'amount_changed'::notification_type) NOT VALID`);
    try {
      await expect(payments.confirmPayment(ownerId, personalGroupId, paymentId, '18.00')).rejects.toMatchObject({
        code: '23514', constraint: 'phase6_forced_difference_failure',
      });
      expect((await database.query('SELECT to_jsonb(p)::text AS snapshot FROM payments p WHERE id = $1', [paymentId])).rows)
        .toEqual(beforePayment);
      expect(await notifications(paymentId)).toEqual(beforeNotices);
    } finally {
      await database.query('ALTER TABLE notifications DROP CONSTRAINT phase6_forced_difference_failure');
    }

    expect((await payments.confirmPayment(ownerId, personalGroupId, paymentId, '18.00')).priceChanged).toBe(true);
    expect(await notifications(paymentId)).toEqual([
      { user_id: ownerId, type: 'payment_due', read_at: new Date('2090-01-02T12:00:00.000Z') },
      { user_id: ownerId, type: 'amount_changed', read_at: null },
    ]);
  });
});
