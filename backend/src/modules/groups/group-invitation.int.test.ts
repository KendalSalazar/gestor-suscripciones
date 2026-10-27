import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CreatedInvitation as Creation, Invitation } from './invitation.types';

const { isolatedPool } = vi.hoisted(() => ({ isolatedPool: { value: undefined as Pool | undefined } }));
vi.mock('../../db/pool', () => ({
  get pool() {
    if (!isolatedPool.value) throw new Error('Isolated PostgreSQL pool is not ready');
    return isolatedPool.value;
  },
}));

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
type Fixture = { userIds: string[]; personalIds: string[]; familyId: string };

describeWithDatabase('owner invitations with real PostgreSQL and HTTP', () => {
  const schema = `phase5_test_${randomUUID().replaceAll('-', '')}`;
  const prefix = `phase5-test-${randomUUID()}`;
  let admin: Pool;
  let database: Pool;
  let schemaCreated = false;
  let invitations: typeof import('./invitation.service');
  let members: typeof import('./group-member.service');
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
    invitations = await import('./invitation.service');
    members = await import('./group-member.service');
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
       SELECT id, email, 'unused-test-hash', $3 || '-' || id::text FROM UNNEST($1::uuid[], $2::text[]) fixture(id, email)`,
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
    method?: 'GET' | 'POST'; body?: object;
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
        'memberships', (SELECT jsonb_agg(to_jsonb(gm) ORDER BY gm.id) FROM group_members gm WHERE gm.group_id = ANY($1::uuid[])),
        'invitations', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
          FROM group_invitations i WHERE i.group_id = ANY($1::uuid[]))
       )::text AS snapshot`, [groupIds],
    )).rows[0].snapshot;
  }

  const emailOf = (id: string) => `${prefix}-${id}@example.com`;
  const nameOf = (id: string) => `${prefix}-${id}`;
  const listPath = (groupId: string) => `/groups/${groupId}/invitations`;
  const revokePath = (groupId: string, id: string) => `${listPath(groupId)}/${id}/revoke`;
  const newEmail = () => emailOf(randomUUID());

  async function create(fixture: Fixture, email = newEmail()) {
    return request<Creation>(listPath(fixture.familyId), fixture.userIds[0], { method: 'POST', body: { email } });
  }

  function assertDTO(invitation: Invitation, fixture: Fixture, invitedBy = fixture.userIds[0]) {
    expect(Object.keys(invitation).sort()).toEqual([
      'createdAt', 'email', 'expiresAt', 'groupId', 'groupName', 'id', 'invitedByName', 'status',
    ]);
    expect(invitation).toMatchObject({ groupId: fixture.familyId, groupName: prefix, invitedByName: nameOf(invitedBy) });
    expect(new Date(invitation.createdAt).toISOString()).toBe(invitation.createdAt);
    expect(new Date(invitation.expiresAt).toISOString()).toBe(invitation.expiresAt);
  }

  async function insertInvitation(fixture: Fixture, status: Invitation['status'] = 'pending', expired = false) {
    const id = randomUUID();
    await database.query(
      `INSERT INTO group_invitations (id,group_id,invited_by,email,token_hash,status,accepted_by,created_at,expires_at,resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6::group_invitation_status,
         CASE WHEN $6::group_invitation_status = 'accepted' THEN $7::uuid ELSE NULL END,
         '2000-01-01', $8::timestamptz,
         CASE WHEN $6::group_invitation_status = 'pending' THEN NULL ELSE '2000-01-03'::timestamptz END)`,
      [id, fixture.familyId, fixture.userIds[0], newEmail(), createHash('sha256').update(randomUUID()).digest('hex'),
        status, fixture.userIds[2], expired ? '2000-01-02' : '2099-01-01'],
    );
    return id;
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

  it('creates the same private DTO for registered and unregistered emails, normalizing input and storing only a seven-day hash', async () => {
    const fixture = await createFixture();
    const before = JSON.parse(await snapshot([fixture.familyId, ...fixture.personalIds]));
    const absentEmail = newEmail();
    expect((await database.query('SELECT id FROM users WHERE email = $1', [absentEmail])).rows).toEqual([]);
    for (const email of [absentEmail, emailOf(fixture.userIds[2])]) {
      const response = await create(fixture, `  ${email.toUpperCase()}  `);
      expect(response.status).toBe(201);
      expect(Object.keys(response.body).sort()).toEqual(['invitation', 'token']);
      assertDTO(response.body.invitation, fixture);
      expect(response.body.invitation).toMatchObject({ email, status: 'pending' });
      // Boolean assertions avoid displaying a raw invitation code if the encoding is wrong.
      expect(/^[A-Za-z0-9_-]{43}$/.test(response.body.token)).toBe(true);
      expect(Buffer.from(response.body.token, 'base64url').length).toBe(32);
      const stored = (await database.query(
        `SELECT token_hash, status, accepted_by, resolved_at,
           EXTRACT(EPOCH FROM (expires_at - created_at))::text AS seconds
         FROM group_invitations WHERE id = $1 AND group_id = $2`, [response.body.invitation.id, fixture.familyId],
      )).rows[0];
      expect(stored.token_hash === createHash('sha256').update(response.body.token).digest('hex')).toBe(true);
      expect(/^[0-9a-f]{64}$/.test(stored.token_hash)).toBe(true);
      expect(stored).toMatchObject({ status: 'pending', accepted_by: null, resolved_at: null });
      expect(Number(stored.seconds)).toBe(7 * 24 * 60 * 60);
    }
    const after = JSON.parse(await snapshot([fixture.familyId, ...fixture.personalIds]));
    expect(after.groups).toEqual(before.groups);
    expect(after.memberships).toEqual(before.memberships);
    expect(after.invitations).toHaveLength(2);
  });

  it('rejects the current owner and active member emails without creating invitations', async () => {
    const fixture = await createFixture();
    const before = await snapshot([fixture.familyId]);
    for (const id of fixture.userIds.slice(0, 2)) {
      expect((await create(fixture, ` ${emailOf(id).toUpperCase()} `)).status).toBe(409);
    }
    expect(await snapshot([fixture.familyId])).toBe(before);
  });

  it('rejects a duplicate live invitation after normalizing its email, preserving the original row', async () => {
    const fixture = await createFixture();
    const email = newEmail();
    expect((await create(fixture, email)).status).toBe(201);
    const before = await snapshot([fixture.familyId]);
    expect((await create(fixture, ` ${email.toUpperCase()} `)).status).toBe(409);
    expect(await snapshot([fixture.familyId])).toBe(before);
  });

  it('materializes an expired pending invitation before creating another for the same email', async () => {
    const fixture = await createFixture();
    const oldId = await insertInvitation(fixture, 'pending', true);
    const old = (await database.query('SELECT * FROM group_invitations WHERE id = $1', [oldId])).rows[0];
    const response = await create(fixture, old.email);
    expect(response.status).toBe(201);
    expect(response.body.invitation.id).not.toBe(oldId);
    expect(response.body.invitation).toMatchObject({ email: old.email, status: 'pending' });
    const rows = (await database.query('SELECT * FROM group_invitations WHERE group_id = $1 AND email = $2 ORDER BY created_at',
      [fixture.familyId, old.email])).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ ...old, status: 'expired', resolved_at: expect.any(Date) });
    expect(rows[1]).toMatchObject({ id: response.body.invitation.id, status: 'pending', resolved_at: null });
    expect(rows[1].token_hash !== rows[0].token_hash).toBe(true);
  });

  it('lists at most 100 invitations by creation date then UUID descending without codes, hashes or user ids', async () => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    await insertInvitation(foreign);
    const ids = Array.from({ length: 101 }, () => randomUUID());
    await database.query(
      `INSERT INTO group_invitations (id,group_id,invited_by,email,token_hash,created_at,expires_at)
       SELECT id,$2,$3,email,hash,created_at,'2099-01-01'
       FROM UNNEST($1::uuid[],$4::text[],$5::text[],$6::timestamptz[]) fixture(id,email,hash,created_at)`,
      [ids, fixture.familyId, fixture.userIds[0], ids.map((id) => emailOf(id)),
        ids.map((id) => createHash('sha256').update(id).digest('hex')),
        ids.map((_id, index) => index < 3 ? '2021-01-01' : '2020-01-01')],
    );
    const before = await snapshot([fixture.familyId, foreign.familyId]);
    const response = await request<{ invitations: Invitation[] }>(listPath(fixture.familyId), fixture.userIds[0]);
    expect(response.status).toBe(200);
    expect(response.body.invitations.map((invitation) => invitation.id)).toEqual([
      ...ids.slice(0, 3).sort().reverse(), ...ids.slice(3).sort().reverse().slice(0, 97),
    ]);
    response.body.invitations.forEach((invitation) => assertDTO(invitation, fixture));
    expect(await snapshot([fixture.familyId, foreign.familyId])).toBe(before);
  });

  it('returns an empty list and presents expired pending rows logically without persisting a resolution', async () => {
    const fixture = await createFixture();
    expect(await request(listPath(fixture.familyId), fixture.userIds[0])).toEqual({ status: 200, body: { invitations: [] } });
    const id = await insertInvitation(fixture, 'pending', true);
    const before = await snapshot([fixture.familyId]);
    const response = await request<{ invitations: Invitation[] }>(listPath(fixture.familyId), fixture.userIds[0]);
    expect(response.status).toBe(200);
    expect(response.body.invitations).toEqual([expect.objectContaining({ id, status: 'expired' })]);
    assertDTO(response.body.invitations[0], fixture);
    expect(await snapshot([fixture.familyId])).toBe(before);
    expect((await database.query('SELECT status,resolved_at FROM group_invitations WHERE id = $1', [id])).rows)
      .toEqual([{ status: 'pending', resolved_at: null }]);
  });

  it('revokes pending invitations with absent or empty body, preserving their photo and rejecting repetition', async () => {
    for (const body of [undefined, {}]) {
      const fixture = await createFixture();
      const created = await create(fixture);
      expect(created.status).toBe(201);
      const id = created.body.invitation.id;
      const before = (await database.query('SELECT * FROM group_invitations WHERE id = $1', [id])).rows[0];
      const response = await request<{ invitation: Invitation }>(revokePath(fixture.familyId, id), fixture.userIds[0], { method: 'POST', body });
      expect(response).toEqual({ status: 200, body: { invitation: { ...created.body.invitation, status: 'revoked' } } });
      expect((await database.query('SELECT * FROM group_invitations WHERE id = $1', [id])).rows[0])
        .toEqual({ ...before, status: 'revoked', resolved_at: expect.any(Date) });
      const committed = await snapshot([fixture.familyId]);
      expect((await request(revokePath(fixture.familyId, id), fixture.userIds[0], { method: 'POST', body: {} })).status).toBe(409);
      expect(await snapshot([fixture.familyId])).toBe(committed);
    }
  });

  it('rejects all terminal states and expired pending revocation without altering history', async () => {
    const fixture = await createFixture();
    for (const state of ['accepted', 'declined', 'revoked', 'expired', 'pending'] as const) {
      const id = await insertInvitation(fixture, state, true);
      const before = await snapshot([fixture.familyId]);
      expect((await request(revokePath(fixture.familyId, id), fixture.userIds[0], { method: 'POST', body: {} })).status).toBe(409);
      expect(await snapshot([fixture.familyId])).toBe(before);
    }
  });

  it('lets the new owner list and revoke invitations created by the previous owner', async () => {
    const fixture = await createFixture();
    const created = await create(fixture);
    expect(created.status).toBe(201);
    await members.transferOwnership(fixture.userIds[0], fixture.familyId, { newOwnerId: fixture.userIds[1] });
    const response = await request<{ invitations: Invitation[] }>(listPath(fixture.familyId), fixture.userIds[1]);
    expect(response).toEqual({ status: 200, body: { invitations: [created.body.invitation] } });
    expect((await request(listPath(fixture.familyId), fixture.userIds[0])).status).toBe(403);
    const revoked = await request<{ invitation: Invitation }>(revokePath(fixture.familyId, created.body.invitation.id),
      fixture.userIds[1], { method: 'POST', body: {} });
    expect(revoked).toEqual({ status: 200, body: { invitation: { ...created.body.invitation, status: 'revoked' } } });
    assertDTO(revoked.body.invitation, fixture, fixture.userIds[0]);
  });

  it.each(['member', 'outsider', 'invited', 'removed', 'missing group'] as const)(
    'returns uniform 403 for %s on all owner invitation routes', async (condition) => {
      const fixture = await createFixture();
      const id = await insertInvitation(fixture);
      const groupId = condition === 'missing group' ? randomUUID() : fixture.familyId;
      const index = { member: 1, outsider: 2, invited: 3, removed: 4, 'missing group': 0 }[condition];
      const before = await snapshot([fixture.familyId]);
      for (const [pathname, options] of [
        [listPath(groupId), {}], [listPath(groupId), { method: 'POST', body: { email: newEmail() } }],
        [revokePath(groupId, id), { method: 'POST', body: {} }],
      ] as const) {
        expect(await request(pathname, fixture.userIds[index], options))
          .toEqual({ status: 403, body: { error: { message: 'Forbidden', status: 403 } } });
      }
      expect(await snapshot([fixture.familyId])).toBe(before);
    },
  );

  it('rejects all invitation operations on an authorized personal group', async () => {
    const fixture = await createFixture();
    const before = await snapshot([fixture.familyId, ...fixture.personalIds]);
    for (const [pathname, options] of [
      [listPath(fixture.personalIds[0]), {}],
      [listPath(fixture.personalIds[0]), { method: 'POST', body: { email: newEmail() } }],
      [revokePath(fixture.personalIds[0], randomUUID()), { method: 'POST', body: {} }],
    ] as const) {
      expect((await request(pathname, fixture.userIds[0], options)).status).toBe(409);
    }
    expect(await snapshot([fixture.familyId, ...fixture.personalIds])).toBe(before);
  });

  it('scopes invitations and active membership checks to the authorized group', async () => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    const foreignId = await insertInvitation(foreign);
    const before = await snapshot([fixture.familyId, foreign.familyId]);
    const foreignBefore = await snapshot([foreign.familyId]);
    for (const id of [foreignId, randomUUID()]) {
      expect((await request(revokePath(fixture.familyId, id), fixture.userIds[0], { method: 'POST', body: {} })).status).toBe(404);
    }
    expect(await snapshot([fixture.familyId, foreign.familyId])).toBe(before);
    // Being an active member elsewhere does not make this account a member of the target family.
    expect((await create(fixture, emailOf(foreign.userIds[1]))).status).toBe(201);
    expect(await snapshot([foreign.familyId])).toBe(foreignBefore);
  });

  it('requires Bearer and strict email, UUID, query and body validation before writing', async () => {
    const fixture = await createFixture();
    const id = await insertInvitation(fixture);
    const before = await snapshot([fixture.familyId]);
    for (const [pathname, options] of [
      [listPath(fixture.familyId), {}], [listPath(fixture.familyId), { method: 'POST', body: { email: newEmail() } }],
      [revokePath(fixture.familyId, id), { method: 'POST', body: {} }],
    ] as const) {
      expect((await request(pathname, undefined, options)).status).toBe(401);
    }
    for (const [pathname, options] of [
      [listPath('invalid'), {}], [listPath(fixture.familyId) + '?status=pending', {}],
      [listPath(fixture.familyId), { method: 'POST', body: { email: 'invalid' } }],
      [listPath(fixture.familyId), { method: 'POST', body: { email: newEmail(), token: 'not-accepted' } }],
      [listPath(fixture.familyId), { method: 'POST', body: {} }],
      [listPath(fixture.familyId) + '?force=true', { method: 'POST', body: { email: newEmail() } }],
      [revokePath(fixture.familyId, 'invalid'), { method: 'POST', body: {} }],
      [revokePath(fixture.familyId, id), { method: 'POST', body: { status: 'revoked' } }],
      [revokePath(fixture.familyId, id) + '?force=true', { method: 'POST', body: {} }],
    ] as const) {
      expect((await request(pathname, fixture.userIds[0], options)).status).toBe(400);
    }
    expect(await snapshot([fixture.familyId])).toBe(before);
  });

  it('serializes concurrent creation of one normalized email into 201 and 409 with exactly one pending row', async () => {
    const fixture = await createFixture();
    const email = newEmail();
    const responses = await Promise.all([create(fixture, email), create(fixture, ` ${email.toUpperCase()} `)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = responses.find((response) => response.status === 201)!;
    expect((await database.query('SELECT id,status FROM group_invitations WHERE group_id = $1 AND email = $2',
      [fixture.familyId, email])).rows).toEqual([{ id: winner.body.invitation.id, status: 'pending' }]);
  });

  it('rolls back a real revocation failure, releases group and invitation locks and permits retry', async () => {
    const fixture = await createFixture();
    const id = await insertInvitation(fixture);
    const before = await snapshot([fixture.familyId]);
    expect((await database.query<{ name: string }>('SELECT current_schema() AS name')).rows[0].name).toBe(schema);
    await database.query(`ALTER TABLE group_invitations ADD CONSTRAINT phase5_reject_revocation
      CHECK (NOT (id = '${id}'::uuid AND status = 'revoked')) NOT VALID`);
    try {
      await expect(invitations.revokeInvitation(fixture.userIds[0], fixture.familyId, id))
        .rejects.toMatchObject({ status: 500, message: 'Invitation operation failed', isOperational: false });
      const failedHTTP = await request<{ error: { status: number; message: string } }>(
        revokePath(fixture.familyId, id), fixture.userIds[0], { method: 'POST', body: {} },
      );
      expect(failedHTTP.status).toBe(500);
      expect(['Invitation operation failed', 'Internal server error']).toContain(failedHTTP.body.error.message);
      expect(Object.keys(failedHTTP.body)).toEqual(['error']);
      expect(Object.keys(failedHTTP.body.error).sort()).toEqual(['message', 'status']);
      expect(failedHTTP.body.error.status).toBe(500);
      expect(await snapshot([fixture.familyId])).toBe(before);
      const observer = await database.connect();
      try {
        await observer.query('BEGIN');
        await observer.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE NOWAIT', [fixture.familyId]);
        const locked = await observer.query('SELECT id FROM group_invitations WHERE id = $1 AND group_id = $2 FOR UPDATE NOWAIT',
          [id, fixture.familyId]);
        expect(locked.rows).toHaveLength(1);
        await observer.query('COMMIT');
      } catch (error) {
        await observer.query('ROLLBACK');
        throw error;
      } finally {
        observer.release();
      }
    } finally {
      await database.query('ALTER TABLE group_invitations DROP CONSTRAINT phase5_reject_revocation');
    }
    expect((await request(revokePath(fixture.familyId, id), fixture.userIds[0], { method: 'POST', body: {} })).status).toBe(200);
  });

  it('rejects revocation when the invitation expires while waiting for the group lock', async () => {
    const fixture = await createFixture();
    const id = await insertInvitation(fixture);
    const holder = await database.connect();
    let holding = false;
    let finished = false;
    let attempted: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      holding = true;
      await holder.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [fixture.familyId]);
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      attempted = invitations.revokeInvitation(fixture.userIds[0], fixture.familyId, id).then(
        (invitation) => { finished = true; return { ok: true, invitation }; },
        (error: unknown) => { finished = true; return { ok: false, error }; },
      );
      await waitForBlockedPid(pid, () => finished);
      await holder.query(
        `UPDATE group_invitations SET expires_at = clock_timestamp() + INTERVAL '100 milliseconds'
         WHERE id = $1 AND group_id = $2`, [id, fixture.familyId],
      );
      const deadline = Date.now() + 1_000;
      let expired = false;
      while (Date.now() < deadline) {
        expired = (await holder.query<{ expired: boolean }>(
          'SELECT clock_timestamp() >= expires_at AS expired FROM group_invitations WHERE id = $1', [id],
        )).rows[0].expired;
        if (expired) break;
        await delay(10);
      }
      expect(expired).toBe(true);
      const expected = (await holder.query('SELECT * FROM group_invitations WHERE id = $1', [id])).rows[0];
      await holder.query('COMMIT');
      holding = false;
      expect(await attempted).toMatchObject({ ok: false, error: { status: 409 } });
      expect((await database.query('SELECT * FROM group_invitations WHERE id = $1', [id])).rows[0]).toEqual(expected);
      expect(expected).toMatchObject({ status: 'pending', resolved_at: null });
      const listed = await request<{ invitations: Invitation[] }>(listPath(fixture.familyId), fixture.userIds[0]);
      expect(listed.status).toBe(200);
      expect(listed.body.invitations).toEqual([expect.objectContaining({ id, status: 'expired' })]);
    } finally {
      try {
        if (holding) await holder.query('ROLLBACK');
      } finally {
        holder.release();
        if (attempted) await attempted;
      }
    }
  }, 10_000);

  it.each(['create', 'revoke'] as const)('revalidates %s after a real ownership transfer retaining the group lock', async (operation) => {
    const fixture = await createFixture();
    const id = await insertInvitation(fixture);
    const before = JSON.parse(await snapshot([fixture.familyId]));
    const holder = await database.connect();
    let holding = false;
    let transferFinished = false;
    let invitationFinished = false;
    let transfer: Promise<unknown> | undefined;
    let attempted: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      holding = true;
      await holder.query('SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2 FOR UPDATE',
        [fixture.familyId, fixture.userIds[1]]);
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      transfer = members.transferOwnership(fixture.userIds[0], fixture.familyId, { newOwnerId: fixture.userIds[1] }).then(
        (group) => { transferFinished = true; return { ok: true, group }; },
        (error: unknown) => { transferFinished = true; return { ok: false, error }; },
      );
      const transferPid = await waitForBlockedPid(pid, () => transferFinished);
      attempted = (operation === 'create'
        ? invitations.createInvitation(fixture.userIds[0], fixture.familyId, { email: newEmail() })
        : invitations.revokeInvitation(fixture.userIds[0], fixture.familyId, id)).then(
        () => { invitationFinished = true; return { ok: true }; },
        (error: unknown) => { invitationFinished = true; return { ok: false, error }; },
      );
      await waitForBlockedPid(transferPid, () => invitationFinished);
      await holder.query('COMMIT');
      holding = false;
      expect(await transfer).toMatchObject({ ok: true, group: { ownerId: fixture.userIds[1], role: 'member' } });
      expect(await attempted).toMatchObject({ ok: false, error: { status: 403, message: 'Forbidden' } });
      const after = JSON.parse(await snapshot([fixture.familyId]));
      expect(after.invitations).toEqual(before.invitations);
      expect(after.groups).toEqual(before.groups.map((group: object) => ({ ...group, owner_id: fixture.userIds[1] })));
      expect(after.memberships).toEqual(before.memberships.map((member: { user_id: string }) => {
        if (member.user_id === fixture.userIds[0]) return { ...member, role: 'member' };
        if (member.user_id === fixture.userIds[1]) return { ...member, role: 'owner' };
        return member;
      }));
    } finally {
      try {
        if (holding) await holder.query('ROLLBACK');
      } finally {
        holder.release();
        await Promise.all([transfer, attempted]);
      }
    }
  }, 15_000);
});

