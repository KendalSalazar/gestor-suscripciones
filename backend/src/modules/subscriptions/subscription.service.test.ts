import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../../db/pool', () => ({ pool: { query: mockQuery } }));
vi.mock('../../config/env', () => ({ env: { isProd: false } }));
vi.mock('../../config/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, subscriptionLogger: logger };
});

import { AppError } from '../../middleware/errorHandler';
import { createSubscription, deleteSubscription, updateSubscription } from './subscription.service';
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

beforeEach(() => {
  mockQuery.mockReset();
});

describe('subscription billing anchor', () => {
  it.each([
    ['2026-01-31', 31],
    ['2028-02-29', 29],
  ])('creates the reference day from %s', async (nextBillingDate, anchorDay) => {
    allowMembership();
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, next_billing_date: nextBillingDate }] });

    const subscription = await createSubscription(userId, groupId, { ...input, nextBillingDate });

    expect(subscription.nextBillingDate).toBe(nextBillingDate);
    expect(subscription.expectedCost).toBe('17.99');
    const [sql, values] = mockQuery.mock.calls[1];
    expect(sql).toContain('next_billing_date, billing_anchor_day');
    expect(values).toEqual([
      groupId, input.name, input.provider, '17.99', 'monthly', nextBillingDate, anchorDay,
    ]);
  });

  it('resets the anchor together with an explicit next billing date edit', async () => {
    allowMembership();
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, next_billing_date: '2028-02-29' }] });

    const subscription = await updateSubscription(userId, groupId, subscriptionId, {
      nextBillingDate: '2028-02-29',
    });

    expect(subscription.nextBillingDate).toBe('2028-02-29');
    const [sql, values] = mockQuery.mock.calls[1];
    expect(sql).toContain('next_billing_date = $3, billing_anchor_day = $4');
    expect(sql).toContain('WHERE group_id = $1 AND id = $2');
    expect(values).toEqual([groupId, subscriptionId, '2028-02-29', 29]);
  });

  it('preserves the anchor when changing the cost, cycle or active state', async () => {
    allowMembership();
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, active: false, expected_cost: '19.99' }] });

    const subscription = await updateSubscription(userId, groupId, subscriptionId, {
      expectedCost: '19.99', billingCycle: 'yearly', active: false,
    });

    expect(subscription.active).toBe(false);
    expect(subscription.expectedCost).toBe('19.99');
    const [sql, values] = mockQuery.mock.calls[1];
    expect(sql).not.toContain('billing_anchor_day');
    expect(sql).toContain('WHERE group_id = $1 AND id = $2');
    expect(values).toEqual([groupId, subscriptionId, '19.99', 'yearly', false]);
  });
});

describe('subscription deletion preserves payment history', () => {
  it('allows deleting a subscription without payments within the authorized group', async () => {
    allowMembership();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: subscriptionId }] });

    await expect(deleteSubscription(userId, groupId, subscriptionId)).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenNthCalledWith(2,
      expect.stringContaining('WHERE group_id = $1 AND id = $2'), [groupId, subscriptionId]);
  });

  it('keeps 404 for a missing subscription in the authorized group', async () => {
    allowMembership();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(deleteSubscription(userId, groupId, subscriptionId)).rejects.toMatchObject({
      status: 404, message: 'Subscription not found',
    });
  });

  it('translates only the payments subscription foreign key violation to 409', async () => {
    allowMembership();
    mockQuery.mockRejectedValueOnce({ code: '23503', constraint: 'payments_subscription_id_fkey' });

    await expect(deleteSubscription(userId, groupId, subscriptionId)).rejects.toEqual(
      new AppError(409, 'Subscription has payment history; deactivate it instead'),
    );
    // No fallback DELETE or other write may remove the history after the rejection.
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it.each([
    { code: '23503', constraint: 'another_subscription_id_fkey' },
    { code: '23503' },
    { code: '23505', constraint: 'payments_subscription_id_fkey' },
    new Error('Database unavailable'),
    null,
  ])('propagates other database errors unchanged: %j', async (error) => {
    allowMembership();
    mockQuery.mockRejectedValueOnce(error);

    await expect(deleteSubscription(userId, groupId, subscriptionId)).rejects.toBe(error);
  });

  it('does not translate the payments foreign key error during a different operation', async () => {
    allowMembership();
    const error = { code: '23503', constraint: 'payments_subscription_id_fkey' };
    mockQuery.mockRejectedValueOnce(error);

    await expect(createSubscription(userId, groupId, input)).rejects.toBe(error);
  });
});

describe('subscription write permissions', () => {
  const writes = [
    ['create', () => createSubscription(userId, groupId, input)],
    ['update', () => updateSubscription(userId, groupId, subscriptionId, { active: false })],
    ['delete', () => deleteSubscription(userId, groupId, subscriptionId)],
  ] as const;

  it.each(writes)('denies %s to a member without attempting the write', async (_operation, write) => {
    allowMembership('member');

    await expect(write()).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
    expect(mockQuery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("status = 'active'"), [userId, groupId]);
  });

  it.each(writes)('denies %s without an active membership before attempting the write', async (_operation, write) => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(write()).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
    expect(mockQuery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("status = 'active'"), [userId, groupId]);
  });
});
