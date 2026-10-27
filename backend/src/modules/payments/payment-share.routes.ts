import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { groupIdParamsSchema } from '../subscriptions/subscription.schemas';
import * as paymentShareController from './payment-share.controller';
import { paymentShareQuerySchema } from './payment-share.schemas';

export const paymentShareRouter = Router({ mergeParams: true });

paymentShareRouter.get(
  '/',
  validate(groupIdParamsSchema, 'params'),
  validate(paymentShareQuerySchema, 'query'),
  paymentShareController.listOwn,
);
