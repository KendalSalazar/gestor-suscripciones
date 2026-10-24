import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { groupIdParamsSchema } from '../subscriptions/subscription.schemas';
import * as paymentController from './payment.controller';
import {
  confirmPaymentSchema,
  paymentActionQuerySchema,
  paymentParamsSchema,
  paymentQuerySchema,
  skipPaymentSchema,
} from './payment.schemas';

export const paymentRouter = Router({ mergeParams: true });

paymentRouter.get(
  '/',
  validate(groupIdParamsSchema, 'params'),
  validate(paymentQuerySchema, 'query'),
  paymentController.list,
);

paymentRouter.post(
  '/:paymentId/confirm',
  validate(paymentParamsSchema, 'params'),
  validate(paymentActionQuerySchema, 'query'),
  validate(confirmPaymentSchema),
  paymentController.confirm,
);

paymentRouter.post(
  '/:paymentId/skip',
  validate(paymentParamsSchema, 'params'),
  validate(paymentActionQuerySchema, 'query'),
  validate(skipPaymentSchema),
  paymentController.skip,
);
