import { z } from 'zod';

export const groupInputSchema = z.object({
  name: z.string().trim().min(1).max(255),
}).strict();

export const groupRootParamsSchema = z.object({}).strict();
export const groupQuerySchema = z.object({}).strict();
export const groupListBodySchema = z.object({}).strict().default({});
export const groupParamsSchema = z.object({
  groupId: z.string().uuid(),
}).strict();

export const groupMemberParamsSchema = groupParamsSchema.extend({
  userId: z.string().uuid(),
}).strict();

export const transferOwnershipSchema = z.object({
  newOwnerId: z.string().uuid(),
}).strict();

export const createInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
}).strict();

export const groupInvitationParamsSchema = groupParamsSchema.extend({
  invitationId: z.string().uuid(),
}).strict();

export type GroupInput = z.infer<typeof groupInputSchema>;
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
