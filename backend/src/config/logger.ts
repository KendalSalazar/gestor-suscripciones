import fs from 'node:fs';
import winston from 'winston';
import { env } from './env';

const sensitiveKeys = new Set([
  'password', 'password_hash', 'currentpassword', 'newpassword', 'token',
  'accesstoken', 'refreshtoken', 'jwt', 'authorization', 'cookie', 'cookies',
  'secret', 'jwtaccesssecret', 'jwtrefreshsecret', 'database_url', 'databaseurl',
  'connectionstring', 'cardnumber', 'pan', 'cvv', 'cvc', 'card', 'creditcard',
]);

export const sanitizeMeta = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeMeta);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    sensitiveKeys.has(key.toLowerCase()) ? '[REDACTED]' : sanitizeMeta(entry),
  ]));
};

const sanitizeFormat = winston.format((info) => {
  if (!info.context) info.context = 'app';
  const sanitized = sanitizeMeta(info) as Record<string, unknown>;
  Object.keys(info).forEach((key) => delete info[key]);
  Object.assign(info, sanitized);
  return info;
});

if (env.isProd) {
  fs.mkdirSync(env.logDir, { recursive: true });
}

const productionFormat = winston.format.combine(
  winston.format.timestamp(),
  sanitizeFormat(),
  winston.format.json(),
);
const developmentFormat = winston.format.combine(
  winston.format.timestamp(),
  sanitizeFormat(),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, context, stack, ...meta }) =>
    `${timestamp} ${level} [${context ?? 'app'}] ${message}${stack ? `\n${stack}` : ''}${Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ''}`),
);

const transports: winston.transport[] = [new winston.transports.Console({ level: env.logLevel })];
if (env.isProd) {
  transports.push(
    new winston.transports.File({ filename: `${env.logDir}/combined.log`, level: 'info' }),
    new winston.transports.File({ filename: `${env.logDir}/error.log`, level: 'error' }),
  );
}

export const logger = winston.createLogger({
  levels: { error: 0, warn: 1, info: 2 },
  level: env.logLevel,
  format: env.isProd ? productionFormat : developmentFormat,
  transports,
});

export const authLogger = logger.child({ context: 'auth' });
export const paymentLogger = logger.child({ context: 'payment' });
export const jobLogger = logger.child({ context: 'job' });
export const dbLogger = logger.child({ context: 'db' });
export const httpLogger = logger.child({ context: 'http' });
