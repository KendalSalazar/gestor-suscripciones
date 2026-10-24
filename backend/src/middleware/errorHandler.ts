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
  const invalidJson = error instanceof SyntaxError
    && 'type' in error && error.type === 'entity.parse.failed';
  const status = error instanceof AppError ? error.status : invalidJson ? 400 : 500;
  // Parser errors can contain excerpts of the body; do not echo them or log their stack.
  const rawMessage = invalidJson ? 'Invalid JSON body' : error instanceof Error ? error.message : 'Unknown error';
  const message = env.isProd && status === 500 ? 'Internal server error' : rawMessage;

  logger.error('Unhandled error', {
    message: rawMessage,
    status,
    stack: env.isProd || invalidJson ? undefined : error instanceof Error ? error.stack : undefined,
  });

  response.status(status).json({ error: { message, status } });
};
