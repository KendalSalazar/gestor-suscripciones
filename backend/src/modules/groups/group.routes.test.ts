import { request as httpRequest, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockConnect, mockClientQuery, mockRelease } = vi.hoisted(() => ({
  mockQuery: vi.fn(), mockConnect: vi.fn(), mockClientQuery: vi.fn(), mockRelease: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { query: mockQuery, connect: mockConnect } }));
vi.mock('../../config/env', () => ({
  env: { isProd: false, jwtAccessSecret: 'group-route-tests-only-access-key', jwtAccessExpiresIn: '15m' },
}));
vi.mock('../../config/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, authLogger: logger, subscriptionLogger: logger };
});

import { app } from '../../app';
import { signAccessToken } from '../auth/auth.tokens';
import { createGroup, updateGroup } from './group.service';
import type { GroupRow } from './group.types';

const userId = 'a7e4dc62-0df7-4ff4-a54f-c670455d1151';
const groupId = '08dc3ad7-cf55-4199-9fa3-594003beef20';
const row: GroupRow = {
  id: groupId, name: 'Learning family', type: 'family', owner_id: userId, role: 'owner',
  created_at: new Date('2026-10-27T12:00:00.000Z'),
};
const actions = [
  ['GET', '/groups'], ['POST', '/groups'], ['PATCH', `/groups/${groupId}`],
] as const;

