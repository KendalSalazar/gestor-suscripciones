import { Pool } from 'pg';
import { env } from '../config/env';
import { dbLogger } from '../config/logger';

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (error) => {
  dbLogger.error('Unexpected error on idle client', {
    message: error.message,
    code: 'code' in error ? error.code : undefined,
  });
});

export async function assertDbConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    dbLogger.info('Postgres connection OK');
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
  dbLogger.info('Postgres pool closed');
}
