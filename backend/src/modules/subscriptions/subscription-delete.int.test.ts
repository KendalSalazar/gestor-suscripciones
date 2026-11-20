import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { isolatedPool } = vi.hoisted(() => ({ isolatedPool: { value: undefined as Pool | undefined } }));
vi.mock('../../db/pool', () => ({
  get pool() {
    if (!isolatedPool.value) throw new Error('Isolated pool is not ready');
    return isolatedPool.value;
  },
}));
const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

describeWithDatabase('subscription deletion with isolated PostgreSQL', () => {
  let admin: Pool;
  let database: Pool;
  let schema = '';
  let created = false;
  let deleteSubscription: typeof import('./subscription.service').deleteSubscription;

  beforeAll(async () => {
    const { env } = await import('../../config/env');
    admin = new Pool({ connectionString: env.databaseUrl, max: 2, connectionTimeoutMillis: 5000 });
    schema = `subscription_delete_test_${randomUUID().replaceAll('-', '')}`;
    if (!/^subscription_delete_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const url = new URL(env.databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema},pg_catalog`);
    database = new Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 5000 });
    isolatedPool.value = database;
    const client = await database.connect();
    try {
      expect((await client.query('SELECT current_schema() AS name')).rows[0].name).toBe(schema);
      await client.query('BEGIN');
      const directory = path.join(__dirname, '../../db/migrations');
      for (const filename of fs.readdirSync(directory).filter((name) => /^00[1-9]_.*\.sql$/.test(name)).sort()) {
        const source = fs.readFileSync(path.join(directory, filename), 'utf8');
        await client.query(source.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\r?\n/, ''));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    ({ deleteSubscription } = await import('./subscription.service'));
  });

  afterAll(async () => {
    try {
      if (database) await database.end();
      isolatedPool.value = undefined;
      if (created) {
        if (!/^subscription_delete_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        expect((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rowCount).toBe(0);
      }
    } finally {
      if (admin) await admin.end();
    }
  });

  async function fixture() {
    const owner = randomUUID();
    const member = randomUUID();
    const outsider = randomUUID();
    const group = randomUUID();
    const foreignGroup = randomUUID();
    const target = randomUUID();
    const sibling = randomUUID();
    const foreign = randomUUID();
    for (const user of [owner, member, outsider]) {
      await database.query(`INSERT INTO users (id, email, password_hash, name)
        VALUES ($1, $2, 'unused-test-hash', 'Deletion fixture')`, [user, `${user}@example.com`]);
    }
    await database.query(`INSERT INTO groups (id, name, type, owner_id)
      VALUES ($1, 'Deletion family', 'family', $3), ($2, 'Foreign family', 'family', $3)`, [group, foreignGroup, owner]);
    await database.query(`INSERT INTO group_members (group_id, user_id, role, status, joined_at)
      VALUES ($1, $3, 'owner', 'active', NOW()), ($2, $3, 'owner', 'active', NOW()),
             ($1, $4, 'member', 'active', NOW())`, [group, foreignGroup, owner, member]);
    for (const [id, parent] of [[target, group], [sibling, group], [foreign, foreignGroup]]) {
      await database.query(`INSERT INTO subscriptions
        (id, group_id, name, provider, expected_cost, billing_cycle, next_billing_date, active)
        VALUES ($1, $2, 'Deletion fixture', 'Fixture', '10.00', 'monthly', '2099-12-31', FALSE)`, [id, parent]);
      for (const [index, status] of ['pending', 'confirmed', 'skipped'].entries()) {
        const payment = randomUUID();
        await database.query(`INSERT INTO payments
          (id, subscription_id, expected_date, expected_amount, status, actual_amount, resolved_at)
          VALUES ($1, $2, $3, '10.00', $4::payment_status,
            CASE WHEN $4 = 'confirmed' THEN 10.00 ELSE NULL END,
            CASE WHEN $4 <> 'pending' THEN NOW() ELSE NULL END)`,
        [payment, id, `2099-01-0${index + 1}`, status]);
        await database.query(`INSERT INTO payment_shares
          (payment_id, user_id, share_amount, share_percentage, status, actual_amount, confirmed_at)
          VALUES ($1, $2, '10.00', '100.0000', $3::payment_share_status,
            CASE WHEN $3 = 'confirmed' THEN 10.00 ELSE NULL END,
            CASE WHEN $3 = 'confirmed' THEN NOW() ELSE NULL END)`, [payment, owner, status]);
        await database.query(`INSERT INTO notifications (user_id, payment_id, type)
          VALUES ($1, $2, 'payment_due')`, [owner, payment]);
      }
    }
    return { owner, member, outsider, group, foreignGroup, target, sibling, foreign };
  }

  async function snapshot(subscriptionId: string) {
    const result = await database.query(`SELECT jsonb_build_object(
      'subscription', (SELECT to_jsonb(s) FROM subscriptions s WHERE s.id = $1),
      'payments', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]') FROM payments p WHERE p.subscription_id = $1),
      'shares', (SELECT COALESCE(jsonb_agg(to_jsonb(ps) ORDER BY ps.id), '[]') FROM payment_shares ps
        JOIN payments p ON p.id = ps.payment_id WHERE p.subscription_id = $1),
      'notices', (SELECT COALESCE(jsonb_agg(to_jsonb(n) ORDER BY n.id), '[]') FROM notifications n
        JOIN payments p ON p.id = n.payment_id WHERE p.subscription_id = $1)
      ) AS snapshot`, [subscriptionId]);
    return result.rows[0].snapshot;
  }

  it('removes pending, confirmed and skipped history only for the selected subscription', async () => {
    const f = await fixture();
    const siblingBefore = await snapshot(f.sibling);
    const foreignBefore = await snapshot(f.foreign);
    const history = await snapshot(f.target);
    expect(history.payments).toHaveLength(3);
    expect(history.shares).toHaveLength(3);
    expect(history.notices).toHaveLength(3);
    await deleteSubscription(f.owner, f.group, f.target);
    expect(await snapshot(f.target)).toEqual({ subscription: null, payments: [], shares: [], notices: [] });
    expect(await snapshot(f.sibling)).toEqual(siblingBefore);
    expect(await snapshot(f.foreign)).toEqual(foreignBefore);
    await expect(deleteSubscription(f.owner, f.group, f.target)).rejects.toMatchObject({ status: 404 });
  });

  it('denies members and outsiders and isolates foreign and missing subscription IDs', async () => {
    const f = await fixture();
    const before = await snapshot(f.target);
    const foreignBefore = await snapshot(f.foreign);
    for (const user of [f.member, f.outsider]) {
      await expect(deleteSubscription(user, f.group, f.target)).rejects.toMatchObject({ status: 403 });
    }
    await expect(deleteSubscription(f.owner, f.group, f.foreign)).rejects.toMatchObject({ status: 404 });
    await expect(deleteSubscription(f.owner, f.group, randomUUID())).rejects.toMatchObject({ status: 404 });
    expect(await snapshot(f.target)).toEqual(before);
    expect(await snapshot(f.foreign)).toEqual(foreignBefore);
  });

  it('restores all dependent history after a late failure and releases its group lock', async () => {
    const f = await fixture();
    const before = await snapshot(f.target);
    // This trigger exists only in this suite's UUID schema and only rejects the fixture target.
    await database.query(`CREATE FUNCTION reject_fixture_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Forced late deletion failure'; END; $$`);
    await database.query(`CREATE TRIGGER reject_fixture_delete BEFORE DELETE ON subscriptions
      FOR EACH ROW WHEN (OLD.id = '${f.target}'::uuid) EXECUTE FUNCTION reject_fixture_delete()`);
    try {
      await expect(deleteSubscription(f.owner, f.group, f.target)).rejects.toMatchObject({ code: 'P0001' });
      expect(await snapshot(f.target)).toEqual(before);
      const observer = await database.connect();
      try {
        await observer.query('BEGIN');
        await observer.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE NOWAIT', [f.group]);
        await observer.query('ROLLBACK');
      } finally {
        observer.release();
      }
    } finally {
      await database.query('DROP TRIGGER reject_fixture_delete ON subscriptions');
      await database.query('DROP FUNCTION reject_fixture_delete()');
    }
    await expect(deleteSubscription(f.owner, f.group, f.target)).resolves.toBeUndefined();
  });
});
