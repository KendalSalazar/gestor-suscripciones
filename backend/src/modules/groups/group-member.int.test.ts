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

describeWithDatabase('family members and ownership with real PostgreSQL and HTTP', () => {
  const schema = `phase5_test_${randomUUID().replaceAll('-', '')}`;
  const prefix = `phase5-test-${randomUUID()}`;
  let admin: Pool;
  let database: Pool;
  let schemaCreated = false;
  let members: typeof import('./group-member.service');
  let groups: typeof import('./group.service');
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
    groups = await import('./group.service');
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
        userIds.slice(0, 3).map((id) => id === first ? '33.3334' : '33.3333'), userIds[0]],
    );
    return fixture;
  }

  const memberPath = (id: string) => `/groups/${id}/members`;
  const transferPath = (id: string) => `/groups/${id}/transfer-ownership`;
  async function request<T>(pathname: string, userId: string | undefined, options: {
    method?: 'GET' | 'POST' | 'PATCH'; body?: object;
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
    return { status: response.status, body: await response.json() as T };
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

  it('lists only active members for owner and member, with stable order, ISO dates and no private fields', async () => {
    const fixture = await createFixture();
    const before = await ownership(fixture);
    const response = await request<{ members: GroupMember[] }>(memberPath(fixture.familyId), fixture.userIds[0]);
    expect(response.status).toBe(200);
    expect(response.body.members.map((member) => member.userId)).toEqual([
      fixture.userIds[0], ...fixture.userIds.slice(1, 3).sort(),
    ]);
    for (const member of response.body.members) {
      expect(Object.keys(member).sort()).toEqual(['joinedAt', 'name', 'role', 'status', 'userId']);
      expect(member).toMatchObject({ name: prefix, status: 'active' });
      expect(new Date(member.joinedAt).toISOString()).toBe(member.joinedAt);
    }
    expect(await request(memberPath(fixture.familyId), fixture.userIds[1])).toEqual(response);
    expect(await ownership(fixture)).toBe(before);
  });

  it('applies the HTTP limit of 20 after owner-first and UUID ordering', async () => {
    const fixture = await createFixture();
    // Deliberately overfill only this isolated fixture to exercise the read cap.
    const extraIds = Array.from({ length: 19 }, () => randomUUID());
    await database.query(
      `INSERT INTO users (id,email,password_hash,name)
       SELECT id,email,'unused-test-hash',$3 FROM UNNEST($1::uuid[],$2::text[]) fixture(id,email)`,
      [extraIds, extraIds.map((id) => `${prefix}-${id}@example.com`), prefix],
    );
    await database.query(
      `INSERT INTO group_members (group_id,user_id,role,status,joined_at)
       SELECT $1,id,'member','active',NOW() FROM UNNEST($2::uuid[]) fixture(id)`, [fixture.familyId, extraIds],
    );
    const response = await request<{ members: GroupMember[] }>(memberPath(fixture.familyId), fixture.userIds[1]);
    expect(response.status).toBe(200);
    expect(response.body.members.map((member) => member.userId)).toEqual([
      fixture.userIds[0], ...[...fixture.userIds.slice(1, 3), ...extraIds].sort().slice(0, 19),
    ]);
  });

  it('transfers between two HTTP sessions, preserves history and changes their current permissions', async () => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    const foreignBefore = await ownership(foreign);
    const historyBefore = await history(fixture);
    const before = JSON.parse(await ownership(fixture));
    const original = (await groups.listGroups(fixture.userIds[0])).find((group) => group.id === fixture.familyId);
    const response = await request<{ group: Group }>(transferPath(fixture.familyId), fixture.userIds[0], {
      method: 'POST', body: { newOwnerId: fixture.userIds[1] },
    });
    expect(response).toEqual({ status: 200, body: { group: { ...original, ownerId: fixture.userIds[1], role: 'member' } } });
    await assertOwner(fixture, fixture.userIds[1]);
    const after = JSON.parse(await ownership(fixture));
    expect(after.groups).toEqual(before.groups.map((group: { id: string }) => group.id === fixture.familyId
      ? { ...group, owner_id: fixture.userIds[1] } : group));
    expect(after.members).toEqual(before.members.map((member: { group_id: string; user_id: string }) => {
      if (member.group_id !== fixture.familyId) return member;
      if (member.user_id === fixture.userIds[0]) return { ...member, role: 'member' };
      if (member.user_id === fixture.userIds[1]) return { ...member, role: 'owner' };
      return member;
    }));
    for (const [index, role] of [[0, 'member'], [1, 'owner']] as const) {
      const listed = await request<{ groups: Group[] }>('/groups', fixture.userIds[index]);
      expect(listed.status).toBe(200);
      expect(listed.body.groups.find((group) => group.id === fixture.familyId))
        .toEqual({ ...response.body.group, role });
      const roster = await request<{ members: GroupMember[] }>(memberPath(fixture.familyId), fixture.userIds[index]);
      expect(roster.body.members[0]).toMatchObject({ userId: fixture.userIds[1], role: 'owner' });
    }
    expect((await request(`/groups/${fixture.familyId}`, fixture.userIds[0], {
      method: 'PATCH', body: { name: 'Old owner rename' },
    })).status).toBe(403);
    expect((await request(`/groups/${fixture.familyId}`, fixture.userIds[1], {
      method: 'PATCH', body: { name: 'New owner rename' },
    })).status).toBe(200);
    expect(await history(fixture)).toBe(historyBefore);
    expect(await ownership(foreign)).toBe(foreignBefore);
    const detail = await request<PaymentShareBreakdown>(
      `/groups/${fixture.familyId}/payments/${fixture.paymentId}/shares`, fixture.userIds[1],
    );
    expect(detail.body.summary).toEqual({ totalShares: 3, confirmedShares: 1, confirmedAmount: '4.50' });
    expect(detail.body.payment).toMatchObject({ status: 'pending', actualAmount: null, priceChanged: false });
    expect(detail.body.shares.find((share) => share.id === fixture.shareIds[0]))
      .toMatchObject({ userId: fixture.userIds[0], status: 'confirmed', actualAmount: '4.50' });
    // Becoming owner does not transfer someone else's saved share.
    expect((await request(
      `/groups/${fixture.familyId}/payments/${fixture.paymentId}/shares/${fixture.shareIds[2]}/confirm`,
      fixture.userIds[1], { method: 'POST', body: {} },
    )).status).toBe(403);
    expect(await history(fixture)).toBe(historyBefore);
  });

  it.each(['outsider', 'invited', 'removed', 'missing group'] as const)(
    'returns uniform HTTP 403 for %s on both new routes', async (condition) => {
      const fixture = await createFixture();
      const index = { outsider: 5, invited: 3, removed: 4, 'missing group': 0 }[condition];
      const groupId = condition === 'missing group' ? randomUUID() : fixture.familyId;
      const before = await ownership(fixture);
      for (const [pathname, options] of [
        [memberPath(groupId), {}],
        [transferPath(groupId), { method: 'POST', body: { newOwnerId: fixture.userIds[1] } }],
      ] as const) {
        expect(await request(pathname, fixture.userIds[index], options))
          .toEqual({ status: 403, body: { error: { message: 'Forbidden', status: 403 } } });
      }
      expect(await ownership(fixture)).toBe(before);
    },
  );

  it('permits member reads but rejects a member attempting ownership transfer', async () => {
    const fixture = await createFixture();
    const before = await ownership(fixture);
    expect((await request(memberPath(fixture.familyId), fixture.userIds[1])).status).toBe(200);
    expect(await request(transferPath(fixture.familyId), fixture.userIds[1], {
      method: 'POST', body: { newOwnerId: fixture.userIds[2] },
    })).toEqual({ status: 403, body: { error: { message: 'Forbidden', status: 403 } } });
    expect(await ownership(fixture)).toBe(before);
  });

  it('rejects authorized personal groups on both routes without affecting the personal owner', async () => {
    const fixture = await createFixture();
    const before = await ownership(fixture);
    expect((await request(memberPath(fixture.personalIds[0]), fixture.userIds[0])).status).toBe(409);
    expect((await request(transferPath(fixture.personalIds[0]), fixture.userIds[0], {
      method: 'POST', body: { newOwnerId: fixture.userIds[1] },
    })).status).toBe(409);
    expect((await request(memberPath(fixture.personalIds[0]), fixture.userIds[1])).status).toBe(403);
    expect(await ownership(fixture)).toBe(before);
  });

  it.each(['self', 'outsider', 'invited', 'removed', 'missing'] as const)(
    'rejects %s as transfer destination without partial role changes', async (condition) => {
      const fixture = await createFixture();
      const target = condition === 'missing' ? randomUUID() : fixture.userIds[
        { self: 0, outsider: 5, invited: 3, removed: 4, missing: 0 }[condition]
      ];
      if (condition === 'outsider') {
        const foreign = await createFixture();
        await database.query(
          `INSERT INTO group_members (group_id,user_id,role,status,joined_at)
           VALUES ($1,$2,'member','active',NOW())`, [foreign.familyId, target],
        );
      }
      const before = await ownership(fixture);
      const historyBefore = await history(fixture);
      expect((await request(transferPath(fixture.familyId), fixture.userIds[0], {
        method: 'POST', body: { newOwnerId: target },
      })).status).toBe(409);
      expect(await ownership(fixture)).toBe(before);
      expect(await history(fixture)).toBe(historyBefore);
    },
  );

  it('requires authentication and strictly validates UUID, body and query before any mutation', async () => {
    const fixture = await createFixture();
    const before = await ownership(fixture);
    expect((await request(memberPath(fixture.familyId), undefined)).status).toBe(401);
    expect((await request(transferPath(fixture.familyId), undefined, {
      method: 'POST', body: { newOwnerId: fixture.userIds[1] },
    })).status).toBe(401);
    for (const [pathname, options] of [
      [memberPath('invalid-uuid'), {}], [memberPath(fixture.familyId) + '?status=active', {}],
      [transferPath('invalid-uuid'), { method: 'POST', body: { newOwnerId: fixture.userIds[1] } }],
      [transferPath(fixture.familyId), { method: 'POST', body: {} }],
      [transferPath(fixture.familyId), { method: 'POST', body: { newOwnerId: 'invalid' } }],
      [transferPath(fixture.familyId), { method: 'POST', body: { newOwnerId: fixture.userIds[1], role: 'owner' } }],
      [transferPath(fixture.familyId) + '?role=owner', { method: 'POST', body: { newOwnerId: fixture.userIds[1] } }],
    ] as const) {
      expect((await request(pathname, fixture.userIds[0], options)).status).toBe(400);
    }
    expect(await ownership(fixture)).toBe(before);
  });

  it.each(['promotion', 'group owner'] as const)(
    'rolls back failure at %s, releases every lock and permits retry', async (stage) => {
      const fixture = await createFixture();
      const before = await ownership(fixture);
      const historyBefore = await history(fixture);
      const table = stage === 'promotion' ? 'group_members' : 'groups';
      const constraint = stage === 'promotion' ? 'phase5_reject_promotion' : 'phase5_reject_owner_change';
      // Only generated UUIDs are interpolated, and both tables exist solely in this validated schema.
      const predicate = stage === 'promotion'
        ? `NOT (group_id = '${fixture.familyId}'::uuid AND user_id = '${fixture.userIds[1]}'::uuid AND role = 'owner')`
        : `NOT (id = '${fixture.familyId}'::uuid AND owner_id = '${fixture.userIds[1]}'::uuid)`;
      await database.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (${predicate}) NOT VALID`);
      try {
        await expect(members.transferOwnership(fixture.userIds[0], fixture.familyId, { newOwnerId: fixture.userIds[1] }))
          .rejects.toMatchObject({ code: '23514', constraint });
        expect(await ownership(fixture)).toBe(before);
        expect(await history(fixture)).toBe(historyBefore);
        const observer = await database.connect();
        try {
          await observer.query('BEGIN');
          await observer.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE NOWAIT', [fixture.familyId]);
          const locked = await observer.query(
            `SELECT user_id FROM group_members WHERE group_id = $1 AND user_id = ANY($2::uuid[])
             ORDER BY user_id FOR UPDATE NOWAIT`, [fixture.familyId, fixture.userIds.slice(0, 2)],
          );
          expect(locked.rows).toHaveLength(2);
          await observer.query('COMMIT');
        } catch (error) {
          await observer.query('ROLLBACK');
          throw error;
        } finally {
          observer.release();
        }
      } finally {
        await database.query(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`);
      }
      expect(await members.transferOwnership(fixture.userIds[0], fixture.familyId, { newOwnerId: fixture.userIds[1] }))
        .toMatchObject({ ownerId: fixture.userIds[1], role: 'member' });
      await assertOwner(fixture, fixture.userIds[1]);
      expect(await history(fixture)).toBe(historyBefore);
    },
  );

  it('serializes two HTTP transfers by the old owner: one succeeds and one loses authorization', async () => {
    const fixture = await createFixture();
    const historyBefore = await history(fixture);
    const results = await Promise.all(fixture.userIds.slice(1, 3).map((target) => request<{ group: Group }>(
      transferPath(fixture.familyId), fixture.userIds[0], { method: 'POST', body: { newOwnerId: target } },
    )));
    expect(results.map((result) => result.status).sort()).toEqual([200, 403]);
    const winner = results.find((result) => result.status === 200)!;
    expect(winner.body.group.role).toBe('member');
    await assertOwner(fixture, winner.body.group.ownerId);
    const roster = await members.listMembers(fixture.userIds[0], fixture.familyId);
    expect(roster.find((member) => member.userId === fixture.userIds[0])?.role).toBe('member');
    expect(roster.filter((member) => member.role === 'owner')).toHaveLength(1);
    expect(await history(fixture)).toBe(historyBefore);
  });

  it('holds the group while awaiting the target row, then invalidates an old-owner rename already waiting behind it', async () => {
    const fixture = await createFixture();
    const historyBefore = await history(fixture);
    const holder = await database.connect();
    let holding = false;
    let transferFinished = false;
    let renameFinished = false;
    let transfer: Promise<unknown> | undefined;
    let rename: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      holding = true;
      // Lock only the target membership, so the real transfer can first acquire the group lock.
      await holder.query('SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2 FOR UPDATE',
        [fixture.familyId, fixture.userIds[1]]);
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      transfer = members.transferOwnership(fixture.userIds[0], fixture.familyId, { newOwnerId: fixture.userIds[1] }).then(
        (group) => { transferFinished = true; return { ok: true, group }; },
        (error: unknown) => { transferFinished = true; return { ok: false, error }; },
      );
      const transferPid = await waitForBlockedPid(holderPid, () => transferFinished);
      rename = groups.updateGroup(fixture.userIds[0], fixture.familyId, { name: 'Outdated owner permission' }).then(
        (group) => { renameFinished = true; return { ok: true, group }; },
        (error: unknown) => { renameFinished = true; return { ok: false, error }; },
      );
      const renamePid = await waitForBlockedPid(transferPid, () => renameFinished);
      expect(renamePid).not.toBe(transferPid);
      await holder.query('COMMIT');
      holding = false;
      expect(await transfer).toMatchObject({ ok: true, group: { ownerId: fixture.userIds[1], role: 'member' } });
      expect(await rename).toMatchObject({ ok: false, error: { status: 403, message: 'Forbidden' } });
      await assertOwner(fixture, fixture.userIds[1]);
      expect((await database.query('SELECT name FROM groups WHERE id = $1', [fixture.familyId])).rows[0].name).toBe(prefix);
      expect(await history(fixture)).toBe(historyBefore);
    } finally {
      try {
        if (holding) await holder.query('ROLLBACK');
      } finally {
        holder.release();
        await Promise.all([transfer, rename]);
      }
    }
  }, 15_000);

  it('rejects a target removed while the real transfer waits for the group lock', async () => {
    const fixture = await createFixture();
    const historyBefore = await history(fixture);
    const holder = await database.connect();
    let holding = false;
    let finished = false;
    let attempted: Promise<unknown> | undefined;
    const before = JSON.parse(await ownership(fixture));
    try {
      await holder.query('BEGIN');
      holding = true;
      await holder.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [fixture.familyId]);
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      attempted = members.transferOwnership(fixture.userIds[0], fixture.familyId, { newOwnerId: fixture.userIds[1] }).then(
        (group) => { finished = true; return { ok: true, group }; },
        (error: unknown) => { finished = true; return { ok: false, error }; },
      );
      await waitForBlockedPid(pid, () => finished);
      await holder.query("UPDATE group_members SET status = 'removed' WHERE group_id = $1 AND user_id = $2",
        [fixture.familyId, fixture.userIds[1]]);
      await holder.query('COMMIT');
      holding = false;
      expect(await attempted).toMatchObject({ ok: false, error: { status: 409 } });
      expect(JSON.parse(await ownership(fixture))).toEqual({
        ...before,
        members: before.members.map((member: { group_id: string; user_id: string }) => (
          member.group_id === fixture.familyId && member.user_id === fixture.userIds[1]
            ? { ...member, status: 'removed' } : member
        )),
      });
      await assertOwner(fixture, fixture.userIds[0]);
      expect(await history(fixture)).toBe(historyBefore);
    } finally {
      try {
        if (holding) await holder.query('ROLLBACK');
      } finally {
        holder.release();
        if (attempted) await attempted;
      }
    }
  }, 15_000);
});
