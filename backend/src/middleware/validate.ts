import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { AppError } from './errorHandler';

type Location = 'body' | 'params' | 'query';

export const validate = (schema: ZodType, location: Location = 'body'): RequestHandler =>
  (request, _response, next) => {
    const result = schema.safeParse(request[location]);
    if (!result.success) {
      next(new AppError(400, result.error.issues[0]?.message ?? 'Validation error'));
      return;
    }

    // Express 5 exposes query through a getter; define an own property so the
    // parsed and transformed value is the one later middleware/controllers see.
    Object.defineProperty(request, location, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: result.data,
    });
    next();
  };
