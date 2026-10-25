import type { PoolClient, QueryResultRow } from 'pg';
import { jobLogger } from '../../config/logger';
import { pool } from '../../db/pool';
import type { BillingCycle } from '../subscriptions/subscription.types';
import { nextBillingDate } from './billing-date';
import { splitPaymentEqually } from './payment-sharing';

const MAX_GROUPS_PER_RUN = 100;
const MAX_SUBSCRIPTIONS_PER_RUN = 100;
const MAX_CYCLES_PER_SUBSCRIPTION = 24;

type DueGroupRow = QueryResultRow & {
  id: string;
  type: 'personal' | 'family';
  owner_id: string;
};

type DueSubscriptionRow = QueryResultRow & {
  id: string;
  group_id: string;
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

    // Skip occupied groups before consuming the subscription budget. All group
    // writers use this same first lock, so membership changes cannot split a snapshot.
    const groups = await client.query<DueGroupRow>(
      `SELECT g.id, g.type, g.owner_id
       FROM groups g
       WHERE EXISTS (
         SELECT 1 FROM subscriptions s
         WHERE s.group_id = g.id AND s.active = TRUE
           AND s.next_billing_date <= $1::date
           AND ($2::uuid IS NULL OR s.id = $2::uuid)
       )
       ORDER BY g.id
       LIMIT $3
       FOR UPDATE OF g SKIP LOCKED`,
      [today, subscriptionId ?? null, MAX_GROUPS_PER_RUN],
    );

    // Re-read the current subscription values after acquiring the group locks.
    const due = groups.rows.length === 0 ? { rows: [] as DueSubscriptionRow[] } : await client.query<DueSubscriptionRow>(
      `SELECT s.id, s.group_id, s.expected_cost, s.billing_cycle,
              s.next_billing_date::text AS next_billing_date, s.billing_anchor_day
       FROM subscriptions s
       WHERE s.group_id = ANY($3::uuid[]) AND s.active = TRUE
         AND s.next_billing_date <= $1::date
         AND ($2::uuid IS NULL OR s.id = $2::uuid)
       ORDER BY s.next_billing_date, s.id
       LIMIT $4
       FOR UPDATE OF s SKIP LOCKED`,
      [today, subscriptionId ?? null, groups.rows.map((group) => group.id), MAX_SUBSCRIPTIONS_PER_RUN],
    );

    const groupsById = new Map(groups.rows.map((group) => [group.id, group]));
    const familyParticipants = new Map<string, string[]>();
    let paymentsCreated = 0;
    let subscriptionsStillDue = 0;

    for (const subscription of due.rows) {
      const group = groupsById.get(subscription.group_id);
      if (!group) throw new Error('Payment generation group lock is missing');
      let participants: string[] | undefined;
      if (group.type === 'family') {
        participants = familyParticipants.get(group.id);
        if (!participants) {
          participants = await readFamilyParticipants(client, group);
          familyParticipants.set(group.id, participants);
        }
      }

      let billingDate = subscription.next_billing_date;
      const anchorDay = subscription.billing_anchor_day
        ?? Number(billingDate.slice(8, 10));
      let cycles = 0;

      while (billingDate <= today && cycles < MAX_CYCLES_PER_SUBSCRIPTION) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO payments (subscription_id, expected_date, expected_amount)
           VALUES ($1, $2::date, $3)
           ON CONFLICT (subscription_id, expected_date) DO NOTHING
           RETURNING id`,
          [subscription.id, billingDate, subscription.expected_cost],
        );
        const payment = inserted.rows[0];
        if (payment) {
          paymentsCreated += 1;
          if (participants) {
            const allocation = splitPaymentEqually(subscription.expected_cost, participants);
            await client.query(
              `INSERT INTO payment_shares (payment_id, user_id, share_amount, share_percentage)
               SELECT $1::uuid, user_id, share_amount, share_percentage
               FROM UNNEST($2::uuid[], $3::numeric[], $4::numeric[])
                 AS allocation(user_id, share_amount, share_percentage)`,
              [payment.id, allocation.map((share) => share.userId),
                allocation.map((share) => share.shareAmount), allocation.map((share) => share.sharePercentage)],
            );
          }
        } else if (participants) {
          // A retry must validate the saved photo, never rebuild it using today's
          // membership or cost. Resolved shares and their actual amounts stay untouched.
          await validateFamilySnapshot(client, subscription.id, billingDate);
        }
        billingDate = nextBillingDate(billingDate, subscription.billing_cycle, anchorDay);
        cycles += 1;
      }

      await client.query(
        `UPDATE subscriptions
         SET next_billing_date = $2::date, billing_anchor_day = $3
         WHERE id = $1 AND group_id = $4`,
        [subscription.id, billingDate, anchorDay, group.id],
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

async function readFamilyParticipants(client: PoolClient, group: DueGroupRow): Promise<string[]> {
  const members = await client.query<{ user_id: string; role: 'owner' | 'member' }>(
    `SELECT user_id, role FROM group_members
     WHERE group_id = $1 AND status = 'active'
     ORDER BY user_id
     LIMIT 21`, [group.id],
  );
  const owners = members.rows.filter((member) => member.role === 'owner');
  if (members.rows.length < 1 || members.rows.length > 20
    || owners.length !== 1 || owners[0].user_id !== group.owner_id) {
    throw new Error('Family payment generation requires valid active membership and owner');
  }
  return members.rows.map((member) => member.user_id);
}

async function validateFamilySnapshot(client: PoolClient, subscriptionId: string, billingDate: string): Promise<void> {
  const payments = await client.query<{ id: string; expected_amount: string }>(
    `SELECT id, expected_amount FROM payments
     WHERE subscription_id = $1 AND expected_date = $2::date
     FOR UPDATE`, [subscriptionId, billingDate],
  );
  const payment = payments.rows[0];
  if (!payment) throw new Error('Family payment snapshot is inconsistent');

  const shares = await client.query<{ user_id: string; share_amount: string; share_percentage: string }>(
    `SELECT user_id, share_amount, share_percentage FROM payment_shares
     WHERE payment_id = $1 ORDER BY id FOR UPDATE`, [payment.id],
  );
  // This also checks participant count, uniqueness and the original expected total.
  let expected;
  try {
    expected = splitPaymentEqually(payment.expected_amount, shares.rows.map((share) => share.user_id));
  } catch {
    throw new Error('Family payment snapshot is inconsistent');
  }
  const savedByUser = new Map(shares.rows.map((share) => [share.user_id, share]));
  if (expected.some((share) => {
    const saved = savedByUser.get(share.userId);
    return saved?.share_amount !== share.shareAmount || saved.share_percentage !== share.sharePercentage;
  })) {
    throw new Error('Family payment snapshot is inconsistent');
  }
}
