import { Router } from 'express';
import { pool } from '../db/pool';
import { AppError } from '../middleware/errorHandler';

export const healthRouter = Router();

healthRouter.get('/health', async (_request, _response, next) => {
  try {
    await pool.query('SELECT 1 AS ok');
    _response.status(200).json({ status: 'ok', db: 'up' });
  } catch {
    next(new AppError(503, 'Database unavailable'));
  }
});
