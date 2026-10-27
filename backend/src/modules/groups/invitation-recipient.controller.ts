import type { Request, Response } from 'express';
import { AppError } from '../../middleware/errorHandler';
import {
  acceptInvitation,
  declineInvitation,
  previewInvitation,
} from './invitation-recipient.service';
import type { InvitationRecipientInput } from './invitation-recipient.schemas';

export async function preview(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { invitationId } = request.params as { invitationId: string };
  const { token } = request.body as InvitationRecipientInput;
  const invitation = await previewInvitation(request.user.id, invitationId, token);
  response.status(200).json({ invitation });
}

export async function accept(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { invitationId } = request.params as { invitationId: string };
  const { token } = request.body as InvitationRecipientInput;
  const result = await acceptInvitation(request.user.id, invitationId, token);
  response.status(200).json(result);
}

export async function decline(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { invitationId } = request.params as { invitationId: string };
  const { token } = request.body as InvitationRecipientInput;
  const invitation = await declineInvitation(request.user.id, invitationId, token);
  response.status(200).json({ invitation });
}
