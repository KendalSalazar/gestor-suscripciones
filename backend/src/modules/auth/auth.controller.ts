import type { Request, Response } from 'express';
import { AppError } from '../../middleware/errorHandler';
import { refreshCookieOptions } from './auth.tokens';
import * as authService from './auth.service';

export async function register(request: Request, response: Response): Promise<void> {
  const result = await authService.register(request.body);
  response.cookie('refresh_token', result.refreshToken, refreshCookieOptions());
  response.status(201).json({ user: result.user, accessToken: result.accessToken });
}

export async function login(request: Request, response: Response): Promise<void> {
  const result = await authService.login(request.body);
  response.cookie('refresh_token', result.refreshToken, refreshCookieOptions());
  response.status(200).json({ user: result.user, accessToken: result.accessToken });
}

export async function refresh(request: Request, response: Response): Promise<void> {
  const rawToken = request.cookies.refresh_token as string | undefined;
  if (!rawToken) throw new AppError(401, 'Refresh token missing');
  const result = await authService.refresh(rawToken);
  response.cookie('refresh_token', result.refreshToken, refreshCookieOptions());
  response.status(200).json({ accessToken: result.accessToken });
}

export async function logout(request: Request, response: Response): Promise<void> {
  await authService.logout(request.cookies.refresh_token as string | undefined);
  response.clearCookie('refresh_token', { ...refreshCookieOptions(), maxAge: undefined });
  response.status(204).send();
}

export function me(request: Request, response: Response): void {
  response.status(200).json({ user: request.user });
}
