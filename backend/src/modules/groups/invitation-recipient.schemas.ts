import { z } from 'zod';

export const invitationRecipientParamsSchema = z.object({
  invitationId: z.string().uuid(),
}).strict();

export const invitationRecipientQuerySchema = z.object({}).strict();

export const invitationRecipientBodySchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export type InvitationRecipientInput = z.infer<typeof invitationRecipientBodySchema>;
