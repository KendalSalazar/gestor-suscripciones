import { env } from '../../config/env';
import { jobLogger } from '../../config/logger';
import { todayInTimeZone } from './billing-date';
import { runDuePayments } from './payment-generation.service';

const PAYMENT_INTERVAL_MS = 60 * 60 * 1000;

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
        await runDuePayments(today);
      })
      .catch((error: unknown) => {
        // Avoid logging arbitrary error messages, which may contain private data.
        jobLogger.error('Scheduled payment generation failed; next run will retry', {
          code: typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
        });
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
