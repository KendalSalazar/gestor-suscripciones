import { z } from 'zod';

const money = z.union([
  z.string().regex(/^\d+(\.\d{1,2})?$/),
  z.number().finite().nonnegative(),
]).transform((value) => {
  if (typeof value === 'string') {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(2, '0')}`;
  }

  return (Math.round(value * 100) / 100).toFixed(2);
}).refine((value) => Number(value) <= 9_999_999_999.99, 'Expected cost is too large');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}, 'Invalid calendar date');

const subscriptionFields = {
  name: z.string().trim().min(1).max(255),
  provider: z.string().trim().min(1).max(255),
  expectedCost: money,
  billingCycle: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']),
  nextBillingDate: isoDate,
  active: z.boolean(),
};

export const createSubscriptionSchema = z.object({
  name: subscriptionFields.name,
  provider: subscriptionFields.provider,
  expectedCost: subscriptionFields.expectedCost,
  billingCycle: subscriptionFields.billingCycle,
  nextBillingDate: subscriptionFields.nextBillingDate,
}).strict();

export const updateSubscriptionSchema = z.object(subscriptionFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

export const groupIdParamsSchema = z.object({
  groupId: z.string().uuid(),
}).strict();

export const subscriptionParamsSchema = z.object({
  groupId: z.string().uuid(),
  subscriptionId: z.string().uuid(),
}).strict();

export const subscriptionQuerySchema = z.object({
  active: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
}).strict();

export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>;
