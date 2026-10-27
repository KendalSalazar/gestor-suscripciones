import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Group } from './group.types';

const { isolatedPool } = vi.hoisted(() => ({ isolatedPool: { value: undefined as Pool | undefined } }));
vi.mock('../../db/pool', () => ({
  get pool() {
    if (!isolatedPool.value) throw new Error('Isolated PostgreSQL pool is not ready');
    return isolatedPool.value;
  },
}));

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
type Fixture = { userIds: string[]; personalIds: string[]; familyId: string };

describeWithDatabase('groups API with real PostgreSQL and HTTP', () => {
  const schema = `phase5_test_${randomUUID().replaceAll('-', '')}`;
  const prefix = `phase5-test-${randomUUID()}`;
  let admin: Pool;
  let database: Pool;
  let schemaCreated = false;
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
      connectionString: isolatedUrl.toString(), max: 6,
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
        // PostgreSQL 16 provides gen_random_uuid; keep global extensions untouched.
        await client.query(source.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\r?\n/, ''));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    groups = await import('./group.service');
    ({ signAccessToken } = await import('../auth/auth.tokens'));
    const { app } = await import('../../app');
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server?.once('listening', resolve);
      server?.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing groups HTTP address');
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
    const userIds = Array.from({ length: 5 }, () => randomUUID());
    const personalIds = userIds.map(() => randomUUID());
    const familyId = randomUUID();
    await database.query(
      `INSERT INTO users (id, email, password_hash, name)
       SELECT id, email, 'unused-test-hash', $3 FROM UNNEST($1::uuid[], $2::text[]) fixture(id, email)`,
      [userIds, userIds.map((id) => `${prefix}-${id}@example.com`), prefix],
    );
    await database.query(
      `INSERT INTO groups (id, name, type, owner_id)
       SELECT id, 'Personal', 'personal'::group_type, user_id
       FROM UNNEST($1::uuid[], $2::uuid[]) fixture(id, user_id)`, [personalIds, userIds],
    );
    await database.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       SELECT group_id, user_id, 'owner'::member_role, 'active'::member_status, NOW()
       FROM UNNEST($1::uuid[], $2::uuid[]) fixture(group_id, user_id)`, [personalIds, userIds],
    );
    await database.query("INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, 'family', $3)",
      [familyId, prefix, userIds[0]]);
    await database.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       SELECT $1::uuid, user_id, role, status, CASE WHEN status = 'active' THEN NOW() ELSE NULL END
       FROM UNNEST($2::uuid[], $3::member_role[], $4::member_status[]) fixture(user_id, role, status)`,
      [familyId, [userIds[0], userIds[1], userIds[3], userIds[4]],
        ['owner', 'member', 'member', 'member'], ['active', 'active', 'invited', 'removed']],
    );
    return { userIds, personalIds, familyId };
  }

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

  async function snapshot(groupIds: string[]): Promise<string> {
    return (await database.query<{ snapshot: string }>(
      `SELECT jsonb_build_object(
        'groups', (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM groups g WHERE g.id = ANY($1::uuid[])),
        'memberships', (SELECT jsonb_agg(to_jsonb(gm) ORDER BY gm.id) FROM group_members gm WHERE gm.group_id = ANY($1::uuid[]))
       )::text AS snapshot`, [groupIds],
    )).rows[0].snapshot;
  }

  it('creates a family with its unique active owner, preserving the existing personal group', async () => {
    const fixture = await createFixture();
    const personalBefore = await snapshot([fixture.personalIds[0]]);
    const response = await request<{ group: Group }>('/groups', fixture.userIds[0], {
      method: 'POST', body: { name: '  Familia de prueba  ' },
    });
    expect(response.status).toBe(201);
    expect(response.body.group).toEqual({
      id: expect.any(String), name: 'Familia de prueba', type: 'family',
      ownerId: fixture.userIds[0], role: 'owner', createdAt: expect.any(String),
    });
    expect(new Date(response.body.group.createdAt).toISOString()).toBe(response.body.group.createdAt);
    expect((await database.query(
      `SELECT g.owner_id, gm.user_id, gm.role, gm.status, gm.joined_at IS NOT NULL AS joined
       FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE g.id = $1`, [response.body.group.id],
    )).rows).toEqual([{
      owner_id: fixture.userIds[0], user_id: fixture.userIds[0], role: 'owner', status: 'active', joined: true,
    }]);
    const listed = await request<{ groups: Group[] }>('/groups', fixture.userIds[0]);
    expect(listed.status).toBe(200);
    expect(listed.body.groups).toContainEqual(response.body.group);
    expect(await snapshot([fixture.personalIds[0]])).toBe(personalBefore);
    // Matching names are allowed: a repeated POST creates a distinct family.
    const second = await request<{ group: Group }>('/groups', fixture.userIds[0], {
      method: 'POST', body: { name: 'Familia de prueba' },
    });
    expect(second.status).toBe(201);
    expect(second.body.group.id).not.toBe(response.body.group.id);
  });

  it('lists only active own groups with personal first and stable creation/id ordering', async () => {
    const fixture = await createFixture();
    const extraIds = [randomUUID(), randomUUID()].sort();
    for (const id of extraIds) {
      await database.query("INSERT INTO groups (id,name,type,owner_id,created_at) VALUES ($1,$2,'family',$3,'2000-01-01')",
        [id, prefix, fixture.userIds[2]]);
      await database.query(
        `INSERT INTO group_members (group_id,user_id,role,status,joined_at)
         VALUES ($1,$2,'owner','active',NOW()), ($1,$3,'member','active',NOW())`,
        [id, fixture.userIds[2], fixture.userIds[0]],
      );
    }
    const response = await request<{ groups: Group[] }>('/groups', fixture.userIds[0]);
    expect(response.status).toBe(200);
    expect(response.body.groups.map((group) => group.id)).toEqual([fixture.personalIds[0], ...extraIds, fixture.familyId]);
    expect(response.body.groups.map((group) => group.role)).toEqual(['owner', 'member', 'member', 'owner']);
    expect(response.body.groups.every((group) => Object.keys(group).sort().join(',') === 'createdAt,id,name,ownerId,role,type')).toBe(true);
    for (const index of [3, 4]) {
      const inactive = await request<{ groups: Group[] }>('/groups', fixture.userIds[index]);
      expect(inactive.body.groups.map((group) => group.id)).toEqual([fixture.personalIds[index]]);
    }
    const member = await request<{ groups: Group[] }>('/groups', fixture.userIds[1]);
    expect(member.body.groups.map((group) => group.id)).toEqual([fixture.personalIds[1], fixture.familyId]);
    expect(member.body.groups[1].role).toBe('member');
  });

  it('renames a family through HTTP without altering ownership, memberships or another group', async () => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    const personalBefore = await snapshot([fixture.personalIds[0], foreign.familyId]);
    const previous = await groups.listGroups(fixture.userIds[0]);
    const expected = previous.find((group) => group.id === fixture.familyId);
    const membersBefore = (await database.query('SELECT * FROM group_members WHERE group_id = $1 ORDER BY id', [fixture.familyId])).rows;
    const response = await request<{ group: Group }>(`/groups/${fixture.familyId}`, fixture.userIds[0], {
      method: 'PATCH', body: { name: '  Nuevo nombre  ' },
    });
    expect(response).toEqual({ status: 200, body: { group: { ...expected, name: 'Nuevo nombre' } } });
    expect((await database.query('SELECT * FROM group_members WHERE group_id = $1 ORDER BY id', [fixture.familyId])).rows).toEqual(membersBefore);
    expect(await snapshot([fixture.personalIds[0], foreign.familyId])).toBe(personalBefore);
    expect((await request<{ groups: Group[] }>('/groups', fixture.userIds[1])).body.groups)
      .toContainEqual({ ...response.body.group, role: 'member' });
  });

  it.each(['member', 'outsider', 'invited', 'removed', 'missing group'] as const)(
    'returns the same HTTP 403 to %s without changing any fixture group', async (condition) => {
      const fixture = await createFixture();
      const indexes = { member: 1, outsider: 2, invited: 3, removed: 4, 'missing group': 0 };
      const before = await snapshot([fixture.familyId, ...fixture.personalIds]);
      const groupId = condition === 'missing group' ? randomUUID() : fixture.familyId;
      const response = await request(`/groups/${groupId}`, fixture.userIds[indexes[condition]], {
        method: 'PATCH', body: { name: 'Forbidden rename' },
      });
      expect(response).toEqual({ status: 403, body: { error: { message: 'Forbidden', status: 403 } } });
      expect(await snapshot([fixture.familyId, ...fixture.personalIds])).toBe(before);
    },
  );

  it('rejects renaming the authorized personal group with HTTP 409', async () => {
    const fixture = await createFixture();
    const before = await snapshot([fixture.personalIds[0]]);
    expect(await request(`/groups/${fixture.personalIds[0]}`, fixture.userIds[0], {
      method: 'PATCH', body: { name: 'Changed personal' },
    })).toMatchObject({ status: 409, body: { error: { status: 409 } } });
    expect(await snapshot([fixture.personalIds[0]])).toBe(before);
  });

  it('requires Bearer for all three routes and rejects invalid fields without writes', async () => {
    const fixture = await createFixture();
    const before = await snapshot([fixture.familyId, ...fixture.personalIds]);
    for (const [pathname, method, body] of [
      ['/groups', 'GET', undefined], ['/groups', 'POST', { name: 'Test' }],
      [`/groups/${fixture.familyId}`, 'PATCH', { name: 'Test' }],
    ] as const) {
      expect((await request(pathname, undefined, { method, body })).status).toBe(401);
    }
    for (const [pathname, method, body] of [
      ['/groups?type=family', 'GET', undefined], ['/groups', 'POST', { name: '  ' }],
      ['/groups', 'POST', { name: 'Injected', type: 'personal' }],
      [`/groups/${fixture.familyId}`, 'PATCH', { name: 'Injected', ownerId: fixture.userIds[1] }],
      [`/groups/${fixture.familyId}?role=owner`, 'PATCH', { name: 'Test' }],
      ['/groups/not-a-uuid', 'PATCH', { name: 'Test' }],
    ] as const) {
      expect((await request(pathname, fixture.userIds[0], { method, body })).status).toBe(400);
    }
    expect(await snapshot([fixture.familyId, ...fixture.personalIds])).toBe(before);
    expect((await groups.listGroups(fixture.userIds[0])).map((group) => group.id)).toHaveLength(2);
  });

  it('rolls back the inserted family if creating its owner membership fails, then permits retry', async () => {
    const fixture = await createFixture();
    const before = await snapshot([fixture.familyId, ...fixture.personalIds]);
    const countsBefore = (await database.query('SELECT (SELECT COUNT(*)::int FROM groups) AS groups, COUNT(*)::int AS memberships FROM group_members')).rows[0];
    const name = `${prefix}-rollback`;
    // UUID comes only from this fixture. NOT VALID leaves the existing owner untouched.
    await database.query(`ALTER TABLE group_members ADD CONSTRAINT phase5_reject_owner
      CHECK (user_id <> '${fixture.userIds[0]}'::uuid) NOT VALID`);
    try {
      await expect(groups.createGroup(fixture.userIds[0], { name }))
        .rejects.toMatchObject({ code: '23514', constraint: 'phase5_reject_owner' });
      expect((await database.query('SELECT id FROM groups WHERE name = $1', [name])).rows).toEqual([]);
      expect((await database.query('SELECT (SELECT COUNT(*)::int FROM groups) AS groups, COUNT(*)::int AS memberships FROM group_members')).rows[0]).toEqual(countsBefore);
      expect(await snapshot([fixture.familyId, ...fixture.personalIds])).toBe(before);
    } finally {
      await database.query('ALTER TABLE group_members DROP CONSTRAINT phase5_reject_owner');
    }
    const retry = await groups.createGroup(fixture.userIds[0], { name });
    expect(retry).toMatchObject({ name, type: 'family', ownerId: fixture.userIds[0], role: 'owner' });
  });

  it('rolls back a failed rename, releases the group lock and permits retry', async () => {
    const fixture = await createFixture();
    const before = await snapshot([fixture.familyId]);
    await database.query("ALTER TABLE groups ADD CONSTRAINT phase5_reject_rename CHECK (name <> 'Rejected rename') NOT VALID");
    try {
      await expect(groups.updateGroup(fixture.userIds[0], fixture.familyId, { name: 'Rejected rename' }))
        .rejects.toMatchObject({ code: '23514', constraint: 'phase5_reject_rename' });
      expect(await snapshot([fixture.familyId])).toBe(before);
      const observer = await database.connect();
      try {
        await observer.query('BEGIN');
        await observer.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE NOWAIT', [fixture.familyId]);
        await observer.query('COMMIT');
      } catch (error) {
        await observer.query('ROLLBACK');
        throw error;
      } finally {
        observer.release();
      }
    } finally {
      await database.query('ALTER TABLE groups DROP CONSTRAINT phase5_reject_rename');
    }
    expect(await groups.updateGroup(fixture.userIds[0], fixture.familyId, { name: 'Retry allowed' }))
      .toMatchObject({ id: fixture.familyId, name: 'Retry allowed' });
  });

  it.each(['member', 'removed'] as const)(
    'revalidates a former owner changed to %s while rename waits for the group lock', async (state) => {
      const fixture = await createFixture();
      const before = await snapshot([fixture.familyId]);
      const holder = await database.connect();
      let holding = false;
      let finished = false;
      let attempted: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
      try {
        await holder.query('BEGIN');
        holding = true;
        await holder.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [fixture.familyId]);
        const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        attempted = groups.updateGroup(fixture.userIds[0], fixture.familyId, { name: 'Outdated permission' }).then(
          () => { finished = true; return { ok: true as const }; },
          (error: unknown) => { finished = true; return { ok: false as const, error }; },
        );
        let waiting = false;
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline && !finished) {
          const result = await database.query<{ waiting: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1
             AND wait_event_type = 'Lock' AND $2::integer = ANY(pg_blocking_pids(pid))) AS waiting`, [prefix, pid],
          );
          if (result.rows[0].waiting) { waiting = true; break; }
          await delay(10);
        }
        expect(waiting).toBe(true);
        // Fixture-only SQL simulates a later transfer/removal; no new endpoint is added.
        await holder.query("UPDATE group_members SET role = 'member', status = $3 WHERE group_id = $1 AND user_id = $2",
          [fixture.familyId, fixture.userIds[0], state === 'removed' ? 'removed' : 'active']);
        await holder.query("UPDATE group_members SET role = 'owner' WHERE group_id = $1 AND user_id = $2",
          [fixture.familyId, fixture.userIds[1]]);
        await holder.query('UPDATE groups SET owner_id = $2 WHERE id = $1', [fixture.familyId, fixture.userIds[1]]);
        await holder.query('COMMIT');
        holding = false;
        expect(await attempted).toMatchObject({ ok: false, error: { status: 403, message: 'Forbidden' } });
        const changed = (await database.query('SELECT name, owner_id FROM groups WHERE id = $1', [fixture.familyId])).rows[0];
        expect(changed).toEqual({ name: prefix, owner_id: fixture.userIds[1] });
        expect(await snapshot([fixture.familyId])).not.toBe(before);
        const listed = await groups.listGroups(fixture.userIds[0]);
        if (state === 'removed') expect(listed.some((group) => group.id === fixture.familyId)).toBe(false);
        else expect(listed.find((group) => group.id === fixture.familyId)?.role).toBe('member');
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
