import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockPoolQuery, mockConnect, mockRelease } = vi.hoisted(() => ({
  mockQuery: vi.fn(), mockPoolQuery: vi.fn(), mockConnect: vi.fn(), mockRelease: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { query: mockPoolQuery, connect: mockConnect } }));
vi.mock('../../config/env', () => ({ env: { isProd: false } }));
vi.mock('../../config/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, subscriptionLogger: logger };
});

import { AppError } from '../../middleware/errorHandler';
import { lockGroupForWrite } from '../groups/group-lock';
import { createSubscription, deleteSubscription, getSubscription, listSubscriptions, updateSubscription } from './subscription.service';
import type { CreateSubscriptionInput } from './subscription.schemas';
import type { SubscriptionRow } from './subscription.types';

const userId = 'a7e4dc62-0df7-4ff4-a54f-c670455d1151';
const groupId = '08dc3ad7-cf55-4199-9fa3-594003beef20';
const subscriptionId = '63da8815-7dcc-449d-a7c7-d27826b64d90';
const input: CreateSubscriptionInput = {
  name: 'Learning subscription',
  provider: 'Example',
  expectedCost: '17.99',
  billingCycle: 'monthly',
  nextBillingDate: '2026-01-31',
};
const row: SubscriptionRow = {
  id: subscriptionId,
  group_id: groupId,
  name: input.name,
  provider: input.provider,
  expected_cost: input.expectedCost,
  billing_cycle: input.billingCycle,
  next_billing_date: input.nextBillingDate,
  active: true,
  created_at: new Date('2026-01-01T12:00:00.000Z'),
};

function allowMembership(role: 'owner' | 'member' = 'owner'): void {
  mockQuery.mockResolvedValueOnce({
    rows: [{ group_id: groupId, user_id: userId, role, status: 'active' }],
  });
}

function allowWrite(finalRole: 'owner' | 'member' = 'owner'): void {
  mockQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
  allowMembership();
  mockQuery.mockResolvedValueOnce({ rows: [{ type: 'personal' }] });
  allowMembership(finalRole);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockPoolQuery.mockReset();
  mockConnect.mockReset();
  mockRelease.mockReset();
  mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
});

describe('subscription billing anchor', () => {
  it.each([
    ['2026-01-31', 31],
    ['2028-02-29', 29],
  ])('creates the reference day from %s', async (nextBillingDate, anchorDay) => {
    allowWrite();
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, next_billing_date: nextBillingDate }] });

    const subscription = await createSubscription(userId, groupId, { ...input, nextBillingDate });

    expect(subscription.nextBillingDate).toBe(nextBillingDate);
    expect(subscription.expectedCost).toBe('17.99');
    const [sql, values] = mockQuery.mock.calls[4];
    expect(sql).toContain('next_billing_date, billing_anchor_day');
    expect(values).toEqual([
      groupId, input.name, input.provider, '17.99', 'monthly', nextBillingDate, anchorDay,
    ]);
  });

  it('resets the anchor together with an explicit next billing date edit', async () => {
    allowWrite();
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, next_billing_date: '2028-02-29' }] });

    const subscription = await updateSubscription(userId, groupId, subscriptionId, {
      nextBillingDate: '2028-02-29',
    });

    expect(subscription.nextBillingDate).toBe('2028-02-29');
    const [sql, values] = mockQuery.mock.calls[4];
    expect(sql).toContain('next_billing_date = $3, billing_anchor_day = $4');
    expect(sql).toContain('WHERE group_id = $1 AND id = $2');
    expect(values).toEqual([groupId, subscriptionId, '2028-02-29', 29]);
  });

  it('preserves the anchor when changing the cost, cycle or active state', async () => {
    allowWrite();
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, active: false, expected_cost: '19.99' }] });

    const subscription = await updateSubscription(userId, groupId, subscriptionId, {
      expectedCost: '19.99', billingCycle: 'yearly', active: false,
    });

    expect(subscription.active).toBe(false);
    expect(subscription.expectedCost).toBe('19.99');
    const [sql, values] = mockQuery.mock.calls[4];
    expect(sql).not.toContain('billing_anchor_day');
    expect(sql).toContain('WHERE group_id = $1 AND id = $2');
    expect(values).toEqual([groupId, subscriptionId, '19.99', 'yearly', false]);
  });
});

