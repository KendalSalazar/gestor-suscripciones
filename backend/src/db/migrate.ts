import fs from 'node:fs';
import path from 'node:path';
import { closePool, pool } from './pool';
import { dbLogger } from '../config/logger';

const migrationsDirectory = path.join(__dirname, 'migrations');

export async function runMigrations(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = fs.readdirSync(migrationsDirectory)
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
  const applied = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const appliedFiles = new Set(applied.rows.map((row) => row.filename));
  let appliedCount = 0;

  for (const filename of files) {
    if (appliedFiles.has(filename)) continue;

    const sql = fs.readFileSync(path.join(migrationsDirectory, filename), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      appliedCount += 1;
      dbLogger.info('Migration applied', { filename });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const message = error instanceof Error ? error.message : 'Unknown migration error';
      dbLogger.error('Migration failed', { filename, message });
      throw error;
    } finally {
      client.release();
    }
  }

  if (appliedCount === 0) {
    dbLogger.info('No pending migrations');
  } else {
    dbLogger.info(`Applied ${appliedCount} migration(s)`);
  }
}

if (require.main === module) {
  runMigrations()
    .catch(() => process.exitCode = 1)
    .finally(() => closePool());
}
