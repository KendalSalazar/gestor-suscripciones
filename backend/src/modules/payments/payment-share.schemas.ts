import { z } from 'zod';
import { confirmPaymentSchema } from './payment.schemas';

export const paymentShareQuerySchema = z.object({
  status: z.enum(['pending', 'confirmed', 'skipped']).optional(),
}).strict();

export const paymentSharePaymentParamsSchema = z.object({
  groupId: z.string().uuid(),
  paymentId: z.string().uuid(),
}).strict();

export const paymentShareDetailQuerySchema = z.object({}).strict();

export const paymentShareConfirmParamsSchema = paymentSharePaymentParamsSchema.extend({
  shareId: z.string().uuid(),
}).strict();

// Keep the personal amount contract, while rejecting a final newline that the
// legacy regular expression's `$` anchor can otherwise accept.
export const confirmPaymentShareSchema = confirmPaymentSchema.refine(
  (input) => input.actualAmount === undefined || input.actualAmount.trim() === input.actualAmount,
  { message: 'Actual amount must not contain surrounding whitespace', path: ['actualAmount'] },
);

export type PaymentShareFilters = z.infer<typeof paymentShareQuerySchema>;
export type ConfirmPaymentShareInput = z.infer<typeof confirmPaymentShareSchema>;
