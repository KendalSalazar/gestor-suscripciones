import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Group, GroupMember } from './group.types';
import type { Invitation } from './invitation.types';

const { isolatedPool } = vi.hoisted(() => ({ isolatedPool: { value: undefined as Pool | undefined } }));
vi.mock('../../db/pool', () => ({
  get pool() {
    if (!isolatedPool.value) throw new Error('Isolated PostgreSQL pool is not ready');
    return isolatedPool.value;
  },
}));

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
type Fixture = { users: string[]; personalGroups: string[]; familyId: string };
type InvitationState = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';

describeWithDatabase('recipient invitation flow with real PostgreSQL and HTTP', () => {
  const schema = `phase5_test_${randomUUID().replaceAll('-', '')}`;
  const prefix = `phase5-test-${randomUUID()}`;
  let admin: Pool;
  let database: Pool;
  let schemaCreated = false;
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
    database = new Pool({ connectionString: isolatedUrl.toString(), max: 8, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
    isolatedPool.value = database;
    const client = await database.connect();
    try {
      const current = await client.query<{ name: string }>('SELECT current_schema() AS name');
      if (current.rows[0].name !== schema) throw new Error('Unexpected PostgreSQL search_path');
      await client.query('BEGIN');
      const directory = path.join(__dirname, '../../db/migrations');
      for (const filename of fs.readdirSync(directory).filter((name) => /^00[1-8]_.*\.sql$/.test(name)).sort()) {
        const source = fs.readFileSync(path.join(directory, filename), 'utf8');
        // PostgreSQL 16 provides gen_random_uuid; do not alter global extensions.
        await client.query(source.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\r?\n/, ''));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    ({ signAccessToken } = await import('../auth/auth.tokens'));
    const { app } = await import('../../app');
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server?.once('listening', resolve);
      server?.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing recipient invitation HTTP address');
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
    const users = Array.from({ length: 6 }, () => randomUUID());
    const personalGroups = users.map(() => randomUUID());
    const familyId = randomUUID();
    await database.query(
      `INSERT INTO users (id, email, password_hash, name)
       SELECT id, $2 || '-' || id::text || '@example.com', 'unused-test-hash', $2 || '-' || id::text
       FROM UNNEST($1::uuid[]) fixture(id)`, [users, prefix],
    );
    await database.query(
      `INSERT INTO groups (id, name, type, owner_id)
       SELECT id, 'Personal', 'personal'::group_type, user_id
       FROM UNNEST($1::uuid[], $2::uuid[]) fixture(id, user_id)`, [personalGroups, users],
    );
    await database.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       SELECT group_id, user_id, 'owner'::member_role, 'active'::member_status, statement_timestamp()
       FROM UNNEST($1::uuid[], $2::uuid[]) fixture(group_id, user_id)`, [personalGroups, users],
    );
    await database.query("INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, 'family', $3)",
      [familyId, prefix, users[0]]);
    await database.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       SELECT $1::uuid, user_id, role, status,
         CASE WHEN status = 'active' THEN statement_timestamp() ELSE NULL END
       FROM UNNEST($2::uuid[], $3::member_role[], $4::member_status[]) fixture(user_id, role, status)`,
      [familyId, users.slice(0, 5), ['owner', 'member', 'member', 'member', 'member'],
        ['active', 'active', 'active', 'invited', 'removed']],
    );
    return { users, personalGroups, familyId };
  }

  const emailOf = (userId: string) => `${prefix}-${userId}@example.com`;
  const previewPath = (id: string) => `/invitations/${id}/preview`;
  const acceptPath = (id: string) => `/invitations/${id}/accept`;
  const declinePath = (id: string) => `/invitations/${id}/decline`;
  const testToken = () => randomUUID().replaceAll('-', '').padEnd(43, 'x').slice(0, 43);
  const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

  async function insertInvitation(
    fixture: Fixture,
    email: string,
    token = testToken(),
    state: InvitationState = 'pending',
    expiresAt = '2099-01-01T00:00:00.000Z',
  ): Promise<{ id: string; token: string }> {
    const id = randomUUID();
    await database.query(
      `INSERT INTO group_invitations
         (id, group_id, invited_by, email, token_hash, status, accepted_by, created_at, expires_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6::group_invitation_status,
         CASE WHEN $6::group_invitation_status = 'accepted' THEN $7::uuid ELSE NULL END,
         CASE WHEN $8::timestamptz <= statement_timestamp() THEN $8::timestamptz - INTERVAL '1 day'
              ELSE statement_timestamp() END,
         $8::timestamptz,
         CASE WHEN $6::group_invitation_status = 'pending' THEN NULL ELSE statement_timestamp() END)`,
      [id, fixture.familyId, fixture.users[0], email, hashToken(token), state, fixture.users[2], expiresAt],
    );
    return { id, token };
  }

  async function request<T>(pathname: string, userId: string | undefined, tokenValue?: string,
    jwtEmail?: string): Promise<{ status: number; body: T }> {
    const accessToken = userId
      ? signAccessToken({ id: userId, email: jwtEmail ?? emailOf(userId) })
      : undefined;
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(tokenValue === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: tokenValue === undefined ? undefined : JSON.stringify({ token: tokenValue }),
      signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: await response.json() as T };
  }

  async function snapshot(fixture: Fixture, invitationId: string): Promise<string> {
    return (await database.query<{ snapshot: string }>(
      `SELECT jsonb_build_object(
        'groups', (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM groups g WHERE g.id = $1),
        'memberships', (SELECT COALESCE(jsonb_agg(to_jsonb(gm) ORDER BY gm.user_id), '[]'::jsonb)
          FROM group_members gm WHERE gm.group_id = $1),
        'invitation', (SELECT to_jsonb(i) FROM group_invitations i WHERE i.id = $2 AND i.group_id = $1)
       )::text AS snapshot`, [fixture.familyId, invitationId],
    )).rows[0].snapshot;
  }

  async function waitForBlockedPid(holderPid: number, finished: () => boolean): Promise<number> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const result = await database.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'
         AND $2::integer = ANY(pg_blocking_pids(pid))`, [prefix, holderPid],
      );
      if (result.rows[0]) return result.rows[0].pid;
      if (finished()) throw new Error('Recipient operation finished before the expected lock wait');
      await delay(10);
    }
    throw new Error('Expected recipient group lock wait was not observed');
  }

  it('previews a token only for the matching current database email; stale JWT email is ignored', async () => {
    const fixture = await createFixture();
    const invitation = await insertInvitation(fixture, emailOf(fixture.users[3]));
    const before = await snapshot(fixture, invitation.id);
    const response = await request<{ invitation: Invitation }>(
      previewPath(invitation.id), fixture.users[3], invitation.token, 'outdated-jwt@example.com',
    );
    expect(response.status).toBe(200);
    expect(response.body.invitation).toMatchObject({
      id: invitation.id, groupId: fixture.familyId, groupName: prefix,
      email: emailOf(fixture.users[3]), invitedByName: `${prefix}-${fixture.users[0]}`,
      status: 'pending',
    });
    expect(Object.keys(response.body.invitation).sort()).toEqual([
      'createdAt', 'email', 'expiresAt', 'groupId', 'groupName', 'id', 'invitedByName', 'status',
    ]);
    expect(await snapshot(fixture, invitation.id)).toBe(before);
  });

  it('returns the same unavailable response for a wrong token, wrong recipient and unknown UUID', async () => {
    const fixture = await createFixture();
    const invitation = await insertInvitation(fixture, emailOf(fixture.users[3]));
    const responses = await Promise.all([
      request(previewPath(invitation.id), fixture.users[3], testToken()),
      request(previewPath(invitation.id), fixture.users[4], invitation.token),
      request(previewPath(randomUUID()), fixture.users[3], invitation.token),
    ]);
    expect(responses.map(({ status, body }) => ({ status, body }))).toEqual([
      { status: 404, body: { error: { status: 404, message: 'Invitation unavailable' } } },
      { status: 404, body: { error: { status: 404, message: 'Invitation unavailable' } } },
      { status: 404, body: { error: { status: 404, message: 'Invitation unavailable' } } },
    ]);
  });

  it('accepts an invitation for an account registered after invitation creation', async () => {
    const fixture = await createFixture();
    const futureUser = randomUUID();
    const futureEmail = `${prefix}-registered-later@example.com`;
    const invitation = await insertInvitation(fixture, futureEmail);
    await database.query('INSERT INTO users (id,email,password_hash,name) VALUES ($1,$2,$3,$4)',
      [futureUser, futureEmail, 'unused-test-hash', 'Registered later']);
    const response = await request<{ group: Group; membership: GroupMember }>(
      acceptPath(invitation.id), futureUser, invitation.token,
    );
    expect(response.status).toBe(200);
    expect(response.body.group).toMatchObject({ id: fixture.familyId, type: 'family', role: 'member' });
    expect(response.body.membership).toMatchObject({
      userId: futureUser, name: 'Registered later', role: 'member', status: 'active',
    });
    const stored = (await database.query(
      `SELECT status, accepted_by, resolved_at FROM group_invitations WHERE id = $1`, [invitation.id],
    )).rows[0];
    expect(stored).toMatchObject({ status: 'accepted', accepted_by: futureUser, resolved_at: expect.any(Date) });
    expect((await database.query(
      `SELECT role, status, joined_at FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [fixture.familyId, futureUser],
    )).rows[0]).toMatchObject({ role: 'member', status: 'active', joined_at: expect.any(Date) });
  });

  it.each([
    { userIndex: 3, previousStatus: 'invited' },
    { userIndex: 4, previousStatus: 'removed' },
  ] as const)('reactivates an eligible $previousStatus membership as a member', async ({ userIndex }) => {
    const fixture = await createFixture();
    const invitation = await insertInvitation(fixture, emailOf(fixture.users[userIndex]));
    const response = await request<{ membership: GroupMember }>(
      acceptPath(invitation.id), fixture.users[userIndex], invitation.token,
    );
    expect(response.status).toBe(200);
    expect(response.body.membership).toMatchObject({
      userId: fixture.users[userIndex], role: 'member', status: 'active',
    });
    expect((await database.query(
      `SELECT role, status, joined_at FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [fixture.familyId, fixture.users[userIndex]],
    )).rows[0]).toMatchObject({ role: 'member', status: 'active', joined_at: expect.any(Date) });
  });

  it('does not let an invitation change an already active owner or member', async () => {
    const fixture = await createFixture();
    const ownerInvitation = await insertInvitation(fixture, emailOf(fixture.users[0]));
    const memberInvitation = await insertInvitation(fixture, emailOf(fixture.users[1]));
    const beforeOwner = await snapshot(fixture, ownerInvitation.id);
    const beforeMember = await snapshot(fixture, memberInvitation.id);
    for (const [userId, invitation, before] of [
      [fixture.users[0], ownerInvitation, beforeOwner], [fixture.users[1], memberInvitation, beforeMember],
    ] as const) {
      expect((await request(acceptPath(invitation.id), userId, invitation.token)).status).toBe(409);
      expect(await snapshot(fixture, invitation.id)).toBe(before);
    }
    expect((await database.query(
      `SELECT role, status FROM group_members WHERE group_id = $1 AND user_id = $2`, [fixture.familyId, fixture.users[0]],
    )).rows[0]).toEqual({ role: 'owner', status: 'active' });
  });

  it('returns conflict for a pending invitation whose expiry has passed without persisting a false resolution', async () => {
    const fixture = await createFixture();
    const invitation = await insertInvitation(fixture, emailOf(fixture.users[3]), testToken(), 'pending', '2000-01-01');
    const before = await snapshot(fixture, invitation.id);
    expect((await request(acceptPath(invitation.id), fixture.users[3], invitation.token)).status).toBe(409);
    expect(await snapshot(fixture, invitation.id)).toBe(before);
    expect((await database.query('SELECT status,accepted_by,resolved_at FROM group_invitations WHERE id = $1',
      [invitation.id])).rows[0]).toEqual({ status: 'pending', accepted_by: null, resolved_at: null });
  });

  it.each(['accepted', 'declined', 'revoked', 'expired'] as const)(
    'does not resolve an already %s invitation again', async (status) => {
      const fixture = await createFixture();
      const invitation = await insertInvitation(fixture, emailOf(fixture.users[3]), testToken(), status);
      const before = await snapshot(fixture, invitation.id);
      expect((await request(acceptPath(invitation.id), fixture.users[3], invitation.token)).status).toBe(409);
      expect(await snapshot(fixture, invitation.id)).toBe(before);
    },
  );

  it('rejects acceptance when the family already has twenty active members', async () => {
    const fixture = await createFixture();
    const invitation = await insertInvitation(fixture, emailOf(fixture.users[5]));
    const extraUsers = Array.from({ length: 16 }, () => randomUUID());
    await database.query(
      `INSERT INTO users (id,email,password_hash,name)
       SELECT id, $2 || '-' || id::text || '@example.com', 'unused-test-hash', $2 || '-' || id::text
       FROM UNNEST($1::uuid[]) fixture(id)`, [extraUsers, prefix],
    );
    await database.query(
      `INSERT INTO group_members (group_id,user_id,role,status,joined_at)
       SELECT $1::uuid,id,'member','active',statement_timestamp() FROM UNNEST($2::uuid[]) fixture(id)`,
      [fixture.familyId, extraUsers],
    );
    // The fixture starts with three active members; 16 more and one further
    // member fill the 20 places before the recipient tries to join.
    const lastUser = randomUUID();
    await database.query('INSERT INTO users (id,email,password_hash,name) VALUES ($1,$2,$3,$4)',
      [lastUser, `${prefix}-last@example.com`, 'unused-test-hash', 'Last member']);
    await database.query(
      `INSERT INTO group_members (group_id,user_id,role,status,joined_at)
       VALUES ($1,$2,'member','active',statement_timestamp())`, [fixture.familyId, lastUser],
    );
    const before = await snapshot(fixture, invitation.id);
    expect((await request(acceptPath(invitation.id), fixture.users[5], invitation.token)).status).toBe(409);
    expect(await snapshot(fixture, invitation.id)).toBe(before);
    expect((await database.query('SELECT COUNT(*)::int AS count FROM group_members WHERE group_id=$1 AND status=\'active\'',
      [fixture.familyId])).rows[0].count).toBe(20);
  });

  it('declines without creating or reactivating a group membership', async () => {
    const fixture = await createFixture();
    const invitation = await insertInvitation(fixture, emailOf(fixture.users[3]));
    const beforeMembers = (await database.query('SELECT * FROM group_members WHERE group_id=$1 ORDER BY user_id',
      [fixture.familyId])).rows;
    const response = await request<{ invitation: Invitation }>(
      declinePath(invitation.id), fixture.users[3], invitation.token,
    );
    expect(response.status).toBe(200);
    expect(response.body.invitation).toMatchObject({ id: invitation.id, status: 'declined' });
    expect((await database.query('SELECT status,accepted_by,resolved_at FROM group_invitations WHERE id=$1',
      [invitation.id])).rows[0]).toMatchObject({ status: 'declined', accepted_by: null, resolved_at: expect.any(Date) });
    expect((await database.query('SELECT * FROM group_members WHERE group_id=$1 ORDER BY user_id',
      [fixture.familyId])).rows).toEqual(beforeMembers);
  });

  it('makes two concurrent acceptances of one invitation resolve exactly once', async () => {
    const fixture = await createFixture();
    const invitation = await insertInvitation(fixture, emailOf(fixture.users[3]));
    const results = await Promise.all([
      request(acceptPath(invitation.id), fixture.users[3], invitation.token),
      request(acceptPath(invitation.id), fixture.users[3], invitation.token),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect((await database.query(
      'SELECT status,accepted_by FROM group_invitations WHERE id=$1', [invitation.id],
    )).rows[0]).toEqual({ status: 'accepted', accepted_by: fixture.users[3] });
    expect((await database.query(
      'SELECT COUNT(*)::int AS count FROM group_members WHERE group_id=$1 AND user_id=$2 AND status=\'active\'',
      [fixture.familyId, fixture.users[3]],
    )).rows[0].count).toBe(1);
  });

  it('rolls back membership activation when marking acceptance violates a database CHECK', async () => {
    const fixture = await createFixture();
    const invitation = await insertInvitation(fixture, emailOf(fixture.users[3]));
    const before = await snapshot(fixture, invitation.id);
    if (!/^[0-9a-f-]{36}$/i.test(invitation.id)) throw new Error('Unsafe invitation fixture UUID');
    const constraintName = 'phase5_reject_acceptance';
    await database.query(`ALTER TABLE group_invitations ADD CONSTRAINT ${constraintName}
      CHECK (NOT (id = '${invitation.id}'::uuid AND status = 'accepted')) NOT VALID`);
    try {
      const failed = await request<{ error: { status: number; message: string } }>(
        acceptPath(invitation.id), fixture.users[3], invitation.token,
      );
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({ error: { status: 500, message: 'Invitation operation failed' } });
      expect(await snapshot(fixture, invitation.id)).toBe(before);
      expect((await database.query(
        'SELECT status,accepted_by,resolved_at FROM group_invitations WHERE id=$1', [invitation.id],
      )).rows[0]).toEqual({ status: 'pending', accepted_by: null, resolved_at: null });
      expect((await database.query(
        'SELECT role,status,joined_at FROM group_members WHERE group_id=$1 AND user_id=$2',
        [fixture.familyId, fixture.users[3]],
      )).rows[0]).toMatchObject({ role: 'member', status: 'invited', joined_at: null });

      const observer = await database.connect();
      try {
        await observer.query('BEGIN');
        await observer.query('SELECT id FROM groups WHERE id=$1 FOR UPDATE NOWAIT', [fixture.familyId]);
        await observer.query('SELECT id FROM group_invitations WHERE id=$1 FOR UPDATE NOWAIT', [invitation.id]);
        const member = await observer.query(
          'SELECT status FROM group_members WHERE group_id=$1 AND user_id=$2 FOR UPDATE NOWAIT',
          [fixture.familyId, fixture.users[3]],
        );
        expect(member.rows[0]).toEqual({ status: 'invited' });
        await observer.query('COMMIT');
      } catch (error) {
        await observer.query('ROLLBACK');
        throw error;
      } finally {
        observer.release();
      }
    } finally {
      await database.query(`ALTER TABLE group_invitations DROP CONSTRAINT ${constraintName}`);
    }
  });

  it.each(['accept', 'decline'] as const)('rechecks current database email after a group-lock wait on %s', async (operation) => {
    const fixture = await createFixture();
    const invitation = await insertInvitation(fixture, emailOf(fixture.users[3]));
    const holder = await database.connect();
    let holding = false;
    let finished = false;
    let attempted: Promise<{ status: number; body: unknown }> | undefined;
    try {
      await holder.query('BEGIN');
      holding = true;
      await holder.query('SELECT id FROM groups WHERE id=$1 FOR UPDATE', [fixture.familyId]);
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      attempted = request(operation === 'accept' ? acceptPath(invitation.id) : declinePath(invitation.id),
        fixture.users[3], invitation.token).then((result) => { finished = true; return result; });
      await waitForBlockedPid(holderPid, () => finished);
      await holder.query('UPDATE users SET email=$2 WHERE id=$1',
        [fixture.users[3], `${prefix}-${randomUUID()}-changed@example.com`]);
      await holder.query('COMMIT');
      holding = false;
      const response = await attempted;
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: { status: 404, message: 'Invitation unavailable' } });
      expect((await database.query('SELECT status FROM group_invitations WHERE id=$1', [invitation.id])).rows[0].status)
        .toBe('pending');
      expect((await database.query('SELECT status FROM group_members WHERE group_id=$1 AND user_id=$2',
        [fixture.familyId, fixture.users[3]])).rows[0].status).toBe('invited');
    } finally {
      try {
        if (holding) await holder.query('ROLLBACK');
      } finally {
        holder.release();
        if (attempted) await attempted.catch(() => undefined);
      }
    }
  }, 10_000);

  it('rechecks invitation state after the group-lock wait so concurrent revocation wins', async () => {
    const fixture = await createFixture();
    const invitation = await insertInvitation(fixture, emailOf(fixture.users[3]));
    const holder = await database.connect();
    let holding = false;
    let finished = false;
    let attempted: Promise<{ status: number; body: unknown }> | undefined;
    try {
      await holder.query('BEGIN');
      holding = true;
      await holder.query('SELECT id FROM groups WHERE id=$1 FOR UPDATE', [fixture.familyId]);
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      attempted = request(acceptPath(invitation.id), fixture.users[3], invitation.token)
        .then((result) => { finished = true; return result; });
      await waitForBlockedPid(holderPid, () => finished);
      await holder.query(
        `UPDATE group_invitations SET status='revoked',resolved_at=statement_timestamp()
         WHERE id=$1 AND group_id=$2`, [invitation.id, fixture.familyId],
      );
      await holder.query('COMMIT');
      holding = false;
      expect((await attempted).status).toBe(409);
      expect((await database.query('SELECT status FROM group_invitations WHERE id=$1', [invitation.id])).rows[0].status)
        .toBe('revoked');
      expect((await database.query('SELECT status FROM group_members WHERE group_id=$1 AND user_id=$2',
        [fixture.familyId, fixture.users[3]])).rows[0].status).toBe('invited');
    } finally {
      try {
        if (holding) await holder.query('ROLLBACK');
      } finally {
        holder.release();
        if (attempted) await attempted.catch(() => undefined);
      }
    }
  }, 10_000);
});
