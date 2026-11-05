import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { isolatedPool } = vi.hoisted(() => ({ isolatedPool: { value: undefined as Pool | undefined } }));
vi.mock('../../db/pool', () => ({
  get pool() {
    if (!isolatedPool.value) throw new Error('Isolated PostgreSQL pool is not ready');
    return isolatedPool.value;
  },
}));

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
type PaymentStatus = 'pending' | 'confirmed' | 'skipped';
type ShareStatus = 'pending' | 'confirmed' | 'skipped';
type MemberStatus = 'active' | 'invited' | 'removed';

type Fixture = {
  ownerId: string;
  groupId: string;
  subscriptionId: string;
  paymentId: string;
};

describeWithDatabase('overdue notifications with isolated PostgreSQL', () => {
  let admin: Pool;
  let database: Pool | undefined;
  let schema = '';
  let schemaCreated = false;
  let sequence = 0;
  let scan: typeof import('./notification-generation.service').runOverdueNotifications;
  const prefix = `phase6-test-${randomUUID()}`;

  beforeAll(async () => {
    const { env } = await import('../../config/env');
    admin = new Pool({ connectionString: env.databaseUrl, max: 2, connectionTimeoutMillis: 5000 });
  });

  beforeEach(async () => {
    schema = `phase6_test_${randomUUID().replaceAll('-', '')}`;
    schemaCreated = false;
    database = undefined;
    if (!/^phase6_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const { env } = await import('../../config/env');
    const isolatedUrl = new URL(env.databaseUrl);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema},pg_catalog`);
    isolatedUrl.searchParams.set('application_name', prefix);
    database = new Pool({
      connectionString: isolatedUrl.toString(), max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000,
    });
    isolatedPool.value = database;
    const client = await database.connect();
    try {
      const current = await client.query<{ name: string }>('SELECT current_schema() AS name');
      if (current.rows[0].name !== schema) throw new Error('Unexpected PostgreSQL search_path');
      await client.query('BEGIN');
      const directory = path.join(__dirname, '../../db/migrations');
      for (const filename of fs.readdirSync(directory).filter((name) => /^00[1-9]_.*\.sql$/.test(name)).sort()) {
        const source = fs.readFileSync(path.join(directory, filename), 'utf8');
        // PostgreSQL 16 supplies gen_random_uuid; do not modify global extensions.
        await client.query(source.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\r?\n/, ''));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    ({ runOverdueNotifications: scan } = await import('./notification-generation.service'));
  });

  async function cleanupSchema(): Promise<void> {
    try {
      if (database) await database.end();
    } finally {
      database = undefined;
      isolatedPool.value = undefined;
      if (schemaCreated) {
        if (!/^phase6_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        const remaining = await admin.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM pg_namespace WHERE nspname = $1', [schema],
        );
        expect(remaining.rows[0].count).toBe('0');
        schemaCreated = false;
      }
    }
  }

  afterEach(cleanupSchema);

  afterAll(async () => {
    try {
      // Also clean a schema if a setup failed before an individual case ran.
      await cleanupSchema();
    } finally {
      if (admin) await admin.end();
    }
  });

  function db(): Pool {
    if (!database) throw new Error('Isolated database is not ready');
    return database;
  }

  async function createUser(): Promise<string> {
    const id = randomUUID();
    sequence += 1;
    await db().query('INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)',
      [id, `${prefix}-${sequence}@example.com`, 'unused-test-hash', prefix]);
    return id;
  }

  async function addMember(groupId: string, status: MemberStatus = 'active'): Promise<string> {
    const id = await createUser();
    await db().query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'member', $3::member_status, NOW())`, [groupId, id, status],
    );
    return id;
  }

  async function addSubscription(groupId: string, active = true, cost = '10.00'): Promise<string> {
    const id = randomUUID();
    await db().query(
      `INSERT INTO subscriptions (id, group_id, name, provider, expected_cost, billing_cycle, next_billing_date, active)
       VALUES ($1, $2, $3, 'Test', $4::numeric, 'monthly', '9999-12-31', $5)`,
      [id, groupId, prefix, cost, active],
    );
    return id;
  }

  async function addPayment(
    subscriptionId: string,
    date = '2026-11-01',
    status: PaymentStatus = 'pending',
    amount = '10.00',
  ): Promise<string> {
    const id = randomUUID();
    await db().query(
      `INSERT INTO payments (id, subscription_id, expected_date, expected_amount, actual_amount, status, price_changed, resolved_at)
       VALUES ($1, $2, $3::date, $4::numeric,
               CASE WHEN $5::text = 'confirmed' THEN $4::numeric ELSE NULL END,
               $5::payment_status, FALSE, CASE WHEN $5::text = 'pending' THEN NULL ELSE NOW() END)`,
      [id, subscriptionId, date, amount, status],
    );
    return id;
  }

  async function addShare(paymentId: string, userId: string, status: ShareStatus = 'pending', amount = '5.00', percentage = '50.0000') {
    const id = randomUUID();
    await db().query(
      `INSERT INTO payment_shares (id, payment_id, user_id, share_amount, share_percentage, status, actual_amount, confirmed_at)
       VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::payment_share_status,
               CASE WHEN $6::text = 'confirmed' THEN $4::numeric ELSE NULL END,
               CASE WHEN $6::text = 'confirmed' THEN NOW() ELSE NULL END)`,
      [id, paymentId, userId, amount, percentage, status],
    );
    return id;
  }

  async function createFixture(options: {
    type?: 'personal' | 'family'; date?: string; active?: boolean; amount?: string; status?: PaymentStatus;
  } = {}): Promise<Fixture> {
    const ownerId = await createUser();
    const groupId = randomUUID();
    await db().query('INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, $3, $4)',
      [groupId, prefix, options.type ?? 'personal', ownerId]);
    await db().query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'owner', 'active', NOW())`, [groupId, ownerId],
    );
    const subscriptionId = await addSubscription(groupId, options.active ?? true, options.amount ?? '10.00');
    const paymentId = await addPayment(subscriptionId, options.date, options.status, options.amount);
    return { ownerId, groupId, subscriptionId, paymentId };
  }

  async function notices(paymentId: string) {
    return (await db().query<{ id: string; user_id: string; type: string; read_at: Date | null }>(
      'SELECT id, user_id, type, read_at FROM notifications WHERE payment_id = $1 ORDER BY type, user_id', [paymentId],
    )).rows;
  }

  async function snapshot(fixture: Fixture): Promise<string> {
    return (await db().query<{ snapshot: string }>(
      `SELECT jsonb_build_object(
         'subscription', (SELECT to_jsonb(s) FROM subscriptions s WHERE s.id = $1),
         'payments', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb)
                      FROM payments p WHERE p.subscription_id = $1),
         'shares', (SELECT COALESCE(jsonb_agg(to_jsonb(ps) ORDER BY ps.id), '[]'::jsonb)
                    FROM payment_shares ps JOIN payments p ON p.id = ps.payment_id WHERE p.subscription_id = $1),
         'notifications', (SELECT COALESCE(jsonb_agg(to_jsonb(n) ORDER BY n.id), '[]'::jsonb)
                           FROM notifications n JOIN payments p ON p.id = n.payment_id WHERE p.subscription_id = $1)
       )::text AS snapshot`, [fixture.subscriptionId],
    )).rows[0].snapshot;
  }

  it.each([
    ['2026-11-01', '2026-11-07', '2026-11-08'],
    ['2024-02-29', '2024-03-06', '2024-03-07'],
  ])('uses calendar dates: %s is not overdue on %s but is on %s', async (date, sixthDay, seventhDay) => {
    const fixture = await createFixture({ date });
    const before = await snapshot(fixture);
    expect(await scan(sixthDay, fixture.subscriptionId)).toEqual({ paymentsProcessed: 0, notificationsCreated: 0 });
    expect(await snapshot(fixture)).toBe(before);
    expect(await scan(seventhDay, fixture.subscriptionId)).toEqual({ paymentsProcessed: 1, notificationsCreated: 1 });
    expect(await notices(fixture.paymentId)).toEqual([expect.objectContaining({ user_id: fixture.ownerId, type: 'payment_overdue', read_at: null })]);
  });

  it('includes an inactive subscription and a zero-valued pending payment without changing it', async () => {
    const fixture = await createFixture({ active: false, amount: '0.00' });
    const paymentBefore = (await db().query('SELECT to_jsonb(p)::text AS value FROM payments p WHERE id = $1', [fixture.paymentId])).rows;
    const subscriptionBefore = (await db().query('SELECT to_jsonb(s)::text AS value FROM subscriptions s WHERE id = $1', [fixture.subscriptionId])).rows;
    expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 1, notificationsCreated: 1 });
    expect((await db().query('SELECT to_jsonb(p)::text AS value FROM payments p WHERE id = $1', [fixture.paymentId])).rows).toEqual(paymentBefore);
    expect((await db().query('SELECT to_jsonb(s)::text AS value FROM subscriptions s WHERE id = $1', [fixture.subscriptionId])).rows).toEqual(subscriptionBefore);
    expect((await notices(fixture.paymentId))[0]).toMatchObject({ user_id: fixture.ownerId, type: 'payment_overdue' });
  });

  it('notifies only active members whose own captured share is pending', async () => {
    const fixture = await createFixture({ type: 'family', amount: '10.02' });
    const activePending = await addMember(fixture.groupId);
    const activeConfirmed = await addMember(fixture.groupId);
    const removed = await addMember(fixture.groupId, 'removed');
    const invited = await addMember(fixture.groupId, 'invited');
    const activeSkipped = await addMember(fixture.groupId);
    const newcomerWithoutShare = await addMember(fixture.groupId);
    await addShare(fixture.paymentId, fixture.ownerId, 'pending', '1.67', '16.6667');
    await addShare(fixture.paymentId, activePending, 'pending', '1.67', '16.6667');
    await addShare(fixture.paymentId, activeConfirmed, 'confirmed', '1.67', '16.6667');
    await addShare(fixture.paymentId, removed, 'pending', '1.67', '16.6667');
    await addShare(fixture.paymentId, invited, 'pending', '1.67', '16.6666');
    // Defensive legacy fixture: normal family skip resolves every share together.
    await addShare(fixture.paymentId, activeSkipped, 'skipped', '1.67', '16.6666');
    const beforeShares = (await db().query('SELECT to_jsonb(ps)::text AS value FROM payment_shares ps WHERE payment_id = $1 ORDER BY id', [fixture.paymentId])).rows;

    expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 1, notificationsCreated: 2 });
    const recipients = (await notices(fixture.paymentId)).map((notice) => notice.user_id).sort();
    expect(recipients).toEqual([fixture.ownerId, activePending].sort());
    expect(recipients).not.toContain(activeConfirmed);
    expect(recipients).not.toContain(removed);
    expect(recipients).not.toContain(invited);
    expect(recipients).not.toContain(activeSkipped);
    expect(recipients).not.toContain(newcomerWithoutShare);
    expect((await db().query('SELECT to_jsonb(ps)::text AS value FROM payment_shares ps WHERE payment_id = $1 ORDER BY id', [fixture.paymentId])).rows).toEqual(beforeShares);
  });

  it('notifies only the missing family recipient and preserves an earlier read notice', async () => {
    const fixture = await createFixture({ type: 'family' });
    const member = await addMember(fixture.groupId);
    await addShare(fixture.paymentId, fixture.ownerId);
    await addShare(fixture.paymentId, member);
    await db().query(
      `INSERT INTO notifications (user_id, payment_id, type, read_at)
       VALUES ($1, $2, 'payment_overdue', '2090-01-02T12:00:00Z')`, [fixture.ownerId, fixture.paymentId],
    );
    const previous = (await notices(fixture.paymentId))[0];

    expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 1, notificationsCreated: 1 });
    const after = await notices(fixture.paymentId);
    expect(after).toHaveLength(2);
    expect(after.find((notice) => notice.user_id === fixture.ownerId)).toEqual(previous);
    expect(after.find((notice) => notice.user_id === member)).toMatchObject({ type: 'payment_overdue', read_at: null });
    expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 0, notificationsCreated: 0 });
    expect(await notices(fixture.paymentId)).toEqual(after);
  });

  it('rechecks a member share confirmed while the group was locked', async () => {
    const fixture = await createFixture({ type: 'family' });
    const member = await addMember(fixture.groupId);
    await addShare(fixture.paymentId, fixture.ownerId);
    const memberShareId = await addShare(fixture.paymentId, member);
    const holder = await db().connect();
    let holding = false;
    try {
      await holder.query('BEGIN');
      holding = true;
      await holder.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [fixture.groupId]);
      await holder.query(
        `UPDATE payment_shares SET status = 'confirmed', actual_amount = share_amount, confirmed_at = NOW()
         WHERE id = $1 AND payment_id = $2 AND user_id = $3`, [memberShareId, fixture.paymentId, member],
      );
      expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 0, notificationsCreated: 0 });
      await holder.query('COMMIT');
      holding = false;

      expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 1, notificationsCreated: 1 });
      expect(await notices(fixture.paymentId)).toEqual([
        expect.objectContaining({ user_id: fixture.ownerId, type: 'payment_overdue', read_at: null }),
      ]);
      expect((await db().query('SELECT status FROM payments WHERE id = $1', [fixture.paymentId])).rows)
        .toEqual([{ status: 'pending' }]);
      expect((await db().query('SELECT status FROM payment_shares WHERE id = $1', [memberShareId])).rows)
        .toEqual([{ status: 'confirmed' }]);
    } finally {
      try {
        if (holding) await holder.query('ROLLBACK');
      } finally {
        holder.release();
      }
    }
  });

  it.each(['confirmed', 'skipped'] as const)('does not notify a %s parent payment', async (status) => {
    const fixture = await createFixture({ status });
    expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 0, notificationsCreated: 0 });
    expect(await notices(fixture.paymentId)).toEqual([]);
  });

  it('does not notify a personal group without a matching active owner', async () => {
    const fixture = await createFixture();
    await db().query("UPDATE group_members SET role = 'member', status = 'removed' WHERE group_id = $1 AND user_id = $2",
      [fixture.groupId, fixture.ownerId]);
    expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 0, notificationsCreated: 0 });
    expect(await notices(fixture.paymentId)).toEqual([]);
  });

  it('does not duplicate a read overdue notice or modify other types on retry', async () => {
    const fixture = await createFixture();
    await db().query(
      "INSERT INTO notifications (user_id, payment_id, type) VALUES ($1, $2, 'payment_due')",
      [fixture.ownerId, fixture.paymentId],
    );
    expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 1, notificationsCreated: 1 });
    await db().query(
      "UPDATE notifications SET read_at = '2090-01-02T12:00:00Z' WHERE payment_id = $1 AND type = 'payment_overdue'",
      [fixture.paymentId],
    );
    const before = await notices(fixture.paymentId);
    expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 0, notificationsCreated: 0 });
    expect(await notices(fixture.paymentId)).toEqual(before);
    expect(before.find((notice) => notice.type === 'payment_overdue')?.read_at?.toISOString()).toBe('2090-01-02T12:00:00.000Z');
  });

  it('limits the scan to the requested subscription, including within the same group', async () => {
    const target = await createFixture();
    const siblingSubscription = await addSubscription(target.groupId);
    const siblingPayment = await addPayment(siblingSubscription);
    const other = await createFixture();
    const otherBefore = await snapshot(other);
    expect(await scan('2026-11-08', target.subscriptionId)).toEqual({ paymentsProcessed: 1, notificationsCreated: 1 });
    expect(await notices(target.paymentId)).toHaveLength(1);
    expect(await notices(siblingPayment)).toEqual([]);
    expect(await snapshot(other)).toBe(otherBefore);
  });

  it.each(['tomorrow', '2026-02-30', '2026-2-01'])('rejects invalid date %s without changes', async (today) => {
    const fixture = await createFixture();
    const before = await snapshot(fixture);
    await expect(scan(today, fixture.subscriptionId)).rejects.toThrow();
    expect(await snapshot(fixture)).toBe(before);
  });

  it('skips the locked group while another detector run is still inserting', async () => {
    const fixture = await createFixture();
    const holder = await db().connect();
    let holding = false;
    let finished = false;
    let first: Promise<{ ok: true; result: { paymentsProcessed: number; notificationsCreated: number } } | { ok: false; error: unknown }> | undefined;
    try {
      await holder.query('BEGIN');
      holding = true;
      // SHARE permits the detector's reads but blocks its notification INSERT.
      await holder.query('LOCK TABLE notifications IN SHARE MODE');
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      first = scan('2026-11-08', fixture.subscriptionId).then(
        (result) => { finished = true; return { ok: true as const, result }; },
        (error: unknown) => { finished = true; return { ok: false as const, error }; },
      );
      let waiting = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const blocked = await db().query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                          WHERE application_name = $1 AND wait_event_type = 'Lock'
                            AND $2::integer = ANY(pg_blocking_pids(pid))) AS waiting`,
          [prefix, holderPid],
        );
        if (blocked.rows[0].waiting) {
          waiting = true;
          break;
        }
        if (finished) break;
        await delay(10);
      }
      expect(waiting).toBe(true);
      expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 0, notificationsCreated: 0 });
      await holder.query('COMMIT');
      holding = false;
      expect(await first).toEqual({ ok: true, result: { paymentsProcessed: 1, notificationsCreated: 1 } });
      expect(await notices(fixture.paymentId)).toEqual([expect.objectContaining({ user_id: fixture.ownerId, type: 'payment_overdue' })]);
    } finally {
      try {
        if (holding) await holder.query('ROLLBACK');
        if (first) await first;
      } finally {
        holder.release();
      }
    }
  }, 15000);

  it.each(['confirmed', 'skipped'] as const)(
    'skips a locked group and rechecks a payment %s before the next run', async (status) => {
      const fixture = await createFixture();
      const holder = await db().connect();
      let holding = false;
      try {
        await holder.query('BEGIN');
        holding = true;
        await holder.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [fixture.groupId]);
        await holder.query(
          `UPDATE payments SET status = $2::payment_status,
             actual_amount = CASE WHEN $2::text = 'confirmed' THEN expected_amount ELSE NULL END,
             resolved_at = NOW(), price_changed = FALSE WHERE id = $1`, [fixture.paymentId, status],
        );
        expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 0, notificationsCreated: 0 });
        await holder.query('COMMIT');
        holding = false;
        expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 0, notificationsCreated: 0 });
        expect(await notices(fixture.paymentId)).toEqual([]);
      } finally {
        try {
          if (holding) await holder.query('ROLLBACK');
        } finally {
          holder.release();
        }
      }
    },
  );

  it('skips a locked group and uses the active membership after it commits', async () => {
    const fixture = await createFixture({ type: 'family' });
    const member = await addMember(fixture.groupId);
    await addShare(fixture.paymentId, fixture.ownerId);
    await addShare(fixture.paymentId, member);
    const holder = await db().connect();
    let holding = false;
    try {
      await holder.query('BEGIN');
      holding = true;
      await holder.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [fixture.groupId]);
      // Defensive fixture: a legacy/externally changed membership can be removed
      // even though application services normally block leaving with a pending share.
      await holder.query("UPDATE group_members SET status = 'removed' WHERE group_id = $1 AND user_id = $2", [fixture.groupId, member]);
      expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 0, notificationsCreated: 0 });
      await holder.query('COMMIT');
      holding = false;
      expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 1, notificationsCreated: 1 });
      expect((await notices(fixture.paymentId)).map((notice) => notice.user_id)).toEqual([fixture.ownerId]);
    } finally {
      try {
        if (holding) await holder.query('ROLLBACK');
      } finally {
        holder.release();
      }
    }
  });

  it('rolls back the whole batch if a later notice fails', async () => {
    const fixture = await createFixture({ date: '2026-10-01' });
    const laterId = await addPayment(fixture.subscriptionId, '2026-10-02');
    const before = await snapshot(fixture);
    if (!/^[0-9a-f-]{36}$/.test(laterId)) throw new Error('Unsafe fixture UUID');
    // The CHECK is installed only in this test's private schema.
    await db().query(`ALTER TABLE notifications ADD CONSTRAINT phase6_reject_later_notice
                      CHECK (payment_id <> '${laterId}'::uuid OR type <> 'payment_overdue'::notification_type) NOT VALID`);
    try {
      await expect(scan('2026-11-08', fixture.subscriptionId))
        .rejects.toMatchObject({ code: '23514', constraint: 'phase6_reject_later_notice' });
      expect(await snapshot(fixture)).toBe(before);
    } finally {
      await db().query('ALTER TABLE notifications DROP CONSTRAINT phase6_reject_later_notice');
    }
    expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 2, notificationsCreated: 2 });
  });

  it('advances beyond 200 already-notified payments and respects the 200-payment budget', async () => {
    const fixture = await createFixture({ date: '2020-01-01' });
    await db().query(
      `INSERT INTO payments (subscription_id, expected_date, expected_amount)
       SELECT $1, DATE '2020-01-01' + value, '10.00' FROM generate_series(1, 404) AS value`,
      [fixture.subscriptionId],
    );
    await db().query(
      `INSERT INTO notifications (user_id, payment_id, type)
       SELECT $2::uuid, p.id, 'payment_overdue'::notification_type
       FROM payments p WHERE p.subscription_id = $1 ORDER BY p.expected_date LIMIT 200`,
      [fixture.subscriptionId, fixture.ownerId],
    );
    expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 200, notificationsCreated: 200 });
    expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 5, notificationsCreated: 5 });
    expect(await scan('2026-11-08', fixture.subscriptionId)).toEqual({ paymentsProcessed: 0, notificationsCreated: 0 });
    expect((await db().query('SELECT COUNT(*)::integer AS count FROM notifications')).rows[0].count).toBe(405);
  }, 15000);

  it('continues after the 100-group budget in an isolated schema', async () => {
    const owner = await createUser();
    const groups = Array.from({ length: 101 }, () => randomUUID());
    const subscriptions = Array.from({ length: 101 }, () => randomUUID());
    const payments = Array.from({ length: 101 }, () => randomUUID());
    await db().query(
      `INSERT INTO groups (id, name, type, owner_id)
       SELECT id, $2, 'family'::group_type, $3::uuid FROM UNNEST($1::uuid[]) AS ids(id)`, [groups, prefix, owner],
    );
    await db().query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       SELECT id, $2::uuid, 'owner', 'active', NOW() FROM UNNEST($1::uuid[]) AS ids(id)`, [groups, owner],
    );
    await db().query(
      `INSERT INTO subscriptions (id, group_id, name, provider, expected_cost, billing_cycle, next_billing_date)
       SELECT subscription_id, group_id, $3, 'Test', '1.00', 'monthly', '9999-12-31'::date
       FROM UNNEST($1::uuid[], $2::uuid[]) AS ids(subscription_id, group_id)`, [subscriptions, groups, prefix],
    );
    await db().query(
      `INSERT INTO payments (id, subscription_id, expected_date, expected_amount)
       SELECT payment_id, subscription_id, '2026-11-01'::date, '1.00'
       FROM UNNEST($1::uuid[], $2::uuid[]) AS ids(payment_id, subscription_id)`, [payments, subscriptions],
    );
    await db().query(
      `INSERT INTO payment_shares (payment_id, user_id, share_amount, share_percentage)
       SELECT id, $2::uuid, '1.00', '100.0000' FROM UNNEST($1::uuid[]) AS ids(id)`, [payments, owner],
    );
    // The unfiltered scan is safe here because the pool is restricted to this
    // test's isolated schema; it must never target public in a test.
    expect(await scan('2026-11-08')).toEqual({ paymentsProcessed: 100, notificationsCreated: 100 });
    expect(await scan('2026-11-08')).toEqual({ paymentsProcessed: 1, notificationsCreated: 1 });
    expect(await scan('2026-11-08')).toEqual({ paymentsProcessed: 0, notificationsCreated: 0 });
  }, 15000);
});
