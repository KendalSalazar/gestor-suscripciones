import { request as httpRequest, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockConnect, mockClientQuery, mockRelease } = vi.hoisted(() => ({
  mockQuery: vi.fn(), mockConnect: vi.fn(), mockClientQuery: vi.fn(), mockRelease: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { query: mockQuery, connect: mockConnect } }));
vi.mock('../../config/env', () => ({
  env: { isProd: false, jwtAccessSecret: 'group-member-tests-only-access-key', jwtAccessExpiresIn: '15m' },
}));
vi.mock('../../config/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, authLogger: logger, subscriptionLogger: logger };
});

import { app } from '../../app';
import { signAccessToken } from '../auth/auth.tokens';
import { transferOwnership } from './group-member.service';
import type { GroupMemberRow, GroupRow } from './group.types';

const userId = 'a7e4dc62-0df7-4ff4-a54f-c670455d1151';
const newOwnerId = '2140bd25-5d90-4c87-8c39-fcc2a3328ee8';
const groupId = '08dc3ad7-cf55-4199-9fa3-594003beef20';
const membersPath = `/groups/${groupId}/members`;
const transferPath = `/groups/${groupId}/transfer-ownership`;
const groupRow: GroupRow = {
  id: groupId, name: 'Learning family', type: 'family', owner_id: userId, role: 'owner',
  created_at: new Date('2026-10-27T12:00:00.000Z'),
};
const ownerRow: GroupMemberRow = {
  user_id: userId, name: 'Current owner', role: 'owner', status: 'active', joined_at: new Date('2026-10-20T12:00:00.000Z'),
};
const memberRow: GroupMemberRow = {
  user_id: newOwnerId, name: 'New owner', role: 'member', status: 'active', joined_at: new Date('2026-10-21T12:00:00.000Z'),
};

