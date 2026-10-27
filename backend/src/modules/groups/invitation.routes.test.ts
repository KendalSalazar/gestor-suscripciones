import { createHash } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockConnect, mockClientQuery, mockRelease } = vi.hoisted(() => ({
  mockQuery: vi.fn(), mockConnect: vi.fn(), mockClientQuery: vi.fn(), mockRelease: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { query: mockQuery, connect: mockConnect } }));
vi.mock('../../config/env', () => ({
  env: { isProd: false, jwtAccessSecret: 'invitation-tests-only-access-key', jwtAccessExpiresIn: '15m' },
}));
vi.mock('../../config/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, authLogger: logger, subscriptionLogger: logger };
});

import { app } from '../../app';
import { logger } from '../../config/logger';
import { signAccessToken } from '../auth/auth.tokens';
import type { CreatedInvitation, Invitation, InvitationRow } from './invitation.types';

const userId = 'a7e4dc62-0df7-4ff4-a54f-c670455d1151';
const groupId = '08dc3ad7-cf55-4199-9fa3-594003beef20';
const invitationId = 'bfc9cdd3-0ae3-43ad-9a76-95d0cd8f847a';
const oldInvitationId = 'ab338ee8-0500-43ea-a154-9b703b75eb10';
const ownerEmail = 'owner@example.com';
const invitedEmail = 'invitee@example.com';
const row: InvitationRow = {
  id: invitationId, group_id: groupId, group_name: 'Learning family', email: invitedEmail,
  invited_by_name: 'Inviting owner', status: 'pending',
  created_at: new Date('2090-01-01T12:00:00.000Z'), expires_at: new Date('2090-01-08T12:00:00.000Z'),
};
const publicInvitation: Invitation = {
  id: invitationId, groupId, groupName: row.group_name, email: invitedEmail,
  invitedByName: row.invited_by_name, status: 'pending',
  createdAt: '2090-01-01T12:00:00.000Z', expiresAt: '2090-01-08T12:00:00.000Z',
};
const actions = ['create', 'list', 'revoke'] as const;
type Action = typeof actions[number];

