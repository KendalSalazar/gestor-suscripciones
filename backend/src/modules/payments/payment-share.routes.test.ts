import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockListOwn, mockGetBreakdown, mockConfirm } = vi.hoisted(() => ({
  mockListOwn: vi.fn(), mockGetBreakdown: vi.fn(), mockConfirm: vi.fn(),
}));
vi.mock('./payment-share.service', () => ({
  listOwnPaymentShares: mockListOwn,
  getPaymentShares: mockGetBreakdown,
  confirmPaymentShare: mockConfirm,
}));
vi.mock('../../db/pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../../config/env', () => ({ env: {
  isProd: false,
  jwtAccessSecret: 'payment-share-route-tests-access-key',
  jwtAccessExpiresIn: '15m',
} }));
vi.mock('../../config/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, authLogger: logger, subscriptionLogger: logger };
});

import { app } from '../../app';
import { AppError } from '../../middleware/errorHandler';
import { signAccessToken } from '../auth/auth.tokens';

const userId = 'a7e4dc62-0df7-4ff4-a54f-c670455d1151';
const groupId = '08dc3ad7-cf55-4199-9fa3-594003beef20';
const paymentId = 'c3f47c53-b125-4e3e-b04d-e2c9a6b31351';
const shareId = '63da8815-7dcc-449d-a7c7-d27826b64d90';
const ownPath = `/groups/${groupId}/payment-shares`;
const detailPath = `/groups/${groupId}/payments/${paymentId}/shares`;
const payment = {
  id: paymentId, subscriptionId: '2140bd25-5d90-4c87-8c39-fcc2a3328ee8',
  subscriptionName: 'Family learning subscription', expectedDate: '2026-10-15',
  expectedAmount: '0.30', actualAmount: null, status: 'pending', priceChanged: false,
  resolvedAt: null, createdAt: '2026-10-15T06:00:00.000Z',
};
const share = {
  id: shareId, paymentId, userId, userName: 'Owner', shareAmount: '0.10',
  sharePercentage: '33.3334', actualAmount: '0.10', status: 'confirmed',
  confirmedAt: '2026-10-16T06:00:00.000Z', createdAt: '2026-10-15T06:00:00.000Z',
};
const otherShares = [
  { ...share, id: 'bb60f692-f9f3-4c67-87af-15a2ce4d0160', userId: 'ec43b821-ddb3-4e80-9dd3-4657711df48e',
    userName: 'Member A', sharePercentage: '33.3333', actualAmount: null, status: 'pending', confirmedAt: null },
  { ...share, id: 'c922f2af-c739-4582-b100-9eb7aa6d57fd', userId: '3d1aba97-9c87-4a01-82e9-b9621bb7c40c',
    userName: 'Member B', sharePercentage: '33.3333', actualAmount: null, status: 'pending', confirmedAt: null },
];
const summary = { totalShares: 3, confirmedShares: 1, confirmedAmount: '0.10' };
const breakdown = { payment, shares: [share, ...otherShares], summary };

describe('payment share read HTTP routes', () => {
  let server: Server;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    token = signAccessToken({ id: userId, email: 'share-route-test@example.com' });
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP test address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  beforeEach(() => {
    mockListOwn.mockReset().mockResolvedValue([{ ...share, payment, summary }]);
    mockGetBreakdown.mockReset().mockResolvedValue(breakdown);
    mockConfirm.mockReset();
  });

  function get(path: string, authorization: string | undefined = `Bearer ${token}`): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: authorization ? { Authorization: authorization } : {} });
  }

  it.each([ownPath, detailPath])('requires authentication at %s', async (path) => {
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { status: 401, message: 'Unauthorized' } });
    expect(mockListOwn).not.toHaveBeenCalled();
    expect(mockGetBreakdown).not.toHaveBeenCalled();
  });

  it.each([ownPath, detailPath])('rejects an invalid token at %s', async (path) => {
    expect((await get(path, 'Bearer invalid-test-token')).status).toBe(401);
    expect(mockListOwn).not.toHaveBeenCalled();
    expect(mockGetBreakdown).not.toHaveBeenCalled();
  });

  it('passes the authenticated user and inherited group parameter to the own list', async () => {
    const response = await get(ownPath);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shares: [{ ...share, payment, summary }] });
    expect(mockListOwn).toHaveBeenCalledExactlyOnceWith(userId, groupId, {});
    expect(mockGetBreakdown).not.toHaveBeenCalled();
  });

  it.each(['pending', 'confirmed', 'skipped'])('passes the optional %s filter', async (status) => {
    mockListOwn.mockResolvedValueOnce([]);
    const response = await get(`${ownPath}?status=${status}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shares: [] });
    expect(mockListOwn).toHaveBeenCalledExactlyOnceWith(userId, groupId, { status });
  });

  it('passes both UUID parameters to the breakdown and preserves decimal strings', async () => {
    const response = await get(detailPath);
    expect(response.status).toBe(200);
    const body = await response.json() as typeof breakdown;
    expect(body).toEqual(breakdown);
    expect(typeof body.summary.confirmedShares).toBe('number');
    expect(typeof body.summary.confirmedAmount).toBe('string');
    expect(body.payment.expectedDate).toBe('2026-10-15');
    expect(mockGetBreakdown).toHaveBeenCalledExactlyOnceWith(userId, groupId, paymentId);
    expect(mockListOwn).not.toHaveBeenCalled();
  });

  it.each([
    '?status=paid', '?status=', '?status=pending&status=confirmed', '?limit=1000',
    `?userId=${userId}`, `?groupId=${groupId}`, `?paymentId=${paymentId}`,
  ])('rejects invalid own-list query %s before calling its service', async (query) => {
    expect((await get(`${ownPath}${query}`)).status).toBe(400);
    expect(mockListOwn).not.toHaveBeenCalled();
  });

  it.each(['?status=pending', `?userId=${userId}`, '?limit=100'])('rejects unexpected breakdown query %s', async (query) => {
    expect((await get(`${detailPath}${query}`)).status).toBe(400);
    expect(mockGetBreakdown).not.toHaveBeenCalled();
  });

  it.each([
    '/groups/invalid/payment-shares',
    `/groups/invalid/payments/${paymentId}/shares`,
    `/groups/${groupId}/payments/invalid/shares`,
  ])('rejects invalid UUID parameters in %s', async (path) => {
    expect((await get(path)).status).toBe(400);
    expect(mockListOwn).not.toHaveBeenCalled();
    expect(mockGetBreakdown).not.toHaveBeenCalled();
  });

  describe.each([ownPath, detailPath])('domain errors at %s', (path) => {
    it.each([403, 404, 409])('preserves the %i error envelope', async (status) => {
      const failure = new AppError(status, 'Read unavailable');
      mockListOwn.mockRejectedValueOnce(failure);
      mockGetBreakdown.mockRejectedValueOnce(failure);
      const response = await get(path);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: { status, message: 'Read unavailable' } });
    });
  });

  it('keeps an unexpected read failure as 500', async () => {
    mockGetBreakdown.mockRejectedValueOnce(new Error('Read failed'));
    const response = await get(detailPath);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { status: 500, message: 'Read failed' } });
  });

  it('keeps the own-share collection read-only', async () => {
    const response = await fetch(`${baseUrl}${ownPath}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(response.status).toBe(404);
    expect(mockListOwn).not.toHaveBeenCalled();
    expect(mockGetBreakdown).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});
