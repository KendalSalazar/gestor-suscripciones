import { Router } from 'express';
import { validate } from '../../middleware/validate';
import * as subscriptionController from './subscription.controller';
import {
  createSubscriptionSchema,
  groupIdParamsSchema,
  subscriptionParamsSchema,
  subscriptionQuerySchema,
  updateSubscriptionSchema,
} from './subscription.schemas';

export const subscriptionRouter = Router({ mergeParams: true });

subscriptionRouter.post(
  '/',
  validate(groupIdParamsSchema, 'params'),
  validate(createSubscriptionSchema),
  subscriptionController.create,
);

subscriptionRouter.get(
  '/',
  validate(groupIdParamsSchema, 'params'),
  validate(subscriptionQuerySchema, 'query'),
  subscriptionController.list,
);

subscriptionRouter.get(
  '/:subscriptionId',
  validate(subscriptionParamsSchema, 'params'),
  subscriptionController.get,
);

subscriptionRouter.patch(
  '/:subscriptionId',
  validate(subscriptionParamsSchema, 'params'),
  validate(updateSubscriptionSchema),
  subscriptionController.update,
);

subscriptionRouter.delete(
  '/:subscriptionId',
  validate(subscriptionParamsSchema, 'params'),
  subscriptionController.remove,
);
