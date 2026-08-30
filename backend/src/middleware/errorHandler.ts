import type { ErrorRequestHandler } from 'express';
import { env } from '../config/env';
import { logger } from '../config/logger';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly isOperational = true,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  const status = error instanceof AppError ? error.status : 500;
  const rawMessage = error instanceof Error ? error.message : 'Unknown error';
  const message = env.isProd && status === 500 ? 'Internal server error' : rawMessage;

  logger.error('Unhandled error', {
    message: rawMessage,
    status,
    stack: env.isProd ? undefined : error instanceof Error ? error.stack : undefined,
  });

  response.status(status).json({ error: { message, status } });
};
