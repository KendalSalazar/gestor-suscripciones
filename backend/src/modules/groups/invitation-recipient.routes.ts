import { Router } from 'express';
import { validate } from '../../middleware/validate';
import * as invitationRecipientController from './invitation-recipient.controller';
import {
  invitationRecipientBodySchema,
  invitationRecipientParamsSchema,
  invitationRecipientQuerySchema,
} from './invitation-recipient.schemas';

export const invitationRecipientRouter = Router();

invitationRecipientRouter.post(
  '/:invitationId/preview',
  validate(invitationRecipientParamsSchema, 'params'),
  validate(invitationRecipientQuerySchema, 'query'),
  validate(invitationRecipientBodySchema),
  invitationRecipientController.preview,
);

invitationRecipientRouter.post(
  '/:invitationId/accept',
  validate(invitationRecipientParamsSchema, 'params'),
  validate(invitationRecipientQuerySchema, 'query'),
  validate(invitationRecipientBodySchema),
  invitationRecipientController.accept,
);

invitationRecipientRouter.post(
  '/:invitationId/decline',
  validate(invitationRecipientParamsSchema, 'params'),
  validate(invitationRecipientQuerySchema, 'query'),
  validate(invitationRecipientBodySchema),
  invitationRecipientController.decline,
);
