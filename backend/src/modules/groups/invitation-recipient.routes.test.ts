import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockConnect, mockClientQuery, mockRelease } = vi.hoisted(() => ({
  mockQuery: vi.fn(), mockConnect: vi.fn(), mockClientQuery: vi.fn(), mockRelease: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { query: mockQuery, connect: mockConnect } }));
vi.mock('../../config/env', () => ({
  env: { isProd: false, jwtAccessSecret: 'invitation-recipient-tests-only-access-key', jwtAccessExpiresIn: '15m' },
}));
vi.mock('../../config/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, authLogger: logger, subscriptionLogger: logger };
});

import { app } from '../../app';
import { logger } from '../../config/logger';
import { signAccessToken } from '../auth/auth.tokens';
import type { Group, GroupMember } from './group.types';
import type { Invitation, InvitationRow } from './invitation.types';

const invitationId = 'bfc9cdd3-0ae3-43ad-9a76-95d0cd8f847a';
const groupId = '08dc3ad7-cf55-4199-9fa3-594003beef20';
const userId = 'a7e4dc62-0df7-4ff4-a54f-c670455d1151';
const token = 'A'.repeat(43);
const tokenHash = createHash('sha256').update(token).digest('hex');
const row: InvitationRow = {
  id: invitationId, group_id: groupId, group_name: 'Learning family', email: 'invitee@example.com',
  invited_by_name: 'Owner', status: 'pending', created_at: new Date('2090-01-01T12:00:00.000Z'),
  expires_at: new Date('2090-01-08T12:00:00.000Z'),
};
const recipientRow = { ...row, stored_status: 'pending', is_expired: false };
const publicInvitation: Invitation = {
  id: invitationId, groupId, groupName: row.group_name, email: row.email,
  invitedByName: row.invited_by_name, status: 'pending',
  createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(),
};
const groupRow = {
  id: groupId, name: row.group_name, type: 'family' as const,
  owner_id: 'e9e8072f-a88b-4ccc-9ed7-b1fc6872a770', created_at: new Date('2090-01-01T12:00:00.000Z'),
};
const memberRow: GroupMember = {
  userId, name: 'Invitee', role: 'member', status: 'active', joinedAt: '2090-01-02T12:00:00.000Z',
};