describe('subscription deletion removes its payment history atomically', () => {
  function allowDeletion(): void {
    allowWrite();
    for (let index = 0; index < 3; index += 1) mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: subscriptionId }] });
  }

  it('deletes only the target history in dependency order and commits on the same client', async () => {
    allowDeletion();
    await expect(deleteSubscription(userId, groupId, subscriptionId)).resolves.toBeUndefined();
    const deletes = mockQuery.mock.calls.slice(4, 8);
    expect(deletes.map(([sql]) => sql.match(/DELETE FROM (\w+)/)?.[1]))
      .toEqual(['notifications', 'payment_shares', 'payments', 'subscriptions']);
    for (const [sql, values] of deletes) {
      expect(sql).toContain('group_id = $1');
      expect(sql).toContain('$2');
      expect(values).toEqual([groupId, subscriptionId]);
    }
    expect(mockQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('keeps 404 and rolls back for a missing subscription in the authorized group', async () => {
    allowWrite();
    await expect(deleteSubscription(userId, groupId, subscriptionId)).rejects.toMatchObject({
      status: 404, message: 'Subscription not found',
    });
    expect(mockQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 2, 3])('rolls back if dependent deletion step %s fails', async (step) => {
    allowWrite();
    for (let index = 0; index < step; index += 1) mockQuery.mockResolvedValueOnce({ rows: [] });
    const error = new Error('Forced deletion failure');
    mockQuery.mockRejectedValueOnce(error);
    await expect(deleteSubscription(userId, groupId, subscriptionId)).rejects.toBe(error);
    expect(mockQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(mockQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
  });

  it.each([
    { code: '23503', constraint: 'payments_subscription_id_fkey' },
    { code: '23503', constraint: 'another_subscription_id_fkey' },
    new Error('Database unavailable'),
  ])('propagates database errors unchanged: %j', async (error) => {
    allowWrite();
    mockQuery.mockRejectedValueOnce(error);
    await expect(deleteSubscription(userId, groupId, subscriptionId)).rejects.toBe(error);
  });
});

describe('subscription write permissions', () => {
  const writes = [
    ['create', () => createSubscription(userId, groupId, input)],
    ['update', () => updateSubscription(userId, groupId, subscriptionId, { active: false })],
    ['delete', () => deleteSubscription(userId, groupId, subscriptionId)],
  ] as const;

  it.each(writes)('denies %s when the owner became a member while waiting for the group', async (_operation, write) => {
    allowWrite('member');

    await expect(write()).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
    expect(mockQuery).toHaveBeenCalledTimes(5);
    expect(mockQuery).toHaveBeenNthCalledWith(4,
      expect.stringContaining("status = 'active'"), [userId, groupId]);
    expect(mockQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it.each(writes)('denies %s without an active membership before attempting the write', async (_operation, write) => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rows: [] }); // Initial membership

    await expect(write()).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery).toHaveBeenNthCalledWith(2,
      expect.stringContaining("status = 'active'"), [userId, groupId]);
    expect(mockQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it.each(writes)('denies %s when membership was removed while waiting for the group', async (_operation, write) => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    allowMembership();
    mockQuery.mockResolvedValueOnce({ rows: [{ type: 'personal' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(write()).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
    expect(mockQuery).toHaveBeenCalledTimes(5);
    expect(mockQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it.each(writes)('keeps a disappeared group uniformly forbidden during %s', async (_operation, write) => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    allowMembership();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // Group no longer exists

    await expect(write()).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
    expect(mockQuery).toHaveBeenCalledTimes(4);
    expect(mockQuery).toHaveBeenNthCalledWith(3, 'SELECT type FROM groups WHERE id = $1 FOR UPDATE', [groupId]);
    expect(mockQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it.each(writes)('uses one client and commits %s only after revalidating membership', async (_operation, write) => {
    allowWrite();
    if (_operation === 'delete') {
      for (let index = 0; index < 3; index += 1) mockQuery.mockResolvedValueOnce({ rows: [] });
    }
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    await write();

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockQuery).toHaveBeenNthCalledWith(2, expect.stringContaining("status = 'active'"), [userId, groupId]);
    expect(mockQuery).toHaveBeenNthCalledWith(3, 'SELECT type FROM groups WHERE id = $1 FOR UPDATE', [groupId]);
    expect(mockQuery).toHaveBeenNthCalledWith(4, expect.stringContaining("status = 'active'"), [userId, groupId]);
    expect(mockQuery).toHaveBeenCalledTimes(_operation === 'delete' ? 9 : 6);
    expect(mockQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it.each(writes)('rolls back and releases %s when commit fails', async (_operation, write) => {
    allowWrite();
    if (_operation === 'delete') {
      for (let index = 0; index < 3; index += 1) mockQuery.mockResolvedValueOnce({ rows: [] });
    }
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    const error = new Error('Commit failed');
    mockQuery.mockRejectedValueOnce(error);

    await expect(write()).rejects.toBe(error);
    expect(mockQuery).toHaveBeenNthCalledWith(_operation === 'delete' ? 9 : 6, 'COMMIT');
    expect(mockQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it.each(writes)('preserves the original %s error even when rollback also fails', async (_operation, write) => {
    allowWrite();
    const error = new Error('Write failed');
    mockQuery.mockRejectedValueOnce(error);
    mockQuery.mockRejectedValueOnce(new Error('Rollback failed'));

    await expect(write()).rejects.toBe(error);
    expect(mockQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('rolls back an empty update after authorization and releases its client', async () => {
    allowWrite();
    await expect(updateSubscription(userId, groupId, subscriptionId, {})).rejects.toMatchObject({ status: 400 });
    expect(mockQuery).toHaveBeenCalledTimes(5);
    expect(mockQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('keeps an update scoped to a missing subscription as 404 and rolls back', async () => {
    allowWrite();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(updateSubscription(userId, groupId, subscriptionId, { active: false })).rejects.toMatchObject({ status: 404 });
    expect(mockQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

describe('group write lock', () => {
  it.each(['personal', 'family'])('returns the locked %s group type', async (type) => {
    mockQuery.mockResolvedValueOnce({ rows: [{ type }] });
    await expect(lockGroupForWrite({ query: mockQuery }, groupId)).resolves.toEqual({ type });
    expect(mockQuery).toHaveBeenCalledExactlyOnceWith('SELECT type FROM groups WHERE id = $1 FOR UPDATE', [groupId]);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('does not disclose a missing group', async () => {
    await expect(lockGroupForWrite({ query: mockQuery }, groupId)).rejects.toEqual(new AppError(403, 'Forbidden'));
  });
});

describe('subscription reads', () => {
  it('keeps listing on the pool without a write lock', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: 'member', status: 'active' }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [row] });
    expect(await listSubscriptions(userId, groupId)).toHaveLength(1);
    expect(mockPoolQuery).toHaveBeenNthCalledWith(2, expect.stringContaining('WHERE group_id = $1'), [groupId, null]);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('keeps individual reads scoped to group and subscription', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: 'member', status: 'active' }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [row] });
    expect((await getSubscription(userId, groupId, subscriptionId)).id).toBe(subscriptionId);
    expect(mockPoolQuery).toHaveBeenNthCalledWith(2, expect.stringContaining('WHERE group_id = $1 AND id = $2'), [groupId, subscriptionId]);
    expect(mockConnect).not.toHaveBeenCalled();
  });
});
