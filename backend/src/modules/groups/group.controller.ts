import type { Request, Response } from 'express';
import { AppError } from '../../middleware/errorHandler';
import type { CreateInvitationInput, GroupInput, TransferOwnershipInput } from './group.schemas';
import { createGroup, listGroups, updateGroup } from './group.service';
import {
  leaveGroup,
  listMembers as readMembers,
  removeMember as removeGroupMember,
  transferOwnership as transferGroupOwnership,
} from './group-member.service';
import {
  createInvitation as createGroupInvitation,
  listInvitations as readInvitations,
  revokeInvitation as revokeGroupInvitation,
} from './invitation.service';

export async function list(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const groups = await listGroups(request.user.id);
  response.status(200).json({ groups });
}

export async function create(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const group = await createGroup(request.user.id, request.body as GroupInput);
  response.status(201).json({ group });
}

export async function update(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { groupId } = request.params as { groupId: string };
  const group = await updateGroup(request.user.id, groupId, request.body as GroupInput);
  response.status(200).json({ group });
}

export async function listMembers(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { groupId } = request.params as { groupId: string };
  const members = await readMembers(request.user.id, groupId);
  response.status(200).json({ members });
}

export async function transferOwnership(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { groupId } = request.params as { groupId: string };
  const group = await transferGroupOwnership(request.user.id, groupId, request.body as TransferOwnershipInput);
  response.status(200).json({ group });
}

export async function leave(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { groupId } = request.params as { groupId: string };
  await leaveGroup(request.user.id, groupId);
  response.status(204).send();
}

export async function removeMember(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { groupId, userId } = request.params as { groupId: string; userId: string };
  await removeGroupMember(request.user.id, groupId, userId);
  response.status(204).send();
}

export async function createInvitation(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { groupId } = request.params as { groupId: string };
  const result = await createGroupInvitation(request.user.id, groupId, request.body as CreateInvitationInput);
  response.status(201).json(result);
}

export async function listInvitations(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { groupId } = request.params as { groupId: string };
  const invitations = await readInvitations(request.user.id, groupId);
  response.status(200).json({ invitations });
}

export async function revokeInvitation(request: Request, response: Response): Promise<void> {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  const { groupId, invitationId } = request.params as { groupId: string; invitationId: string };
  const invitation = await revokeGroupInvitation(request.user.id, groupId, invitationId);
  response.status(200).json({ invitation });
}
