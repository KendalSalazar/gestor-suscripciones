import { Router } from 'express';
import { validate } from '../../middleware/validate';
import * as groupController from './group.controller';
import {
  groupInputSchema,
  createInvitationSchema,
  groupInvitationParamsSchema,
  groupListBodySchema,
  groupMemberParamsSchema,
  groupParamsSchema,
  groupQuerySchema,
  groupRootParamsSchema,
  transferOwnershipSchema,
} from './group.schemas';

export const groupRouter = Router();

groupRouter.get(
  '/',
  validate(groupRootParamsSchema, 'params'),
  validate(groupQuerySchema, 'query'),
  validate(groupListBodySchema),
  groupController.list,
);

groupRouter.post(
  '/',
  validate(groupRootParamsSchema, 'params'),
  validate(groupQuerySchema, 'query'),
  validate(groupInputSchema),
  groupController.create,
);

groupRouter.patch(
  '/:groupId',
  validate(groupParamsSchema, 'params'),
  validate(groupQuerySchema, 'query'),
  validate(groupInputSchema),
  groupController.update,
);

groupRouter.get(
  '/:groupId/members',
  validate(groupParamsSchema, 'params'),
  validate(groupQuerySchema, 'query'),
  validate(groupListBodySchema),
  groupController.listMembers,
);

groupRouter.post(
  '/:groupId/transfer-ownership',
  validate(groupParamsSchema, 'params'),
  validate(groupQuerySchema, 'query'),
  validate(transferOwnershipSchema),
  groupController.transferOwnership,
);

groupRouter.post(
  '/:groupId/leave',
  validate(groupParamsSchema, 'params'),
  validate(groupQuerySchema, 'query'),
  validate(groupListBodySchema),
  groupController.leave,
);

groupRouter.delete(
  '/:groupId/members/:userId',
  validate(groupMemberParamsSchema, 'params'),
  validate(groupQuerySchema, 'query'),
  validate(groupListBodySchema),
  groupController.removeMember,
);

groupRouter.post(
  '/:groupId/invitations',
  validate(groupParamsSchema, 'params'),
  validate(groupQuerySchema, 'query'),
  validate(createInvitationSchema),
  groupController.createInvitation,
);

groupRouter.get(
  '/:groupId/invitations',
  validate(groupParamsSchema, 'params'),
  validate(groupQuerySchema, 'query'),
  validate(groupListBodySchema),
  groupController.listInvitations,
);

groupRouter.post(
  '/:groupId/invitations/:invitationId/revoke',
  validate(groupInvitationParamsSchema, 'params'),
  validate(groupQuerySchema, 'query'),
  validate(groupListBodySchema),
  groupController.revokeInvitation,
);