describe('owner invitation HTTP API', () => {
  let server: Server;
  let baseUrl: string;
  let accessToken: string;

  beforeAll(async () => {
    accessToken = signAccessToken({ id: userId, email: 'stale-jwt-email@example.com' });
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue({ rows: [] });
    mockClientQuery.mockReset().mockResolvedValue({ rows: [] });
    mockConnect.mockReset().mockResolvedValue({ query: mockClientQuery, release: mockRelease });
    mockRelease.mockReset();
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
  });

  function targetFor(action: Action, targetGroupId = groupId, targetInvitationId = invitationId): string {
    const root = `/groups/${targetGroupId}/invitations`;
    return action === 'revoke' ? `${root}/${targetInvitationId}/revoke` : root;
  }

  async function send(
    action: Action,
    body: unknown = action === 'create' ? { email: invitedEmail } : undefined,
    target = targetFor(action),
    token: string | null = accessToken,
  ): Promise<Response> {
    return fetch(`${baseUrl}${target}`, {
      method: action === 'list' ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function getWithBody(body: unknown): Promise<{ status: number; body: unknown }> {
    const serialized = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = httpRequest(`${baseUrl}${targetFor('list')}`, {
        method: 'GET', headers: {
          Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(serialized),
        },
      }, (response) => {
        response.setEncoding('utf8');
        let raw = '';
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(raw) }));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.end(serialized);
    });
  }

  function allowWrite(role: 'owner' | 'member' = 'owner', groupType: 'family' | 'personal' = 'family', initialRole = role): void {
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: initialRole, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ type: groupType }] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role, status: 'active' }] });
  }

  function allowList(role: 'owner' | 'member' = 'owner', groupType: 'family' | 'personal' = 'family'): void {
    mockQuery.mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ type: groupType }] });
  }

  function allowCreatePrefix(pending: { id: string; expired: boolean }[] = []): void {
    allowWrite();
    mockClientQuery.mockResolvedValueOnce({ rows: [{ email: ownerEmail }] })
      .mockResolvedValueOnce({ rows: [{ is_active_member: false }] })
      .mockResolvedValueOnce({ rows: pending });
  }

  function allowCreate(email = invitedEmail): void {
    allowCreatePrefix();
    mockClientQuery.mockResolvedValueOnce({ rows: [{ id: invitationId }] })
      .mockResolvedValueOnce({ rows: [{ ...row, email }] });
  }

  function allowRevoke(): void {
    allowWrite();
    mockClientQuery.mockResolvedValueOnce({ rows: [{ id: invitationId }] })
      .mockResolvedValueOnce({ rows: [{ ...row, status: 'revoked' }] });
  }

  it.each(actions)('requires authentication for %s', async (action) => {
    const response = await send(action, action === 'create' ? { email: invitedEmail } : undefined, targetFor(action), null);
    expect(response.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each(actions)('rejects invalid authentication for %s', async (action) => {
    expect((await send(action, action === 'create' ? { email: invitedEmail } : undefined, targetFor(action), 'invalid-token')).status).toBe(401);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each(actions)('rejects malformed group UUID on %s', async (action) => {
    expect((await send(action, action === 'create' ? { email: invitedEmail } : undefined, targetFor(action, 'invalid'))).status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects a malformed invitation UUID', async () => {
    expect((await send('revoke', {}, targetFor('revoke', groupId, 'invalid'))).status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each(actions)('rejects query injection on %s', async (action) => {
    expect((await send(action, action === 'create' ? { email: invitedEmail } : undefined, `${targetFor(action)}?token=dummy-token`)).status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  const invalidCreateBodies = [
    {}, { email: '' }, { email: ' \t\n' }, { email: null }, { email: 7 }, { email: 'invalid' },
    { email: 'person@' }, { email: '@example.com' }, { email: 'person@example.com\nextra' },
    { email: `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}` },
    { email: invitedEmail, token: 'dummy-token' }, { email: invitedEmail, token_hash: 'dummy-hash' },
    { email: invitedEmail, groupId }, { email: invitedEmail, invitedBy: userId },
    { email: invitedEmail, status: 'accepted' }, { email: invitedEmail, expiresAt: '2090-01-01' },
  ];
  it.each(invalidCreateBodies)('rejects invalid create body %j before connecting', async (body) => {
    expect((await send('create', body)).status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('requires an explicit create body', async () => {
    const response = await fetch(`${baseUrl}${targetFor('create')}`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each([{ token: 'dummy-token' }, { email: invitedEmail }, { status: 'revoked' }, null, []])('rejects invalid revoke body %j', async (body) => {
    expect((await send('revoke', body)).status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each([{ token: 'dummy-token' }, { email: invitedEmail }, { status: 'expired' }])('rejects nonempty GET body %j', async (body) => {
    expect((await getWithBody(body)).status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each(actions)('denies %s to an active member', async (action) => {
    if (action === 'list') allowList('member');
    else allowWrite('member');
    const response = await send(action);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { status: 403, message: 'Forbidden' } });
    if (action === 'list') expect(mockQuery).toHaveBeenCalledTimes(1);
    else {
      expect(mockClientQuery).toHaveBeenCalledTimes(5);
      expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
      expect(mockRelease).toHaveBeenCalledOnce();
    }
  });

  for (const action of actions) {
    it.each(['invited', 'removed', 'outsider', 'missing group'])('keeps a %s caller uniformly forbidden on ' + action, async () => {
      const response = await send(action);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { status: 403, message: 'Forbidden' } });
      if (action === 'list') expect(mockQuery).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("status = 'active'"), [userId, groupId]);
      else {
        expect(mockClientQuery).toHaveBeenCalledTimes(3);
        expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
        expect(mockRelease).toHaveBeenCalledOnce();
      }
    });
  }

  it.each(actions)('rejects %s in an authorized personal group', async (action) => {
    if (action === 'list') allowList('owner', 'personal');
    else allowWrite('owner', 'personal');
    const response = await send(action);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'Operation requires a family group' } });
  });

  it.each(['create', 'revoke'] as const)('revalidates owner role after group lock on %s', async (action) => {
    allowWrite('member', 'family', 'owner');
    expect((await send(action)).status).toBe(403);
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it.each(['create', 'revoke'] as const)('revalidates active membership after group lock on %s', async (action) => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: 'owner', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ type: 'family' }] });
    expect((await send(action)).status).toBe(403);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it.each(['create', 'revoke'] as const)('keeps a disappeared group forbidden on %s', async (action) => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: 'owner', status: 'active' }] });
    expect((await send(action)).status).toBe(403);
    expect(mockClientQuery).toHaveBeenCalledTimes(4);
  });

  it('keeps a disappeared group forbidden on listing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: 'owner', status: 'active' }] });
    expect((await send('list')).status).toBe(403);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('creates a normalized invitation with a 32-byte one-time token and stores only its SHA-256 hash', async () => {
    allowCreate();
    const response = await send('create', { email: '\u00a0 INVITEE@EXAMPLE.COM \n' });
    expect(response.status).toBe(201);
    const body = await response.json() as { invitation: Invitation; token: string };
    expect(body.invitation).toEqual(publicInvitation);
    expect(Object.keys(body).sort()).toEqual(['invitation', 'token']);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(body.token, 'base64url')).toHaveLength(32);
    const [insertSql, parameters] = mockClientQuery.mock.calls[7];
    expect(insertSql).toContain("statement_timestamp(), statement_timestamp() + INTERVAL '7 days'");
    expect(parameters).toEqual([groupId, userId, invitedEmail, createHash('sha256').update(body.token).digest('hex')]);
    expect(JSON.stringify(mockClientQuery.mock.calls)).not.toContain(body.token);
    expect(mockClientQuery).toHaveBeenNthCalledWith(3, expect.stringContaining('FOR UPDATE'), [groupId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(7,
      expect.stringMatching(/WHERE group_id = \$1 AND email = \$2 AND status = 'pending'[\s\S]*FOR UPDATE/), [groupId, invitedEmail]);
    expect(mockClientQuery).toHaveBeenCalledTimes(10);
    expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('accepts a normalized email at the 254-character boundary', async () => {
    const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(email.length).toBe(254);
    allowCreate(email);
    const response = await send('create', { email });
    expect(response.status).toBe(201);
    expect((await response.json() as CreatedInvitation).invitation.email).toBe(email);
  });

  it.each(['future-account@example.com', 'registered-nonmember@example.com'])('uses the same creation response contract for %s without a global account lookup', async (email) => {
    allowCreate(email);
    const response = await send('create', { email });
    expect(response.status).toBe(201);
    const body = await response.json() as CreatedInvitation;
    expect(body.invitation).toEqual({ ...publicInvitation, email });
    expect(Object.keys(body).sort()).toEqual(['invitation', 'token']);
    expect(mockClientQuery).toHaveBeenNthCalledWith(5, 'SELECT email FROM users WHERE id = $1', [userId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(6,
      expect.stringContaining("WHERE gm.group_id = $1 AND gm.status = 'active' AND u.email = $2"), [groupId, email]);
  });

  it('produces different tokens for separate creations and never retrieves an old token', async () => {
    allowCreate();
    const first = await (await send('create')).json() as CreatedInvitation;
    allowCreate('another@example.com');
    const second = await (await send('create', { email: 'another@example.com' })).json() as CreatedInvitation;
    expect(first.token).not.toBe(second.token);
    expect(first.token).toHaveLength(43);
    expect(second.token).toHaveLength(43);
  });

  it('rejects self-invitation using the current database email rather than the JWT email', async () => {
    allowWrite();
    mockClientQuery.mockResolvedValueOnce({ rows: [{ email: ownerEmail }] });
    const response = await send('create', { email: ' OWNER@EXAMPLE.COM ' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'Cannot invite yourself' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(6);
  });

  it('rejects inviting a current active member without checking global registration', async () => {
    allowWrite();
    mockClientQuery.mockResolvedValueOnce({ rows: [{ email: ownerEmail }] })
      .mockResolvedValueOnce({ rows: [{ is_active_member: true }] });
    const response = await send('create');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'User is already an active group member' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(7);
  });

  it('rejects a live pending invitation without refreshing or resending its secret', async () => {
    allowCreatePrefix([{ id: oldInvitationId, expired: false }]);
    const response = await send('create');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'Invitation already pending' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(8);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('materializes an expired pending invitation before inserting another', async () => {
    allowCreatePrefix([{ id: oldInvitationId, expired: true }]);
    mockClientQuery.mockResolvedValueOnce({ rows: [{ id: oldInvitationId }] })
      .mockResolvedValueOnce({ rows: [{ id: invitationId }] })
      .mockResolvedValueOnce({ rows: [row] });
    const response = await send('create');
    expect(response.status).toBe(201);
    expect(mockClientQuery).toHaveBeenNthCalledWith(7,
      expect.stringContaining('expires_at <= statement_timestamp() AS expired'), [groupId, invitedEmail]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(8,
      expect.stringMatching(/SET status = 'expired', resolved_at = statement_timestamp\(\)[\s\S]*expires_at <= statement_timestamp\(\)/), [groupId, oldInvitationId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(9, expect.stringContaining('INSERT INTO group_invitations'), expect.any(Array));
    expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
  });

  it('aborts creation if the guarded expiration update affects no row', async () => {
    allowCreatePrefix([{ id: oldInvitationId, expired: true }]);
    const response = await send('create');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'Invitation is not pending' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(9);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('lists public fields only, including old-owner invitations, in bounded stable SQL order', async () => {
    allowList();
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, token_hash: 'dummy-hash', token: 'dummy-token', invited_by: 'old-owner', accepted_by: 'recipient' }] });
    const response = await send('list');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invitations: [publicInvitation] });
    const [sql, parameters] = mockQuery.mock.calls[2];
    expect(sql).toContain('WHERE gi.group_id = $1');
    expect(sql).toContain('ORDER BY gi.created_at DESC, gi.id DESC');
    expect(sql).toContain('LIMIT 100');
    expect(sql).not.toContain('token_hash');
    expect(sql).not.toMatch(/WHERE[\s\S]*invited_by/);
    expect(sql).not.toContain('FOR UPDATE');
    expect(parameters).toEqual([groupId]);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('presents expired pending rows logically without performing an update', async () => {
    allowList();
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, status: 'expired' }] });
    const response = await send('list');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invitations: [{ ...publicInvitation, status: 'expired' }] });
    expect(mockQuery.mock.calls[2][0]).toContain("CASE WHEN gi.status = 'pending' AND gi.expires_at <= statement_timestamp()");
    expect(mockQuery.mock.calls.every(([sql]) => !(sql as string).includes('UPDATE'))).toBe(true);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('supports an empty invitation list and an explicit empty GET body', async () => {
    allowList();
    expect(await getWithBody({})).toEqual({ status: 200, body: { invitations: [] } });
  });

  it.each([undefined, {}])('revokes a live pending invitation with body %j without exposing its secret', async (body) => {
    allowRevoke();
    const response = await send('revoke', body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invitation: { ...publicInvitation, status: 'revoked' } });
    expect(mockClientQuery).toHaveBeenNthCalledWith(5,
      expect.stringMatching(/SET status = 'revoked', resolved_at = statement_timestamp\(\)[\s\S]*WHERE group_id = \$1 AND id = \$2 AND status = 'pending' AND expires_at > statement_timestamp\(\)/),
      [groupId, invitationId]);
    expect(mockClientQuery.mock.calls[4][0]).not.toContain('invited_by');
    expect(mockClientQuery).toHaveBeenNthCalledWith(6,
      expect.stringContaining('WHERE gi.group_id = $1 AND gi.id = $2'), [groupId, invitationId]);
    expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(['accepted', 'declined', 'revoked', 'expired', 'pending'] as const)('rejects non-revocable invitation state %s without changing it', async (status) => {
    allowWrite();
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status }] });
    const response = await send('revoke', {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'Invitation is not pending' } });
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'from another group'])('returns404 for an invitation that is %s inside an authorized group', async () => {
    allowWrite();
    const response = await send('revoke', {});
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { status: 404, message: 'Invitation not found' } });
    expect(mockClientQuery).toHaveBeenNthCalledWith(6,
      'SELECT status FROM group_invitations WHERE group_id = $1 AND id = $2', [groupId, invitationId]);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('maps only the pending-email unique index violation to409', async () => {
    allowCreatePrefix();
    mockClientQuery.mockRejectedValueOnce({ code: '23505', constraint: 'idx_group_invitations_one_pending_email', detail: invitedEmail });
    const response = await send('create');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'Invitation already pending' } });
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(invitedEmail);
  });

  it.each([
    { code: '23505', constraint: 'group_invitations_token_hash_unique' },
    { code: '23503', constraint: 'idx_group_invitations_one_pending_email' },
    { code: '23505', constraint: 'unexpected_constraint' },
  ])('keeps other SQL errors as a safe500: %j', async (error) => {
    allowCreatePrefix();
    mockClientQuery.mockRejectedValueOnce({ ...error, message: `${invitedEmail} dummy-code dummy-hash` });
    const response = await send('create');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { status: 500, message: 'Invitation operation failed' } });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toMatch(/invitee@example\.com|dummy-code|dummy-hash/);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  const createFailureSteps = ['insert', 'DTO query', 'commit'];
  it.each(createFailureSteps)('rolls back creation with a safe error when %s fails', async (step) => {
    allowCreatePrefix();
    if (step !== 'insert') mockClientQuery.mockResolvedValueOnce({ rows: [{ id: invitationId }] });
    if (step === 'commit') mockClientQuery.mockResolvedValueOnce({ rows: [row] });
    mockClientQuery.mockRejectedValueOnce(new Error(`${invitedEmail} dummy-code`));
    const response = await send('create');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { status: 500, message: 'Invitation operation failed' } });
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toMatch(/invitee@example\.com|dummy-code/);
  });

  it.each(['update', 'DTO query', 'commit'])('rolls back revocation with a safe error when %s fails', async (step) => {
    allowWrite();
    if (step !== 'update') mockClientQuery.mockResolvedValueOnce({ rows: [{ id: invitationId }] });
    if (step === 'commit') mockClientQuery.mockResolvedValueOnce({ rows: [{ ...row, status: 'revoked' }] });
    mockClientQuery.mockRejectedValueOnce(new Error(`${invitedEmail} dummy-code`));
    const response = await send('revoke', {});
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { status: 500, message: 'Invitation operation failed' } });
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toMatch(/invitee@example\.com|dummy-code/);
  });

  it('rolls back materialized expiry if the new insert fails', async () => {
    allowCreatePrefix([{ id: oldInvitationId, expired: true }]);
    mockClientQuery.mockResolvedValueOnce({ rows: [{ id: oldInvitationId }] })
      .mockRejectedValueOnce(new Error('dummy-private-data'));
    const response = await send('create');
    expect(response.status).toBe(500);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('keeps the safe original failure if rollback itself also fails', async () => {
    allowCreatePrefix();
    mockClientQuery.mockRejectedValueOnce(new Error('dummy-private-data'))
      .mockRejectedValueOnce(new Error('dummy-rollback-private-data'));
    const response = await send('create');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { status: 500, message: 'Invitation operation failed' } });
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('dummy-');
  });

  it('does not expose SQL errors through listing', async () => {
    allowList();
    mockQuery.mockRejectedValueOnce(new Error(`${invitedEmail} dummy-code`));
    const response = await send('list');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { status: 500, message: 'Invitation operation failed' } });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toMatch(/invitee@example\.com|dummy-code/);
  });

  it.each(['create', 'revoke'] as const)('sanitizes connection errors on %s without releasing an unacquired client', async (action) => {
    mockConnect.mockRejectedValueOnce(new Error(`${invitedEmail} dummy-code`));
    const response = await send(action);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { status: 500, message: 'Invitation operation failed' } });
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('preserves the existing member-list endpoint', async () => {
    allowList();
    const response = await fetch(`${baseUrl}/groups/${groupId}/members`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ members: [] });
  });
});
