import type { Request, Response } from 'express';
import { AppError } from '../../middleware/errorHandler';
import type { ConfirmPaymentInput, PaymentFilters } from './payment.schemas';
import { confirmPayment, listPayments, skipPayment } from './payment.service';

export async function list(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');

  const { groupId } = request.params as { groupId: string };
  const filters = request.query as PaymentFilters;
  const payments = await listPayments(request.user.id, groupId, filters);

  response.status(200).json({ payments });
}

export async function confirm(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { groupId, paymentId } = request.params as { groupId: string; paymentId: string };
  const input = request.body as ConfirmPaymentInput;
  const payment = await confirmPayment(request.user.id, groupId, paymentId, input.actualAmount);
  response.status(200).json({ payment });
}

export async function skip(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { groupId, paymentId } = request.params as { groupId: string; paymentId: string };
  const payment = await skipPayment(request.user.id, groupId, paymentId);
  response.status(200).json({ payment });
}
