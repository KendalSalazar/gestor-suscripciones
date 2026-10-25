import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockConnect, mockClientQuery, mockRelease } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockConnect: vi.fn(),
  mockClientQuery: vi.fn(),
  mockRelease: vi.fn(),
}));

vi.mock('../../db/pool', () => ({ pool: { query: mockQuery, connect: mockConnect } }));
vi.mock('../../config/env', () => ({
  env: {
    isProd: false,
    jwtAccessSecret: 'payment-route-tests-only-access-key',
    jwtAccessExpiresIn: '15m',
  },
}));
vi.mock('../../config/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, authLogger: logger, subscriptionLogger: logger };
});

import { app } from '../../app';
import { logger } from '../../config/logger';
import { signAccessToken } from '../auth/auth.tokens';
import type { PaymentRow } from './payment.types';

const userId = 'a7e4dc62-0df7-4ff4-a54f-c670455d1151';
const groupId = '08dc3ad7-cf55-4199-9fa3-594003beef20';
const paymentRow: PaymentRow = {
  id: 'c3f47c53-b125-4e3e-b04d-e2c9a6b31351',
  subscription_id: '63da8815-7dcc-449d-a7c7-d27826b64d90',
  subscription_name: 'Current subscription name',
  expected_date: '2026-10-01',
  expected_amount: '9999999999.99',
  actual_amount: null,
  status: 'pending',
  price_changed: false,
  resolved_at: null,
  created_at: new Date('2026-10-01T06:00:00.000Z'),
};

