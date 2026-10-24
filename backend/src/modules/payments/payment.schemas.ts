import { z } from 'zod';

export const paymentQuerySchema = z.object({
  status: z.enum(['pending', 'confirmed', 'skipped']).optional(),
}).strict();

export type PaymentFilters = z.infer<typeof paymentQuerySchema>;

export const paymentParamsSchema = z.object({
  groupId: z.string().uuid(),
  paymentId: z.string().uuid(),
}).strict();

const actualAmount = z.string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Actual amount must be a non-negative decimal string with at most two decimals')
  .refine((value) => value.split('.')[0].replace(/^0+/, '').length <= 10, 'Actual amount is too large');

export const confirmPaymentSchema = z.object({
  actualAmount: actualAmount.optional(),
}).strict();

export const skipPaymentSchema = z.object({}).strict().default({});
export const paymentActionQuerySchema = z.object({}).strict();

export type ConfirmPaymentInput = z.infer<typeof confirmPaymentSchema>;
