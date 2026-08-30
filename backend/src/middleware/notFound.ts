import type { RequestHandler } from 'express';

export const notFound: RequestHandler = (_request, response) => {
  response.status(404).json({ error: { message: 'Not found', status: 404 } });
};
