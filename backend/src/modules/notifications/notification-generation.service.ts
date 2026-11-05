import { jobLogger } from '../../config/logger';
import { pool } from '../../db/pool';
import { insertPaymentNotifications } from './notification-writer';

const OVERDUE_AFTER_DAYS = 7;
const MAX_GROUPS_PER_RUN = 100;
const MAX_PAYMENTS_PER_RUN = 200;

export type OverdueNotificationResult = {
  paymentsProcessed: number;
  notificationsCreated: number;
};

// This fragment only contains fixed SQL. Both aliases belong to the surrounding
// query: g is the payment's group and p is the payment being evaluated.
const missingRecipients = `
  SELECT gm.user_id
  FROM group_members gm
  WHERE gm.group_id = g.id AND gm.status = 'active'
    AND (
      (g.type = 'personal' AND gm.role = 'owner' AND gm.user_id = g.owner_id)
      OR (
        g.type = 'family'
        AND EXISTS (
          SELECT 1 FROM payment_shares ps
          WHERE ps.payment_id = p.id AND ps.user_id = gm.user_id AND ps.status = 'pending'
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM notifications n
      WHERE n.payment_id = p.id AND n.user_id = gm.user_id AND n.type = 'payment_overdue'
    )
`;

// Validate calendar days without interpreting a SQL DATE as a local timestamp.
function assertCalendarDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError('Today must use a valid YYYY-MM-DD date');
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    throw new RangeError('Today must use a valid YYYY-MM-DD date');
  }
}

export async function runOverdueNotifications(
  today: string,
  subscriptionId?: string,
): Promise<OverdueNotificationResult> {
  assertCalendarDate(today);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Select only groups with a missing notice, then skip occupied groups before
    // consuming the payment budget. Group writers use the same first lock.
    const groups = await client.query<{ id: string }>(
      `SELECT g.id
       FROM groups g
       WHERE EXISTS (
         SELECT 1 FROM subscriptions s
         JOIN payments p ON p.subscription_id = s.id
         WHERE s.group_id = g.id AND p.status = 'pending'
           AND p.expected_date <= $1::date - $3::integer
           AND ($2::uuid IS NULL OR s.id = $2::uuid)
           AND EXISTS (${missingRecipients})
       )
       ORDER BY g.id
       LIMIT $4
       FOR UPDATE OF g SKIP LOCKED`,
      [today, subscriptionId ?? null, OVERDUE_AFTER_DAYS, MAX_GROUPS_PER_RUN],
    );

    const groupIds = groups.rows.map((group) => group.id);
    const payments = groupIds.length === 0 ? [] : (await client.query<{ id: string }>(
      `SELECT p.id
       FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       JOIN groups g ON g.id = s.group_id
       WHERE s.group_id = ANY($4::uuid[]) AND p.status = 'pending'
         AND p.expected_date <= $1::date - $3::integer
         AND ($2::uuid IS NULL OR s.id = $2::uuid)
         AND EXISTS (${missingRecipients})
       ORDER BY p.expected_date, p.id
       LIMIT $5
       FOR UPDATE OF p SKIP LOCKED`,
      [today, subscriptionId ?? null, OVERDUE_AFTER_DAYS, groupIds, MAX_PAYMENTS_PER_RUN],
    )).rows;

    // Re-read eligibility under the locks. A family payment can have several
    // pending recipients, so the payment limit must not truncate its recipients.
    const recipients = payments.length === 0 ? [] : (await client.query<{ payment_id: string; user_id: string }>(
      `SELECT p.id AS payment_id, recipient.user_id
       FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       JOIN groups g ON g.id = s.group_id
       CROSS JOIN LATERAL (${missingRecipients}) recipient
       WHERE s.group_id = ANY($4::uuid[]) AND p.id = ANY($5::uuid[])
         AND p.status = 'pending' AND p.expected_date <= $1::date - $3::integer
         AND ($2::uuid IS NULL OR s.id = $2::uuid)
       ORDER BY p.id, recipient.user_id`,
      [today, subscriptionId ?? null, OVERDUE_AFTER_DAYS, groupIds, payments.map((payment) => payment.id)],
    )).rows;

    const recipientsByPayment = new Map<string, string[]>();
    for (const recipient of recipients) {
      const users = recipientsByPayment.get(recipient.payment_id) ?? [];
      users.push(recipient.user_id);
      recipientsByPayment.set(recipient.payment_id, users);
    }

    let paymentsProcessed = 0;
    let notificationsCreated = 0;
    for (const payment of payments) {
      const recipientIds = recipientsByPayment.get(payment.id) ?? [];
      if (recipientIds.length === 0) continue;
      notificationsCreated += await insertPaymentNotifications(client, {
        paymentId: payment.id,
        type: 'payment_overdue',
        recipientIds,
      });
      paymentsProcessed += 1;
    }

    await client.query('COMMIT');
    const result = { paymentsProcessed, notificationsCreated };
    jobLogger.info('Overdue notification scan completed', result);
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const code = typeof error === 'object' && error !== null && 'code' in error
      && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)
      ? error.code : undefined;
    jobLogger.error('Overdue notification scan failed', { code });
    throw error;
  } finally {
    client.release();
  }
}
