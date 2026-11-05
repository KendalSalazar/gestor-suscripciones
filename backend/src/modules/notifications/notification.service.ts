import { pool } from '../../db/pool';
import { AppError } from '../../middleware/errorHandler';
import { lockGroupForWrite } from '../groups/group-lock';
import { getActiveMembership } from '../subscriptions/membership';
import { getNotificationMessage } from './notification-messages';
import type { NotificationFilters } from './notification.schemas';
import type { Notification } from './notification.types';

const PAGE_SIZE = 50;

// Shared fixed projection ensures listing and read actions return the same DTO.
const notificationProjection = `
  SELECT n.id, n.type, p.id AS payment_id, s.id AS subscription_id,
         s.name AS subscription_name, g.id AS group_id, g.name AS group_name,
         g.type AS group_type, p.expected_date::text AS expected_date,
         p.expected_amount::text AS expected_amount, p.actual_amount::text AS actual_amount,
         p.status AS payment_status,
         CASE WHEN g.type = 'family' THEN ps.status ELSE NULL END AS own_share_status,
         (n.type IN ('payment_due', 'payment_overdue') AND p.status = 'pending'
          AND ((g.type = 'personal' AND gm.role = 'owner' AND g.owner_id = gm.user_id)
               OR (g.type = 'family' AND ps.status = 'pending'))) IS TRUE AS action_required,
         n.created_at, n.read_at
  FROM notifications n
  JOIN payments p ON p.id = n.payment_id
  JOIN subscriptions s ON s.id = p.subscription_id
  JOIN groups g ON g.id = s.group_id
  JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $1 AND gm.status = 'active'
  LEFT JOIN payment_shares ps ON ps.payment_id = p.id AND ps.user_id = n.user_id
  WHERE n.user_id = $1`;

type NotificationRow = {
  id: string;
  type: Notification['type'];
  payment_id: string;
  subscription_id: string;
  subscription_name: string;
  group_id: string;
  group_name: string;
  group_type: Notification['groupType'];
  expected_date: string;
  expected_amount: string;
  actual_amount: string | null;
  payment_status: Notification['paymentStatus'];
  own_share_status: Notification['ownShareStatus'];
  action_required: boolean;
  created_at: Date;
  read_at: Date | null;
};

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    type: row.type,
    paymentId: row.payment_id,
    subscriptionId: row.subscription_id,
    subscriptionName: row.subscription_name,
    groupId: row.group_id,
    groupName: row.group_name,
    groupType: row.group_type,
    expectedDate: row.expected_date,
    expectedAmount: row.expected_amount,
    actualAmount: row.actual_amount,
    paymentStatus: row.payment_status,
    ownShareStatus: row.own_share_status,
    actionRequired: row.action_required,
    message: getNotificationMessage(row.type),
    createdAt: row.created_at.toISOString(),
    readAt: row.read_at?.toISOString() ?? null,
  };
}

export async function listNotifications(userId: string, filters: NotificationFilters): Promise<{
  notifications: Notification[];
  nextCursor: string | null;
  unreadCount: number;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (filters.groupId) {
      await getActiveMembership(userId, filters.groupId, 'list_notifications', client);
    }

    const rows = await client.query<NotificationRow>(
      `${notificationProjection}
         AND ($2::uuid IS NULL OR g.id = $2::uuid)
         AND ($3::text = 'all' OR ($3::text = 'unread' AND n.read_at IS NULL)
              OR ($3::text = 'read' AND n.read_at IS NOT NULL))
         AND ($4::timestamptz IS NULL OR (n.created_at, n.id) < ($4::timestamptz, $5::uuid))
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT $6`,
      [userId, filters.groupId ?? null, filters.status, filters.cursor?.createdAt ?? null, filters.cursor?.id ?? null, PAGE_SIZE + 1],
    );

    const count = await client.query<{ unread_count: string }>(
      `SELECT COUNT(*)::text AS unread_count
       FROM notifications n
       JOIN payments p ON p.id = n.payment_id
       JOIN subscriptions s ON s.id = p.subscription_id
       JOIN group_members gm ON gm.group_id = s.group_id AND gm.user_id = $1 AND gm.status = 'active'
       WHERE n.user_id = $1 AND n.read_at IS NULL
         AND ($2::uuid IS NULL OR s.group_id = $2::uuid)`,
      [userId, filters.groupId ?? null],
    );

    const page = rows.rows.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    const nextCursor = rows.rows.length > PAGE_SIZE && last
      ? Buffer.from(JSON.stringify({ createdAt: last.created_at.toISOString(), id: last.id })).toString('base64url')
      : null;
    const notifications = page.map(toNotification);
    const unreadCount = Number(count.rows[0].unread_count);
    await client.query('COMMIT');
    return { notifications, nextCursor, unreadCount };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function markNotificationRead(userId: string, notificationId: string): Promise<Notification> {
  const client = await pool.connect();
  const notFound = () => new AppError(404, 'Notification not found');
  try {
    await client.query('BEGIN');
    // Derive the group only from an initially visible notification, without
    // locking the notification before the group.
    const visible = await client.query<{ group_id: string }>(
      `SELECT s.group_id FROM notifications n
       JOIN payments p ON p.id = n.payment_id
       JOIN subscriptions s ON s.id = p.subscription_id
       JOIN group_members gm ON gm.group_id = s.group_id AND gm.user_id = $1 AND gm.status = 'active'
       WHERE n.user_id = $1 AND n.id = $2`, [userId, notificationId],
    );
    if (!visible.rows[0]) throw notFound();
    const groupId = visible.rows[0].group_id;
    try {
      await lockGroupForWrite(client, groupId);
    } catch (error) {
      if (error instanceof AppError && error.status === 403) throw notFound();
      throw error;
    }
    // Membership may have changed while waiting for the group lock.
    const updated = await client.query<{ id: string }>(
      `UPDATE notifications n SET read_at = COALESCE(n.read_at, NOW())
       FROM payments p, subscriptions s, group_members gm
       WHERE n.id = $2 AND n.user_id = $1 AND p.id = n.payment_id
         AND s.id = p.subscription_id AND s.group_id = $3
         AND gm.group_id = s.group_id AND gm.user_id = $1 AND gm.status = 'active'
       RETURNING n.id`, [userId, notificationId, groupId],
    );
    if (!updated.rows[0]) throw notFound();

    const result = await client.query<NotificationRow>(
      `${notificationProjection} AND n.id = $2 AND g.id = $3`,
      [userId, notificationId, groupId],
    );
    if (!result.rows[0]) throw notFound();
    const notification = toNotification(result.rows[0]);
    await client.query('COMMIT');
    return notification;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
