import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfirm } = vi.hoisted(() => ({ mockConfirm: vi.fn() }));
vi.mock('./payment-share.service', () => ({
  listOwnPaymentShares: vi.fn(), getPaymentShares: vi.fn(), confirmPaymentShare: mockConfirm,
}));
vi.mock('../../db/pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../../config/env', () => ({ env: {
  isProd: false,
  jwtAccessSecret: 'share-confirm-route-tests-access-key',
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
const path = `/groups/${groupId}/payments/${paymentId}/shares/${shareId}/confirm`;
const result = {
  share: {
    id: shareId, paymentId, userId, userName: 'Member', shareAmount: '0.10',
    sharePercentage: '33.3334', actualAmount: '0.10', status: 'confirmed',
    confirmedAt: '2026-10-26T12:00:00.000Z', createdAt: '2026-10-25T12:00:00.000Z',
  },
  payment: {
    id: paymentId, subscriptionId: '2140bd25-5d90-4c87-8c39-fcc2a3328ee8',
    subscriptionName: 'Family learning subscription', expectedDate: '2026-10-25',
    expectedAmount: '0.30', actualAmount: null, status: 'pending', priceChanged: false,
    resolvedAt: null, createdAt: '2026-10-25T12:00:00.000Z',
  },
  summary: { totalShares: 3, confirmedShares: 1, confirmedAmount: '0.10' },
};

describe('own payment share confirmation HTTP route', () => {
  let server: Server;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    token = signAccessToken({ id: userId, email: 'share-confirm-test@example.com' });
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing confirmation HTTP test address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  beforeEach(() => {
    mockConfirm.mockReset().mockResolvedValue(result);
  });

  function post(body: unknown = {}, target = path, authorization: string | undefined = `Bearer ${token}`): Promise<Response> {
    return fetch(`${baseUrl}${target}`, {
      method: 'POST',
      headers: { ...(authorization ? { Authorization: authorization } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('requires authentication before confirming', async () => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { status: 401, message: 'Unauthorized' } });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('rejects an invalid Bearer token', async () => {
    expect((await post({}, path, 'Bearer invalid-test-token')).status).toBe(401);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('uses the authenticated identity and leaves the default amount to the service', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(mockConfirm).toHaveBeenCalledExactlyOnceWith(userId, groupId, paymentId, shareId, undefined);
  });

  it.each(['0', '0.00', '17.9', '17.99', '9999999999.99', '00017.99'])(
    'forwards valid decimal string %j without numeric conversion', async (actualAmount) => {
      expect((await post({ actualAmount })).status).toBe(200);
      expect(mockConfirm).toHaveBeenCalledExactlyOnceWith(userId, groupId, paymentId, shareId, actualAmount);
    },
  );

  it.each([
    0.10, -1, null, '', '-0.01', '+1', '1e2', 'NaN', 'Infinity', '1.001',
    '10000000000.00', '.10', '1.', ' 1.00', '1.00 ', '1\n', '1.00\r\n',
  ])('rejects invalid actual amount %j before calling the service', async (actualAmount) => {
    expect((await post({ actualAmount })).status).toBe(400);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it.each([
    { userId }, { role: 'owner' }, { status: 'confirmed' }, { shareAmount: '0.10' },
    { paymentId }, { actualAmount: '0.10', groupId }, [], null, '0.10',
  ])('rejects unknown fields and non-object bodies %j', async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it.each(['?status=confirmed', '?actualAmount=0.10', `?userId=${userId}`])('rejects query %s', async (query) => {
    expect((await post({}, `${path}${query}`)).status).toBe(400);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it.each([
    `/groups/invalid/payments/${paymentId}/shares/${shareId}/confirm`,
    `/groups/${groupId}/payments/invalid/shares/${shareId}/confirm`,
    `/groups/${groupId}/payments/${paymentId}/shares/invalid/confirm`,
  ])('rejects invalid UUID parameters in %s', async (target) => {
    expect((await post({}, target)).status).toBe(400);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it.each([403, 404, 409])('preserves the service error envelope for %i', async (status) => {
    mockConfirm.mockRejectedValueOnce(new AppError(status, 'Confirmation unavailable'));
    const response = await post();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { status, message: 'Confirmation unavailable' } });
  });

  it('preserves unexpected failures as 500', async () => {
    mockConfirm.mockRejectedValueOnce(new Error('Confirmation failed'));
    const response = await post();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { status: 500, message: 'Confirmation failed' } });
  });

  it('uses the default amount when the JSON parser normalizes an empty body', async () => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    expect(mockConfirm).toHaveBeenCalledExactlyOnceWith(userId, groupId, paymentId, shareId, undefined);
  });

  it('keeps individual share skipping outside this block', async () => {
    expect((await post({}, path.replace(/\/confirm$/, '/skip'))).status).toBe(404);
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});
