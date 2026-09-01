import type { RequestHandler } from 'express';
import { authLogger } from '../config/logger';
import { AppError } from './errorHandler';
import { verifyAccessToken } from '../modules/auth/auth.tokens';

export const requireAuth: RequestHandler = (request, _response, next) => {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next(new AppError(401, 'Unauthorized'));
    return;
  }

  try {
    // Access tokens are sent in Authorization; refresh cookies are handled only by /auth/refresh.
    const payload = verifyAccessToken(header.slice('Bearer '.length));
    request.user = { id: payload.sub, email: payload.email };
    next();
  } catch (error) {
    authLogger.warn('Access token rejected', {
      reason: error instanceof Error && error.name === 'TokenExpiredError' ? 'expired' : 'malformed',
    });
    next(new AppError(401, 'Invalid or expired token'));
  }
};