describe('group members and ownership HTTP API', () => {
  let server: Server;
  let baseUrl: string;
  let accessToken: string;

  beforeAll(async () => {
    accessToken = signAccessToken({ id: userId, email: 'group-member-test@example.com' });
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
  });

  async function send(method: string, target: string, body?: unknown, token: string | null = accessToken): Promise<Response> {
    return fetch(`${baseUrl}${target}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function getWithBody(body: unknown): Promise<{ status: number; body: unknown }> {
    const serialized = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = httpRequest(`${baseUrl}${membersPath}`, {
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

  function allowRead(role: 'owner' | 'member' = 'owner', groupType: 'family' | 'personal' = 'family'): void {
    mockQuery.mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ type: groupType }] });
  }

  function allowTransfer(
    role: 'owner' | 'member' = 'owner',
    groupType: 'family' | 'personal' = 'family',
    initialRole: 'owner' | 'member' = role,
  ): void {
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: initialRole, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ type: groupType }] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role, status: 'active' }] });
  }

  const transferSteps = [
    { rows: [{ user_id: newOwnerId, role: 'member' }] },
    { rows: [{ user_id: userId }] },
    { rows: [{ user_id: newOwnerId }] },
    { rows: [{ ...groupRow, owner_id: newOwnerId }] },
  ];

  it.each([['GET', membersPath], ['POST', transferPath]])('requires authentication on %s %s', async (method, target) => {
    const response = await send(method, target, method === 'POST' ? { newOwnerId } : undefined, null);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { status: 401, message: 'Unauthorized' } });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each(['owner', 'member'] as const)('lets an active %s read active members with owner first and bounded stable SQL order', async (role) => {
    allowRead(role);
    mockQuery.mockResolvedValueOnce({ rows: [ownerRow, memberRow] });
    const response = await send('GET', membersPath);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ members: [
      { userId, name: 'Current owner', role: 'owner', status: 'active', joinedAt: '2026-10-20T12:00:00.000Z' },
      { userId: newOwnerId, name: 'New owner', role: 'member', status: 'active', joinedAt: '2026-10-21T12:00:00.000Z' },
    ] });
    expect(mockQuery).toHaveBeenNthCalledWith(1, expect.stringContaining("status = 'active'"), [userId, groupId]);
    expect(mockQuery).toHaveBeenNthCalledWith(2, 'SELECT type FROM groups WHERE id = $1', [groupId]);
    const [sql, parameters] = mockQuery.mock.calls[2];
    expect(sql).toContain('JOIN users u ON u.id = gm.user_id');
    expect(sql).toContain("WHERE gm.group_id = $1 AND gm.status = 'active'");
    expect(sql).toContain("ORDER BY CASE WHEN gm.role = 'owner' THEN 0 ELSE 1 END, gm.user_id ASC");
    expect(sql).toContain('LIMIT 20');
    expect(sql).not.toContain('email');
    expect(sql).not.toContain('FOR UPDATE');
    expect(parameters).toEqual([groupId]);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('accepts an explicit empty GET body', async () => {
    allowRead();
    expect(await getWithBody({})).toEqual({ status: 200, body: { members: [] } });
  });

  it.each([{ role: 'owner' }, { userId: newOwnerId }, { status: 'removed' }])('rejects unknown GET body %j before querying', async (body) => {
    expect((await getWithBody(body)).status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each(['invited', 'removed', 'outsider', 'missing group'])('keeps a %s caller uniformly forbidden on member reads', async () => {
    const response = await send('GET', membersPath);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { status: 403, message: 'Forbidden' } });
    expect(mockQuery).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("status = 'active'"), [userId, groupId]);
  });

  it('keeps a missing group forbidden after a successful initial membership read', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: 'owner', status: 'active' }] });
    const response = await send('GET', membersPath);
    expect(response.status).toBe(403);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('rejects member listing in an authorized personal group', async () => {
    allowRead('owner', 'personal');
    const response = await send('GET', membersPath);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'Operation requires a family group' } });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it.each([['GET', membersPath], ['POST', transferPath]])('rejects unknown query parameters on %s %s', async (method, target) => {
    expect((await send(method, `${target}?force=true`, method === 'POST' ? { newOwnerId } : undefined)).status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each([['GET', 'members'], ['POST', 'transfer-ownership']])('rejects malformed group UUIDs on %s %s', async (method, action) => {
    expect((await send(method, `/groups/not-a-uuid/${action}`, method === 'POST' ? { newOwnerId } : undefined)).status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each([
    undefined, {}, { newOwnerId: 'invalid' }, { newOwnerId: 42 }, { newOwnerId: null },
    { newOwnerId, role: 'owner' }, { newOwnerId, ownerId: newOwnerId }, { newOwnerId, status: 'active' },
    { newOwnerId, type: 'family' },
  ])('rejects invalid transfer body %j before connecting', async (body) => {
    expect((await send('POST', transferPath, body)).status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('transfers ownership in order and returns the previous owner as an active member', async () => {
    allowTransfer();
    for (const result of transferSteps) mockClientQuery.mockResolvedValueOnce(result);
    const response = await send('POST', transferPath, { newOwnerId });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ group: {
      id: groupId, name: groupRow.name, type: 'family', ownerId: newOwnerId, role: 'member', createdAt: '2026-10-27T12:00:00.000Z',
    } });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalledOnce();
    expect(mockClientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockClientQuery).toHaveBeenNthCalledWith(2, expect.stringContaining("status = 'active'"), [userId, groupId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(3, expect.stringContaining('FOR UPDATE'), [groupId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(4, expect.stringContaining("status = 'active'"), [userId, groupId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(5,
      expect.stringMatching(/WHERE group_id = \$1 AND user_id = \$2 AND status = 'active' AND role = 'member'[\s\S]*FOR UPDATE/),
      [groupId, newOwnerId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(6,
      expect.stringContaining("WHERE group_id = $1 AND user_id = $2 AND role = 'owner' AND status = 'active'"), [groupId, userId]);
    expect(mockClientQuery.mock.calls[5][0]).toContain("SET role = 'member'");
    expect(mockClientQuery).toHaveBeenNthCalledWith(7,
      expect.stringContaining("WHERE group_id = $1 AND user_id = $2 AND role = 'member' AND status = 'active'"), [groupId, newOwnerId]);
    expect(mockClientQuery.mock.calls[6][0]).toContain("SET role = 'owner'");
    expect(mockClientQuery).toHaveBeenNthCalledWith(8,
      expect.stringContaining("WHERE id = $1 AND owner_id = $2 AND type = 'family'"), [groupId, userId, newOwnerId]);
    expect(mockClientQuery.mock.calls[7][0]).toContain('SET owner_id = $3');
    expect(mockClientQuery).toHaveBeenCalledTimes(9);
    expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('rejects transferring to oneself before querying a destination', async () => {
    allowTransfer();
    const response = await send('POST', transferPath, { newOwnerId: userId });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'New owner must be a different active member' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(['outsider', 'invited', 'removed', 'nonexistent'])('rejects a %s destination without changing roles', async () => {
    allowTransfer();
    const response = await send('POST', transferPath, { newOwnerId });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'New owner must be a different active member' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(6);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('refuses a destination whose returned role is already owner', async () => {
    allowTransfer();
    mockClientQuery.mockResolvedValueOnce({ rows: [{ user_id: newOwnerId, role: 'owner' }] });
    expect((await send('POST', transferPath, { newOwnerId })).status).toBe(409);
    expect(mockClientQuery).toHaveBeenCalledTimes(6);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('denies a member caller before reading the destination', async () => {
    allowTransfer('member');
    expect((await send('POST', transferPath, { newOwnerId })).status).toBe(403);
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(['invited', 'removed', 'outsider', 'missing group'])('keeps a %s caller uniformly forbidden on transfer', async () => {
    const response = await send('POST', transferPath, { newOwnerId });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { status: 403, message: 'Forbidden' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(3);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('revalidates the caller role after locking the group', async () => {
    allowTransfer('member', 'family', 'owner');
    expect((await send('POST', transferPath, { newOwnerId })).status).toBe(403);
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('revalidates active membership after locking the group', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: 'owner', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ type: 'family' }] });
    expect((await send('POST', transferPath, { newOwnerId })).status).toBe(403);
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('keeps a group missing during lock acquisition uniformly forbidden', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: 'owner', status: 'active' }] });
    expect((await send('POST', transferPath, { newOwnerId })).status).toBe(403);
    expect(mockClientQuery).toHaveBeenCalledTimes(4);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('rejects ownership transfer for an authorized personal group', async () => {
    allowTransfer('owner', 'personal');
    const response = await send('POST', transferPath, { newOwnerId });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'Operation requires a family group' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it.each([1, 2, 3])('rolls back when transfer mutation %s affects no row', async (phase) => {
    allowTransfer();
    for (const result of transferSteps.slice(0, phase)) mockClientQuery.mockResolvedValueOnce(result);
    mockClientQuery.mockResolvedValueOnce({ rows: [] });
    const response = await send('POST', transferPath, { newOwnerId });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'Group ownership could not be transferred' } });
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  const failureSteps = ['destination lock', 'demotion', 'promotion', 'group update', 'commit'];
  it.each(failureSteps)('rolls back and releases the client when %s fails', async (step) => {
    allowTransfer();
    const failureIndex = failureSteps.indexOf(step);
    for (const result of transferSteps.slice(0, failureIndex)) mockClientQuery.mockResolvedValueOnce(result);
    mockClientQuery.mockRejectedValueOnce(new Error(`Transfer ${step} failed`));
    const response = await send('POST', transferPath, { newOwnerId });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { status: 500, message: `Transfer ${step} failed` } });
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('preserves an original SQL error even when rollback also fails', async () => {
    allowTransfer();
    const error = Object.assign(new Error('Unexpected SQL failure'), { code: '23505', constraint: 'unexpected_constraint' });
    mockClientQuery.mockRejectedValueOnce(error).mockRejectedValueOnce(new Error('Rollback failed'));
    await expect(transferOwnership(userId, groupId, { newOwnerId })).rejects.toBe(error);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('keeps unexpected member-list SQL failures as 500 errors', async () => {
    allowRead();
    mockQuery.mockRejectedValueOnce(new Error('Database unavailable'));
    const response = await send('GET', membersPath);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { status: 500, message: 'Database unavailable' } });
    expect(mockConnect).not.toHaveBeenCalled();
  });
});
