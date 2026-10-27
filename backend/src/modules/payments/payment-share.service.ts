import { pool } from '../../db/pool';
import { AppError } from '../../middleware/errorHandler';
import { lockGroupForWrite } from '../groups/group-lock';
import { getActiveMembership } from '../subscriptions/membership';
import type { PaymentShareFilters } from './payment-share.schemas';
import {
  toPaymentShare,
  type OwnPaymentShare,
  type PaymentShareBreakdown,
  type PaymentShareConfirmation,
  type PaymentShareRow,
  type PaymentShareSummary,
} from './payment-share.types';
import { toPayment, type Payment, type PaymentStatus } from './payment.types';

type ParentPaymentRow = {
  payment_id: string;
  payment_subscription_id: string;
  payment_subscription_name: string;
  payment_expected_date: string;
  payment_expected_amount: string;
  payment_actual_amount: string | null;
  payment_status: PaymentStatus;
  payment_price_changed: boolean;
  payment_resolved_at: Date | null;
  payment_created_at: Date;
};

type SummaryRow = {
  total_shares: number;
  confirmed_shares: number;
  confirmed_amount: string;
};

type OwnShareRow = PaymentShareRow & ParentPaymentRow & SummaryRow;
type BreakdownRow = { [Key in keyof PaymentShareRow]: PaymentShareRow[Key] | null } & ParentPaymentRow & SummaryRow;

const shareColumns = `
  ps.id, ps.user_id, u.name AS user_name,
  ps.share_amount, ps.share_percentage, ps.actual_amount,
  ps.status, ps.confirmed_at, ps.created_at
`;

const parentPaymentColumns = `
  p.id AS payment_id, p.subscription_id AS payment_subscription_id,
  s.name AS payment_subscription_name, p.expected_date::text AS payment_expected_date,
  p.expected_amount AS payment_expected_amount, p.actual_amount AS payment_actual_amount,
  p.status AS payment_status, p.price_changed AS payment_price_changed,
  p.resolved_at AS payment_resolved_at, p.created_at AS payment_created_at
`;

// This aggregate always includes every share of the parent. Filtering the list
// by user or status must not change the progress reported for the whole group.
const summaryJoin = `
  CROSS JOIN LATERAL (
    SELECT COUNT(*)::integer AS total_shares,
           (COUNT(*) FILTER (WHERE all_shares.status = 'confirmed'))::integer AS confirmed_shares,
           COALESCE(SUM(all_shares.actual_amount) FILTER (WHERE all_shares.status = 'confirmed'), 0.00)::text AS confirmed_amount
    FROM payment_shares all_shares
    WHERE all_shares.payment_id = p.id
  ) summary
`;

export async function listOwnPaymentShares(
  userId: string,
  groupId: string,
  filters: PaymentShareFilters = {},
): Promise<OwnPaymentShare[]> {
  await assertFamilyAccess(userId, groupId, 'list_own_payment_shares');

  const result = await pool.query<OwnShareRow>(
    `SELECT ${shareColumns}, ${parentPaymentColumns},
            summary.total_shares, summary.confirmed_shares, summary.confirmed_amount
     FROM payment_shares ps
     JOIN payments p ON p.id = ps.payment_id
     JOIN subscriptions s ON s.id = p.subscription_id
     JOIN users u ON u.id = ps.user_id
     ${summaryJoin}
     WHERE s.group_id = $1 AND ps.user_id = $2
       AND ($3::payment_share_status IS NULL OR ps.status = $3)
     ORDER BY p.expected_date DESC, ps.id DESC
     LIMIT 100`,
    [groupId, userId, filters.status ?? null],
  );

  return result.rows.map((row) => ({
    ...toPaymentShare(row),
    payment: toParentPayment(row),
    summary: toSummary(row),
  }));
}

export async function getPaymentShares(
  userId: string,
  groupId: string,
  paymentId: string,
): Promise<PaymentShareBreakdown> {
  await assertFamilyAccess(userId, groupId, 'get_payment_shares');

  // One statement gives the parent, shares and totals the same database snapshot.
  // LEFT JOIN also distinguishes an existing payment with no shares from a 404.
  const result = await pool.query<BreakdownRow>(
    `SELECT ${shareColumns}, ${parentPaymentColumns},
            summary.total_shares, summary.confirmed_shares, summary.confirmed_amount
     FROM payments p
     JOIN subscriptions s ON s.id = p.subscription_id
     LEFT JOIN payment_shares ps ON ps.payment_id = p.id
     LEFT JOIN users u ON u.id = ps.user_id
     ${summaryJoin}
     WHERE s.group_id = $1 AND p.id = $2
     ORDER BY ps.user_id ASC`,
    [groupId, paymentId],
  );
  const first = result.rows[0];
  if (!first) throw new AppError(404, 'Payment not found');

  return {
    payment: toParentPayment(first),
    shares: result.rows.filter((row): row is OwnShareRow => row.id !== null).map(toPaymentShare),
    summary: toSummary(first),
  };
}