describe('groups HTTP API', () => {
  let server: Server;
  let baseUrl: string;
  let accessToken: string;

  beforeAll(async () => {
    accessToken = signAccessToken({ id: userId, email: 'group-test@example.com' });
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
    mockQuery.mockReset();
    mockClientQuery.mockReset().mockResolvedValue({ rows: [] });
    mockRelease.mockReset();
    mockConnect.mockReset().mockResolvedValue({ query: mockClientQuery, release: mockRelease });
  });

  async function send(method: string, target: string, body?: unknown, token: string | null = accessToken): Promise<Response> {
    return fetch(`${baseUrl}${target}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  // Fetch deliberately disallows GET bodies. Use Node's HTTP client to check the
  // server's explicit empty-body contract as well as unknown-field rejection.
  async function getWithBody(body: unknown): Promise<{ status: number; body: unknown }> {
    const serialized = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = httpRequest(`${baseUrl}/groups`, {
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

  function allowCreate(name = row.name): void {
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...row, name }] });
  }

  function allowUpdate(
    finalRole: 'owner' | 'member' = 'owner',
    groupType: 'family' | 'personal' = 'family',
    initialRole: 'owner' | 'member' = finalRole,
  ): void {
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: initialRole, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ type: groupType }] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: finalRole, status: 'active' }] });
  }

  it.each(actions)('requires authentication for %s %s', async (method, target) => {
    const response = await send(method, target, method === 'GET' ? undefined : { name: row.name }, null);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { status: 401, message: 'Unauthorized' } });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('rejects an invalid Bearer token', async () => {
    expect((await send('GET', '/groups', undefined, 'invalid-token')).status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('lists only caller-active memberships, personal first, with an explicit stable SQL order and DTO fields', async () => {
    const personal: GroupRow = { ...row, id: '68b6d90d-4203-4e66-b2be-157c4d628ff6', type: 'personal', name: 'Personal' };
    mockQuery.mockResolvedValueOnce({ rows: [personal, { ...row, role: 'member' }] });
    const response = await send('GET', '/groups');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ groups: [
      { id: personal.id, name: 'Personal', type: 'personal', ownerId: userId, role: 'owner', createdAt: '2026-10-27T12:00:00.000Z' },
      { id: groupId, name: row.name, type: 'family', ownerId: userId, role: 'member', createdAt: '2026-10-27T12:00:00.000Z' },
    ] });
    const [sql, parameters] = mockQuery.mock.calls[0];
    expect(sql).toContain('JOIN group_members gm ON gm.group_id = g.id');
    expect(sql).toContain("WHERE gm.user_id = $1 AND gm.status = 'active'");
    expect(sql).toMatch(/ORDER BY CASE WHEN g\.type = 'personal' THEN 0 ELSE 1 END,[\s\S]*g\.created_at ASC, g\.id ASC/);
    expect(sql).not.toContain('LIMIT');
    expect(sql).not.toContain('email');
    expect(parameters).toEqual([userId]);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('returns an empty list when no active memberships remain', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const response = await send('GET', '/groups');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ groups: [] });
  });

  it('accepts an explicit empty GET body', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getWithBody({})).toEqual({ status: 200, body: { groups: [] } });
  });

  it.each([{ name: 'Unexpected' }, { type: 'family' }, { ownerId: userId }])('rejects nonempty GET body %j', async (body) => {
    expect((await getWithBody(body)).status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each(actions)('rejects query fields on %s %s', async (method, target) => {
    const response = await send(method, `${target}?name=Unexpected`, method === 'GET' ? undefined : { name: row.name });
    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  const invalidInputs = [
    undefined, {}, { name: '' }, { name: ' \t\n' }, { name: 42 }, { name: null }, { name: 'a'.repeat(256) },
    { name: row.name, type: 'personal' }, { name: row.name, ownerId: userId },
    { name: row.name, owner_id: userId }, { name: row.name, role: 'owner' }, { name: row.name, status: 'active' },
  ];
  it.each(invalidInputs)('rejects invalid create body %j before connecting', async (body) => {
    expect((await send('POST', '/groups', body)).status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });
  it.each(invalidInputs)('rejects invalid update body %j before connecting', async (body) => {
    expect((await send('PATCH', `/groups/${groupId}`, body)).status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('rejects an invalid group UUID before opening a transaction', async () => {
    expect((await send('PATCH', '/groups/not-a-uuid', { name: row.name })).status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each(['a', 'a'.repeat(255), '\u00a0  Learning family \n'])('creates a family with a trimmed valid name %j', async (name) => {
    const normalized = name.trim();
    allowCreate(normalized);
    const response = await send('POST', '/groups', { name });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ group: {
      id: groupId, name: normalized, type: 'family', ownerId: userId, role: 'owner', createdAt: '2026-10-27T12:00:00.000Z',
    } });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalledOnce();
    expect(mockClientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockClientQuery).toHaveBeenNthCalledWith(2,
      expect.stringContaining("VALUES ($1, 'family', $2)"), [normalized, userId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(3,
      expect.stringContaining("VALUES ($1, $2, 'owner', 'active', NOW())"), [groupId, userId]);
    expect(mockClientQuery).toHaveBeenCalledTimes(4);
    expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(['a', 'a'.repeat(255), '  Renamed family\t'])('renames a family with trimmed name %j and one transaction client', async (name) => {
    const normalized = name.trim();
    allowUpdate();
    mockClientQuery.mockResolvedValueOnce({ rows: [{ ...row, name: normalized }] });
    const response = await send('PATCH', `/groups/${groupId}`, { name });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ group: {
      id: groupId, name: normalized, type: 'family', ownerId: userId, role: 'owner', createdAt: '2026-10-27T12:00:00.000Z',
    } });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockClientQuery).toHaveBeenNthCalledWith(2, expect.stringContaining("status = 'active'"), [userId, groupId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(3, expect.stringContaining('FOR UPDATE'), [groupId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(4, expect.stringContaining("status = 'active'"), [userId, groupId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(5,
      expect.stringMatching(/SET name = \$2[\s\S]*WHERE id = \$1 AND type = 'family'/), [groupId, normalized]);
    expect(mockClientQuery).toHaveBeenCalledTimes(6);
    expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('denies an active member rename without updating the group', async () => {
    allowUpdate('member');
    const response = await send('PATCH', `/groups/${groupId}`, { name: row.name });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { status: 403, message: 'Forbidden' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(['invited', 'removed', 'outsider', 'missing group'])('keeps %s uniformly forbidden before locking the group', async () => {
    const response = await send('PATCH', `/groups/${groupId}`, { name: row.name });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { status: 403, message: 'Forbidden' } });
    expect(mockClientQuery).toHaveBeenNthCalledWith(2, expect.stringContaining("status = 'active'"), [userId, groupId]);
    expect(mockClientQuery).toHaveBeenCalledTimes(3);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('revalidates the owner role after acquiring the group lock', async () => {
    allowUpdate('member', 'family', 'owner');
    expect((await send('PATCH', `/groups/${groupId}`, { name: row.name })).status).toBe(403);
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('revalidates active membership after acquiring the group lock', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: 'owner', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ type: 'family' }] });
    expect((await send('PATCH', `/groups/${groupId}`, { name: row.name })).status).toBe(403);
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('keeps a group that disappeared after membership uniformly forbidden', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: 'owner', status: 'active' }] });
    expect((await send('PATCH', `/groups/${groupId}`, { name: row.name })).status).toBe(403);
    expect(mockClientQuery).toHaveBeenCalledTimes(4);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('rejects renaming the personal group with a domain conflict', async () => {
    allowUpdate('owner', 'personal');
    const response = await send('PATCH', `/groups/${groupId}`, { name: row.name });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'Operation requires a family group' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(['group insertion', 'membership insertion', 'commit'])('rolls back creation when %s fails', async (step) => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] });
    if (step !== 'group insertion') mockClientQuery.mockResolvedValueOnce({ rows: [row] });
    if (step === 'commit') mockClientQuery.mockResolvedValueOnce({ rows: [] });
    mockClientQuery.mockRejectedValueOnce(new Error(`Creation ${step} failed`));
    const response = await send('POST', '/groups', { name: row.name });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { status: 500, message: `Creation ${step} failed` } });
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('rolls back a failed update commit and releases its client', async () => {
    allowUpdate();
    mockClientQuery.mockResolvedValueOnce({ rows: [row] }).mockRejectedValueOnce(new Error('Commit failed'));
    const response = await send('PATCH', `/groups/${groupId}`, { name: row.name });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { status: 500, message: 'Commit failed' } });
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(['create', 'update'])('preserves an SQL %s failure even if rollback also fails', async (action) => {
    const error = Object.assign(new Error('SQL write failed'), { code: '23503', constraint: 'unexpected_constraint' });
    if (action === 'create') mockClientQuery.mockResolvedValueOnce({ rows: [] });
    else allowUpdate();
    mockClientQuery.mockRejectedValueOnce(error).mockRejectedValueOnce(new Error('Rollback failed'));
    await expect(action === 'create' ? createGroup(userId, { name: row.name }) : updateGroup(userId, groupId, { name: row.name }))
      .rejects.toBe(error);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('keeps unexpected list errors as 500', async () => {
    mockQuery.mockRejectedValueOnce(new Error('Database unavailable'));
    const response = await send('GET', '/groups');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { status: 500, message: 'Database unavailable' } });
  });

  it('does not intercept the existing subscription router', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: 'owner', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [] });
    const response = await send('GET', `/groups/${groupId}/subscriptions`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subscriptions: [] });
  });
});
