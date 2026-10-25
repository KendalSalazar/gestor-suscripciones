import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { isolatedPool } = vi.hoisted(() => ({ isolatedPool: { value: undefined as Pool | undefined } }));
vi.mock('../../db/pool', () => ({
  get pool() {
    if (!isolatedPool.value) throw new Error('Isolated PostgreSQL pool is not ready');
    return isolatedPool.value;
  },
}));

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

type Fixture = {
  groupId: string;
  subscriptionId: string;
  userIds: string[];
};
type StoredPayment = {
  id: string;
  expected_date: string;
  expected_amount: string;
  actual_amount: string | null;
  status: string;
  price_changed: boolean;
};
type StoredShare = {
  id: string;
  payment_id: string;
  user_id: string;
  share_amount: string;
  share_percentage: string;
  actual_amount: string | null;
  status: string;
  confirmed_at: string | null;
};

describeWithDatabase('family payment generation with isolated real PostgreSQL', () => {
  const schema = `phase5_test_${randomUUID().replaceAll('-', '')}`;
  const prefix = `phase5-test-${randomUUID()}`;
  let admin: Pool;
  let database: Pool;
  let schemaCreated = false;
  let runDuePayments: typeof import('./payment-generation.service').runDuePayments;

  beforeAll(async () => {
    if (!/^phase5_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    const { env } = await import('../../config/env');
    admin = new Pool({ connectionString: env.databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const isolatedUrl = new URL(env.databaseUrl);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema},pg_catalog`);
    isolatedUrl.searchParams.set('application_name', prefix);
    database = new Pool({
      connectionString: isolatedUrl.toString(), max: 8,
      connectionTimeoutMillis: 5_000, statement_timeout: 10_000,
    });
    isolatedPool.value = database;
    const client = await database.connect();
    try {
      // Do not run any unqualified DDL unless the connection is in our own schema.
      const current = await client.query<{ name: string }>('SELECT current_schema() AS name');
      if (current.rows[0].name !== schema) throw new Error('Unexpected PostgreSQL search_path');
      await client.query('BEGIN');
      const directory = path.join(__dirname, '../../db/migrations');
      for (const filename of fs.readdirSync(directory).filter((name) => /^00[1-8]_.*\.sql$/.test(name)).sort()) {
        const source = fs.readFileSync(path.join(directory, filename), 'utf8');
        // PostgreSQL 16 has gen_random_uuid; never change a database-wide extension.
        await client.query(source.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\r?\n/, ''));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    ({ runDuePayments } = await import('./payment-generation.service'));
  });

  afterAll(async () => {
    try {
      if (database) await database.end();
    } finally {
      isolatedPool.value = undefined;
      if (admin) {
        try {
          if (schemaCreated) {
            if (!/^phase5_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
            const remaining = await admin.query<{ count: string }>(
              'SELECT COUNT(*)::text AS count FROM pg_namespace WHERE nspname = $1', [schema],
            );
            expect(remaining.rows[0].count).toBe('0');
          }
        } finally {
          await admin.end();
        }
      }
    }
  });

  async function createUser(): Promise<string> {
    const id = randomUUID();
    await database.query('INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)',
      [id, `${prefix}-${id}@example.com`, 'unused-test-hash', prefix]);
    return id;
  }

  async function createFixture(options: {
    type?: 'family' | 'personal'; count?: number; amount?: string; date?: string;
  } = {}): Promise<Fixture> {
    const type = options.type ?? 'family';
    const fixture: Fixture = { groupId: randomUUID(), subscriptionId: randomUUID(), userIds: [] };
    for (let index = 0; index < (options.count ?? (type === 'family' ? 3 : 1)); index += 1) {
      fixture.userIds.push(await createUser());
    }
    await database.query('INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, $3, $4)',
      [fixture.groupId, prefix, type, fixture.userIds[0]]);
    for (const [index, id] of fixture.userIds.entries()) {
      await database.query(
        `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
         VALUES ($1, $2, $3, 'active', NOW())`, [fixture.groupId, id, index === 0 ? 'owner' : 'member'],
      );
    }
    const date = options.date ?? '2026-10-15';
    await database.query(
      `INSERT INTO subscriptions (
         id, group_id, name, provider, expected_cost, billing_cycle,
         next_billing_date, billing_anchor_day, active
       ) VALUES ($1, $2, $3, 'Test', $4, 'monthly', $5::date, $6, TRUE)`,
      [fixture.subscriptionId, fixture.groupId, prefix, options.amount ?? '10.00', date, Number(date.slice(8, 10))],
    );
    return fixture;
  }

  // Every real generation call must pass a fixture UUID, including concurrency tests.
  const generate = (fixture: Fixture, today = '2026-10-15') => runDuePayments(today, fixture.subscriptionId);

  async function photo(fixture: Fixture): Promise<{ payments: StoredPayment[]; shares: StoredShare[] }> {
    const payments = await database.query<StoredPayment>(
      `SELECT id, expected_date::text, expected_amount, actual_amount, status, price_changed
       FROM payments WHERE subscription_id = $1 ORDER BY expected_date`, [fixture.subscriptionId],
    );
    const shares = await database.query<StoredShare>(
      `SELECT ps.id, ps.payment_id, ps.user_id, ps.share_amount, ps.share_percentage,
              ps.actual_amount, ps.status, ps.confirmed_at::text
       FROM payment_shares ps JOIN payments p ON p.id = ps.payment_id
       WHERE p.subscription_id = $1 ORDER BY p.expected_date, ps.user_id`, [fixture.subscriptionId],
    );
    return { payments: payments.rows, shares: shares.rows };
  }

  async function billingDate(fixture: Fixture): Promise<string> {
    return (await database.query<{ next_date: string }>(
      'SELECT next_billing_date::text AS next_date FROM subscriptions WHERE id = $1', [fixture.subscriptionId],
    )).rows[0].next_date;
  }

  async function snapshot(fixture: Fixture): Promise<string> {
    return (await database.query<{ snapshot: string }>(
      `SELECT jsonb_build_object(
         'subscription', (SELECT to_jsonb(s) FROM subscriptions s WHERE s.id = $1),
         'payments', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb)
                      FROM payments p WHERE p.subscription_id = $1),
         'shares', (SELECT COALESCE(jsonb_agg(to_jsonb(ps) ORDER BY ps.id), '[]'::jsonb)
                    FROM payment_shares ps JOIN payments p ON p.id = ps.payment_id WHERE p.subscription_id = $1)
       )::text AS snapshot`, [fixture.subscriptionId],
    )).rows[0].snapshot;
  }

  async function addMember(client: Pick<PoolClient, 'query'>, fixture: Fixture, userId: string): Promise<void> {
    await client.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'member', 'active', NOW())`, [fixture.groupId, userId],
    );
  }

  async function waitForBlockedPid(blockerPid: number, finished: () => boolean): Promise<number> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const result = await database.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
         WHERE application_name = $1 AND wait_event_type = 'Lock'
           AND $2::integer = ANY(pg_blocking_pids(pid))`, [prefix, blockerPid],
      );
      if (result.rows[0]) return result.rows[0].pid;
      if (finished()) throw new Error('Fixture operation finished before the expected PostgreSQL lock wait');
      // The predicate above proves the wait; this delay only spaces observations.
      await delay(10);
    }
    throw new Error('Expected fixture PostgreSQL lock wait was not observed');
  }

  it('captures three active members and exact totals without touching another due fixture', async () => {
    const fixture = await createFixture();
    const untouched = await createFixture();
    const untouchedBefore = await snapshot(untouched);
    expect(await generate(fixture)).toEqual({ subscriptionsProcessed: 1, paymentsCreated: 1, subscriptionsStillDue: 0 });
    const stored = await photo(fixture);
    expect(stored.payments).toEqual([expect.objectContaining({
      expected_date: '2026-10-15', expected_amount: '10.00', actual_amount: null, status: 'pending', price_changed: false,
    })]);
    expect(stored.shares.map(({ user_id, share_amount, share_percentage, status, actual_amount, confirmed_at }) => (
      { user_id, share_amount, share_percentage, status, actual_amount, confirmed_at }
    ))).toEqual([...fixture.userIds].sort().map((id, index) => ({
      user_id: id, share_amount: index === 0 ? '3.34' : '3.33',
      share_percentage: index === 0 ? '33.3334' : '33.3333', status: 'pending', actual_amount: null, confirmed_at: null,
    })));
    const totals = await database.query(
      `SELECT SUM(ps.share_amount)::text AS amount, SUM(ps.share_percentage)::text AS percentage
       FROM payment_shares ps JOIN payments p ON p.id = ps.payment_id WHERE p.subscription_id = $1`, [fixture.subscriptionId],
    );
    expect(totals.rows).toEqual([{ amount: '10.00', percentage: '100.0000' }]);
    expect(await billingDate(fixture)).toBe('2026-11-15');
    expect(await snapshot(untouched)).toBe(untouchedBefore);
  });

  it('continues generating personal payments without shares', async () => {
    const fixture = await createFixture({ type: 'personal', amount: '17.99' });
    expect((await generate(fixture)).paymentsCreated).toBe(1);
    expect(await photo(fixture)).toEqual({
      payments: [expect.objectContaining({ expected_amount: '17.99', status: 'pending' })], shares: [],
    });
    expect(await billingDate(fixture)).toBe('2026-11-15');
  });

  it.each([
    ['0.00', ['0.00', '0.00', '0.00']],
    ['0.01', ['0.01', '0.00', '0.00']],
  ])('captures a family amount of %s including zero shares', async (amount, expectedAmounts) => {
    const fixture = await createFixture({ amount: amount as string });
    await generate(fixture);
    const stored = await photo(fixture);
    expect(stored.shares.map((share) => share.share_amount)).toEqual(expectedAmounts);
    expect(stored.shares.every((share) => share.status === 'pending')).toBe(true);
  });

  it('captures a complete current snapshot for every recovered billing date', async () => {
    const fixture = await createFixture({ date: '2026-08-15' });
    expect(await generate(fixture)).toEqual({ subscriptionsProcessed: 1, paymentsCreated: 3, subscriptionsStillDue: 0 });
    const stored = await photo(fixture);
    expect(stored.payments.map((payment) => payment.expected_date)).toEqual(['2026-08-15', '2026-09-15', '2026-10-15']);
    expect(stored.shares).toHaveLength(9);
    for (const payment of stored.payments) {
      expect(stored.shares.filter((share) => share.payment_id === payment.id).map((share) => share.user_id))
        .toEqual([...fixture.userIds].sort());
    }
    expect(await billingDate(fixture)).toBe('2026-11-15');
  });

  it('keeps saved participants, cost and partial confirmations on conflict and repetition', async () => {
    const fixture = await createFixture();
    await generate(fixture);
    const stored = await photo(fixture);
    const confirmedShare = stored.shares.filter((share) => share.user_id !== fixture.userIds[0])[0];
    await database.query(
      "UPDATE payment_shares SET status = 'confirmed', actual_amount = '4.00', confirmed_at = NOW() WHERE id = $1",
      [confirmedShare.id],
    );
    const newcomer = await createUser();
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [fixture.groupId]);
      // This member has confirmed their only share. Raw fixture SQL does not add a leave API.
      await client.query("UPDATE group_members SET status = 'removed' WHERE group_id = $1 AND user_id = $2",
        [fixture.groupId, confirmedShare.user_id]);
      await addMember(client, fixture, newcomer);
      await client.query("UPDATE subscriptions SET expected_cost = '30.00', next_billing_date = '2026-10-15' WHERE id = $1",
        [fixture.subscriptionId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const before = await photo(fixture);
    expect(await generate(fixture)).toEqual({ subscriptionsProcessed: 1, paymentsCreated: 0, subscriptionsStillDue: 0 });
    expect(await photo(fixture)).toEqual(before);
    expect(await billingDate(fixture)).toBe('2026-11-15');
    expect(await generate(fixture)).toEqual({ subscriptionsProcessed: 0, paymentsCreated: 0, subscriptionsStillDue: 0 });
    expect(await photo(fixture)).toEqual(before);
  });

  it.each(['confirmed', 'skipped'] as const)('preserves an existing %s payment and its resolved shares', async (status) => {
    const fixture = await createFixture();
    await generate(fixture);
    const stored = await photo(fixture);
    await database.query(
      `UPDATE payment_shares SET status = $2::payment_share_status,
         actual_amount = CASE WHEN $2 = 'confirmed' THEN share_amount ELSE NULL END,
         confirmed_at = CASE WHEN $2 = 'confirmed' THEN NOW() ELSE NULL END
       WHERE payment_id = $1`, [stored.payments[0].id, status],
    );
    await database.query(
      `UPDATE payments SET status = $2::payment_status,
         actual_amount = CASE WHEN $2 = 'confirmed' THEN expected_amount ELSE NULL END, resolved_at = NOW()
       WHERE id = $1`, [stored.payments[0].id, status],
    );
    await database.query("UPDATE subscriptions SET next_billing_date = '2026-10-15' WHERE id = $1", [fixture.subscriptionId]);
    const before = await photo(fixture);
    expect((await generate(fixture)).paymentsCreated).toBe(0);
    expect(await photo(fixture)).toEqual(before);
  });

  it.each(['missing shares', 'wrong amount', 'wrong percentage'] as const)('aborts a conflict with %s without repairing history', async (problem) => {
    const fixture = await createFixture();
    await generate(fixture);
    const stored = await photo(fixture);
    if (problem === 'missing shares') {
      await database.query('DELETE FROM payment_shares WHERE payment_id = $1', [stored.payments[0].id]);
    } else if (problem === 'wrong amount') {
      await database.query("UPDATE payment_shares SET share_amount = '3.35' WHERE id = $1", [stored.shares[0].id]);
    } else {
      await database.query("UPDATE payment_shares SET share_percentage = '20.0000' WHERE id = $1", [stored.shares[0].id]);
    }
    await database.query("UPDATE subscriptions SET next_billing_date = '2026-10-15' WHERE id = $1", [fixture.subscriptionId]);
    const before = await snapshot(fixture);
    await expect(generate(fixture)).rejects.toThrow('Family payment snapshot is inconsistent');
    expect(await snapshot(fixture)).toBe(before);
  });

  it.each(['mismatched owner', 'no active members', 'too many active members'] as const)('rejects a family with %s without advancing its date', async (problem) => {
    const fixture = await createFixture({ count: problem === 'too many active members' ? 21 : 3 });
    if (problem === 'mismatched owner') {
      await database.query('UPDATE groups SET owner_id = $2 WHERE id = $1', [fixture.groupId, fixture.userIds[1]]);
    } else if (problem === 'no active members') {
      await database.query("UPDATE group_members SET role = 'member', status = 'removed' WHERE group_id = $1", [fixture.groupId]);
    }
    const before = await snapshot(fixture);
    await expect(generate(fixture)).rejects.toThrow('Family payment generation requires valid active membership and owner');
    expect(await snapshot(fixture)).toBe(before);
  });

  it('rolls back payment, shares and billing date when a share insert fails', async () => {
    const fixture = await createFixture();
    const before = await snapshot(fixture);
    // NOT VALID leaves older fixture rows alone while enforcing all new inserts.
    // The constraint exists only inside this suite's isolated schema.
    await database.query(`ALTER TABLE payment_shares ADD CONSTRAINT phase5_forced_share_failure
                          CHECK (share_amount <> 3.33) NOT VALID`);
    try {
      await expect(generate(fixture)).rejects.toMatchObject({ code: '23514', constraint: 'phase5_forced_share_failure' });
      expect(await snapshot(fixture)).toBe(before);
    } finally {
      await database.query('ALTER TABLE payment_shares DROP CONSTRAINT phase5_forced_share_failure');
    }
    expect((await generate(fixture)).paymentsCreated).toBe(1);
    expect((await photo(fixture)).shares).toHaveLength(3);
  });

  it.each(['join', 'leave'] as const)('skips a group occupied by a fixture %s and captures its committed membership next time', async (change) => {
    const fixture = await createFixture();
    const newcomer = change === 'join' ? await createUser() : undefined;
    const before = await snapshot(fixture);
    const holder = await database.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [fixture.groupId]);
      if (newcomer) {
        await addMember(holder, fixture, newcomer);
      } else {
        await holder.query("UPDATE group_members SET status = 'removed' WHERE group_id = $1 AND user_id = $2",
          [fixture.groupId, fixture.userIds[1]]);
      }
      expect(await generate(fixture)).toEqual({ subscriptionsProcessed: 0, paymentsCreated: 0, subscriptionsStillDue: 0 });
      expect(await snapshot(fixture)).toBe(before);
      await holder.query('COMMIT');
    } catch (error) {
      await holder.query('ROLLBACK');
      throw error;
    } finally {
      holder.release();
    }
    expect((await generate(fixture)).paymentsCreated).toBe(1);
    const expected = newcomer ? [...fixture.userIds, newcomer] : fixture.userIds.filter((id) => id !== fixture.userIds[1]);
    expect((await photo(fixture)).shares.map((share) => share.user_id)).toEqual(expected.sort());
  });

  it('makes a concurrent join wait for generation and preserves both complete snapshots', async () => {
    const fixture = await createFixture();
    const newcomer = await createUser();
    let holder: PoolClient | undefined;
    let changer: PoolClient | undefined;
    let holding = false;
    let changing = false;
    let generationFinished = false;
    let joinFinished = false;
    let generation: Promise<{ ok: boolean; error?: unknown }> | undefined;
    let join: Promise<{ ok: boolean; error?: unknown }> | undefined;
    try {
      holder = await database.connect();
      await holder.query('BEGIN');
      holding = true;
      await holder.query('LOCK TABLE payment_shares IN SHARE MODE');
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      generation = generate(fixture).then(
        () => { generationFinished = true; return { ok: true }; },
        (error: unknown) => { generationFinished = true; return { ok: false, error }; },
      );
      const generationPid = await waitForBlockedPid(holderPid, () => generationFinished);

      changer = await database.connect();
      await changer.query('BEGIN');
      changing = true;
      const joinClient = changer;
      join = (async () => {
        await joinClient.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [fixture.groupId]);
        await addMember(joinClient, fixture, newcomer);
        await joinClient.query('COMMIT');
        changing = false;
      })().then(
        () => { joinFinished = true; return { ok: true }; },
        (error: unknown) => { joinFinished = true; return { ok: false, error }; },
      );
      await waitForBlockedPid(generationPid, () => joinFinished);
      expect(joinFinished).toBe(false);
      await holder.query('COMMIT');
      holding = false;
      expect(await generation).toEqual({ ok: true });
      expect(await join).toEqual({ ok: true });
      const first = await photo(fixture);
      expect(first.shares.map((share) => share.user_id)).toEqual([...fixture.userIds].sort());

      await generate(fixture, '2026-11-15');
      const both = await photo(fixture);
      expect(both.payments).toHaveLength(2);
      expect(both.shares.filter((share) => share.payment_id === first.payments[0].id)).toEqual(first.shares);
      const nextPayment = both.payments.find((payment) => payment.expected_date === '2026-11-15');
      expect(nextPayment).toBeDefined();
      expect(both.shares.filter((share) => share.payment_id === nextPayment?.id).map((share) => share.user_id))
        .toEqual([...fixture.userIds, newcomer].sort());
    } finally {
      try {
        if (holding && holder) await holder.query('ROLLBACK');
        if (generation) await generation;
        // Let the waiting join finish after the generator released its group lock.
        if (join) await join;
        if (changing && changer) await changer.query('ROLLBACK');
      } finally {
        holder?.release();
        changer?.release();
      }
    }
  }, 15_000);
});