describe('recipient invitation HTTP API', () => {
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
    if (!address || typeof address === 'string') throw new Error('Missing invitation recipient test server address');
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

  type Operation = 'preview' | 'accept' | 'decline';
  const target = (operation: Operation, id = invitationId) => `/invitations/${id}/${operation}`;

  async function send(operation: Operation, body: unknown = { token }, id = invitationId,
    bearer: string | null = accessToken, query = ''): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${baseUrl}${target(operation, id)}${query}`, {
      method: 'POST',
      headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  function locateInvitation(): void {
    mockQuery.mockResolvedValueOnce({ rows: [{ group_id: groupId }] });
  }

  function initialRecipientInvitation(overrides: Partial<typeof recipientRow> = {}): void {
    mockClientQuery.mockResolvedValueOnce({ rows: [{ ...recipientRow, ...overrides }] });
  }

  function allowPreview(overrides: Partial<typeof recipientRow> = {}): void {
    locateInvitation();
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ type: 'family' }] });
    initialRecipientInvitation(overrides);
  }

  it.each(['preview', 'accept', 'decline'] as const)('requires Bearer authentication for %s', async (operation) => {
    const response = await send(operation, { token }, invitationId, null);
    expect(response).toEqual({ status: 401, body: { error: { status: 401, message: 'Unauthorized' } } });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each(['preview', 'accept', 'decline'] as const)('rejects invalid invitation UUID on %s', async (operation) => {
    expect((await send(operation, { token }, 'invalid')).status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each(['preview', 'accept', 'decline'] as const)('rejects unknown query parameters on %s', async (operation) => {
    expect((await send(operation, { token }, invitationId, accessToken, '?token=leaked')).status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each([
    {}, null, [], { token: '' }, { token: 'short' }, { token: `${token}!` },
    { token, invitationId }, { token, email: row.email }, { token, acceptedBy: userId },
  ])('rejects an invalid or extra recipient body %j before database access', async (body) => {
    expect((await send('preview', body)).status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('requires a body for the recipient operation', async () => {
    const response = await fetch(`${baseUrl}${target('preview')}`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('previews an eligible invitation without consuming it and uses the database identity', async () => {
    allowPreview();
    const response = await send('preview', { token });
    expect(response).toEqual({ status: 200, body: { invitation: publicInvitation } });
    expect(mockQuery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('gi.token_hash = $2'), [invitationId, tokenHash, userId],
    );
    expect(mockClientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockClientQuery).toHaveBeenNthCalledWith(2, expect.stringContaining('FOR UPDATE'), [groupId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(3,
      expect.stringMatching(/JOIN users recipient ON recipient\.id = \$3[\s\S]*FOR UPDATE OF gi/),
      [groupId, invitationId, userId, tokenHash]);
    expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(mockClientQuery.mock.calls.some(([sql]) => /^\s*(UPDATE|INSERT)\b/i.test(String(sql)))).toBe(false);
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(JSON.stringify(mockClientQuery.mock.calls)).not.toContain(token);
    expect(JSON.stringify(mockQuery.mock.calls)).not.toContain(token);
  });

  it.each([
    { stored_status: 'accepted', is_expired: false },
    { stored_status: 'declined', is_expired: false },
    { stored_status: 'revoked', is_expired: false },
    { stored_status: 'expired', is_expired: true },
    { stored_status: 'pending', is_expired: true },
  ])('rejects preview for a non-live invitation without mutation: %j', async (state) => {
    allowPreview(state);
    const response = await send('preview');
    expect(response).toEqual({ status: 409, body: { error: { status: 409, message: 'Invitation is not pending' } } });
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('returns one generic 404 for wrong token, wrong email, unknown UUID or vanished group', async () => {
    for (const lookup of [[], []]) {
      mockQuery.mockResolvedValueOnce({ rows: lookup });
      expect(await send('preview')).toEqual({
        status: 404, body: { error: { status: 404, message: 'Invitation unavailable' } },
      });
    }
    locateInvitation();
    mockClientQuery.mockResolvedValueOnce({ rows: [] });
    mockClientQuery.mockResolvedValueOnce({ rows: [] });
    expect(await send('preview')).toEqual({
      status: 404, body: { error: { status: 404, message: 'Invitation unavailable' } },
    });
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('accepts a new member atomically and returns the group plus only their membership', async () => {
    locateInvitation();
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ type: 'family' }] })
      .mockResolvedValueOnce({ rows: [recipientRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: 3 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: invitationId }] })
      .mockResolvedValueOnce({ rows: [groupRow] })
      .mockResolvedValueOnce({ rows: [{
        user_id: userId, name: 'Invitee', role: 'member', status: 'active',
        joined_at: new Date('2090-01-02T12:00:00.000Z'),
      }] });
    const expectedGroup: Group = {
      id: groupId, name: row.group_name, type: 'family', ownerId: groupRow.owner_id,
      role: 'member', createdAt: groupRow.created_at.toISOString(),
    };
    const expectedMember: GroupMember = { ...memberRow };
    expectedMember.joinedAt = '2090-01-02T12:00:00.000Z';
    const response = await send('accept');
    expect(response).toEqual({ status: 200, body: { group: expectedGroup, membership: expectedMember } });
    expect(mockClientQuery).toHaveBeenNthCalledWith(4,
      expect.stringContaining('SELECT role, status FROM group_members'), [groupId, userId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(5,
      expect.stringContaining('COUNT(*)::int AS count'), [groupId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(6,
      expect.stringContaining("VALUES ($1, $2, 'member', 'active', statement_timestamp())"), [groupId, userId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(7,
      expect.stringMatching(/SET status = 'accepted', accepted_by = \$3, resolved_at = statement_timestamp\(\)[\s\S]*expires_at > statement_timestamp\(\)/),
      [groupId, invitationId, userId]);
    expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(JSON.stringify(mockClientQuery.mock.calls)).not.toContain(token);
    expect(mockConnect).toHaveBeenCalledOnce();
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(['invited', 'removed'] as const)('reactivates an existing %s member without promoting them', async (status) => {
    locateInvitation();
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ type: 'family' }] })
      .mockResolvedValueOnce({ rows: [recipientRow] })
      .mockResolvedValueOnce({ rows: [{ role: 'member', status }] })
      .mockResolvedValueOnce({ rows: [{ count: 3 }] })
      .mockResolvedValueOnce({ rows: [{ user_id: userId }] })
      .mockResolvedValueOnce({ rows: [{ id: invitationId }] })
      .mockResolvedValueOnce({ rows: [groupRow] })
      .mockResolvedValueOnce({ rows: [{
        user_id: userId, name: 'Invitee', role: 'member', status: 'active',
        joined_at: new Date('2090-01-02T12:00:00.000Z'),
      }] });
    expect((await send('accept')).status).toBe(200);
    expect(mockClientQuery).toHaveBeenNthCalledWith(6,
      expect.stringMatching(/UPDATE group_members SET role = 'member', status = 'active', joined_at = statement_timestamp\(\)/),
      [groupId, userId]);
  });

  it.each([
    { role: 'owner', status: 'active' },
    { role: 'member', status: 'active' },
  ])('does not change an already active membership: %j', async (membership) => {
    locateInvitation();
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ type: 'family' }] })
      .mockResolvedValueOnce({ rows: [recipientRow] })
      .mockResolvedValueOnce({ rows: [membership] });
    expect((await send('accept')).status).toBe(409);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockClientQuery.mock.calls.some(([sql]) => /INSERT INTO group_members|UPDATE group_members/.test(String(sql)))).toBe(false);
  });

  it('rejects acceptance at capacity before creating membership or resolving invitation', async () => {
    locateInvitation();
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ type: 'family' }] })
      .mockResolvedValueOnce({ rows: [recipientRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: 20 }] });
    expect((await send('accept')).status).toBe(409);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockClientQuery.mock.calls.some(([sql]) => /INSERT INTO group_members|UPDATE group_members|UPDATE group_invitations/.test(String(sql)))).toBe(false);
  });

  it('declines atomically without creating membership', async () => {
    locateInvitation();
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ type: 'family' }] })
      .mockResolvedValueOnce({ rows: [recipientRow] })
      .mockResolvedValueOnce({ rows: [{ id: invitationId }] })
      .mockResolvedValueOnce({ rows: [{ ...recipientRow, status: 'declined', stored_status: 'declined' }] });
    expect(await send('decline')).toEqual({
      status: 200, body: { invitation: { ...publicInvitation, status: 'declined' } },
    });
    expect(mockClientQuery).toHaveBeenNthCalledWith(4,
      expect.stringMatching(/SET status = 'declined', resolved_at = statement_timestamp\(\)[\s\S]*expires_at > statement_timestamp\(\)/),
      [groupId, invitationId]);
    expect(mockClientQuery.mock.calls.some(([sql]) => /INSERT INTO group_members|UPDATE group_members/.test(String(sql)))).toBe(false);
    expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
  });

  it.each(['accept', 'decline'] as const)('returns conflict for expired invitation on %s and rolls back', async (operation) => {
    locateInvitation();
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ type: 'family' }] })
      .mockResolvedValueOnce({ rows: [{ ...recipientRow, is_expired: true }] });
    expect((await send(operation)).status).toBe(409);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockClientQuery.mock.calls.some(([sql]) => /UPDATE group_invitations/.test(String(sql)))).toBe(false);
  });

  it('does not leak database errors or invitation secrets', async () => {
    mockQuery.mockRejectedValueOnce(new Error(`recipient@example.com ${token}`));
    const response = await send('preview');
    expect(response).toEqual({
      status: 500, body: { error: { status: 500, message: 'Invitation operation failed' } },
    });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(token);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('recipient@example.com');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('keeps the one-time token out of the request URL', async () => {
    allowPreview();
    const response = await fetch(`${baseUrl}${target('preview')}`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(200);
    expect(target('preview')).not.toContain(token);
    expect(mockQuery.mock.calls[0][0]).not.toContain(token);
  });
});