export async function confirmPaymentShare(
  userId: string,
  groupId: string,
  paymentId: string,
  shareId: string,
  actualAmount?: string,
): Promise<PaymentShareConfirmation> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await getActiveMembership(userId, groupId, 'confirm_payment_share', client);
    const group = await lockGroupForWrite(client, groupId);
    await getActiveMembership(userId, groupId, 'confirm_payment_share', client);
    if (group.type !== 'family') throw new AppError(409, 'Payment shares are only available for family groups');

    const selectedPayment = await client.query<ParentPaymentRow>(
      `SELECT ${parentPaymentColumns}
       FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       WHERE s.group_id = $1 AND p.id = $2
       FOR UPDATE OF p`, [groupId, paymentId],
    );
    let payment = selectedPayment.rows[0];
    if (!payment) throw new AppError(404, 'Payment not found');

    const selectedShare = await client.query<PaymentShareRow>(
      `SELECT ${shareColumns}, p.id AS payment_id
       FROM payment_shares ps
       JOIN payments p ON p.id = ps.payment_id
       JOIN subscriptions s ON s.id = p.subscription_id
       JOIN users u ON u.id = ps.user_id
       WHERE s.group_id = $1 AND p.id = $2 AND ps.id = $3
       FOR UPDATE OF ps`, [groupId, paymentId, shareId],
    );
    const share = selectedShare.rows[0];
    if (!share) throw new AppError(404, 'Payment share not found');
    // Ownership is checked even for resolved parts: an owner cannot confirm for
    // someone else, and the request cannot substitute another user's identity.
    if (share.user_id !== userId) throw new AppError(403, 'Forbidden');
    if (payment.payment_status !== 'pending') throw new AppError(409, 'Payment already resolved');
    if (share.status !== 'pending') throw new AppError(409, 'Payment share already resolved');

    const amount = actualAmount ?? share.share_amount;
    const capacity = await client.query<{ within_limit: boolean }>(
      `SELECT (
         COALESCE(SUM(ps.actual_amount) FILTER (WHERE ps.status = 'confirmed'), 0.00)
         + $3::numeric <= 9999999999.99
       ) AS within_limit
       FROM payment_shares ps
       JOIN payments p ON p.id = ps.payment_id
       JOIN subscriptions s ON s.id = p.subscription_id
       WHERE s.group_id = $1 AND p.id = $2`, [groupId, paymentId, amount],
    );
    if (!capacity.rows[0].within_limit) throw new AppError(409, 'Confirmed payment total would exceed the amount limit');

    const updatedShare = await client.query<PaymentShareRow>(
      `UPDATE payment_shares ps
       SET actual_amount = $4::numeric, status = 'confirmed', confirmed_at = NOW()
       FROM payments p, subscriptions s, users u
       WHERE ps.payment_id = p.id AND p.subscription_id = s.id AND u.id = ps.user_id
         AND s.group_id = $1 AND p.id = $2 AND ps.id = $3 AND ps.user_id = $5
       RETURNING ${shareColumns}, p.id AS payment_id`, [groupId, paymentId, shareId, amount, userId],
    );

    // Read our own write through this client. A pool-based GET could see the old
    // state while this transaction is still open.
    const summaryResult = await client.query<SummaryRow>(
      `SELECT summary.total_shares, summary.confirmed_shares, summary.confirmed_amount
       FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       ${summaryJoin}
       WHERE s.group_id = $1 AND p.id = $2`, [groupId, paymentId],
    );
    const summary = summaryResult.rows[0];
    if (summary.total_shares > 0 && summary.confirmed_shares === summary.total_shares) {
      const updatedPayment = await client.query<ParentPaymentRow>(
        `UPDATE payments p
         SET status = 'confirmed', actual_amount = $3::numeric,
             resolved_at = NOW(), price_changed = ($3::numeric <> p.expected_amount)
         FROM subscriptions s
         WHERE p.subscription_id = s.id AND s.group_id = $1 AND p.id = $2
         RETURNING ${parentPaymentColumns}`, [groupId, paymentId, summary.confirmed_amount],
      );
      payment = updatedPayment.rows[0];
    }

    const result = {
      share: toPaymentShare(updatedShare.rows[0]),
      payment: toParentPayment(payment),
      summary: toSummary(summary),
    };
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function assertFamilyAccess(userId: string, groupId: string, operation: string): Promise<void> {
  await getActiveMembership(userId, groupId, operation);
  const result = await pool.query<{ type: 'personal' | 'family' }>(
    'SELECT type FROM groups WHERE id = $1', [groupId],
  );
  const group = result.rows[0];
  if (!group) throw new AppError(403, 'Forbidden');
  if (group.type !== 'family') throw new AppError(409, 'Payment shares are only available for family groups');
}

function toParentPayment(row: ParentPaymentRow): Payment {
  return toPayment({
    id: row.payment_id,
    subscription_id: row.payment_subscription_id,
    subscription_name: row.payment_subscription_name,
    expected_date: row.payment_expected_date,
    expected_amount: row.payment_expected_amount,
    actual_amount: row.payment_actual_amount,
    status: row.payment_status,
    price_changed: row.payment_price_changed,
    resolved_at: row.payment_resolved_at,
    created_at: row.payment_created_at,
  });
}

function toSummary(row: SummaryRow): PaymentShareSummary {
  return { totalShares: row.total_shares, confirmedShares: row.confirmed_shares, confirmedAmount: row.confirmed_amount };
}
