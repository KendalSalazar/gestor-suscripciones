import { pool } from '../../db/pool';
import { AppError } from '../../middleware/errorHandler';
import { lockGroupForWrite } from '../groups/group-lock';
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
    await getActiveMembership(userId, groupId, 'resolve_payment', client);
    const group = await lockGroupForWrite(client, groupId);
    // A role or membership may have changed while this transaction waited.
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
    if (group.type === 'family' && status === 'confirmed') {
      throw new AppError(409, 'Family payments must be confirmed through individual shares');
    }
    if (payment.status !== 'pending') throw new AppError(409, 'Payment already resolved');

    if (group.type === 'family') {
      const shares = await client.query<{ id: string; status: PaymentRow['status'] }>(
        `SELECT ps.id, ps.status
         FROM payment_shares ps
         JOIN payments p ON p.id = ps.payment_id
         JOIN subscriptions s ON s.id = p.subscription_id
         WHERE s.group_id = $1 AND p.id = $2
         ORDER BY ps.id
         FOR UPDATE OF ps`, [groupId, paymentId],
      );
      if (shares.rows.length === 0) throw new AppError(409, 'Family payment has no shares');
      if (shares.rows.some((share) => share.status !== 'pending')) {
        throw new AppError(409, 'Family payments can only be skipped while all shares are pending');
      }

      // The parent and every share are locked. A concurrent confirmation uses
      // the same group → payment → share order and cannot leave a mixed result.
      await client.query(
        `UPDATE payment_shares ps
         SET status = 'skipped', actual_amount = NULL, confirmed_at = NULL
         FROM payments p
         JOIN subscriptions s ON s.id = p.subscription_id
         WHERE ps.payment_id = p.id AND s.group_id = $1 AND p.id = $2`, [groupId, paymentId],
      );
    }

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
