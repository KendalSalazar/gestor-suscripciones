import type { QueryResultRow } from 'pg';
import { jobLogger } from '../../config/logger';
import { pool } from '../../db/pool';
import type { BillingCycle } from '../subscriptions/subscription.types';
import { nextBillingDate } from './billing-date';

const MAX_SUBSCRIPTIONS_PER_RUN = 100;
const MAX_CYCLES_PER_SUBSCRIPTION = 24;

type DueSubscriptionRow = QueryResultRow & {
  id: string;
  expected_cost: string;
  billing_cycle: BillingCycle;
  next_billing_date: string;
  billing_anchor_day: number | null;
};

export type PaymentGenerationResult = {
  subscriptionsProcessed: number;
  paymentsCreated: number;
  subscriptionsStillDue: number;
};

export async function runDuePayments(
  today: string,
  subscriptionId?: string,
): Promise<PaymentGenerationResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const due = await client.query<DueSubscriptionRow>(
      `SELECT id, expected_cost, billing_cycle,
              next_billing_date::text AS next_billing_date, billing_anchor_day
       FROM subscriptions
       WHERE active = TRUE
         AND next_billing_date <= $1::date
         AND ($2::uuid IS NULL OR id = $2::uuid)
       ORDER BY next_billing_date, id
       LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      [today, subscriptionId ?? null, MAX_SUBSCRIPTIONS_PER_RUN],
    );

    let paymentsCreated = 0;
    let subscriptionsStillDue = 0;

    for (const subscription of due.rows) {
      let billingDate = subscription.next_billing_date;
      const anchorDay = subscription.billing_anchor_day
        ?? Number(billingDate.slice(8, 10));
      let cycles = 0;

      while (billingDate <= today && cycles < MAX_CYCLES_PER_SUBSCRIPTION) {
        const inserted = await client.query(
          `INSERT INTO payments (subscription_id, expected_date, expected_amount)
           VALUES ($1, $2::date, $3)
           ON CONFLICT (subscription_id, expected_date) DO NOTHING`,
          [subscription.id, billingDate, subscription.expected_cost],
        );
        paymentsCreated += inserted.rowCount ?? 0;
        billingDate = nextBillingDate(billingDate, subscription.billing_cycle, anchorDay);
        cycles += 1;
      }

      await client.query(
        `UPDATE subscriptions
         SET next_billing_date = $2::date, billing_anchor_day = $3
         WHERE id = $1`,
        [subscription.id, billingDate, anchorDay],
      );
      if (billingDate <= today) subscriptionsStillDue += 1;
    }

    await client.query('COMMIT');
    const result = {
      subscriptionsProcessed: due.rows.length,
      paymentsCreated,
      subscriptionsStillDue,
    };
    jobLogger.info('Due payment generation completed', result);
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    jobLogger.error('Due payment generation failed', {
      code: typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
      message: error instanceof Error ? error.message : 'Unknown database error',
    });
    throw error;
  } finally {
    client.release();
  }
}
