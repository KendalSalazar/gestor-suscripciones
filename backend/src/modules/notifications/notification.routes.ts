import { Router } from 'express';
import { validate } from '../../middleware/validate';
import * as notificationController from './notification.controller';
import { notificationQuerySchema, notificationReadBodySchema, notificationReadParamsSchema, notificationReadQuerySchema } from './notification.schemas';

export const notificationRouter = Router();

notificationRouter.get('/', validate(notificationQuerySchema, 'query'), notificationController.list);
notificationRouter.post(
  '/:notificationId/read',
  validate(notificationReadParamsSchema, 'params'),
  validate(notificationReadQuerySchema, 'query'),
  validate(notificationReadBodySchema),
  notificationController.markRead,
);
