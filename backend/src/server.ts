import { env } from './config/env';
import { logger, dbLogger } from './config/logger';
import { assertDbConnection, closePool } from './db/pool';
import { runMigrations } from './db/migrate';
import { app } from './app';

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
  }

  const server = app.listen(env.port, () => {
    logger.info('Server listening', { port: env.port, nodeEnv: env.nodeEnv });
  });

  const shutdown = (signal: string): void => {
    logger.info('Shutdown requested', { signal });
    server.close(() => {
      closePool()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
