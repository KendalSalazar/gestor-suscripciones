import { z } from 'zod';
import { env } from '../../config/env';
import { jobLogger } from '../../config/logger';
import { runMigrations } from '../../db/migrate';
import { assertDbConnection, closePool } from '../../db/pool';
import { todayInTimeZone } from '../payments/billing-date';
import { runOverdueNotifications } from './notification-generation.service';

const usage = 'Usage: notifications:scan --subscription-id <uuid> | --all';

class UsageError extends Error {
  constructor() {
    super(usage);
  }
}

function subscriptionIdFromArgs(args: string[]): string | undefined {
  if (args.length === 1 && args[0] === '--all') return undefined;
  if (args.length === 2 && args[0] === '--subscription-id') {
    const id = z.string().uuid().safeParse(args[1]);
    if (id.success) return id.data;
  }
  throw new UsageError();
}

export async function scanNotificationsCli(args: string[]): Promise<void> {
  // Refuse ambiguous or invalid input before opening a database connection.
  const subscriptionId = subscriptionIdFromArgs(args);
  try {
    await assertDbConnection();
    await runMigrations();
    const today = todayInTimeZone(new Date(), env.paymentTimeZone);
    await runOverdueNotifications(today, subscriptionId);
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  void scanNotificationsCli(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof UsageError) {
      jobLogger.error(usage);
    } else {
      // Arbitrary error messages may contain connection details or other secrets.
      const code = typeof error === 'object' && error !== null && 'code' in error
        && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)
        ? error.code : undefined;
      jobLogger.error('Manual overdue notification scan failed', { code });
    }
    process.exitCode = 1;
  });
}
