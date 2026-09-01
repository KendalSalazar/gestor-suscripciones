import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { AppError } from './errorHandler';

export const validate = (schema: ZodType): RequestHandler => (request, _response, next) => {
  // Replace the body with the parsed value so controllers receive normalized input.
  const result = schema.safeParse(request.body);
  if (!result.success) {
    next(new AppError(400, result.error.issues[0]?.message ?? 'Validation error'));
    return;
  }

  request.body = result.data;
  next();
};
