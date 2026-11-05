import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

describeWithDatabase('manual scan CLI with isolated PostgreSQL', () => {
  it('scans only the selected subscription and is idempotent across processes', async () => {
    const { env } = await import('../../config/env');
    const admin = new Pool({ connectionString: env.databaseUrl, max: 2, connectionTimeoutMillis: 5000 });
    const schema = `phase6_cli_${randomUUID().replaceAll('-', '')}`;
    if (!/^phase6_cli_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    let created = false;
    let db: Pool | undefined;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      const isolatedUrl = new URL(env.databaseUrl);
      isolatedUrl.searchParams.set('options', `-c search_path=${schema},pg_catalog`);
      db = new Pool({ connectionString: isolatedUrl.toString(), connectionTimeoutMillis: 5000 });
      const current = await db.query<{ name: string }>('SELECT current_schema() AS name');
      if (current.rows[0].name !== schema) throw new Error('Unexpected PostgreSQL search_path');

      const directory = path.join(__dirname, '../../db/migrations');
      const migrations = fs.readdirSync(directory).filter((name) => /^00[1-9]_.*\.sql$/.test(name)).sort();
      for (const filename of migrations) {
        const source = fs.readFileSync(path.join(directory, filename), 'utf8');
        // PostgreSQL 16 supplies gen_random_uuid; never change global extensions.
        await db.query(source.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\r?\n/, ''));
      }
      await db.query('CREATE TABLE schema_migrations (id SERIAL PRIMARY KEY, filename TEXT NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
      for (const filename of migrations) await db.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [filename]);

      const userId = randomUUID();
      const groupId = randomUUID();
      const targetId = randomUUID();
      const otherId = randomUUID();
      await db.query('INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)',
        [userId, `${userId}@example.com`, 'unused-test-hash', 'CLI fixture']);
      await db.query("INSERT INTO groups (id, name, type, owner_id) VALUES ($1, 'CLI fixture', 'personal', $2)", [groupId, userId]);
      await db.query("INSERT INTO group_members (group_id, user_id, role, status, joined_at) VALUES ($1, $2, 'owner', 'active', NOW())", [groupId, userId]);
      for (const id of [targetId, otherId]) {
        await db.query("INSERT INTO subscriptions (id, group_id, name, provider, expected_cost, billing_cycle, next_billing_date, active) VALUES ($1, $2, 'CLI fixture', 'Test', 10, 'monthly', '9999-12-31', TRUE)", [id, groupId]);
        await db.query("INSERT INTO payments (id, subscription_id, expected_date, expected_amount, status, price_changed) VALUES ($1, $2, '2000-01-01', 10, 'pending', FALSE)", [randomUUID(), id]);
      }

      const cli = path.join(__dirname, 'scan-notifications.cli.ts');
      const childEnv = { ...process.env, DATABASE_URL: isolatedUrl.toString() };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await execFileAsync(process.execPath, [require.resolve('tsx/cli'), cli, '--subscription-id', targetId], {
          cwd: path.join(__dirname, '../../..'), env: childEnv, timeout: 20000,
        });
      }
      const notices = await db.query<{ subscription_id: string; type: string }>(
        'SELECT p.subscription_id, n.type FROM notifications n JOIN payments p ON p.id = n.payment_id ORDER BY p.subscription_id',
      );
      expect(notices.rows).toEqual([{ subscription_id: targetId, type: 'payment_overdue' }]);
    } finally {
      try {
        if (db) await db.end();
      } finally {
        try {
          if (created) {
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
            const remaining = await admin.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
            expect(remaining.rowCount).toBe(0);
          }
        } finally {
          await admin.end();
        }
      }
    }
  }, 30000);
});
