import { env } from './config/env';
import { logger, dbLogger } from './config/logger';
import { assertDbConnection, closePool } from './db/pool';
import { runMigrations } from './db/migrate';
import { app } from './app';
import { startPaymentScheduler } from './modules/payments/payment.scheduler';

async function main(): Promise<void> {
  try {
    await assertDbConnection();
    await runMigrations();
  } catch (error) {
    dbLogger.error('Unable to initialize database', {
      message: error instanceof Error ? error.message : 'Unknown database error',
    });
    await closePool().catch(() => undefined);
    process.exit(1);
    return;
  }

  const paymentScheduler = startPaymentScheduler();
  const server = app.listen(env.port, () => {
    logger.info('Server listening', { port: env.port, nodeEnv: env.nodeEnv });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutdown requested', { signal });
    // Stop new runs immediately while HTTP requests and the active run finish.
    const schedulerStopped = paymentScheduler.stop();
    server.close((error) => {
      schedulerStopped
        .then(() => closePool())
        .then(() => process.exit(error ? 1 : 0))
        .catch(() => process.exit(1));
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
