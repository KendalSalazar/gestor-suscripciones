import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
const migrationDirectory = path.join(__dirname, 'migrations');
const migration009 = fs.readFileSync(path.join(migrationDirectory, '009_create_notifications.sql'), 'utf8');

type NotificationType = 'payment_due' | 'payment_overdue' | 'amount_changed';

describeWithDatabase('migration 009 with PostgreSQL in an isolated schema', () => {
  let database: Pool;
  let client: PoolClient;
  let schemaCreated = false;
  const schema = `phase6_test_${randomUUID().replaceAll('-', '')}`;
  const prefix = `phase6-test-${randomUUID()}`;
  const ownerId = randomUUID();
  const memberId = randomUUID();
  // This user has no other references, so its DELETE tests the notification FK.
  const recipientId = randomUUID();
  const groupId = randomUUID();
  const subscriptionId = randomUUID();
  const pendingPaymentId = randomUUID();
  const confirmedPaymentId = randomUUID();

  beforeAll(async () => {
    database = (await import('./pool')).pool;
    client = await database.connect();
    if (!/^phase6_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    await client.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await client.query(`SET search_path TO "${schema}", pg_catalog`);
    await client.query('BEGIN');
    try {
      for (const filename of fs.readdirSync(migrationDirectory).filter((name) => /^00[1-8]_.*\.sql$/.test(name)).sort()) {
        const source = fs.readFileSync(path.join(migrationDirectory, filename), 'utf8');
        // PostgreSQL 16 supplies gen_random_uuid natively; do not alter extensions.
        await client.query(source.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\r?\n/, ''));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    for (const [id, label] of [[ownerId, 'owner'], [memberId, 'member'], [recipientId, 'recipient']]) {
      await client.query(
        'INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)',
        [id, `${prefix}-${label}@example.com`, 'unused-test-hash', `${prefix}-${label}`],
      );
    }
    await client.query(
      `INSERT INTO groups (id, name, type, owner_id)
       VALUES ($1, $2, 'family', $3)`, [groupId, prefix, ownerId],
    );
    await client.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'owner', 'active', NOW()), ($1, $3, 'member', 'active', NOW())`,
      [groupId, ownerId, memberId],
    );
    await client.query(
      `INSERT INTO subscriptions (id, group_id, name, provider, expected_cost, billing_cycle, next_billing_date, active)
       VALUES ($1, $2, $3, 'Test', '10.00', 'monthly', '9999-12-31', FALSE)`,
      [subscriptionId, groupId, prefix],
    );
    await client.query(
      `INSERT INTO payments (id, subscription_id, expected_date, expected_amount, actual_amount, status, price_changed, resolved_at)
       VALUES ($1, $3, '2090-01-01', '10.00', NULL, 'pending', FALSE, NULL),
              ($2, $3, '2090-02-01', '10.00', '10.25', 'confirmed', TRUE, '2090-02-02T12:00:00Z')`,
      [pendingPaymentId, confirmedPaymentId, subscriptionId],
    );
    await client.query(
      `INSERT INTO payment_shares (payment_id, user_id, share_amount, share_percentage)
       VALUES ($1, $2, '5.00', '50.0000'), ($1, $3, '5.00', '50.0000')`,
      [pendingPaymentId, ownerId, memberId],
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
        if (schemaCreated) {
          if (!/^phase6_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
          await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          const remaining = await client.query<{ count: string }>(
            'SELECT COUNT(*)::text AS count FROM pg_namespace WHERE nspname = $1', [schema],
          );
          expect(remaining.rows[0].count).toBe('0');
        }
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

  async function insertNotification(
    userId = ownerId,
    paymentId = pendingPaymentId,
    type: NotificationType = 'payment_due',
  ) {
    const result = await client.query<{ id: string; type: NotificationType; created_at: Date; read_at: Date | null }>(
      `INSERT INTO notifications (user_id, payment_id, type)
       VALUES ($1, $2, $3) RETURNING id, type, created_at, read_at`, [userId, paymentId, type],
    );
    return result.rows[0];
  }

  it('preserves existing records and does not backfill notifications', async () => {
    // Each table lives in the private schema and contains only this test's fixtures.
    const tables = ['users', 'groups', 'group_members', 'subscriptions', 'payments', 'payment_shares'];
    const snapshot = async () => {
      const rows: { row: string }[][] = [];
      for (const table of tables) {
        const result = await client.query<{ row: string }>(
          `SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
        );
        rows.push(result.rows);
      }
      return rows;
    };
    const before = await snapshot();
    expect(before.map((rows) => rows.length)).toEqual([3, 1, 2, 1, 2, 2]);
    await client.query(migration009);
    expect(await snapshot()).toEqual(before);
    expect((await client.query('SELECT COUNT(*)::text AS count FROM notifications')).rows).toEqual([{ count: '0' }]);
  });

  it('creates an identifier and timestamp while leaving read_at null', async () => {
    await client.query(migration009);
    const notification = await insertNotification();
    expect(notification.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(notification.type).toBe('payment_due');
    expect(notification.created_at).toBeInstanceOf(Date);
    expect(notification.read_at).toBeNull();
  });

  it.each(['payment_due', 'payment_overdue', 'amount_changed'] as const)('accepts type %s', async (type) => {
    await client.query(migration009);
    expect((await insertNotification(ownerId, pendingPaymentId, type)).type).toBe(type);
  });

  it('rejects a null or unknown type', async () => {
    await client.query(migration009);
    await expectRejected(() => client.query(
      'INSERT INTO notifications (user_id, payment_id, type) VALUES ($1, $2, NULL)', [ownerId, pendingPaymentId],
    ), { code: '23502', column: 'type' });
    await expectRejected(() => client.query(
      'INSERT INTO notifications (user_id, payment_id, type) VALUES ($1, $2, $3)', [ownerId, pendingPaymentId, 'unknown'],
    ), { code: '22P02' });
  });

  it.each(['user_id', 'payment_id'] as const)('requires %s', async (column) => {
    await client.query(migration009);
    await expectRejected(() => client.query(
      `INSERT INTO notifications (user_id, payment_id, type)
       VALUES ($1::uuid, $2::uuid, 'payment_due')`,
      [column === 'user_id' ? null : ownerId, column === 'payment_id' ? null : pendingPaymentId],
    ), { code: '23502', column });
  });

  it('allows different recipients, payments or types but rejects a duplicate triple', async () => {
    await client.query(migration009);
    const first = await insertNotification();
    await expectRejected(() => insertNotification(), { code: '23505', constraint: 'notifications_user_payment_type_unique' });
    const otherType = await insertNotification(ownerId, pendingPaymentId, 'payment_overdue');
    const otherUser = await insertNotification(memberId, pendingPaymentId);
    const otherPayment = await insertNotification(ownerId, confirmedPaymentId);
    expect(new Set([first.id, otherType.id, otherUser.id, otherPayment.id]).size).toBe(4);
  });

  it.each([
    ['user', 'notifications_user_id_fkey'],
    ['payment', 'notifications_payment_id_fkey'],
  ])('rejects a missing referenced %s', async (missing, constraint) => {
    await client.query(migration009);
    const userId = missing === 'user' ? randomUUID() : ownerId;
    const paymentId = missing === 'payment' ? randomUUID() : pendingPaymentId;
    await expectRejected(() => insertNotification(userId, paymentId), { code: '23503', constraint });
  });

  it('restricts deleting a referenced payment or user and retains the notification', async () => {
    await client.query(migration009);
    const notification = await insertNotification(recipientId, confirmedPaymentId);
    await expectRejected(() => client.query('DELETE FROM payments WHERE id = $1', [confirmedPaymentId]),
      { code: '23503', constraint: 'notifications_payment_id_fkey' });
    await expectRejected(() => client.query('DELETE FROM users WHERE id = $1', [recipientId]),
      { code: '23503', constraint: 'notifications_user_id_fkey' });
    expect((await client.query('SELECT id FROM notifications WHERE id = $1', [notification.id])).rows).toEqual([{ id: notification.id }]);
  });

  it('preserves millisecond cursor precision and orders equal timestamps by UUID', async () => {
    await client.query(migration009);
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ];
    const types: NotificationType[] = ['payment_due', 'payment_overdue', 'amount_changed'];
    for (const [index, id] of ids.entries()) {
      await client.query(
        `INSERT INTO notifications (id, user_id, payment_id, type, created_at, read_at)
         VALUES ($1, $2, $3, $4, '2090-01-01T12:00:00.123499Z', '2090-01-01T13:00:00.789499Z')`,
        [id, ownerId, pendingPaymentId, types[index]],
      );
    }
    const first = await client.query<{ id: string; created_at: Date; read_at: Date }>(
      `SELECT id, created_at, read_at FROM notifications
       WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [ownerId],
    );
    expect(first.rows[0].id).toBe(ids[2]);
    expect(first.rows[0].created_at.toISOString()).toBe('2090-01-01T12:00:00.123Z');
    expect(first.rows[0].read_at.toISOString()).toBe('2090-01-01T13:00:00.789Z');
    const next = await client.query<{ id: string }>(
      `SELECT id FROM notifications
       WHERE user_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid)
       ORDER BY created_at DESC, id DESC`,
      [ownerId, first.rows[0].created_at.toISOString(), first.rows[0].id],
    );
    expect(next.rows.map((row) => row.id)).toEqual([ids[1], ids[0]]);
  });

  it('creates the full and unread indexes for recipient and cursor order', async () => {
    await client.query(migration009);
    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'notifications'`, [schema],
    );
    const byName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.get('idx_notifications_user_created')).toContain('(user_id, created_at DESC, id DESC)');
    expect(byName.get('idx_notifications_user_unread_created')).toContain('(user_id, created_at DESC, id DESC)');
    expect(byName.get('idx_notifications_user_unread_created')).toContain('WHERE (read_at IS NULL)');
  });

  it('rolls back the migration objects and leaves prior records intact', async () => {
    await client.query('SAVEPOINT before_009');
    await client.query(migration009);
    await insertNotification();
    await client.query('ROLLBACK TO SAVEPOINT before_009');
    await client.query('RELEASE SAVEPOINT before_009');
    const objects = await client.query<{ table_present: boolean; enum_present: boolean }>(
      `SELECT to_regclass('notifications') IS NOT NULL AS table_present,
              EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                      WHERE n.nspname = $1 AND t.typname = 'notification_type') AS enum_present`, [schema],
    );
    expect(objects.rows).toEqual([{ table_present: false, enum_present: false }]);
    expect((await client.query('SELECT COUNT(*)::text AS count FROM payments')).rows).toEqual([{ count: '2' }]);
    expect((await client.query('SELECT COUNT(*)::text AS count FROM payment_shares')).rows).toEqual([{ count: '2' }]);
  });
});
