import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { groupIdParamsSchema } from '../subscriptions/subscription.schemas';
import * as paymentController from './payment.controller';
import * as paymentShareController from './payment-share.controller';
import {
  confirmPaymentShareSchema,
  paymentShareConfirmParamsSchema,
  paymentShareDetailQuerySchema,
  paymentSharePaymentParamsSchema,
} from './payment-share.schemas';
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

paymentRouter.get(
  '/:paymentId/shares',
  validate(paymentSharePaymentParamsSchema, 'params'),
  validate(paymentShareDetailQuerySchema, 'query'),
  paymentShareController.getBreakdown,
);

paymentRouter.post(
  '/:paymentId/shares/:shareId/confirm',
  validate(paymentShareConfirmParamsSchema, 'params'),
  validate(paymentShareDetailQuerySchema, 'query'),
  validate(confirmPaymentShareSchema),
  paymentShareController.confirmOwn,
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
