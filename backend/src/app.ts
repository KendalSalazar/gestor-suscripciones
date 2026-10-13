import cors from 'cors';
import cookieParser from 'cookie-parser';
import express from 'express';
import { errorHandler } from './middleware/errorHandler';
import { requireAuth } from './middleware/auth.middleware';
import { notFound } from './middleware/notFound';
import { authRouter } from './modules/auth/auth.routes';
import { subscriptionRouter } from './modules/subscriptions/subscription.routes';
import { healthRouter } from './routes/health';

export const app = express();

app.use(express.json({ limit: '100kb' }));
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(cookieParser());
app.use(healthRouter);
app.use('/auth', authRouter);
app.use('/groups/:groupId/subscriptions', requireAuth, subscriptionRouter);
app.use(notFound);
app.use(errorHandler);
