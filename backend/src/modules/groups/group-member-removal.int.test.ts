import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Group, GroupMember } from './group.types';
import type { PaymentShareBreakdown } from '../payments/payment-share.types';

const { isolatedPool } = vi.hoisted(() => ({ isolatedPool: { value: undefined as Pool | undefined } }));
vi.mock('../../db/pool', () => ({
  get pool() {
    if (!isolatedPool.value) throw new Error('Isolated PostgreSQL pool is not ready');
    return isolatedPool.value;
  },
}));

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
type Fixture = {
  userIds: string[]; personalIds: string[]; familyId: string;
  subscriptionId: string; paymentId: string; shareIds: string[];
};

describeWithDatabase('family membership removal with real PostgreSQL and HTTP', () => {
  const schema = `phase5_test_${randomUUID().replaceAll('-', '')}`;
  const prefix = `phase5-test-${randomUUID()}`;
  let admin: Pool;
  let database: Pool;
  let schemaCreated = false;
  let members: typeof import('./group-member.service');
  let generation: typeof import('../payments/payment-generation.service');
  let signAccessToken: typeof import('../auth/auth.tokens').signAccessToken;
  let server: Server | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    if (!/^phase5_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    const { env } = await import('../../config/env');
    admin = new Pool({ connectionString: env.databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const isolatedUrl = new URL(env.databaseUrl);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema},pg_catalog`);
    isolatedUrl.searchParams.set('application_name', prefix);
    database = new Pool({
      connectionString: isolatedUrl.toString(), max: 8,
      connectionTimeoutMillis: 5_000, statement_timeout: 10_000,
    });
    isolatedPool.value = database;
    const client = await database.connect();
    try {
      const current = await client.query<{ name: string }>('SELECT current_schema() AS name');
      if (current.rows[0].name !== schema) throw new Error('Unexpected PostgreSQL search_path');
      await client.query('BEGIN');
      const directory = path.join(__dirname, '../../db/migrations');
      for (const filename of fs.readdirSync(directory).filter((name) => /^00[1-8]_.*\.sql$/.test(name)).sort()) {
        const source = fs.readFileSync(path.join(directory, filename), 'utf8');
        // PostgreSQL 16 provides gen_random_uuid without changing global extensions.
        await client.query(source.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\r?\n/, ''));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    members = await import('./group-member.service');
    generation = await import('../payments/payment-generation.service');
    ({ signAccessToken } = await import('../auth/auth.tokens'));
    const { app } = await import('../../app');
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server?.once('listening', resolve);
      server?.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing members HTTP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    try {
      if (server) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    } finally {
      try {
        if (database) await database.end();
      } finally {
        isolatedPool.value = undefined;
        if (admin) {
          try {
            if (schemaCreated) {
              if (!/^phase5_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
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
    }
  });

  async function createFixture(): Promise<Fixture> {
    const userIds = Array.from({ length: 6 }, () => randomUUID());
    const fixture: Fixture = {
      userIds, personalIds: userIds.map(() => randomUUID()), familyId: randomUUID(),
      subscriptionId: randomUUID(), paymentId: randomUUID(), shareIds: userIds.slice(0, 3).map(() => randomUUID()),
    };
    await database.query(
      `INSERT INTO users (id, email, password_hash, name)
       SELECT id, email, 'unused-test-hash', $3 FROM UNNEST($1::uuid[], $2::text[]) fixture(id, email)`,
      [userIds, userIds.map((id) => `${prefix}-${id}@example.com`), prefix],
    );
    await database.query(
      `INSERT INTO groups (id, name, type, owner_id)
       SELECT id, 'Personal', 'personal'::group_type, user_id
       FROM UNNEST($1::uuid[], $2::uuid[]) fixture(id, user_id)`, [fixture.personalIds, userIds],
    );
    await database.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       SELECT group_id, user_id, 'owner'::member_role, 'active'::member_status, '2020-01-01'::timestamptz
       FROM UNNEST($1::uuid[], $2::uuid[]) fixture(group_id, user_id)`, [fixture.personalIds, userIds],
    );
    await database.query("INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, 'family', $3)",
      [fixture.familyId, prefix, userIds[0]]);
    // Three active users, an invitation, a removed user and an outsider.
    await database.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       SELECT $1::uuid, user_id, role, status, CASE WHEN status <> 'invited' THEN '2020-01-02'::timestamptz ELSE NULL END
       FROM UNNEST($2::uuid[], $3::member_role[], $4::member_status[]) fixture(user_id, role, status)`,
      [fixture.familyId, userIds.slice(0, 5), ['owner', 'member', 'member', 'member', 'member'],
        ['active', 'active', 'active', 'invited', 'removed']],
    );
    await database.query(
      `INSERT INTO subscriptions (id, group_id, name, provider, expected_cost, billing_cycle, next_billing_date, billing_anchor_day, active)
       VALUES ($1, $2, $3, 'Test', '12.00', 'monthly', '9999-12-31', 31, FALSE)`,
      [fixture.subscriptionId, fixture.familyId, prefix],
    );
    await database.query(
      `INSERT INTO payments (id, subscription_id, expected_date, expected_amount)
       VALUES ($1, $2, '2090-01-01', '12.00')`, [fixture.paymentId, fixture.subscriptionId],
    );
    const first = [...userIds.slice(0, 3)].sort()[0];
    await database.query(
      `INSERT INTO payment_shares (id, payment_id, user_id, share_amount, share_percentage, status, actual_amount, confirmed_at)
       SELECT id, $2::uuid, user_id, '4.00', percentage,
         CASE WHEN user_id = $5::uuid THEN 'confirmed'::payment_share_status ELSE 'pending'::payment_share_status END,
         CASE WHEN user_id = $5::uuid THEN 4.50 ELSE NULL END,
         CASE WHEN user_id = $5::uuid THEN '2020-01-03'::timestamptz ELSE NULL END
       FROM UNNEST($1::uuid[], $3::uuid[], $4::numeric[]) fixture(id, user_id, percentage)`,
      [fixture.shareIds, fixture.paymentId, userIds.slice(0, 3),
        userIds.slice(0, 3).map((id) => id === first ? '33.3334' : '33.3333'), userIds[1]],
    );
    return fixture;
  }

  const memberPath = (id: string) => `/groups/${id}/members`;
  type Operation = 'leave' | 'remove';
  const removalPath = (fixture: Fixture, operation: Operation, target = fixture.userIds[1]) => operation === 'leave'
    ? `/groups/${fixture.familyId}/leave` : `/groups/${fixture.familyId}/members/${target}`;
  const depart = (fixture: Fixture, operation: Operation, body?: object) => request(
    removalPath(fixture, operation), operation === 'leave' ? fixture.userIds[1] : fixture.userIds[0],
    { method: operation === 'leave' ? 'POST' : 'DELETE', body },
  );
  async function request<T>(pathname: string, userId: string | undefined, options: {
    method?: 'GET' | 'POST' | 'DELETE'; body?: object;
  } = {}): Promise<{ status: number; body: T }> {
    const token = userId ? signAccessToken({ id: userId, email: `${prefix}-${userId}@example.com` }) : undefined;
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: response.status === 204 ? undefined as T : await response.json() as T };
  }

  async function history(fixture: Fixture): Promise<string> {
    return (await database.query<{ snapshot: string }>(
      `SELECT jsonb_build_object(
         'subscription', (SELECT to_jsonb(s) FROM subscriptions s WHERE s.id = $1),
         'payment', (SELECT to_jsonb(p) FROM payments p WHERE p.id = $2),
         'shares', (SELECT jsonb_agg(to_jsonb(ps) ORDER BY ps.id) FROM payment_shares ps WHERE ps.payment_id = $2)
       )::text AS snapshot`, [fixture.subscriptionId, fixture.paymentId],
    )).rows[0].snapshot;
  }

  async function ownership(fixture: Fixture): Promise<string> {
    return (await database.query<{ snapshot: string }>(
      `SELECT jsonb_build_object(
         'groups', (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM groups g WHERE g.id = ANY($1::uuid[])),
         'members', (SELECT jsonb_agg(to_jsonb(gm) ORDER BY gm.id) FROM group_members gm WHERE gm.group_id = ANY($1::uuid[]))
       )::text AS snapshot`, [[fixture.familyId, ...fixture.personalIds]],
    )).rows[0].snapshot;
  }

  async function assertOwner(fixture: Fixture, ownerId: string): Promise<void> {
    const result = await database.query(
      `SELECT g.owner_id, gm.user_id FROM groups g JOIN group_members gm ON gm.group_id = g.id
       WHERE g.id = $1 AND gm.role = 'owner' AND gm.status = 'active'`, [fixture.familyId],
    );
    expect(result.rows).toEqual([{ owner_id: ownerId, user_id: ownerId }]);
  }

  async function waitForBlockedPid(holderPid: number, finished: () => boolean): Promise<number> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const result = await database.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'
         AND $2::integer = ANY(pg_blocking_pids(pid))`, [prefix, holderPid],
      );
      if (result.rows[0]) return result.rows[0].pid;
      if (finished()) throw new Error('Operation finished before the expected fixture lock wait');
      await delay(10);
    }
    throw new Error('Expected fixture lock wait was not observed');
  }

  async function assertCurrentSchema(): Promise<void> {
    expect((await database.query<{ name: string }>('SELECT current_schema() AS name')).rows[0].name).toBe(schema);
  }

  async function makeDue(fixture: Fixture): Promise<void> {
    await database.query(
      `UPDATE subscriptions SET active = TRUE, next_billing_date = '2091-01-01', billing_anchor_day = 1 WHERE id = $1`,
      [fixture.subscriptionId],
    );
  }

  async function generate(fixture: Fixture) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fixture.subscriptionId)) {
      throw new Error('Fixture subscription UUID required');
    }
    return generation.runDuePayments('2091-01-01', fixture.subscriptionId);
  }

  async function generatedPhoto(fixture: Fixture) {
    return (await database.query(
      `SELECT ps.user_id, ps.share_amount::text, ps.share_percentage::text, ps.status,
         ps.actual_amount::text, ps.confirmed_at, p.status AS parent_status
       FROM payments p JOIN payment_shares ps ON ps.payment_id = p.id
       WHERE p.subscription_id = $1 AND p.expected_date = '2091-01-01' ORDER BY ps.user_id`, [fixture.subscriptionId],
    )).rows;
  }

  async function nextDate(fixture: Fixture): Promise<string> {
    return (await database.query<{ date: string }>(
      'SELECT next_billing_date::text AS date FROM subscriptions WHERE id = $1', [fixture.subscriptionId],
    )).rows[0].date;
  }

  async function assertOnlyRemoved(fixture: Fixture, before: string, target = fixture.userIds[1]) {
    const expected = JSON.parse(before);
    expected.members = expected.members.map((member: { group_id: string; user_id: string }) => (
      member.group_id === fixture.familyId && member.user_id === target ? { ...member, status: 'removed' } : member
    ));
    expect(JSON.parse(await ownership(fixture))).toEqual(expected);
    await assertOwner(fixture, fixture.userIds[0]);
  }

  it.each([
    ['leave', undefined], ['leave', {}], ['remove', undefined], ['remove', {}],
  ] as const)('performs %s with body %j, preserves saved history and removes later access', async (operation, body) => {
    const fixture = await createFixture();
    const before = await ownership(fixture);
    const historyBefore = await history(fixture);
    expect(await depart(fixture, operation, body)).toEqual({ status: 204, body: undefined });
    await assertOnlyRemoved(fixture, before);
    expect(await history(fixture)).toBe(historyBefore);
    const ownGroups = await request<{ groups: Group[] }>('/groups', fixture.userIds[1]);
    expect(ownGroups.body.groups.map((group) => group.id)).toEqual([fixture.personalIds[1]]);
    for (const pathname of [
      memberPath(fixture.familyId), `/groups/${fixture.familyId}/subscriptions`,
      `/groups/${fixture.familyId}/payments`, `/groups/${fixture.familyId}/payment-shares`,
      `/groups/${fixture.familyId}/payments/${fixture.paymentId}/shares`,
    ]) {
      expect(await request(pathname, fixture.userIds[1]))
        .toEqual({ status: 403, body: { error: { message: 'Forbidden', status: 403 } } });
    }
    const detail = await request<PaymentShareBreakdown>(
      `/groups/${fixture.familyId}/payments/${fixture.paymentId}/shares`, fixture.userIds[2],
    );
    expect(detail.status).toBe(200);
    expect(detail.body.shares.find((share) => share.id === fixture.shareIds[1]))
      .toMatchObject({ userId: fixture.userIds[1], status: 'confirmed', shareAmount: '4.00', actualAmount: '4.50' });
    expect(detail.body.summary).toEqual({ totalShares: 3, confirmedShares: 1, confirmedAmount: '4.50' });
    const roster = await request<{ members: GroupMember[] }>(memberPath(fixture.familyId), fixture.userIds[0]);
    expect(roster.body.members.map((member) => member.userId).sort()).toEqual([fixture.userIds[0], fixture.userIds[2]].sort());
    expect((await depart(fixture, operation)).status).toBe(operation === 'leave' ? 403 : 404);
    expect(await history(fixture)).toBe(historyBefore);
  });

  it.each(['leave', 'remove'] as const)('blocks %s only when that user has a pending share of a pending parent', async (operation) => {
    const fixture = await createFixture();
    await database.query("UPDATE payment_shares SET status = 'pending', actual_amount = NULL, confirmed_at = NULL WHERE id = $1",
      [fixture.shareIds[1]]);
    const before = await ownership(fixture);
    const historyBefore = await history(fixture);
    expect((await depart(fixture, operation)).status).toBe(409);
    expect(await ownership(fixture)).toBe(before);
    expect(await history(fixture)).toBe(historyBefore);
  });

  it.each(['leave', 'remove'] as const)('allows %s for a saved pending share whose parent is already resolved', async (operation) => {
    for (const state of ['confirmed', 'skipped']) {
      const fixture = await createFixture();
      await database.query("UPDATE payment_shares SET status = 'pending', actual_amount = NULL, confirmed_at = NULL WHERE id = $1",
        [fixture.shareIds[1]]);
      // Defensive historical fixture: cross-row state is intentionally different from a new generation.
      await database.query(
        `UPDATE payments SET status = $2::payment_status,
          actual_amount = CASE WHEN $2::payment_status = 'confirmed' THEN expected_amount ELSE NULL END,
          resolved_at = NOW(), price_changed = FALSE WHERE id = $1`, [fixture.paymentId, state],
      );
      const before = await ownership(fixture);
      const historyBefore = await history(fixture);
      expect((await depart(fixture, operation)).status).toBe(204);
      await assertOnlyRemoved(fixture, before);
      expect(await history(fixture)).toBe(historyBefore);
    }
  });

  it.each(['leave', 'remove'] as const)('does not block %s for another user or a debt of this user in another family', async (operation) => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    await database.query(
      `INSERT INTO group_members (group_id,user_id,role,status,joined_at) VALUES ($1,$2,'member','active',NOW())`,
      [foreign.familyId, fixture.userIds[1]],
    );
    await database.query('UPDATE payment_shares SET user_id = $2 WHERE id = $1', [foreign.shareIds[2], fixture.userIds[1]]);
    const foreignBefore = await ownership(foreign);
    const foreignHistory = await history(foreign);
    const historyBefore = await history(fixture);
    expect((await depart(fixture, operation)).status).toBe(204);
    expect(await ownership(foreign)).toBe(foreignBefore);
    expect(await history(foreign)).toBe(foreignHistory);
    expect(await history(fixture)).toBe(historyBefore);
    const foreignRead = await request(`/groups/${foreign.familyId}/payment-shares?status=pending`, fixture.userIds[1]);
    expect(foreignRead.status).toBe(200);
  });

  it('prevents the owner leaving or deleting itself, and preserves its personal group', async () => {
    const fixture = await createFixture();
    const before = await ownership(fixture);
    expect((await request(`/groups/${fixture.familyId}/leave`, fixture.userIds[0], { method: 'POST', body: {} })).status).toBe(409);
    expect((await request(`/groups/${fixture.familyId}/members/${fixture.userIds[0]}`, fixture.userIds[0], { method: 'DELETE' })).status).toBe(409);
    for (const [pathname, method] of [
      [`/groups/${fixture.personalIds[0]}/leave`, 'POST'],
      [`/groups/${fixture.personalIds[0]}/members/${fixture.userIds[0]}`, 'DELETE'],
    ] as const) {
      expect((await request(pathname, fixture.userIds[0], { method, body: {} })).status).toBe(409);
    }
    expect(await ownership(fixture)).toBe(before);
  });

  it.each(['outsider', 'invited', 'removed', 'missing group'] as const)(
    'denies %s uniformly on both departure endpoints without changes', async (condition) => {
      const fixture = await createFixture();
      const index = { outsider: 5, invited: 3, removed: 4, 'missing group': 0 }[condition];
      const groupId = condition === 'missing group' ? randomUUID() : fixture.familyId;
      const before = await ownership(fixture);
      const historyBefore = await history(fixture);
      for (const [pathname, method] of [
        [`/groups/${groupId}/leave`, 'POST'], [`/groups/${groupId}/members/${fixture.userIds[1]}`, 'DELETE'],
      ] as const) {
        expect(await request(pathname, fixture.userIds[index], { method, body: {} }))
          .toEqual({ status: 403, body: { error: { message: 'Forbidden', status: 403 } } });
      }
      expect(await ownership(fixture)).toBe(before);
      expect(await history(fixture)).toBe(historyBefore);
    },
  );

  it('rejects member-admin removal and gives owner 404 for a missing or inactive target', async () => {
    const fixture = await createFixture();
    const before = await ownership(fixture);
    expect((await request(removalPath(fixture, 'remove'), fixture.userIds[2], { method: 'DELETE' })).status).toBe(403);
    for (const target of [randomUUID(), fixture.userIds[3], fixture.userIds[4], fixture.userIds[5]]) {
      expect((await request(removalPath(fixture, 'remove', target), fixture.userIds[0], { method: 'DELETE' })).status).toBe(404);
    }
    expect(await ownership(fixture)).toBe(before);
  });

  it('requires Bearer and rejects invalid UUIDs, extra fields and query parameters', async () => {
    const fixture = await createFixture();
    const before = await ownership(fixture);
    for (const [pathname, method] of [[removalPath(fixture, 'leave'), 'POST'], [removalPath(fixture, 'remove'), 'DELETE']] as const) {
      expect((await request(pathname, undefined, { method })).status).toBe(401);
      expect((await request(pathname, fixture.userIds[0], { method, body: { status: 'removed' } })).status).toBe(400);
      expect((await request(pathname + '?force=true', fixture.userIds[0], { method, body: {} })).status).toBe(400);
    }
    for (const [pathname, method] of [
      ['/groups/invalid/leave', 'POST'], [`/groups/${fixture.familyId}/members/invalid`, 'DELETE'],
      [`/groups/invalid/members/${fixture.userIds[1]}`, 'DELETE'],
    ] as const) {
      expect((await request(pathname, fixture.userIds[0], { method, body: {} })).status).toBe(400);
    }
    expect(await ownership(fixture)).toBe(before);
  });

  it.each(['leave', 'remove'] as const)('rolls back a real failed %s update, releases group and target locks and allows retry', async (operation) => {
    const fixture = await createFixture();
    const before = await ownership(fixture);
    const historyBefore = await history(fixture);
    await assertCurrentSchema();
    await database.query(`ALTER TABLE group_members ADD CONSTRAINT phase5_reject_removal
      CHECK (NOT (group_id = '${fixture.familyId}'::uuid AND user_id = '${fixture.userIds[1]}'::uuid AND status = 'removed')) NOT VALID`);
    try {
      const action = operation === 'leave'
        ? members.leaveGroup(fixture.userIds[1], fixture.familyId)
        : members.removeMember(fixture.userIds[0], fixture.familyId, fixture.userIds[1]);
      await expect(action).rejects.toMatchObject({ code: '23514', constraint: 'phase5_reject_removal' });
      expect(await ownership(fixture)).toBe(before);
      expect(await history(fixture)).toBe(historyBefore);
      const observer = await database.connect();
      try {
        await observer.query('BEGIN');
        await observer.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE NOWAIT', [fixture.familyId]);
        const target = await observer.query('SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2 FOR UPDATE NOWAIT',
          [fixture.familyId, fixture.userIds[1]]);
        expect(target.rows).toHaveLength(1);
        await observer.query('COMMIT');
      } catch (error) {
        await observer.query('ROLLBACK');
        throw error;
      } finally {
        observer.release();
      }
    } finally {
      await database.query('ALTER TABLE group_members DROP CONSTRAINT phase5_reject_removal');
    }
    expect((await depart(fixture, operation)).status).toBe(204);
    await assertOnlyRemoved(fixture, before);
    expect(await history(fixture)).toBe(historyBefore);
  });

  it.each(['leave', 'remove'] as const)('skips generation while real %s holds the group, then generates only the remaining members', async (operation) => {
    const fixture = await createFixture();
    await makeDue(fixture);
    const before = await ownership(fixture);
    const historyBefore = await history(fixture);
    const holder = await database.connect();
    let holding = false;
    let finished = false;
    let departure: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      holding = true;
      await holder.query('SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2 FOR UPDATE',
        [fixture.familyId, fixture.userIds[1]]);
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      departure = (operation === 'leave'
        ? members.leaveGroup(fixture.userIds[1], fixture.familyId)
        : members.removeMember(fixture.userIds[0], fixture.familyId, fixture.userIds[1])).then(
        () => { finished = true; return { ok: true }; },
        (error: unknown) => { finished = true; return { ok: false, error }; },
      );
      await waitForBlockedPid(pid, () => finished);
      expect(await generate(fixture)).toEqual({ subscriptionsProcessed: 0, paymentsCreated: 0, subscriptionsStillDue: 0 });
      expect(await nextDate(fixture)).toBe('2091-01-01');
      expect(await generatedPhoto(fixture)).toEqual([]);
      expect(await history(fixture)).toBe(historyBefore);
      await holder.query('COMMIT');
      holding = false;
      expect(await departure).toEqual({ ok: true });
      await assertOnlyRemoved(fixture, before);
      expect(await generate(fixture)).toEqual({ subscriptionsProcessed: 1, paymentsCreated: 1, subscriptionsStillDue: 0 });
      expect(await generatedPhoto(fixture)).toEqual([fixture.userIds[0], fixture.userIds[2]].sort().map((id) => ({
        user_id: id, share_amount: '6.00', share_percentage: '50.0000', status: 'pending',
        actual_amount: null, confirmed_at: null, parent_status: 'pending',
      })));
      expect(await nextDate(fixture)).toBe('2091-02-01');
      const expectedHistory = JSON.parse(historyBefore);
      expectedHistory.subscription.next_billing_date = '2091-02-01';
      expect(JSON.parse(await history(fixture))).toEqual(expectedHistory);
    } finally {
      try {
        if (holding) await holder.query('ROLLBACK');
      } finally {
        holder.release();
        if (departure) await departure;
      }
    }
  }, 15_000);

  it.each(['leave', 'remove'] as const)('keeps the complete snapshot when generation locks the group before %s', async (operation) => {
    const fixture = await createFixture();
    await makeDue(fixture);
    const before = await ownership(fixture);
    const historyBefore = await history(fixture);
    const holder = await database.connect();
    let holding = false;
    let generationFinished = false;
    let departureFinished = false;
    let generating: Promise<unknown> | undefined;
    let departure: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      holding = true;
      expect((await holder.query<{ name: string }>('SELECT current_schema() AS name')).rows[0].name).toBe(schema);
      // This table exists only in our schema. SELECTs remain available to departure's debt check.
      await holder.query('LOCK TABLE payments IN SHARE MODE');
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      generating = generate(fixture).then(
        (result) => { generationFinished = true; return { ok: true, result }; },
        (error: unknown) => { generationFinished = true; return { ok: false, error }; },
      );
      const generatorPid = await waitForBlockedPid(pid, () => generationFinished);
      departure = (operation === 'leave'
        ? members.leaveGroup(fixture.userIds[1], fixture.familyId)
        : members.removeMember(fixture.userIds[0], fixture.familyId, fixture.userIds[1])).then(
        () => { departureFinished = true; return { ok: true }; },
        (error: unknown) => { departureFinished = true; return { ok: false, error }; },
      );
      const departurePid = await waitForBlockedPid(generatorPid, () => departureFinished);
      expect(departurePid).not.toBe(generatorPid);
      await holder.query('COMMIT');
      holding = false;
      expect(await generating).toEqual({ ok: true, result: { subscriptionsProcessed: 1, paymentsCreated: 1, subscriptionsStillDue: 0 } });
      expect(await departure).toMatchObject({ ok: false, error: { status: 409 } });
      expect(await ownership(fixture)).toBe(before);
      const first = [...fixture.userIds.slice(0, 3)].sort()[0];
      expect(await generatedPhoto(fixture)).toEqual(fixture.userIds.slice(0, 3).sort().map((id) => ({
        user_id: id, share_amount: '4.00', share_percentage: id === first ? '33.3334' : '33.3333',
        status: 'pending', actual_amount: null, confirmed_at: null, parent_status: 'pending',
      })));
      expect(await nextDate(fixture)).toBe('2091-02-01');
      const expectedHistory = JSON.parse(historyBefore);
      expectedHistory.subscription.next_billing_date = '2091-02-01';
      expect(JSON.parse(await history(fixture))).toEqual(expectedHistory);
      const committed = await history(fixture);
      expect((await depart(fixture, operation)).status).toBe(409);
      expect(await history(fixture)).toBe(committed);
    } finally {
      try {
        if (holding) await holder.query('ROLLBACK');
      } finally {
        holder.release();
        await Promise.all([generating, departure]);
      }
    }
  }, 15_000);

  it.each(['leave caller removed', 'remove owner demoted'] as const)(
    'revalidates %s while waiting on the group lock', async (condition) => {
      const fixture = await createFixture();
      const historyBefore = await history(fixture);
      const expected = JSON.parse(await ownership(fixture));
      const holder = await database.connect();
      let holding = false;
      let finished = false;
      let attempted: Promise<unknown> | undefined;
      try {
        await holder.query('BEGIN');
        holding = true;
        await holder.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [fixture.familyId]);
        const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        attempted = (condition === 'leave caller removed'
          ? members.leaveGroup(fixture.userIds[1], fixture.familyId)
          : members.removeMember(fixture.userIds[0], fixture.familyId, fixture.userIds[1])).then(
          () => { finished = true; return { ok: true }; },
          (error: unknown) => { finished = true; return { ok: false, error }; },
        );
        await waitForBlockedPid(pid, () => finished);
        if (condition === 'leave caller removed') {
          expected.members = expected.members.map((member: { group_id: string; user_id: string }) => (
            member.group_id === fixture.familyId && member.user_id === fixture.userIds[1]
              ? { ...member, status: 'removed' } : member
          ));
          await holder.query("UPDATE group_members SET status = 'removed' WHERE group_id = $1 AND user_id = $2",
            [fixture.familyId, fixture.userIds[1]]);
        } else {
          expected.members = expected.members.map((member: { group_id: string; user_id: string }) => {
            if (member.group_id !== fixture.familyId) return member;
            if (member.user_id === fixture.userIds[0]) return { ...member, role: 'member' };
            if (member.user_id === fixture.userIds[2]) return { ...member, role: 'owner' };
            return member;
          });
          expected.groups = expected.groups.map((group: { id: string }) => group.id === fixture.familyId
            ? { ...group, owner_id: fixture.userIds[2] } : group);
          await holder.query("UPDATE group_members SET role = 'member' WHERE group_id = $1 AND user_id = $2",
            [fixture.familyId, fixture.userIds[0]]);
          await holder.query("UPDATE group_members SET role = 'owner' WHERE group_id = $1 AND user_id = $2",
            [fixture.familyId, fixture.userIds[2]]);
          await holder.query('UPDATE groups SET owner_id = $2 WHERE id = $1', [fixture.familyId, fixture.userIds[2]]);
        }
        await holder.query('COMMIT');
        holding = false;
        expect(await attempted).toMatchObject({ ok: false, error: { status: 403, message: 'Forbidden' } });
        expect(await history(fixture)).toBe(historyBefore);
        expect(JSON.parse(await ownership(fixture))).toEqual(expected);
        await assertOwner(fixture, condition === 'leave caller removed' ? fixture.userIds[0] : fixture.userIds[2]);
        const target = (await database.query('SELECT role,status FROM group_members WHERE group_id = $1 AND user_id = $2',
          [fixture.familyId, fixture.userIds[1]])).rows[0];
        expect(target).toEqual({ role: 'member', status: condition === 'leave caller removed' ? 'removed' : 'active' });
      } finally {
        try {
          if (holding) await holder.query('ROLLBACK');
        } finally {
          holder.release();
          if (attempted) await attempted;
        }
      }
    }, 15_000,
  );
});

