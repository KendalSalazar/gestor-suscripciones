import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockConnect, mockRelease, jobLogger } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockConnect: vi.fn(),
  mockRelease: vi.fn(),
  jobLogger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('../../db/pool', () => ({ pool: { connect: mockConnect } }));
vi.mock('../../config/logger', () => ({ jobLogger }));

import { runDuePayments } from './payment-generation.service';

const groupId = '08dc3ad7-cf55-4199-9fa3-594003beef20';
const subscriptionId = '63da8815-7dcc-449d-a7c7-d27826b64d90';
const paymentId = 'c3f47c53-b125-4e3e-b04d-e2c9a6b31351';
const group = { id: groupId, type: 'personal', owner_id: 'a7e4dc62-0df7-4ff4-a54f-c670455d1151' };
const subscription = {
  id: subscriptionId, group_id: groupId, expected_cost: '17.99',
  billing_cycle: 'monthly', next_billing_date: '2026-10-31', billing_anchor_day: 31,
};

beforeEach(() => {
  mockQuery.mockReset().mockImplementation(async (sql: string) => (
    sql.includes('INSERT INTO payments')
      ? { rows: [{ id: paymentId }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  ));
  mockRelease.mockReset();
  mockConnect.mockReset().mockResolvedValue({ query: mockQuery, release: mockRelease });
  jobLogger.info.mockReset();
  jobLogger.error.mockReset();
});

function selectDue(groups = [group], subscriptions = [subscription]): void {
  mockQuery
    .mockResolvedValueOnce({ rows: [] }) // BEGIN
    .mockResolvedValueOnce({ rows: groups })
    .mockResolvedValueOnce({ rows: subscriptions });
}

describe('payment generation selection and transaction boundaries without PostgreSQL', () => {
  // The unfiltered branch here uses a mocked client: it never runs a global job on a database.
  it.each([subscriptionId, undefined])('filters groups and subscriptions consistently for UUID %j', async (targetId) => {
    selectDue();

    expect(await runDuePayments('2026-10-31', targetId)).toEqual({
      subscriptionsProcessed: 1, paymentsCreated: 1, subscriptionsStillDue: 0,
    });
    const [groupSql, groupParams] = mockQuery.mock.calls[1];
    expect(groupSql).toContain('FROM groups g');
    expect(groupSql).toContain('WHERE EXISTS');
    expect(groupSql).toContain('s.active = TRUE');
    expect(groupSql).toContain('s.next_billing_date <= $1::date');
    expect(groupSql).toContain('s.id = $2::uuid');
    expect(groupSql).toContain('ORDER BY g.id');
    expect(groupSql).toContain('LIMIT $3');
    expect(groupSql).toContain('FOR UPDATE OF g SKIP LOCKED');
    expect(groupParams).toEqual(['2026-10-31', targetId ?? null, 100]);
    // The EXISTS only discovers groups; no subscription quota is consumed before group locking.
    expect(groupSql.split('ORDER BY g.id')[0]).not.toContain('LIMIT');

    const [subscriptionSql, subscriptionParams] = mockQuery.mock.calls[2];
    expect(subscriptionSql).toContain('s.group_id = ANY($3::uuid[])');
    expect(subscriptionSql).toContain('s.active = TRUE');
    expect(subscriptionSql).toContain('s.next_billing_date <= $1::date');
    expect(subscriptionSql).toContain('s.id = $2::uuid');
    expect(subscriptionSql).toContain('LIMIT $4');
    expect(subscriptionSql).toContain('FOR UPDATE OF s SKIP LOCKED');
    expect(subscriptionParams).toEqual(['2026-10-31', targetId ?? null, [groupId], 100]);
    expect(mockQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('commits an empty result without selecting subscriptions when every group is unavailable', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

    expect(await runDuePayments('2026-10-31', subscriptionId)).toEqual({
      subscriptionsProcessed: 0, paymentsCreated: 0, subscriptionsStillDue: 0,
    });
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('uses the fresh subscription selection after locking, even when candidates are no longer due', async () => {
    selectDue([group], []);

    expect(await runDuePayments('2026-10-31', subscriptionId)).toEqual({
      subscriptionsProcessed: 0, paymentsCreated: 0, subscriptionsStillDue: 0,
    });
    expect(mockQuery).toHaveBeenCalledTimes(4);
    expect(mockQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('applies one subscription budget across the locked groups', async () => {
    const secondGroupId = '2140bd25-5d90-4c87-8c39-fcc2a3328ee8';
    const secondSubscriptionId = 'e5b81ecd-f210-4262-a122-f876196c163e';
    selectDue([group, { ...group, id: secondGroupId }], [
      subscription,
      { ...subscription, id: secondSubscriptionId, group_id: secondGroupId },
    ]);

    expect(await runDuePayments('2026-10-31')).toEqual({
      subscriptionsProcessed: 2, paymentsCreated: 2, subscriptionsStillDue: 0,
    });
    const subscriptionSelections = mockQuery.mock.calls.filter(([sql]) => sql.includes('FOR UPDATE OF s SKIP LOCKED'));
    expect(subscriptionSelections).toHaveLength(1);
    expect(subscriptionSelections[0][1]).toEqual(['2026-10-31', null, [groupId, secondGroupId], 100]);
    expect(mockQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO payment_shares'))).toBe(false);
  });

  it('keeps the 24-cycle catch-up limit and original anchor', async () => {
    selectDue([group], [{ ...subscription, next_billing_date: '2020-01-31' }]);

    expect(await runDuePayments('2026-10-31', subscriptionId)).toEqual({
      subscriptionsProcessed: 1, paymentsCreated: 24, subscriptionsStillDue: 1,
    });
    const inserts = mockQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO payments'));
    expect(inserts).toHaveLength(24);
    expect(inserts[0][1]).toEqual([subscriptionId, '2020-01-31', '17.99']);
    expect(inserts[1][1]).toEqual([subscriptionId, '2020-02-29', '17.99']);
    expect(inserts[2][1]).toEqual([subscriptionId, '2020-03-31', '17.99']);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1 AND group_id = $4'),
      [subscriptionId, '2022-01-31', 31, groupId]);
  });

  it('rolls back and releases the client if group discovery fails', async () => {
    const failure = new Error('Group selection failed');
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(failure);

    await expect(runDuePayments('2026-10-31', subscriptionId)).rejects.toBe(failure);
    expect(mockQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(jobLogger.info).not.toHaveBeenCalled();
  });

  it('does not report success when advancing the date fails, even if rollback also fails', async () => {
    selectDue();
    const failure = new Error('Date update failed');
    mockQuery.mockResolvedValueOnce({ rows: [{ id: paymentId }], rowCount: 1 })
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(new Error('Rollback failed'));

    await expect(runDuePayments('2026-10-31', subscriptionId)).rejects.toBe(failure);
    expect(mockQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(jobLogger.info).not.toHaveBeenCalled();
  });
});
