import { env } from '../../config/env';
import { jobLogger } from '../../config/logger';
import { todayInTimeZone } from './billing-date';
import { runDuePayments } from './payment-generation.service';
import { runOverdueNotifications } from '../notifications/notification-generation.service';

const PAYMENT_INTERVAL_MS = 60 * 60 * 1000;

function safeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return undefined;
  return /^[A-Z0-9]{5}$/.test(error.code) || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error.code)
    ? error.code : undefined;
}

export function startPaymentScheduler(): { stop(): Promise<void> } {
  let stopped = false;
  let activeRun: Promise<void> | undefined;

  function runOnce(): void {
    if (stopped) return;
    if (activeRun) {
      jobLogger.info('Payment generation interval skipped: previous run still active');
      return;
    }

    // Reserve the slot before starting async work, including date calculation.
    activeRun = Promise.resolve()
      .then(async () => {
        const today = todayInTimeZone(new Date(), env.paymentTimeZone);
        try {
          await runDuePayments(today);
        } catch (error: unknown) {
          jobLogger.error('Scheduled payment generation failed; next run will retry', { code: safeErrorCode(error) });
        }
        try {
          await runOverdueNotifications(today);
        } catch (error: unknown) {
          jobLogger.error('Scheduled overdue notification scan failed; next run will retry', { code: safeErrorCode(error) });
        }
      })
      .catch((error: unknown) => {
        // The calendar calculation failed before either job could start.
        jobLogger.error('Scheduled payment cycle failed; next run will retry', { code: safeErrorCode(error) });
      })
      .finally(() => {
        activeRun = undefined;
      });
  }

  const interval = setInterval(runOnce, PAYMENT_INTERVAL_MS);
  jobLogger.info('Payment scheduler started', {
    intervalMs: PAYMENT_INTERVAL_MS,
    timeZone: env.paymentTimeZone,
  });
  runOnce();

  return {
    async stop(): Promise<void> {
      if (stopped) {
        await activeRun;
        return;
      }
      stopped = true;
      clearInterval(interval);
      await activeRun;
      jobLogger.info('Payment scheduler stopped');
    },
  };
}
