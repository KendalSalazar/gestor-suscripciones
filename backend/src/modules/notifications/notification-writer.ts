import type { PoolClient } from 'pg';
import type { NotificationType } from './notification.types';

type InsertPaymentNotificationsInput = {
  paymentId: string;
  type: NotificationType;
  recipientIds: string[];
};

// The caller supplies its transaction and determines authorized recipients.
export async function insertPaymentNotifications(
  client: PoolClient,
  { paymentId, type, recipientIds }: InsertPaymentNotificationsInput,
): Promise<number> {
  if (recipientIds.length === 0) return 0;

  const inserted = await client.query(
    `INSERT INTO notifications (user_id, payment_id, type)
     SELECT recipient_id, $1::uuid, $2::notification_type
     FROM (
       SELECT DISTINCT unnest($3::uuid[]) AS recipient_id
     ) AS recipients
     ORDER BY recipient_id
     ON CONFLICT (user_id, payment_id, type) DO NOTHING`,
    [paymentId, type, recipientIds],
  );

  return inserted.rowCount ?? 0;
}
