import type { Request, Response } from 'express';
import { AppError } from '../../middleware/errorHandler';
import type { NotificationFilters } from './notification.schemas';
import { listNotifications, markNotificationRead } from './notification.service';

export async function list(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const result = await listNotifications(request.user.id, request.query as NotificationFilters);
  response.status(200).json(result);
}

export async function markRead(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { notificationId } = request.params as { notificationId: string };
  const notification = await markNotificationRead(request.user.id, notificationId);
  response.status(200).json({ notification });
}
