import { pool } from '../../db/pool';
import { AppError } from '../../middleware/errorHandler';
import { assertOwner, getActiveMembership } from '../subscriptions/membership';
import type { PaymentFilters } from './payment.schemas';
import { toPayment, type Payment, type PaymentRow } from './payment.types';

const paymentColumns = `
  p.id, p.subscription_id, s.name AS subscription_name,
  p.expected_date::text AS expected_date,
  p.expected_amount, p.actual_amount, p.status,
  p.price_changed, p.resolved_at, p.created_at
`;

export async function listPayments(
  userId: string,
  groupId: string,
  filters: PaymentFilters = {},
): Promise<Payment[]> {
  await getActiveMembership(userId, groupId, 'list_payments');

  const result = await pool.query<PaymentRow>(
    `SELECT ${paymentColumns}
     FROM payments p
     JOIN subscriptions s ON s.id = p.subscription_id
     -- Payments inherit their group from the subscription, including inactive ones.
     WHERE s.group_id = $1
       AND ($2::payment_status IS NULL OR p.status = $2::payment_status)
     ORDER BY p.expected_date DESC, p.id DESC
     LIMIT 100`,
    [groupId, filters.status ?? null],
  );

  return result.rows.map(toPayment);
}

export async function confirmPayment(
  userId: string,
  groupId: string,
  paymentId: string,
  actualAmount?: string,
): Promise<Payment> {
  return resolvePayment(userId, groupId, paymentId, 'confirmed', actualAmount);
}

export async function skipPayment(
  userId: string,
  groupId: string,
  paymentId: string,
): Promise<Payment> {
  return resolvePayment(userId, groupId, paymentId, 'skipped');
}

async function resolvePayment(
  userId: string,
  groupId: string,
  paymentId: string,
  status: 'confirmed' | 'skipped',
  actualAmount?: string,
): Promise<Payment> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const membership = await getActiveMembership(userId, groupId, 'resolve_payment', client);
    assertOwner(membership, 'resolve_payment');

    const selected = await client.query<PaymentRow>(
      `SELECT ${paymentColumns}
       FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       WHERE s.group_id = $1 AND p.id = $2
       FOR UPDATE OF p`,
      [groupId, paymentId],
    );
    const payment = selected.rows[0];
    if (!payment) throw new AppError(404, 'Payment not found');
    if (payment.status !== 'pending') throw new AppError(409, 'Payment already resolved');

    // The lock keeps another resolution waiting until this transaction finishes.
    // NUMERIC comparisons happen in PostgreSQL without converting money to Number.
    const updated = status === 'confirmed'
      ? await client.query<PaymentRow>(
        `UPDATE payments p
         SET status = 'confirmed',
             actual_amount = COALESCE($3::numeric, p.expected_amount),
             price_changed = (COALESCE($3::numeric, p.expected_amount) <> p.expected_amount),
             resolved_at = NOW()
         FROM subscriptions s
         WHERE p.subscription_id = s.id AND s.group_id = $1 AND p.id = $2
         RETURNING ${paymentColumns}`,
        [groupId, paymentId, actualAmount ?? null],
      )
      : await client.query<PaymentRow>(
        `UPDATE payments p
         SET status = 'skipped', actual_amount = NULL,
             price_changed = FALSE, resolved_at = NOW()
         FROM subscriptions s
         WHERE p.subscription_id = s.id AND s.group_id = $1 AND p.id = $2
         RETURNING ${paymentColumns}`,
        [groupId, paymentId],
      );

    const result = toPayment(updated.rows[0]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
