import dotenv from 'dotenv';

dotenv.config();

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const nodeEnvValue = required('NODE_ENV');
if (!['development', 'production', 'test'].includes(nodeEnvValue)) {
  throw new Error('NODE_ENV must be development, production, or test');
}

const port = Number.parseInt(required('PORT'), 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const databaseUrl = required('DATABASE_URL');
if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
  throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
}

const jwtAccessSecret = required('JWT_ACCESS_SECRET');
const jwtRefreshSecret = required('JWT_REFRESH_SECRET');
if (jwtAccessSecret.length < 32 || jwtRefreshSecret.length < 32) {
  throw new Error('JWT secrets must contain at least 32 characters');
}

const logLevel = required('LOG_LEVEL');
if (!['info', 'warn', 'error'].includes(logLevel)) {
  throw new Error('LOG_LEVEL must be info, warn, or error');
}

export const env = {
  nodeEnv: nodeEnvValue as 'development' | 'production' | 'test',
  isProd: nodeEnvValue === 'production',
  port,
  databaseUrl,
  jwtAccessSecret,
  jwtRefreshSecret,
  jwtAccessExpiresIn: required('JWT_ACCESS_EXPIRES_IN'),
  jwtRefreshExpiresIn: required('JWT_REFRESH_EXPIRES_IN'),
  logLevel: logLevel as 'info' | 'warn' | 'error',
  logDir: required('LOG_DIR'),
};
