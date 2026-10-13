import type { Request, Response } from 'express';
import { AppError } from '../../middleware/errorHandler';
import * as subscriptionService from './subscription.service';

function authenticatedUserId(request: Request): string {
  if (!request.user) throw new AppError(401, 'Unauthorized');
  return request.user.id;
}

export async function list(request: Request, response: Response): Promise<void> {
  const filters = request.query as { active?: boolean };
  const { groupId } = request.params as { groupId: string };
  const subscriptions = await subscriptionService.listSubscriptions(
    authenticatedUserId(request),
    groupId,
    filters,
  );

  response.status(200).json({ subscriptions });
}

export async function get(request: Request, response: Response): Promise<void> {
  const { groupId, subscriptionId } = request.params as {
    groupId: string;
    subscriptionId: string;
  };
  const subscription = await subscriptionService.getSubscription(
    authenticatedUserId(request),
    groupId,
    subscriptionId,
  );

  response.status(200).json({ subscription });
}

export async function create(request: Request, response: Response): Promise<void> {
  const { groupId } = request.params as { groupId: string };
  const subscription = await subscriptionService.createSubscription(
    authenticatedUserId(request),
    groupId,
    request.body,
  );

  response.status(201).json({ subscription });
}

export async function update(request: Request, response: Response): Promise<void> {
  const { groupId, subscriptionId } = request.params as {
    groupId: string;
    subscriptionId: string;
  };
  const subscription = await subscriptionService.updateSubscription(
    authenticatedUserId(request),
    groupId,
    subscriptionId,
    request.body,
  );

  response.status(200).json({ subscription });
}

export async function remove(request: Request, response: Response): Promise<void> {
  const { groupId, subscriptionId } = request.params as {
    groupId: string;
    subscriptionId: string;
  };
  await subscriptionService.deleteSubscription(
    authenticatedUserId(request),
    groupId,
    subscriptionId,
  );

  response.status(204).send();
}
