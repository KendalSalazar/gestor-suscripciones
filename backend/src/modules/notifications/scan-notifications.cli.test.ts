import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertDbConnection: vi.fn(),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
  runOverdueNotifications: vi.fn(),
}));

vi.mock('../../config/env', () => ({ env: { paymentTimeZone: 'America/Costa_Rica' } }));
vi.mock('../../config/logger', () => ({ jobLogger: { error: vi.fn() } }));
vi.mock('../../db/pool', () => ({
  assertDbConnection: mocks.assertDbConnection,
  closePool: mocks.closePool,
}));
vi.mock('../../db/migrate', () => ({ runMigrations: mocks.runMigrations }));
vi.mock('./notification-generation.service', () => ({ runOverdueNotifications: mocks.runOverdueNotifications }));

import { scanNotificationsCli } from './scan-notifications.cli';

const subscriptionId = '11111111-1111-4111-8111-111111111111';

describe('manual overdue notification scan', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    // This instant is November 1 in Costa Rica and November 2 in UTC.
    vi.setSystemTime(new Date('2026-11-02T03:00:00Z'));
    mocks.assertDbConnection.mockResolvedValue(undefined);
    mocks.runMigrations.mockResolvedValue(undefined);
    mocks.runOverdueNotifications.mockResolvedValue({ paymentsProcessed: 1, notificationsCreated: 1 });
    mocks.closePool.mockResolvedValue(undefined);
  });

  afterEach(() => vi.useRealTimers());

  it.each([
    [], ['--subscription-id'], ['--subscription-id', 'invalid'], ['--all', '--subscription-id', subscriptionId],
    ['--subscription-id', subscriptionId, '--all'], ['--all', '--all'], ['--all', 'extra'],
    ['--date', '2026-11-02'], ['--subscription-id', subscriptionId, '--date', '2026-11-02'],
    ['--unknown'],
  ])('rejects invalid arguments %j before touching the database', async (...args) => {
    await expect(scanNotificationsCli(args)).rejects.toThrow('Usage: notifications:scan');
    expect(mocks.assertDbConnection).not.toHaveBeenCalled();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.runOverdueNotifications).not.toHaveBeenCalled();
    expect(mocks.closePool).not.toHaveBeenCalled();
  });

  it.each([
    { args: ['--subscription-id', subscriptionId], expectedId: subscriptionId },
    { args: ['--all'], expectedId: undefined },
  ])('checks, migrates, scans with local calendar date and closes for $args', async ({ args, expectedId }) => {
    await scanNotificationsCli(args);
    expect(mocks.assertDbConnection).toHaveBeenCalledOnce();
    expect(mocks.runMigrations).toHaveBeenCalledOnce();
    expect(mocks.runOverdueNotifications).toHaveBeenCalledExactlyOnceWith('2026-11-01', expectedId);
    expect(mocks.closePool).toHaveBeenCalledOnce();
    expect(mocks.assertDbConnection.mock.invocationCallOrder[0]).toBeLessThan(mocks.runMigrations.mock.invocationCallOrder[0]);
    expect(mocks.runMigrations.mock.invocationCallOrder[0]).toBeLessThan(mocks.runOverdueNotifications.mock.invocationCallOrder[0]);
    expect(mocks.runOverdueNotifications.mock.invocationCallOrder[0]).toBeLessThan(mocks.closePool.mock.invocationCallOrder[0]);
  });

  it.each(['connection', 'migration', 'scan'] as const)('closes the pool if %s fails', async (stage) => {
    const error = new Error('failure');
    if (stage === 'connection') mocks.assertDbConnection.mockRejectedValueOnce(error);
    if (stage === 'migration') mocks.runMigrations.mockRejectedValueOnce(error);
    if (stage === 'scan') mocks.runOverdueNotifications.mockRejectedValueOnce(error);

    await expect(scanNotificationsCli(['--subscription-id', subscriptionId])).rejects.toBe(error);
    expect(mocks.closePool).toHaveBeenCalledOnce();
    if (stage === 'connection') expect(mocks.runMigrations).not.toHaveBeenCalled();
    if (stage !== 'scan') expect(mocks.runOverdueNotifications).not.toHaveBeenCalled();
  });

  it('propagates a pool-closing failure', async () => {
    const error = new Error('close failure');
    mocks.closePool.mockRejectedValueOnce(error);
    await expect(scanNotificationsCli(['--all'])).rejects.toBe(error);
  });
});
