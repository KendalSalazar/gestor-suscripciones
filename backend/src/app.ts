import cors from 'cors';
import express from 'express';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { healthRouter } from './routes/health';

export const app = express();

app.use(express.json({ limit: '100kb' }));
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(healthRouter);
app.use(notFound);
app.use(errorHandler);
