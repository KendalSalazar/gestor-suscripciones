import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from './notification.types';

const { isolatedPool } = vi.hoisted(() => ({ isolatedPool: { value: undefined as Pool | undefined } }));
vi.mock('../../db/pool', () => ({
  get pool() {
    if (!isolatedPool.value) throw new Error('Isolated PostgreSQL pool is not ready');
    return isolatedPool.value;
  },
}));

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
type Fixture = {
  owner: string; member: string; former: string; invited: string; outsider: string;
  family: string; personal: string; foreign: string;
  familySubscription: string; personalSubscription: string; foreignSubscription: string;
  familyPayment: string; personalPayment: string; foreignPayment: string;
  ownerNotice: string; memberNotice: string; personalNotice: string; formerNotice: string; invitedNotice: string;
};

describeWithDatabase('mark notification read with isolated PostgreSQL and HTTP', () => {
  let admin: Pool;
  let database: Pool | undefined;
  let schema = '';
  let schemaCreated = false;
  let server: Server | undefined;
  let baseUrl: string;
  let signAccessToken: typeof import('../auth/auth.tokens').signAccessToken;

  beforeAll(async () => {
    const { env } = await import('../../config/env');
    admin = new Pool({ connectionString: env.databaseUrl, max: 2, connectionTimeoutMillis: 5000 });
    ({ signAccessToken } = await import('../auth/auth.tokens'));
  });

  beforeEach(async () => {
    schema = `phase6_test_${randomUUID().replaceAll('-', '')}`;
    if (!/^phase6_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    schemaCreated = false;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const { env } = await import('../../config/env');
    const url = new URL(env.databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema},pg_catalog`);
    database = new Pool({ connectionString: url.toString(), max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    isolatedPool.value = database;
    const client = await database.connect();
    try {
      const current = await client.query<{ name: string }>('SELECT current_schema() AS name');
      if (current.rows[0].name !== schema) throw new Error('Unexpected PostgreSQL search_path');
      await client.query('BEGIN');
      const directory = path.join(__dirname, '../../db/migrations');
      for (const filename of fs.readdirSync(directory).filter((name) => /^00[1-9]_.*\.sql$/.test(name)).sort()) {
        const source = fs.readFileSync(path.join(directory, filename), 'utf8');
        await client.query(source.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\r?\n/, ''));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!server) {
      const { app } = await import('../../app');
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        server!.once('listening', resolve);
        server!.once('error', reject);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test HTTP address');
      baseUrl = `http://127.0.0.1:${address.port}`;
    }
  });

  async function cleanupSchema() {
    try {
      if (database) await database.end();
    } finally {
      database = undefined;
      isolatedPool.value = undefined;
      if (schemaCreated) {
        if (!/^phase6_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        expect((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rowCount).toBe(0);
        schemaCreated = false;
      }
    }
  }

  afterEach(cleanupSchema);
  afterAll(async () => {
    try {
      if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      await cleanupSchema();
    } finally {
      if (admin) await admin.end();
    }
  });

  function db(): Pool {
    if (!database) throw new Error('Isolated database is not ready');
    return database;
  }

  async function fixture(): Promise<Fixture> {
    const f: Fixture = {
      owner: randomUUID(), member: randomUUID(), former: randomUUID(), invited: randomUUID(), outsider: randomUUID(),
      family: randomUUID(), personal: randomUUID(), foreign: randomUUID(),
      familySubscription: randomUUID(), personalSubscription: randomUUID(), foreignSubscription: randomUUID(),
      familyPayment: randomUUID(), personalPayment: randomUUID(), foreignPayment: randomUUID(),
      ownerNotice: randomUUID(), memberNotice: randomUUID(), personalNotice: randomUUID(), formerNotice: randomUUID(), invitedNotice: randomUUID(),
    };
    const users = [f.owner, f.member, f.former, f.invited, f.outsider];
    await db().query(`INSERT INTO users (id, email, password_hash, name)
      SELECT id, id::text || '@example.com', 'unused-test-hash', 'Fixture'
      FROM UNNEST($1::uuid[]) AS ids(id)`, [users]);
    await db().query(`INSERT INTO groups (id, name, type, owner_id)
      SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::group_type[], $4::uuid[])`,
    [[f.family, f.personal, f.foreign], ['Familia', 'Personal', 'Ajeno'], ['family', 'personal', 'personal'], [f.owner, f.owner, f.outsider]]);
    await db().query(`INSERT INTO group_members (group_id, user_id, role, status, joined_at)
      SELECT group_id, user_id, role, status, NOW()
      FROM UNNEST($1::uuid[], $2::uuid[], $3::member_role[], $4::member_status[]) AS m(group_id,user_id,role,status)`,
    [[f.family, f.family, f.family, f.family, f.personal, f.foreign],
      [f.owner, f.member, f.former, f.invited, f.owner, f.outsider],
      ['owner', 'member', 'member', 'member', 'owner', 'owner'],
      ['active', 'active', 'removed', 'invited', 'active', 'active']]);
    await db().query(`INSERT INTO subscriptions (id, group_id, name, provider, expected_cost, billing_cycle, next_billing_date, active)
      SELECT id, group_id, name, 'Fixture', '10.23', 'monthly', '9999-12-31', FALSE
      FROM UNNEST($1::uuid[], $2::uuid[], $3::text[]) AS s(id,group_id,name)`,
    [[f.familySubscription, f.personalSubscription, f.foreignSubscription], [f.family, f.personal, f.foreign], ['Familiar', 'Personal', 'Ajena']]);
    await db().query(`INSERT INTO payments (id, subscription_id, expected_date, expected_amount, status)
      SELECT id, subscription_id, '2026-11-01'::date, '10.23'::numeric, 'pending'::payment_status
      FROM UNNEST($1::uuid[], $2::uuid[]) AS p(id,subscription_id)`,
    [[f.familyPayment, f.personalPayment, f.foreignPayment], [f.familySubscription, f.personalSubscription, f.foreignSubscription]]);
    await db().query(`INSERT INTO payment_shares (payment_id, user_id, share_amount, share_percentage, status, actual_amount, confirmed_at)
      VALUES ($1, $2, '5.11', '50', 'pending', NULL, NULL),
             ($1, $3, '5.12', '50', 'confirmed', '5.12', NOW())`, [f.familyPayment, f.member, f.owner]);
    await db().query(`INSERT INTO notifications (id, user_id, payment_id, type, created_at, read_at)
      SELECT id, user_id, payment_id, type, '2026-11-08T12:00:00.123Z'::timestamptz, read_at
      FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::notification_type[], $5::timestamptz[])
        AS n(id,user_id,payment_id,type,read_at)`,
    [[f.ownerNotice, f.memberNotice, f.personalNotice, f.formerNotice, f.invitedNotice],
      [f.owner, f.member, f.owner, f.former, f.invited],
      [f.familyPayment, f.familyPayment, f.personalPayment, f.familyPayment, f.familyPayment],
      ['payment_due', 'payment_overdue', 'amount_changed', 'payment_due', 'payment_due'],
      [null, null, '2026-11-09T12:00:00Z', null, null]]);
    return f;
  }

  async function get(userId?: string, query = '') {
    const headers = userId ? { Authorization: `Bearer ${signAccessToken({ id: userId, email: `${userId}@example.com` })}` } : undefined;
    const response = await fetch(`${baseUrl}/notifications${query}`, { headers });
    const body = await response.json() as { notifications: Notification[]; nextCursor: string | null; unreadCount: number };
    return { status: response.status, body };
  }

  async function read(userId: string | undefined, id: string, body: unknown = {}, query = '') {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (userId) headers.Authorization = `Bearer ${signAccessToken({ id: userId, email: `${userId}@example.com` })}`;
    const response = await fetch(`${baseUrl}/notifications/${id}/read${query}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as { notification: Notification; error: { message: string; status: number } } };
  }

  it('validates identity and input before changing a notice', async () => {
    const f = await fixture();
    expect((await read(undefined, f.ownerNotice)).status).toBe(401);
    for (const [id, body, query] of [
      ['not-a-uuid', {}, ''], [f.ownerNotice, { readAt: '2020-01-01' }, ''],
      [f.ownerNotice, {}, '?extra=value'], [f.ownerNotice, null, ''],
    ] as const) expect((await read(f.owner, id, body, query)).status).toBe(400);
    expect((await db().query('SELECT read_at FROM notifications WHERE id=$1', [f.ownerNotice])).rows[0].read_at).toBeNull();
  });

  it('marks own notices idempotently, updates count and preserves payments and other notices', async () => {
    const f = await fixture();
    const snapshot = async () => ({
      payments: (await db().query('SELECT to_jsonb(p) AS value FROM payments p ORDER BY id')).rows,
      shares: (await db().query('SELECT to_jsonb(s) AS value FROM payment_shares s ORDER BY id')).rows,
      others: (await db().query('SELECT to_jsonb(n) AS value FROM notifications n WHERE id <> ALL($1::uuid[]) ORDER BY id', [[f.ownerNotice, f.memberNotice]])).rows,
    });
    const before = await snapshot();
    expect((await get(f.owner)).body.unreadCount).toBe(1);
    const first = await read(f.owner, f.ownerNotice);
    expect(first.status).toBe(200);
    expect(first.body.notification).toMatchObject({ id: f.ownerNotice, paymentId: f.familyPayment, ownShareStatus: 'confirmed', actionRequired: false, expectedDate: '2026-11-01', expectedAmount: '10.23' });
    expect(first.body.notification.readAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const again = await read(f.owner, f.ownerNotice);
    expect(again.status).toBe(200);
    expect(again.body.notification.readAt).toBe(first.body.notification.readAt);
    expect((await get(f.owner)).body.unreadCount).toBe(0);
    const member = await read(f.member, f.memberNotice);
    expect(member.status).toBe(200);
    expect(member.body.notification).toMatchObject({ id: f.memberNotice, ownShareStatus: 'pending', actionRequired: true });
    expect(member.body.notification.readAt).not.toBeNull();
    const alreadyRead = await read(f.owner, f.personalNotice);
    expect(alreadyRead.status).toBe(200);
    expect(alreadyRead.body.notification.readAt).toBe('2026-11-09T12:00:00.000Z');
    expect(await snapshot()).toEqual(before);
  });

  it('returns the same 404 for foreign, missing and inactive memberships', async () => {
    const f = await fixture();
    const attempts = [
      await read(f.owner, f.memberNotice), await read(f.outsider, f.ownerNotice),
      await read(f.owner, randomUUID()), await read(f.former, f.formerNotice),
      await read(f.invited, f.invitedNotice),
    ];
    for (const result of attempts) {
      expect(result.status).toBe(404);
      expect(result.body.error).toEqual({ message: 'Notification not found', status: 404 });
    }
    const unchanged = await db().query('SELECT read_at FROM notifications WHERE id = ANY($1::uuid[])', [[f.ownerNotice, f.memberNotice, f.formerNotice, f.invitedNotice]]);
    expect(unchanged.rows.every((row) => row.read_at === null)).toBe(true);
  });

  it('concurrent requests preserve the same first read timestamp', async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 4 }, () => read(f.member, f.memberNotice)));
    expect(results.map((result) => result.status)).toEqual([200, 200, 200, 200]);
    const first = results[0].body.notification.readAt;
    expect(first).not.toBeNull();
    expect(results.every((result) => result.body.notification.readAt === first)).toBe(true);
    expect((await db().query('SELECT read_at FROM notifications WHERE id=$1', [f.memberNotice])).rows[0].read_at.toISOString()).toBe(first);
  });

  it('rechecks membership after waiting for the group lock', async () => {
    const f = await fixture();
    const holder = await db().connect();
    let transactionOpen = false;
    let pending: Promise<Awaited<ReturnType<typeof read>>> | undefined;
    try {
      await holder.query('BEGIN');
      transactionOpen = true;
      await holder.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [f.family]);
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = read(f.member, f.memberNotice);
      await vi.waitFor(async () => {
        const waiting = await db().query<{ waiting: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting', [holderPid],
        );
        expect(waiting.rows[0].waiting).toBe(true);
      }, { timeout: 5000, interval: 25 });
      await holder.query("UPDATE group_members SET status='removed' WHERE group_id=$1 AND user_id=$2", [f.family, f.member]);
      await holder.query('COMMIT');
      transactionOpen = false;
      const response = await pending;
      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('Notification not found');
      expect((await db().query('SELECT read_at FROM notifications WHERE id=$1', [f.memberNotice])).rows[0].read_at).toBeNull();
    } finally {
      if (transactionOpen) await holder.query('ROLLBACK');
      holder.release();
      if (pending) await pending.catch(() => undefined);
    }
  });
});