describe('payments HTTP API', () => {
  let server: Server;
  let baseUrl: string;
  let accessToken: string;

  beforeAll(async () => {
    accessToken = signAccessToken({ id: userId, email: 'payment-test@example.com' });
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset().mockResolvedValue({ rows: [] });
    mockRelease.mockReset();
    mockConnect.mockReset().mockResolvedValue({ query: mockClientQuery, release: mockRelease });
  });

  async function getPayments(query = '', targetGroupId = groupId): Promise<Response> {
    return fetch(`${baseUrl}/groups/${targetGroupId}/payments${query}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  function allowMembership(role: 'owner' | 'member' = 'owner'): void {
    mockQuery.mockResolvedValueOnce({
      rows: [{ group_id: groupId, user_id: userId, role, status: 'active' }],
    });
  }

  it('requires a Bearer access token before querying the database', async () => {
    const response = await fetch(`${baseUrl}/groups/${groupId}/payments`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { message: 'Unauthorized', status: 401 } });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects an invalid Bearer token', async () => {
    const response = await fetch(`${baseUrl}/groups/${groupId}/payments`, {
      headers: { Authorization: 'Bearer invalid-test-token' },
    });
    expect(response.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each(['owner', 'member'] as const)('allows an active %s and returns only the API fields', async (role) => {
    allowMembership(role);
    mockQuery.mockResolvedValueOnce({ rows: [paymentRow] });

    const response = await getPayments();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      payments: [{
        id: paymentRow.id,
        subscriptionId: paymentRow.subscription_id,
        subscriptionName: 'Current subscription name',
        expectedDate: '2026-10-01',
        expectedAmount: '9999999999.99',
        actualAmount: null,
        status: 'pending',
        priceChanged: false,
        resolvedAt: null,
        createdAt: '2026-10-01T06:00:00.000Z',
      }],
    });
    expect(mockQuery).toHaveBeenNthCalledWith(1,
      expect.stringContaining("status = 'active'"), [userId, groupId]);
    const [sql, values] = mockQuery.mock.calls[1];
    expect(sql).toContain('JOIN subscriptions s ON s.id = p.subscription_id');
    expect(sql).toContain('WHERE s.group_id = $1');
    expect(sql).toContain('p.expected_date::text AS expected_date');
    expect(sql).toContain('ORDER BY p.expected_date DESC, p.id DESC');
    expect(sql).toContain('LIMIT 100');
    expect(sql).not.toMatch(/s\.active\s*=/);
    expect(values).toEqual([groupId, null]);
  });

  it.each(['pending', 'confirmed', 'skipped'])('passes status %s as a SQL parameter', async (status) => {
    allowMembership();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const response = await getPayments(`?status=${status}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ payments: [] });
    expect(mockQuery).toHaveBeenNthCalledWith(2,
      expect.stringContaining('p.status = $2::payment_status'), [groupId, status]);
  });

  it('serializes resolved timestamps, actual amounts and price changes', async () => {
    allowMembership();
    mockQuery.mockResolvedValueOnce({ rows: [{
      ...paymentRow,
      status: 'confirmed',
      actual_amount: '17.99',
      price_changed: true,
      resolved_at: new Date('2026-10-02T09:30:00-06:00'),
    }] });

    const response = await getPayments();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ payments: [{
      expectedAmount: '9999999999.99',
      actualAmount: '17.99',
      priceChanged: true,
      resolvedAt: '2026-10-02T15:30:00.000Z',
    }] });
  });

  it('returns 403 without reading payments when no active membership exists', async () => {
    // The real membership helper filters out invited/removed memberships in SQL.
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const response = await getPayments();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { message: 'Forbidden', status: 403 } });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = 'active'"), [userId, groupId]);
  });

  it('checks membership against the group from the URL, even for another or missing group', async () => {
    const otherGroupId = '2140bd25-5d90-4c87-8c39-fcc2a3328ee8';
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const response = await getPayments('', otherGroupId);
    expect(response.status).toBe(403);
    expect(mockQuery).toHaveBeenCalledExactlyOnceWith(expect.any(String), [userId, otherGroupId]);
  });

  it.each(['?status=paid', '?status=', '?limit=1000', '?status=pending&status=confirmed'])('rejects invalid query %s before accessing data', async (query) => {
    const response = await getPayments(query);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { status: 400 } });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects an invalid group UUID', async () => {
    const response = await getPayments('', 'invalid-group');
    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('keeps unexpected database failures as 500 errors', async () => {
    allowMembership();
    mockQuery.mockRejectedValueOnce(new Error('Database unavailable'));

    const response = await getPayments();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { message: 'Database unavailable', status: 500 } });
  });

  async function postPayment(action: 'confirm' | 'skip', body?: unknown, paymentId = paymentRow.id, query = ''): Promise<Response> {
    return fetch(`${baseUrl}/groups/${groupId}/payments/${paymentId}/${action}${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function transactionMembership(
    role: 'owner' | 'member' = 'owner',
    groupType: 'personal' | 'family' = 'personal',
    initialRole: 'owner' | 'member' = role,
  ): void {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ group_id: groupId, user_id: userId, role: initialRole, status: 'active' }],
      })
      .mockResolvedValueOnce({ rows: [{ type: groupType }] }) // group lock
      .mockResolvedValueOnce({
        rows: [{ group_id: groupId, user_id: userId, role, status: 'active' }],
      });
  }

  it.each(['confirm', 'skip'] as const)('requires authentication for %s', async (action) => {
    const response = await fetch(`${baseUrl}/groups/${groupId}/payments/${paymentRow.id}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(response.status).toBe(401);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each([undefined, '0', '17.99', '9999999999.99'])('confirms with amount %j using a single transaction client', async (actualAmount) => {
    transactionMembership();
    mockClientQuery
      .mockResolvedValueOnce({ rows: [paymentRow] })
      .mockResolvedValueOnce({ rows: [{
        ...paymentRow, status: 'confirmed', actual_amount: actualAmount ?? paymentRow.expected_amount,
        price_changed: actualAmount !== undefined && actualAmount !== paymentRow.expected_amount,
        resolved_at: new Date('2026-10-23T12:00:00.000Z'),
      }] });

    const response = await postPayment('confirm', actualAmount === undefined ? {} : { actualAmount });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ payment: {
      id: paymentRow.id, status: 'confirmed', actualAmount: actualAmount ?? paymentRow.expected_amount,
      resolvedAt: '2026-10-23T12:00:00.000Z',
    } });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockClientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockClientQuery).toHaveBeenNthCalledWith(2,
      expect.stringContaining("status = 'active'"), [userId, groupId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(3,
      expect.stringMatching(/FROM groups[\s\S]*WHERE id = \$1[\s\S]*FOR UPDATE/), [groupId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(4,
      expect.stringContaining("status = 'active'"), [userId, groupId]);
    expect(mockClientQuery).toHaveBeenNthCalledWith(5,
      expect.stringContaining('FOR UPDATE OF p'), [groupId, paymentRow.id]);
    const [sql, params] = mockClientQuery.mock.calls[5];
    expect(sql).toContain('COALESCE($3::numeric, p.expected_amount) <> p.expected_amount');
    expect(sql).toContain('s.group_id = $1 AND p.id = $2');
    expect(params).toEqual([groupId, paymentRow.id, actualAmount ?? null]);
    expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each([undefined, {}])('skips a payment with an empty body %j', async (body) => {
    transactionMembership();
    mockClientQuery
      .mockResolvedValueOnce({ rows: [paymentRow] })
      .mockResolvedValueOnce({ rows: [{
        ...paymentRow, status: 'skipped', resolved_at: new Date('2026-10-23T12:00:00.000Z'),
      }] });

    const response = await postPayment('skip', body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ payment: {
      status: 'skipped', actualAmount: null, priceChanged: false,
      resolvedAt: '2026-10-23T12:00:00.000Z',
    } });
    expect(mockClientQuery).toHaveBeenNthCalledWith(6,
      expect.stringContaining("SET status = 'skipped', actual_amount = NULL"), [groupId, paymentRow.id]);
    expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(['confirm', 'skip'] as const)('denies %s to an active member before reading the payment', async (action) => {
    transactionMembership('member');

    const response = await postPayment(action, {});
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { message: 'Forbidden', status: 403 } });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockClientQuery).toHaveBeenCalledTimes(5); // BEGIN, membership, group lock, membership, ROLLBACK
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('denies resolution when no active membership exists', async () => {
    const response = await postPayment('confirm', {});
    expect(response.status).toBe(403);
    expect(mockClientQuery).toHaveBeenCalledTimes(3);
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(['confirm', 'skip'] as const)('denies %s after ownership is lost while waiting for the group', async (action) => {
    transactionMembership('member', 'personal', 'owner');

    const response = await postPayment(action, {});
    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('denies resolution if the active membership disappears after the group lock', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: 'owner', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ type: 'personal' }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await postPayment('confirm', {});
    expect(response.status).toBe(403);
    expect(mockClientQuery).toHaveBeenCalledTimes(5);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('keeps 403 if the group disappears after the initial membership check', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ group_id: groupId, user_id: userId, role: 'owner', status: 'active' }] });

    const response = await postPayment('confirm', {});
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { message: 'Forbidden', status: 403 } });
    expect(mockClientQuery).toHaveBeenCalledTimes(4);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(['confirm', 'skip'] as const)('blocks direct family %s without writing the parent', async (action) => {
    transactionMembership('owner', 'family');
    mockClientQuery.mockResolvedValueOnce({ rows: [paymentRow] });

    const response = await postPayment(action, {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { status: 409, message: action === 'confirm'
      ? 'Family payments must be confirmed through individual shares'
      : 'Family payments must be skipped together with their shares' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(6);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(['confirm', 'skip'] as const)('returns 404 for a missing family payment before the %s guard', async (action) => {
    transactionMembership('owner', 'family');

    const response = await postPayment(action, {});
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { status: 404, message: 'Payment not found' } });
    expect(mockClientQuery).toHaveBeenCalledTimes(6);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each(['confirm', 'skip'] as const)('returns 404 for %s when the payment is missing in the authorized group', async (action) => {
    transactionMembership();

    const response = await postPayment(action, {});
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { message: 'Payment not found', status: 404 } });
    expect(mockClientQuery).toHaveBeenNthCalledWith(5,
      expect.stringContaining('WHERE s.group_id = $1 AND p.id = $2'), [groupId, paymentRow.id]);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each([
    ['confirm', 'confirmed'], ['confirm', 'skipped'], ['skip', 'confirmed'], ['skip', 'skipped'],
  ] as const)('rejects %s after status %s without writing', async (action, status) => {
    transactionMembership();
    mockClientQuery.mockResolvedValueOnce({ rows: [{ ...paymentRow, status }] });

    const response = await postPayment(action, {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { message: 'Payment already resolved', status: 409 } });
    expect(mockClientQuery).toHaveBeenCalledTimes(6);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it.each([
    ['confirm', { actualAmount: 17.99 }], ['confirm', { actualAmount: '-1' }],
    ['confirm', { actualAmount: '17.999' }], ['confirm', { actualAmount: '10000000000.00' }],
    ['confirm', { status: 'confirmed' }], ['skip', { actualAmount: '17.99' }],
  ] as const)('rejects invalid %s body %j before connecting', async (action, body) => {
    const response = await postPayment(action, body);
    expect(response.status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('rejects invalid payment UUIDs and unknown action query parameters', async () => {
    expect((await postPayment('confirm', {}, 'invalid')).status).toBe(400);
    expect((await postPayment('skip', {}, paymentRow.id, '?status=confirmed')).status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each(['null', '"17.99"', '{"actualAmount":'])('rejects invalid JSON body %s with 400', async (body) => {
    const response = await fetch(`${baseUrl}/groups/${groupId}/payments/${paymentRow.id}/confirm`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: 'Invalid JSON body', status: 400 } });
    expect(logger.error).toHaveBeenLastCalledWith('Unhandled error', {
      message: 'Invalid JSON body', status: 400, stack: undefined,
    });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('rolls back and releases the client when the update fails', async () => {
    transactionMembership();
    mockClientQuery
      .mockResolvedValueOnce({ rows: [paymentRow] })
      .mockRejectedValueOnce(new Error('Update failed'));

    const response = await postPayment('confirm', {});
    expect(response.status).toBe(500);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('rolls back and releases the client when the commit fails', async () => {
    transactionMembership();
    mockClientQuery
      .mockResolvedValueOnce({ rows: [paymentRow] })
      .mockResolvedValueOnce({ rows: [{ ...paymentRow, status: 'confirmed' }] })
      .mockRejectedValueOnce(new Error('Commit failed'));

    const response = await postPayment('confirm', {});
    expect(response.status).toBe(500);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('preserves the original error and releases the client if rollback also fails', async () => {
    transactionMembership();
    mockClientQuery
      .mockResolvedValueOnce({ rows: [paymentRow] })
      .mockRejectedValueOnce(new Error('Update failed'))
      .mockRejectedValueOnce(new Error('Rollback failed'));

    const response = await postPayment('confirm', {});
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { status: 500, message: 'Update failed' } });
    expect(mockRelease).toHaveBeenCalledOnce();
  });
});
