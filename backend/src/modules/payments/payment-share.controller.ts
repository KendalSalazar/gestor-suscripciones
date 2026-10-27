import type { Request, Response } from 'express';
import { AppError } from '../../middleware/errorHandler';
import type { ConfirmPaymentShareInput, PaymentShareFilters } from './payment-share.schemas';
import { confirmPaymentShare, getPaymentShares, listOwnPaymentShares } from './payment-share.service';

export async function listOwn(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { groupId } = request.params as { groupId: string };
  const shares = await listOwnPaymentShares(request.user.id, groupId, request.query as PaymentShareFilters);
  response.status(200).json({ shares });
}

export async function getBreakdown(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { groupId, paymentId } = request.params as { groupId: string; paymentId: string };
  const breakdown = await getPaymentShares(request.user.id, groupId, paymentId);
  response.status(200).json(breakdown);
}

export async function confirmOwn(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { groupId, paymentId, shareId } = request.params as { groupId: string; paymentId: string; shareId: string };
  const input = request.body as ConfirmPaymentShareInput;
  const result = await confirmPaymentShare(request.user.id, groupId, paymentId, shareId, input.actualAmount);
  response.status(200).json(result);
}
