import { z } from 'zod';

const cursorPayloadSchema = z.object({
  createdAt: z.string().refine((value) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || value.startsWith('0000-')) return false;
    const date = new Date(value);
    return !Number.isNaN(date.getTime()) && date.toISOString() === value;
  }),
  id: z.string().uuid(),
}).strict();

export type NotificationCursor = z.infer<typeof cursorPayloadSchema>;

const cursorSchema = z.string().min(1).max(512).transform((value, ctx): NotificationCursor => {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('Noncanonical encoding');
    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    const result = cursorPayloadSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // Report a generic validation error for all malformed cursors.
  }
  ctx.addIssue({ code: 'custom', message: 'Invalid cursor' });
  return z.NEVER;
});

export const notificationQuerySchema = z.object({
  status: z.enum(['all', 'unread', 'read']).default('all'),
  groupId: z.string().uuid().optional(),
  cursor: cursorSchema.optional(),
}).strict();

export type NotificationFilters = z.output<typeof notificationQuerySchema>;

export const notificationReadParamsSchema = z.object({
  notificationId: z.string().uuid(),
}).strict();

export const notificationReadQuerySchema = z.object({}).strict();
export const notificationReadBodySchema = z.object({}).strict();
