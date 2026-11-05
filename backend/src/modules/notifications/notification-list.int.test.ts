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

describeWithDatabase('notification list with isolated PostgreSQL and HTTP', () => {
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

  it('requires authentication and restricts each recipient to active memberships', async () => {
    const f = await fixture();
    expect((await get()).status).toBe(401);
    const owner = await get(f.owner);
    expect(owner.status).toBe(200);
    expect(owner.body.notifications.map((n: { id: string }) => n.id).sort()).toEqual([f.ownerNotice, f.personalNotice].sort());
    expect(owner.body.unreadCount).toBe(1);
    expect((await get(f.member)).body.notifications.map((n: { id: string }) => n.id)).toEqual([f.memberNotice]);
    expect((await get(f.former)).body).toMatchObject({ notifications: [], unreadCount: 0, nextCursor: null });
    expect((await get(f.invited)).body).toMatchObject({ notifications: [], unreadCount: 0, nextCursor: null });
    expect((await get(f.outsider)).body).toMatchObject({ notifications: [], unreadCount: 0 });
    expect((await get(f.owner, `?groupId=${f.foreign}`)).status).toBe(403);
    expect((await get(f.owner, `?groupId=${randomUUID()}`)).status).toBe(403);
    expect((await get(f.former, `?groupId=${f.family}`)).status).toBe(403);
  });

  it('returns the documented DTO and current action state, with exact DATE and decimal values', async () => {
    const f = await fixture();
    const personalDue = randomUUID();
    await db().query(
      `INSERT INTO notifications (id, user_id, payment_id, type)
       VALUES ($1, $2, $3, 'payment_due')`,
      [personalDue, f.owner, f.personalPayment],
    );
    const member = await get(f.member, `?groupId=${f.family}`);
    expect(member.body.notifications).toEqual([expect.objectContaining({
      id: f.memberNotice, type: 'payment_overdue', paymentId: f.familyPayment,
      subscriptionId: f.familySubscription, subscriptionName: 'Familiar', groupId: f.family,
      groupName: 'Familia', groupType: 'family', expectedDate: '2026-11-01', expectedAmount: '10.23',
      actualAmount: null, paymentStatus: 'pending', ownShareStatus: 'pending', actionRequired: true,
      createdAt: '2026-11-08T12:00:00.123Z', readAt: null, message: expect.any(String),
    })]);
    const owner = await get(f.owner);
    const family = owner.body.notifications.find((n: { id: string }) => n.id === f.ownerNotice);
    const personal = owner.body.notifications.find((n: { id: string }) => n.id === f.personalNotice);
    expect(family).toMatchObject({ ownShareStatus: 'confirmed', actionRequired: false });
    expect(personal).toMatchObject({ ownShareStatus: null, actionRequired: false, readAt: '2026-11-09T12:00:00.000Z' });
    expect(owner.body.notifications.find((n) => n.id === personalDue))
      .toMatchObject({ ownShareStatus: null, actionRequired: true, paymentStatus: 'pending' });
    expect(Object.keys(family!).sort()).toEqual(['id', 'type', 'paymentId', 'subscriptionId', 'subscriptionName', 'groupId', 'groupName', 'groupType', 'expectedDate', 'expectedAmount', 'actualAmount', 'paymentStatus', 'ownShareStatus', 'actionRequired', 'message', 'createdAt', 'readAt'].sort());
  });

  it('filters status and group while unreadCount ignores status', async () => {
    const f = await fixture();
    const read = await get(f.owner, '?status=read');
    expect(read.body.notifications.map((n: { id: string }) => n.id)).toEqual([f.personalNotice]);
    expect(read.body.unreadCount).toBe(1);
    const unread = await get(f.owner, `?status=unread&groupId=${f.family}`);
    expect(unread.body.notifications.map((n: { id: string }) => n.id)).toEqual([f.ownerNotice]);
    expect(unread.body.unreadCount).toBe(1);
    const personal = await get(f.owner, `?status=read&groupId=${f.personal}`);
    expect(personal.body.notifications.map((n: { id: string }) => n.id)).toEqual([f.personalNotice]);
    expect(personal.body.unreadCount).toBe(0);
  });

  it('uses one snapshot when another transaction marks a listed notice read before the count', async () => {
    const f = await fixture();
    const realPool = db();
    let updated = false;
    // Instrument only the isolated test pool: the SQL service and production pool are unchanged.
    isolatedPool.value = new Proxy(realPool, {
      get(target, property) {
        if (property === 'connect') return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, key) {
              if (key === 'query') return async (sql: string, ...args: unknown[]) => {
                if (!updated && sql.includes('AS unread_count')) {
                  updated = true;
                  await realPool.query('UPDATE notifications SET read_at = NOW() WHERE id = $1', [f.ownerNotice]);
                }
                return Reflect.apply(connection.query, connection, [sql, ...args]);
              };
              const value = Reflect.get(connection, key);
              return typeof value === 'function' ? value.bind(connection) : value;
            },
          });
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      const result = await get(f.owner, `?groupId=${f.family}&status=unread`);
      expect(updated).toBe(true);
      expect(result.status).toBe(200);
      expect(result.body.notifications.map((notice) => notice.id)).toEqual([f.ownerNotice]);
      expect(result.body.unreadCount).toBe(1);
      expect((await realPool.query('SELECT read_at IS NOT NULL AS is_read FROM notifications WHERE id = $1', [f.ownerNotice])).rows[0].is_read).toBe(true);
    } finally {
      isolatedPool.value = realPool;
    }
  });

  it('paginates equal timestamps by UUID without missing rows and counts unread beyond the page', async () => {
    const f = await fixture();
    await db().query(`INSERT INTO payments (id, subscription_id, expected_date, expected_amount)
      SELECT gen_random_uuid(), $1, DATE '2020-01-01' + n, '1.00' FROM generate_series(1, 105) AS n`, [f.personalSubscription]);
    await db().query(`INSERT INTO notifications (user_id, payment_id, type, created_at)
      SELECT $1, id, 'payment_due', '2026-11-08T12:00:00.123Z'::timestamptz
      FROM payments WHERE subscription_id = $2 AND id <> $3`, [f.owner, f.personalSubscription, f.personalPayment]);
    const expected = (await db().query<{ id: string }>(`SELECT n.id FROM notifications n
      JOIN payments p ON p.id = n.payment_id WHERE n.user_id = $1 AND p.subscription_id = $2
      ORDER BY n.created_at DESC, n.id DESC`, [f.owner, f.personalSubscription])).rows.map((row) => row.id);
    let cursor: string | null = null;
    const received: string[] = [];
    const counts: number[] = [];
    do {
      const page = await get(f.owner, `?groupId=${f.personal}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(page.status).toBe(200);
      expect(page.body.notifications.length).toBeLessThanOrEqual(50);
      received.push(...page.body.notifications.map((n: { id: string }) => n.id));
      counts.push(page.body.unreadCount);
      cursor = page.body.nextCursor;
    } while (cursor && counts.length < 5);
    expect(cursor).toBeNull();
    expect(received).toEqual(expected);
    expect(counts).toEqual([105, 105, 105]);
  });

  it('rejects malformed or extra inputs with 400', async () => {
    const f = await fixture();
    const badCursors = ['bad!', 'a'.repeat(513),
      Buffer.from(JSON.stringify({ createdAt: 'bad', id: randomUUID() })).toString('base64url'),
      Buffer.from(JSON.stringify({ createdAt: '0000-01-01T00:00:00.000Z', id: randomUUID() })).toString('base64url')];
    for (const cursor of badCursors) expect((await get(f.owner, `?cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
    for (const query of ['?status=unknown', '?groupId=not-a-uuid', '?userId=abc', '?status=read&status=unread']) {
      expect((await get(f.owner, query)).status).toBe(400);
    }
  });
});
