import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
const migrationDirectory = path.join(__dirname, 'migrations');
const migration008 = fs.readFileSync(path.join(migrationDirectory, '008_create_payment_shares.sql'), 'utf8');

type ShareInput = {
  paymentId: string;
  userId: string;
  shareAmount: string;
  sharePercentage: string;
  actualAmount: string | null;
  status: 'pending' | 'confirmed' | 'skipped';
  confirmedAt: string | null;
};

describeWithDatabase('migration 008 with PostgreSQL in an isolated schema', () => {
  let database: Pool;
  let client: PoolClient;
  const schema = `phase5_test_${randomUUID().replaceAll('-', '')}`;
  const prefix = `phase5-test-${randomUUID()}`;
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const personalId = randomUUID();
  const familyId = randomUUID();
  const personalSubscriptionId = randomUUID();
  const familySubscriptionId = randomUUID();
  const familyPaymentId = randomUUID();
  const confirmedAt = '2090-01-02T12:00:00.000Z';

  beforeAll(async () => {
    database = (await import('./pool')).pool;
    client = await database.connect();
    if (!/^phase5_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", pg_catalog`);
    await client.query('BEGIN');
    try {
      for (const filename of fs.readdirSync(migrationDirectory).filter((name) => /^00[1-7]_.*\.sql$/.test(name)).sort()) {
        const source = fs.readFileSync(path.join(migrationDirectory, filename), 'utf8');
        // PostgreSQL 16 supplies gen_random_uuid natively: do not touch extensions.
        const sql = source.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\r?\n/, '');
        await client.query(sql);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    for (const [id, label] of [[ownerId, 'owner'], [memberId, 'member']]) {
      await client.query(
        'INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)',
        [id, `${prefix}-${label}@example.com`, 'unused-test-hash', `${prefix}-${label}`],
      );
    }
    for (const [id, type, subscriptionId] of [[personalId, 'personal', personalSubscriptionId], [familyId, 'family', familySubscriptionId]]) {
      await client.query(
        'INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, $3, $4)', [id, prefix, type, ownerId],
      );
      await client.query(
        `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
         VALUES ($1, $2, 'owner', 'active', NOW())`, [id, ownerId],
      );
      await client.query(
        `INSERT INTO subscriptions (
           id, group_id, name, provider, expected_cost, billing_cycle, next_billing_date, active
         ) VALUES ($1, $2, $3, 'Test', '10.00', 'monthly', '9999-12-31', FALSE)`, [subscriptionId, id, prefix],
      );
    }
    await client.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'member', 'active', NOW())`, [familyId, memberId],
    );
    await client.query(
      `INSERT INTO payments (subscription_id, expected_date, expected_amount, actual_amount, status, price_changed, resolved_at)
       VALUES ($1, '2090-01-01', '10.00', NULL, 'pending', FALSE, NULL),
              ($1, '2090-02-01', '10.00', '11.25', 'confirmed', TRUE, $2::timestamptz),
              ($1, '2090-03-01', '10.00', NULL, 'skipped', FALSE, $2::timestamptz)`, [personalSubscriptionId, confirmedAt],
    );
    await client.query(
      `INSERT INTO payments (id, subscription_id, expected_date, expected_amount)
       VALUES ($1, $2, '2090-01-01', '10.00')`, [familyPaymentId, familySubscriptionId],
    );
  });

  afterEach(async () => {
    if (client) await client.query('ROLLBACK');
  });

  afterAll(async () => {
    try {
      if (client) {
        await client.query('ROLLBACK');
        await client.query('RESET search_path');
        if (!/^phase5_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        const remaining = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM pg_namespace WHERE nspname = $1', [schema],
        );
        expect(remaining.rows[0].count).toBe('0');
      }
    } finally {
      client?.release();
      if (database) await database.end();
    }
  });

  async function expectRejected(operation: () => Promise<unknown>, expected: Record<string, unknown>) {
    await client.query('SAVEPOINT rejected_operation');
    let failure: unknown;
    try {
      await operation();
    } catch (error) {
      failure = error;
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT rejected_operation');
      await client.query('RELEASE SAVEPOINT rejected_operation');
    }
    expect(failure).toMatchObject(expected);
  }

  async function insertShare(overrides: Partial<ShareInput> = {}) {
    const input: ShareInput = {
      paymentId: familyPaymentId, userId: memberId,
      shareAmount: '3.33', sharePercentage: '33.3333', actualAmount: null, status: 'pending', confirmedAt: null,
      ...overrides,
    };
    const result = await client.query<{
      id: string; share_amount: string; share_percentage: string; actual_amount: string | null;
      status: string; confirmed_at: Date | null;
    }>(
      `INSERT INTO payment_shares (payment_id, user_id, share_amount, share_percentage, actual_amount, status, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
       RETURNING id, share_amount, share_percentage, actual_amount, status, confirmed_at`,
      [input.paymentId, input.userId, input.shareAmount, input.sharePercentage, input.actualAmount, input.status, input.confirmedAt],
    );
    return result.rows[0];
  }

  it('preserves every field of preexisting personal payments without a share backfill', async () => {
    const snapshots = () => client.query(
      'SELECT id, to_jsonb(p)::text AS snapshot FROM payments p WHERE subscription_id = $1 ORDER BY id', [personalSubscriptionId],
    );
    const before = await snapshots();
    expect(before.rowCount).toBe(3);
    await client.query(migration008);
    expect((await snapshots()).rows).toEqual(before.rows);
    expect((await client.query('SELECT COUNT(*)::text AS count FROM payment_shares')).rows).toEqual([{ count: '0' }]);
  });

  it('keeps personal insertion, confirmation and skipping valid without creating shares', async () => {
    await client.query(migration008);
    const pending = await client.query<{ id: string }>(
      `INSERT INTO payments (subscription_id, expected_date, expected_amount)
       VALUES ($1, '2090-04-01', '17.99') RETURNING id`, [personalSubscriptionId],
    );
    const confirmed = await client.query(
      `UPDATE payments SET actual_amount = '17.99', status = 'confirmed', resolved_at = $2::timestamptz
       WHERE id = $1 RETURNING actual_amount, status`, [pending.rows[0].id, confirmedAt],
    );
    expect(confirmed.rows).toEqual([{ actual_amount: '17.99', status: 'confirmed' }]);
    const skipped = await client.query(
      `UPDATE payments SET status = 'skipped', resolved_at = $2::timestamptz
       WHERE subscription_id = $1 AND expected_date = '2090-01-01' RETURNING status`, [personalSubscriptionId, confirmedAt],
    );
    expect(skipped.rows).toEqual([{ status: 'skipped' }]);
    expect((await client.query('SELECT COUNT(*)::text AS count FROM payment_shares')).rows).toEqual([{ count: '0' }]);
  });

  it('defaults to pending with generated identity, timestamp and null resolution fields', async () => {
    await client.query(migration008);
    const result = await client.query<{
      id: string; status: string; actual_amount: string | null; confirmed_at: Date | null; created_at: Date;
    }>(
      `INSERT INTO payment_shares (payment_id, user_id, share_amount, share_percentage)
       VALUES ($1, $2, '3.34', '33.3334') RETURNING id, status, actual_amount, confirmed_at, created_at`, [familyPaymentId, memberId],
    );
    expect(result.rows[0]).toMatchObject({ status: 'pending', actual_amount: null, confirmed_at: null });
    expect(result.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.rows[0].created_at).toBeInstanceOf(Date);
  });

  it.each(['pending', 'confirmed', 'skipped'] as const)('accepts coherent state %s and returns decimal strings', async (status) => {
    await client.query(migration008);
    const share = await insertShare({ status, actualAmount: status === 'confirmed' ? '4.25' : null, confirmedAt: status === 'confirmed' ? confirmedAt : null });
    expect(share).toMatchObject({ share_amount: '3.33', share_percentage: '33.3333', actual_amount: status === 'confirmed' ? '4.25' : null, status });
    expect(share.confirmed_at?.toISOString() ?? null).toBe(status === 'confirmed' ? confirmedAt : null);
  });

  it.each([
    ['zero amounts and percentage', { shareAmount: '0.00', sharePercentage: '0.0000', actualAmount: '0.00' }],
    ['maximum monetary amounts and full percentage', { shareAmount: '9999999999.99', sharePercentage: '100.0000', actualAmount: '9999999999.99' }],
  ] as [string, Partial<ShareInput>][])('accepts %s', async (_label, input) => {
    await client.query(migration008);
    const share = await insertShare({ ...input, status: 'confirmed', confirmedAt });
    expect(share.share_amount).toBe(input.shareAmount);
    expect(share.share_percentage).toBe(input.sharePercentage);
    expect(share.actual_amount).toBe(input.actualAmount);
  });

  const invalidRows: [string, Partial<ShareInput>, string][] = [
    ['negative expected amount', { shareAmount: '-0.01' }, 'payment_shares_share_amount_valid'],
    ['NaN expected amount', { shareAmount: 'NaN' }, 'payment_shares_share_amount_valid'],
    ['negative actual amount', { status: 'confirmed', actualAmount: '-0.01', confirmedAt }, 'payment_shares_actual_amount_valid'],
    ['NaN actual amount', { status: 'confirmed', actualAmount: 'NaN', confirmedAt }, 'payment_shares_actual_amount_valid'],
    ['negative percentage', { sharePercentage: '-0.0001' }, 'payment_shares_percentage_valid'],
    ['percentage greater than 100', { sharePercentage: '100.0001' }, 'payment_shares_percentage_valid'],
    ['NaN percentage', { sharePercentage: 'NaN' }, 'payment_shares_percentage_valid'],
    ['pending with actual amount', { actualAmount: '3.33' }, 'payment_shares_state_consistent'],
    ['pending with confirmation date', { confirmedAt }, 'payment_shares_state_consistent'],
    ['skipped with actual amount', { status: 'skipped', actualAmount: '3.33' }, 'payment_shares_state_consistent'],
    ['skipped with confirmation date', { status: 'skipped', confirmedAt }, 'payment_shares_state_consistent'],
    ['confirmed without actual amount', { status: 'confirmed', confirmedAt }, 'payment_shares_state_consistent'],
    ['confirmed without confirmation date', { status: 'confirmed', actualAmount: '3.33' }, 'payment_shares_state_consistent'],
  ];
  it.each(invalidRows)('rejects %s', async (_label, input, constraint) => {
    await client.query(migration008);
    await expectRejected(() => insertShare(input), { code: '23514', constraint });
  });

  it.each([
    ['expected amount beyond precision', { shareAmount: '10000000000.00' }],
    ['actual amount beyond precision', { status: 'confirmed', actualAmount: '10000000000.00', confirmedAt }],
    ['infinite expected amount', { shareAmount: 'Infinity' }],
    ['infinite percentage', { sharePercentage: 'Infinity' }],
  ] as [string, Partial<ShareInput>][])('rejects %s', async (_label, input) => {
    await client.query(migration008);
    await expectRejected(() => insertShare(input), { code: '22003' });
  });

  it('rejects a null status rather than letting null bypass state checks', async () => {
    await client.query(migration008);
    await expectRejected(() => client.query(
      `INSERT INTO payment_shares (payment_id, user_id, share_amount, share_percentage, status)
       VALUES ($1, $2, '3.33', '33.3333', NULL)`, [familyPaymentId, memberId],
    ), { code: '23502', column: 'status' });
  });

  it('rejects a second share for the same payment and user', async () => {
    await client.query(migration008);
    await insertShare();
    await expectRejected(() => insertShare(), { code: '23505', constraint: 'payment_shares_payment_user_unique' });
  });

  it('allows different users on a payment and the same user on different payments', async () => {
    await client.query(migration008);
    const first = await insertShare();
    const second = await insertShare({ userId: ownerId });
    const otherPayment = await client.query<{ id: string }>(
      `INSERT INTO payments (subscription_id, expected_date, expected_amount)
       VALUES ($1, '2090-02-01', '10.00') RETURNING id`, [familySubscriptionId],
    );
    const third = await insertShare({ paymentId: otherPayment.rows[0].id });
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  });

  it.each([
    ['payment', { paymentId: randomUUID() }, 'payment_shares_payment_id_fkey'],
    ['user', { userId: randomUUID() }, 'payment_shares_user_id_fkey'],
  ] as [string, Partial<ShareInput>, string][])('rejects a missing referenced %s', async (_label, input, constraint) => {
    await client.query(migration008);
    await expectRejected(() => insertShare(input), { code: '23503', constraint });
  });

  it.each([
    ['payment', 'DELETE FROM payments WHERE id = $1', familyPaymentId, 'payment_shares_payment_id_fkey'],
    ['user', 'DELETE FROM users WHERE id = $1', memberId, 'payment_shares_user_id_fkey'],
  ])('restricts deleting a %s and retains its share', async (_label, sql, id, constraint) => {
    await client.query(migration008);
    const share = await insertShare();
    await expectRejected(() => client.query(sql, [id]), { code: '23503', constraint });
    expect((await client.query('SELECT id FROM payment_shares WHERE id = $1', [share.id])).rows).toEqual([{ id: share.id }]);
  });

  it('rolls back all migration objects and leaves personal payments untouched', async () => {
    await client.query('SAVEPOINT before_008');
    await client.query(migration008);
    await insertShare();
    await client.query('ROLLBACK TO SAVEPOINT before_008');
    await client.query('RELEASE SAVEPOINT before_008');
    const objects = await client.query<{ table_present: boolean; enum_present: boolean }>(
      `SELECT to_regclass('payment_shares') IS NOT NULL AS table_present,
              EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                      WHERE n.nspname = $1 AND t.typname = 'payment_share_status') AS enum_present`, [schema],
    );
    expect(objects.rows).toEqual([{ table_present: false, enum_present: false }]);
    expect((await client.query('SELECT COUNT(*)::text AS count FROM payments WHERE subscription_id = $1', [personalSubscriptionId])).rows).toEqual([{ count: '3' }]);
  });
});
