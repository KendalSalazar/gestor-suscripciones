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
type JourneyFixture = {
  ownerId: string;
  memberId: string;
  ownerEmail: string;
  memberEmail: string;
  groupId: string;
  subscriptionId: string;
  paymentId: string;
  ownerShareId: string;
  memberShareId: string;
};

describeWithDatabase('notification journey with isolated PostgreSQL and HTTP', () => {
  let admin: Pool;
  let database: Pool | undefined;
  let schema = '';
  let schemaCreated = false;
  let server: Server | undefined;
  let baseUrl: string;
  let signAccessToken: typeof import('../auth/auth.tokens').signAccessToken;
  let runDuePayments: typeof import('../payments/payment-generation.service').runDuePayments;
  let runOverdueNotifications: typeof import('./notification-generation.service').runOverdueNotifications;

  beforeAll(async () => {
    const { env } = await import('../../config/env');
    admin = new Pool({ connectionString: env.databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
    ({ signAccessToken } = await import('../auth/auth.tokens'));
    ({ runDuePayments } = await import('../payments/payment-generation.service'));
    ({ runOverdueNotifications } = await import('./notification-generation.service'));
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
    database = new Pool({ connectionString: url.toString(), max: 8, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
    isolatedPool.value = database;

    const client = await database.connect();
    try {
      const current = await client.query<{ name: string }>('SELECT current_schema() AS name');
      if (current.rows[0].name !== schema) throw new Error('Unexpected PostgreSQL search_path');
      await client.query('BEGIN');
      const directory = path.join(__dirname, '../../db/migrations');
      for (const filename of fs.readdirSync(directory).filter((name) => /^00[1-9]_.*\.sql$/.test(name)).sort()) {
        const source = fs.readFileSync(path.join(directory, filename), 'utf8');
        // PostgreSQL 16 provides gen_random_uuid(); keep the test schema self-contained.
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

  async function cleanupSchema(): Promise<void> {
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
    if (!database) throw new Error('Isolated PostgreSQL pool is not ready');
    return database;
  }

  async function createFixture(): Promise<JourneyFixture> {
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const ownerEmail = `${ownerId}@example.com`;
    const memberEmail = `${memberId}@example.com`;
    const groupId = randomUUID();
    const subscriptionId = randomUUID();

    await db().query(
      `INSERT INTO users (id, email, password_hash, name)
       VALUES ($1, $2, 'unused-test-hash', 'Owner fixture'),
              ($3, $4, 'unused-test-hash', 'Member fixture')`,
      [ownerId, ownerEmail, memberId, memberEmail],
    );
    await db().query('INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, \'family\', $3)',
      [groupId, 'Journey family', ownerId]);
    await db().query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'owner', 'active', NOW()), ($1, $3, 'member', 'active', NOW())`,
      [groupId, ownerId, memberId],
    );
    await db().query(
      `INSERT INTO subscriptions (
         id, group_id, name, provider, expected_cost, billing_cycle, next_billing_date, billing_anchor_day, active
       ) VALUES ($1, $2, 'Journey subscription', 'Fixture', '10.00', 'monthly', '2026-11-01', 1, TRUE)`,
      [subscriptionId, groupId],
    );
    return { ownerId, memberId, ownerEmail, memberEmail, groupId, subscriptionId, paymentId: '', ownerShareId: '', memberShareId: '' };
  }

  function token(userId: string, email: string): string {
    return signAccessToken({ id: userId, email });
  }

  async function request<T>(pathName: string, userId: string, email: string, options: {
    method?: 'GET' | 'POST'; body?: object;
  } = {}): Promise<{ status: number; body: T }> {
    const response = await fetch(`${baseUrl}${pathName}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token(userId, email)}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(5_000),
    });
    const body = response.status === 204 ? undefined : await response.json() as T;
    return { status: response.status, body: body as T };
  }

  async function notices(fixture: JourneyFixture, user: 'owner' | 'member') {
    const id = user === 'owner' ? fixture.ownerId : fixture.memberId;
    const email = user === 'owner' ? fixture.ownerEmail : fixture.memberEmail;
    return request<{ notifications: Notification[]; unreadCount: number; nextCursor: string | null }>(
      '/notifications', id, email,
    );
  }

  it('generates, reads, resolves and restores each member’s own notice journey through HTTP', async () => {
    const fixture = await createFixture();

    // The date is explicit and generation is limited to this selected subscription.
    await runDuePayments('2026-11-01', fixture.subscriptionId);
    fixture.paymentId = (await db().query<{ id: string }>(
      'SELECT id FROM payments WHERE subscription_id = $1 AND expected_date = DATE \'2026-11-01\'',
      [fixture.subscriptionId],
    )).rows[0].id;
    await runOverdueNotifications('2026-11-08', fixture.subscriptionId);
    await runOverdueNotifications('2026-11-08', fixture.subscriptionId);

    const ownerInitial = await notices(fixture, 'owner');
    const memberInitial = await notices(fixture, 'member');
    expect(ownerInitial.status).toBe(200);
    expect(memberInitial.status).toBe(200);
    for (const response of [ownerInitial, memberInitial]) {
      expect(response.body.notifications).toHaveLength(2);
      expect(response.body.notifications.map((notice) => notice.type).sort()).toEqual(['payment_due', 'payment_overdue']);
      expect(response.body.notifications.every((notice) => notice.actionRequired)).toBe(true);
      expect(response.body.notifications.every((notice) => notice.expectedDate === '2026-11-01')).toBe(true);
    }
    const ownerOverdue = ownerInitial.body.notifications.find((notice) => notice.type === 'payment_overdue')!;
    const memberOverdue = memberInitial.body.notifications.find((notice) => notice.type === 'payment_overdue')!;
    expect(ownerOverdue.paymentId).toBe(memberOverdue.paymentId);
    expect(ownerOverdue.paymentId).toBe(fixture.paymentId);

    const readResult = await request<{ notification: Notification }>(
      `/notifications/${ownerOverdue.id}/read`, fixture.ownerId, fixture.ownerEmail,
      { method: 'POST', body: {} },
    );
    expect(readResult.status).toBe(200);
    expect((await notices(fixture, 'owner')).body.notifications.find((notice) => notice.id === ownerOverdue.id)?.readAt)
      .not.toBeNull();

    const shares = await db().query<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM payment_shares WHERE payment_id = $1 ORDER BY user_id', [fixture.paymentId],
    );
    const ownerShare = shares.rows.find((share) => share.user_id === fixture.ownerId)!;
    const memberShare = shares.rows.find((share) => share.user_id === fixture.memberId)!;
    expect(shares.rows).toHaveLength(2);
    fixture.ownerShareId = ownerShare.id;
    fixture.memberShareId = memberShare.id;

    const confirmationPath = (shareId: string) => `/groups/${fixture.groupId}/payments/${fixture.paymentId}/shares/${shareId}/confirm`;
    const ownerConfirmation = await request<{ payment: { status: string }; share: { actualAmount: string } }>(
      confirmationPath(ownerShare.id), fixture.ownerId, fixture.ownerEmail,
      { method: 'POST', body: { actualAmount: '5.00' } },
    );
    expect(ownerConfirmation).toMatchObject({ status: 200, body: { payment: { status: 'pending' }, share: { actualAmount: '5.00' } } });
    expect((await db().query('SELECT id FROM notifications WHERE payment_id = $1 AND type = \'amount_changed\'', [fixture.paymentId])).rowCount).toBe(0);

    const memberConfirmation = await request<{ payment: { status: string; actualAmount: string; priceChanged: boolean } }>(
      confirmationPath(memberShare.id), fixture.memberId, fixture.memberEmail,
      { method: 'POST', body: { actualAmount: '4.50' } },
    );
    expect(memberConfirmation).toMatchObject({
      status: 200,
      body: { payment: { status: 'confirmed', actualAmount: '9.50', priceChanged: true } },
    });
    const amountChanged = await db().query<{ user_id: string }>(
      'SELECT user_id FROM notifications WHERE payment_id = $1 AND type = \'amount_changed\'', [fixture.paymentId],
    );
    expect(amountChanged.rows).toEqual([{ user_id: fixture.ownerId }]);

    for (const user of ['owner', 'member'] as const) {
      const current = await notices(fixture, user);
      expect(current.status).toBe(200);
      expect(current.body.notifications).toHaveLength(user === 'owner' ? 3 : 2);
      expect(current.body.notifications.filter((notice) => notice.type === 'amount_changed')).toHaveLength(user === 'owner' ? 1 : 0);
      expect(current.body.notifications.filter((notice) => notice.type !== 'amount_changed')
        .every((notice) => !notice.actionRequired)).toBe(true);
    }
    expect((await notices(fixture, 'owner')).body.notifications.find((notice) => notice.id === ownerOverdue.id)?.readAt)
      .not.toBeNull();

    const memberRead = await request<{ notification: Notification }>(
      `/notifications/${memberOverdue.id}/read`, fixture.memberId, fixture.memberEmail,
      { method: 'POST', body: {} },
    );
    expect(memberRead.status).toBe(200);
    const memberReadAt = (await notices(fixture, 'member')).body.notifications
      .find((notice) => notice.id === memberOverdue.id)?.readAt;
    expect(memberReadAt).not.toBeNull();

    const leave = await request<undefined>(`/groups/${fixture.groupId}/leave`, fixture.memberId, fixture.memberEmail,
      { method: 'POST', body: {} });
    expect(leave.status).toBe(204);
    expect((await notices(fixture, 'member')).body).toMatchObject({ notifications: [], unreadCount: 0, nextCursor: null });

    const invitation = await request<{ invitation: { id: string }; token: string }>(
      `/groups/${fixture.groupId}/invitations`, fixture.ownerId, fixture.ownerEmail,
      { method: 'POST', body: { email: fixture.memberEmail } },
    );
    expect(invitation.status).toBe(201);
    const accepted = await request<{ membership: { status: string } }>(
      `/invitations/${invitation.body.invitation.id}/accept`, fixture.memberId, fixture.memberEmail,
      { method: 'POST', body: { token: invitation.body.token } },
    );
    expect(accepted).toMatchObject({ status: 200, body: { membership: { status: 'active' } } });
    const restored = await notices(fixture, 'member');
    expect(restored.status).toBe(200);
    expect(restored.body.notifications).toHaveLength(2);
    expect(restored.body.notifications.every((notice) => !notice.actionRequired)).toBe(true);
    expect(restored.body.notifications.find((notice) => notice.id === memberOverdue.id)).toBeDefined();
    expect(restored.body.notifications.find((notice) => notice.id === memberOverdue.id)?.readAt).toBe(memberReadAt);
  });
});
