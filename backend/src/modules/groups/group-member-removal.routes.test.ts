import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockConnect, mockClientQuery, mockRelease } = vi.hoisted(() => ({
  mockQuery: vi.fn(), mockConnect: vi.fn(), mockClientQuery: vi.fn(), mockRelease: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { query: mockQuery, connect: mockConnect } }));
vi.mock('../../config/env', () => ({
  env: { isProd: false, jwtAccessSecret: 'group-removal-tests-only-access-key', jwtAccessExpiresIn: '15m' },
}));
vi.mock('../../config/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, authLogger: logger, subscriptionLogger: logger };
});

import { app } from '../../app';
import { signAccessToken } from '../auth/auth.tokens';
import { leaveGroup, removeMember } from './group-member.service';

const userId = 'a7e4dc62-0df7-4ff4-a54f-c670455d1151';
const memberId = '2140bd25-5d90-4c87-8c39-fcc2a3328ee8';
const groupId = '08dc3ad7-cf55-4199-9fa3-594003beef20';
const actions = ['leave', 'remove'] as const;
type Action = typeof actions[number];

describe('group leave and removal HTTP API', () => {
  let server: Server;
  let baseUrl: string;
  let accessToken: string;

  beforeAll(async () => {
    accessToken = signAccessToken({ id: userId, email: 'group-removal-test@example.com' });
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
    mockConnect.mockReset().mockResolvedValue({ query: mockClientQuery, release: mockRelease });
    mockRelease.mockReset();
  });

  function pathFor(action: Action, targetId = memberId, targetGroupId = groupId): string {
    return action === 'leave' ? `/groups/${targetGroupId}/leave` : `/groups/${targetGroupId}/members/${targetId}`;
  }

  async function send(action: Action, body?: unknown, target = pathFor(action), token: string | null = accessToken): Promise<Response> {
    return fetch(`${baseUrl}${target}`, {
      method: action === 'leave' ? 'POST' : 'DELETE',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function allowRequester(
    action: Action,
    role: 'owner' | 'member' = action === 'leave' ? 'member' : 'owner',
    groupType: 'family' | 'personal' = 'family',
    initialRole: 'owner' | 'member' = role,
  ): void {
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: initialRole, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ type: groupType }] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role, status: 'active' }] });
  }

  function allowTarget(action: Action, role: 'owner' | 'member' = 'member', targetId = action === 'leave' ? userId : memberId): void {
    mockClientQuery.mockResolvedValueOnce({ rows: [{ user_id: targetId, role }] });
  }

  function allowRemoval(action: Action): void {
    allowRequester(action);
    allowTarget(action);
    mockClientQuery.mockResolvedValueOnce({ rows: [{ has_pending_shares: false }] })
      .mockResolvedValueOnce({ rows: [{ user_id: action === 'leave' ? userId : memberId }] });
  }

  it.each(actions)('requires authentication for %s before querying', async (action) => {
    const response = await send(action, {}, pathFor(action), null);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { status: 401, message: 'Unauthorized' } });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each(actions)('rejects an invalid access token for %s', async (action) => {
    expect((await send(action, {}, pathFor(action), 'invalid-token')).status).toBe(401);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each(actions)('rejects extra query parameters for %s', async (action) => {
    expect((await send(action, {}, `${pathFor(action)}?force=true`)).status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each(actions)('rejects malformed group UUID for %s', async (action) => {
    expect((await send(action, {}, pathFor(action, memberId, 'invalid-group'))).status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('rejects malformed target UUID for removal', async () => {
    expect((await send('remove', {}, pathFor('remove', 'invalid-member'))).status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  const invalidBodies = [{ status: 'removed' }, { role: 'member' }, { userId }, { force: true }, null, [], 'invalid'];
  it.each(invalidBodies)('rejects invalid leave body %j', async (body) => {
    expect((await send('leave', body)).status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });
  it.each(invalidBodies)('rejects invalid removal body %j', async (body) => {
    expect((await send('remove', body)).status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each([undefined, {}])('allows a member to leave with empty body %j and returns an empty 204', async (body) => {
    allowRemoval('leave');
    const response = await send('leave', body);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(mockClientQuery).toHaveBeenNthCalledWith(5,
      expect.stringMatching(/WHERE group_id = \$1 AND user_id = \$2 AND status = 'active'[\s\S]*FOR UPDATE/), [groupId, userId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(7,
      expect.stringContaining("SET status = 'removed'"), [groupId, userId]);
    expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(mockClientQuery).toHaveBeenCalledTimes(8);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalledOnce();
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each([undefined, {}])('allows an owner to remove a member with empty body %j and returns an empty 204', async (body) => {
    allowRemoval('remove');
    const response = await send('remove', body);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(mockClientQuery).toHaveBeenNthCalledWith(2, expect.stringContaining("status = 'active'"), [userId, groupId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(3, expect.stringContaining('FOR UPDATE'), [groupId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(4, expect.stringContaining("status = 'active'"), [userId, groupId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(5,
      expect.stringContaining('FOR UPDATE'), [groupId, memberId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(7,
      expect.stringContaining("WHERE group_id = $1 AND user_id = $2 AND status = 'active' AND role = 'member'"), [groupId, memberId]);
    const updateSql = mockClientQuery.mock.calls[6][0] as string;
    expect(updateSql.split('WHERE')[0].replace(/\s+/g, ' ').trim()).toBe("UPDATE group_members SET status = 'removed'");
    expect(updateSql).not.toContain('joined_at');
    expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(mockClientQuery).toHaveBeenCalledTimes(8);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(actions)('uses a pending-own-share and pending-parent predicate for %s', async (action) => {
    allowRemoval(action);
    expect((await send(action, {})).status).toBe(204);
    const [sql, parameters] = mockClientQuery.mock.calls[5];
    expect(sql).toContain('SELECT EXISTS');
    expect(sql).toContain('JOIN payments p ON p.id = ps.payment_id');
    expect(sql).toContain('JOIN subscriptions s ON s.id = p.subscription_id');
    expect(sql).toContain('WHERE s.group_id = $1 AND ps.user_id = $2');
    expect(sql).toContain("ps.status = 'pending' AND p.status = 'pending'");
    expect(parameters).toEqual([groupId, action === 'leave' ? userId : memberId]);
  });

  it.each(actions)('blocks %s when the target has a pending share of a pending parent', async (action) => {
    allowRequester(action);
    allowTarget(action);
    mockClientQuery.mockResolvedValueOnce({ rows: [{ has_pending_shares: true }] });
    const response = await send(action, {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'Member has pending payment shares' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(7);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(actions)('prevents the owner from using %s before transferring ownership', async (action) => {
    allowRequester(action, 'owner');
    allowTarget(action, 'owner', userId);
    const response = await send(action, {}, pathFor(action, userId));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'Owner must transfer ownership before leaving' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(6);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('determines owner self-removal from the database even with uppercase target UUID', async () => {
    allowRequester('remove', 'owner');
    allowTarget('remove', 'owner', userId);
    const response = await send('remove', {}, pathFor('remove', userId.toUpperCase()));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'Owner must transfer ownership before leaving' } });
    expect(mockClientQuery).toHaveBeenNthCalledWith(5, expect.any(String), [groupId, userId.toUpperCase()]);
    expect(mockClientQuery).toHaveBeenCalledTimes(6);
  });

  it.each(['invited', 'removed', 'outsider', 'missing group'])('keeps a %s caller uniformly forbidden on leave', async () => {
    const response = await send('leave', {});
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { status: 403, message: 'Forbidden' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(3);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(['invited', 'removed', 'outsider', 'missing group'])('keeps a %s caller uniformly forbidden on removal', async () => {
    const response = await send('remove', {});
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { status: 403, message: 'Forbidden' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(3);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('denies DELETE by a non-owner member before reading the target, including self', async () => {
    allowRequester('remove', 'member');
    const response = await send('remove', {}, pathFor('remove', userId));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { status: 403, message: 'Forbidden' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('denies removal after the requester loses ownership while waiting', async () => {
    allowRequester('remove', 'member', 'family', 'owner');
    expect((await send('remove', {})).status).toBe(403);
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it.each(actions)('revalidates active membership after the group lock for %s', async (action) => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: 'owner', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ type: 'family' }] });
    expect((await send(action, {})).status).toBe(403);
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it.each(actions)('keeps a disappeared group forbidden during %s', async (action) => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: 'owner', status: 'active' }] });
    expect((await send(action, {})).status).toBe(403);
    expect(mockClientQuery).toHaveBeenCalledTimes(4);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it.each(actions)('rejects %s in an authorized personal group', async (action) => {
    allowRequester(action, 'owner', 'personal');
    const response = await send(action, {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'Operation requires a family group' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it.each(['outsider', 'invited', 'removed', 'missing'])('returns 404 to the owner for a %s target', async () => {
    allowRequester('remove');
    const response = await send('remove', {});
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { status: 404, message: 'Member not found' } });
    expect(mockClientQuery).toHaveBeenNthCalledWith(5,
      expect.stringContaining("WHERE group_id = $1 AND user_id = $2 AND status = 'active'"), [groupId, memberId]);
    expect(mockClientQuery).toHaveBeenCalledTimes(6);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it.each(actions)('rolls back %s if the guarded update affects no row', async (action) => {
    allowRequester(action);
    allowTarget(action);
    mockClientQuery.mockResolvedValueOnce({ rows: [{ has_pending_shares: false }] });
    const response = await send(action, {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: 'Member could not be removed' } });
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  const failureSteps = ['target lock', 'obligation query', 'membership update', 'commit'];
  it.each(failureSteps)('rolls back leave and releases its client when %s fails', async (step) => {
    allowRequester('leave');
    const successSteps = [
      { rows: [{ user_id: userId, role: 'member' }] },
      { rows: [{ has_pending_shares: false }] },
      { rows: [{ user_id: userId }] },
    ];
    for (const result of successSteps.slice(0, failureSteps.indexOf(step))) mockClientQuery.mockResolvedValueOnce(result);
    mockClientQuery.mockRejectedValueOnce(new Error(`Leave ${step} failed`));
    const response = await send('leave', {});
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { status: 500, message: `Leave ${step} failed` } });
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(actions)('preserves the original SQL error on %s even when rollback fails', async (action) => {
    allowRequester(action);
    const error = Object.assign(new Error('Unexpected SQL failure'), { code: '23503', constraint: 'unexpected_constraint' });
    mockClientQuery.mockRejectedValueOnce(error).mockRejectedValueOnce(new Error('Rollback failed'));
    await expect(action === 'leave' ? leaveGroup(userId, groupId) : removeMember(userId, groupId, memberId)).rejects.toBe(error);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });
});
