import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGenerate, mockScan, jobLogger } = vi.hoisted(() => ({
  mockGenerate: vi.fn(),
  mockScan: vi.fn(),
  jobLogger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('./payment-generation.service', () => ({ runDuePayments: mockGenerate }));
vi.mock('../notifications/notification-generation.service', () => ({ runOverdueNotifications: mockScan }));
vi.mock('../../config/logger', () => ({ jobLogger }));
vi.mock('../../config/env', () => ({ env: { paymentTimeZone: 'America/Costa_Rica' } }));

import { env } from '../../config/env';
import { startPaymentScheduler } from './payment.scheduler';

const HOUR = 60 * 60 * 1000;

describe('payment scheduler', () => {
  let scheduler: ReturnType<typeof startPaymentScheduler> | undefined;
  let releasePending: Array<() => void>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T02:00:00.000Z'));
    env.paymentTimeZone = 'America/Costa_Rica';
    mockGenerate.mockResolvedValue({ subscriptionsProcessed: 0, paymentsCreated: 0, subscriptionsStillDue: 0 });
    mockScan.mockResolvedValue({ paymentsProcessed: 0, notificationsCreated: 0 });
    scheduler = undefined;
    releasePending = [];
  });

  afterEach(async () => {
    releasePending.forEach((release) => release());
    await scheduler?.stop();
    vi.useRealTimers();
  });

  function pendingRun(): { promise: Promise<void>; resolve(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    releasePending.push(resolve);
    return { promise, resolve };
  }

  it('runs on startup with the configured calendar day and logs only scheduler metadata', async () => {
    scheduler = startPaymentScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockGenerate).toHaveBeenCalledExactlyOnceWith('2026-10-14');
    expect(mockScan).toHaveBeenCalledExactlyOnceWith('2026-10-14');
    expect(mockGenerate.mock.invocationCallOrder[0]).toBeLessThan(mockScan.mock.invocationCallOrder[0]);
    expect(jobLogger.info).toHaveBeenCalledWith('Payment scheduler started', {
      intervalMs: HOUR, timeZone: 'America/Costa_Rica',
    });
  });

  it('runs every hour and recalculates today when the configured day changes', async () => {
    vi.setSystemTime(new Date('2026-10-15T05:30:00.000Z'));
    scheduler = startPaymentScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGenerate).toHaveBeenNthCalledWith(1, '2026-10-14');

    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockGenerate).toHaveBeenNthCalledWith(2, '2026-10-15');
    expect(mockScan).toHaveBeenNthCalledWith(1, '2026-10-14');
    expect(mockScan).toHaveBeenNthCalledWith(2, '2026-10-15');
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(mockGenerate).toHaveBeenCalledTimes(3);
  });

  it('uses the configured timezone instead of the machine timezone', async () => {
    env.paymentTimeZone = 'UTC';
    scheduler = startPaymentScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockGenerate).toHaveBeenCalledExactlyOnceWith('2026-10-15');
    expect(mockScan).toHaveBeenCalledExactlyOnceWith('2026-10-15');
  });

  it('skips overlapping intervals and resumes after the active run finishes', async () => {
    const held = pendingRun();
    mockGenerate.mockReturnValueOnce(held.promise);
    scheduler = startPaymentScheduler();
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockScan).not.toHaveBeenCalled();
    expect(jobLogger.info).toHaveBeenCalledWith('Payment generation interval skipped: previous run still active');
    held.resolve();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it.each(['promise rejection', 'synchronous throw'])('captures a %s and retries at the next interval', async (failure) => {
    const error = Object.assign(new Error('private-error-details'), { code: 'ECONNRESET' });
    if (failure === 'promise rejection') mockGenerate.mockRejectedValueOnce(error);
    else mockGenerate.mockImplementationOnce(() => { throw error; });
    scheduler = startPaymentScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(jobLogger.error).toHaveBeenCalledExactlyOnceWith('Scheduled payment generation failed; next run will retry', {
      code: 'ECONNRESET',
    });
    expect(JSON.stringify(jobLogger.error.mock.calls)).not.toContain('private-error-details');
    expect(mockScan).toHaveBeenCalledExactlyOnceWith('2026-10-14');
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it('captures calendar errors and allows a later run', async () => {
    env.paymentTimeZone = 'Invalid/TimeZone';
    scheduler = startPaymentScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockScan).not.toHaveBeenCalled();
    expect(jobLogger.error).toHaveBeenCalledOnce();

    env.paymentTimeZone = 'America/Costa_Rica';
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(mockGenerate).toHaveBeenCalledExactlyOnceWith('2026-10-14');
    expect(mockScan).toHaveBeenCalledExactlyOnceWith('2026-10-14');
  });

  it('stops new intervals immediately but waits for the active run', async () => {
    const held = pendingRun();
    mockGenerate.mockReturnValueOnce(held.promise);
    scheduler = startPaymentScheduler();
    await vi.advanceTimersByTimeAsync(0);
    let finished = false;
    const stopping = scheduler.stop().then(() => { finished = true; });

    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(finished).toBe(false);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    held.resolve();
    await stopping;
    expect(finished).toBe(true);
    expect(mockScan).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('can stop an idle scheduler repeatedly without scheduling more runs', async () => {
    scheduler = startPaymentScheduler();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.stop();
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(3 * HOUR);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['promise rejection', 'synchronous throw'])('isolates a scan %s and retries next hour', async (failure) => {
    const error = Object.assign(new Error('private-error-details'), { code: 'private-code-details' });
    if (failure === 'promise rejection') mockScan.mockRejectedValueOnce(error);
    else mockScan.mockImplementationOnce(() => { throw error; });
    scheduler = startPaymentScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockGenerate).toHaveBeenCalledOnce();
    expect(jobLogger.error).toHaveBeenCalledExactlyOnceWith('Scheduled overdue notification scan failed; next run will retry', { code: undefined });
    expect(JSON.stringify(jobLogger.error.mock.calls)).not.toContain('private-');
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockScan).toHaveBeenCalledTimes(2);
  });

  it('keeps the cycle reserved while the scan is pending and waits for it at shutdown', async () => {
    const held = pendingRun();
    mockScan.mockReturnValueOnce(held.promise);
    scheduler = startPaymentScheduler();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockScan).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(stopped).toBe(false);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    held.resolve();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(mockScan).toHaveBeenCalledTimes(1);
  });

  it('resumes on the next interval once a slow scan completes', async () => {
    const held = pendingRun();
    mockScan.mockReturnValueOnce(held.promise);
    scheduler = startPaymentScheduler();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockScan).toHaveBeenCalledTimes(1);

    held.resolve();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockScan).toHaveBeenCalledTimes(2);
  });

  it('passes the same calendar day to both jobs even if midnight passes during generation', async () => {
    const held = pendingRun();
    mockGenerate.mockReturnValueOnce(held.promise);
    vi.setSystemTime(new Date('2026-10-15T05:59:00.000Z'));
    scheduler = startPaymentScheduler();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    held.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGenerate).toHaveBeenCalledExactlyOnceWith('2026-10-14');
    expect(mockScan).toHaveBeenCalledExactlyOnceWith('2026-10-14');
  });
});
