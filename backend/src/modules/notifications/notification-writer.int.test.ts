import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertPaymentNotifications } from './notification-writer';

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
const migrationDirectory = path.join(__dirname, '../../db/migrations');

describeWithDatabase('notification writer with PostgreSQL in an isolated schema', () => {
  let database: Pool;
  let client: PoolClient;
  let schemaCreated = false;
  const schema = `phase6_test_${randomUUID().replaceAll('-', '')}`;
  const prefix = `phase6-test-${randomUUID()}`;
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const groupId = randomUUID();
  const subscriptionId = randomUUID();
  const paymentId = randomUUID();
  const otherPaymentId = randomUUID();

  beforeAll(async () => {
    database = (await import('../../db/pool')).pool;
    client = await database.connect();
    if (!/^phase6_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    await client.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await client.query(`SET search_path TO "${schema}", pg_catalog`);
    await client.query('BEGIN');
    try {
      const migrations = fs.readdirSync(migrationDirectory)
        .filter((name) => /^00[1-9]_.*\.sql$/.test(name)).sort();
      for (const filename of migrations) {
        const source = fs.readFileSync(path.join(migrationDirectory, filename), 'utf8');
        await client.query(source.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\r?\n/, ''));
      }
      for (const [id, label] of [[ownerId, 'owner'], [memberId, 'member']]) {
        await client.query(
          'INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)',
          [id, `${prefix}-${label}@example.com`, 'unused-test-hash', `${prefix}-${label}`],
        );
      }
      await client.query(
        `INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, 'family', $3)`,
        [groupId, prefix, ownerId],
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
        `INSERT INTO payments (id, subscription_id, expected_date, expected_amount)
         VALUES ($1, $3, '2090-01-01', '10.00'), ($2, $3, '2090-02-01', '10.00')`,
        [paymentId, otherPaymentId, subscriptionId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

  beforeEach(async () => {
    await client.query('BEGIN');
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

  it('inserts each recipient once, including repeated UUIDs with different casing', async () => {
    const input = { paymentId, type: 'payment_due' as const,
      recipientIds: [memberId.toUpperCase(), ownerId, memberId, ownerId.toUpperCase()] };
    expect(await insertPaymentNotifications(client, input)).toBe(2);
    const stored = await client.query<{ user_id: string; type: string; read_at: Date | null }>(
      'SELECT user_id, type, read_at FROM notifications WHERE payment_id = $1 ORDER BY user_id', [paymentId],
    );
    expect(stored.rows).toEqual([ownerId, memberId].sort().map((user_id) => ({
      user_id, type: 'payment_due', read_at: null,
    })));
  });

  it('returns zero for an empty recipient list without querying', async () => {
    const noQueryClient = {
      query: () => { throw new Error('Unexpected query'); },
    } as unknown as PoolClient;
    expect(await insertPaymentNotifications(noQueryClient, {
      paymentId, type: 'payment_due', recipientIds: [],
    })).toBe(0);
  });

  it('preserves the read state on retry and allows other types or payments', async () => {
    const due = { paymentId, type: 'payment_due' as const, recipientIds: [ownerId] };
    expect(await insertPaymentNotifications(client, due)).toBe(1);
    await client.query(
      `UPDATE notifications SET read_at = '2090-01-01T12:00:00Z'
       WHERE payment_id = $1 AND user_id = $2 AND type = 'payment_due'`, [paymentId, ownerId],
    );
    const before = await client.query('SELECT id, created_at, read_at FROM notifications');
    expect(await insertPaymentNotifications(client, due)).toBe(0);
    expect((await client.query('SELECT id, created_at, read_at FROM notifications')).rows).toEqual(before.rows);

    expect(await insertPaymentNotifications(client, { ...due, type: 'payment_overdue' })).toBe(1);
    expect(await insertPaymentNotifications(client, { ...due, paymentId: otherPaymentId })).toBe(1);
    expect((await client.query('SELECT COUNT(*)::integer AS count FROM notifications')).rows[0].count).toBe(3);
  });

  it('rolls back business data and notifications together on the same client', async () => {
    await client.query('SAVEPOINT business_operation');
    await client.query("UPDATE subscriptions SET expected_cost = '12.50' WHERE id = $1", [subscriptionId]);
    expect(await insertPaymentNotifications(client, {
      paymentId, type: 'amount_changed', recipientIds: [ownerId, memberId],
    })).toBe(2);
    await client.query('ROLLBACK TO SAVEPOINT business_operation');
    await client.query('RELEASE SAVEPOINT business_operation');
    expect((await client.query('SELECT expected_cost FROM subscriptions WHERE id = $1', [subscriptionId])).rows)
      .toEqual([{ expected_cost: '10.00' }]);
    expect((await client.query('SELECT COUNT(*)::integer AS count FROM notifications')).rows[0].count).toBe(0);
  });

  it('propagates a foreign-key failure and leaves no partial batch after rollback', async () => {
    await client.query('SAVEPOINT rejected_operation');
    await client.query("UPDATE subscriptions SET expected_cost = '12.50' WHERE id = $1", [subscriptionId]);
    await expect(insertPaymentNotifications(client, {
      paymentId, type: 'payment_due', recipientIds: [ownerId, randomUUID()],
    })).rejects.toMatchObject({ code: '23503', constraint: 'notifications_user_id_fkey' });
    await client.query('ROLLBACK TO SAVEPOINT rejected_operation');
    await client.query('RELEASE SAVEPOINT rejected_operation');
    expect((await client.query('SELECT expected_cost FROM subscriptions WHERE id = $1', [subscriptionId])).rows)
      .toEqual([{ expected_cost: '10.00' }]);
    expect((await client.query('SELECT COUNT(*)::integer AS count FROM notifications')).rows[0].count).toBe(0);
  });

  it('waits for an uncommitted batch when recipients arrive in reverse order', async () => {
    const first = await database.connect();
    let second: PoolClient | undefined;
    let secondInsertion: Promise<{ count: number } | { error: unknown }> | undefined;
    try {
      second = await database.connect();
      for (const target of [first, second]) {
        await target.query(`SET search_path TO "${schema}", pg_catalog`);
        await target.query('BEGIN');
        await target.query("SET LOCAL lock_timeout = '5s'");
      }

      const firstPid = (await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const secondPid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      expect(await insertPaymentNotifications(first, {
        paymentId, type: 'payment_due', recipientIds: [ownerId, memberId],
      })).toBe(2);

      // Keep the first transaction open and verify that PostgreSQL reports it
      // as the blocker before allowing it to commit.
      secondInsertion = insertPaymentNotifications(second, {
        paymentId, type: 'payment_due', recipientIds: [memberId, ownerId],
      }).then((count) => ({ count }), (error: unknown) => ({ error }));
      let blocked = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const state = await client.query<{ blocked: boolean }>(
          'SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked',
          [firstPid, secondPid],
        );
        if (state.rows[0].blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await first.query('COMMIT');
      expect(await secondInsertion).toEqual({ count: 0 });
      await second.query('COMMIT');
      expect((await client.query('SELECT COUNT(*)::integer AS count FROM notifications')).rows[0].count).toBe(2);
    } finally {
      try {
        await first.query('ROLLBACK').catch(() => undefined);
        if (secondInsertion) await secondInsertion;
        if (second) {
          await second.query('ROLLBACK').catch(() => undefined);
          // Qualify the private schema even if a search_path setup failed.
          await second.query(`DELETE FROM "${schema}".notifications WHERE payment_id = $1`, [paymentId]);
          await second.query('RESET search_path');
        }
        await first.query('RESET search_path');
      } finally {
        first.release();
        second?.release();
      }
    }
  });
});
