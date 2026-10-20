import { z } from 'zod';
import { env } from '../../config/env';
import { jobLogger } from '../../config/logger';
import { assertDbConnection, closePool } from '../../db/pool';
import { runMigrations } from '../../db/migrate';
import { todayInTimeZone } from './billing-date';
import { runDuePayments } from './payment-generation.service';

function subscriptionIdFromArgs(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== '--subscription-id') {
    throw new Error('Usage: payments:generate [--subscription-id <uuid>]');
  }
  return z.string().uuid().parse(args[1]);
}

async function main(): Promise<void> {
  try {
    const subscriptionId = subscriptionIdFromArgs(process.argv.slice(2));
    await assertDbConnection();
    await runMigrations();
    const today = todayInTimeZone(new Date(), env.paymentTimeZone);
    await runDuePayments(today, subscriptionId);
  } finally {
    await closePool();
  }
}

void main().catch((error) => {
  jobLogger.error('Manual payment generation failed', {
    message: error instanceof Error ? error.message : 'Unknown error',
  });
  process.exitCode = 1;
});
