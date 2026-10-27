import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

type Fixture = {
  ownerId: string;
  memberId: string;
  groupId: string;
  subscriptionId: string;
  emptySubscriptionId: string;
  paymentId: string;
};

describeWithDatabase('group writes and permission changes with PostgreSQL', () => {
  let database: Pool;
  let subscriptions: typeof import('../subscriptions/subscription.service');
  let payments: typeof import('../payments/payment.service');
  const prefix = `phase5-test-${randomUUID()}`;
  const fixtures: Fixture[] = [];
  const allGroupIds: string[] = [];
  const allUserIds: string[] = [];

  beforeAll(async () => {
    database = (await import('../../db/pool')).pool;
    const migration = await database.query(
      'SELECT filename FROM schema_migrations WHERE filename = $1', ['008_create_payment_shares.sql'],
    );
    if (migration.rowCount !== 1) throw new Error('Apply migration 008 before running group write tests');
    subscriptions = await import('../subscriptions/subscription.service');
    payments = await import('../payments/payment.service');
  });

  async function createFixture(type: 'family' | 'personal' = 'family'): Promise<Fixture> {
    const fixture: Fixture = {
      ownerId: randomUUID(), memberId: randomUUID(), groupId: randomUUID(),
      subscriptionId: randomUUID(), emptySubscriptionId: randomUUID(), paymentId: randomUUID(),
    };
    // Register UUIDs before inserting so even partially created fixtures are cleaned.
    fixtures.push(fixture);
    allGroupIds.push(fixture.groupId);
    allUserIds.push(fixture.ownerId, fixture.memberId);
    for (const [id, name] of [[fixture.ownerId, 'owner'], [fixture.memberId, 'member']]) {
      await database.query(
        'INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)',
        [id, `${prefix}-${id}@example.com`, 'unused-test-hash', `${prefix}-${name}`],
      );
    }
    await database.query(
      'INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, $3, $4)',
      [fixture.groupId, prefix, type, fixture.ownerId],
    );
    for (const [userId, role] of [[fixture.ownerId, 'owner'], [fixture.memberId, 'member']]) {
      await database.query(
        `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
         VALUES ($1, $2, $3, 'active', NOW())`, [fixture.groupId, userId, role],
      );
    }
    for (const id of [fixture.subscriptionId, fixture.emptySubscriptionId]) {
      await database.query(
        `INSERT INTO subscriptions (
           id, group_id, name, provider, expected_cost, billing_cycle,
           next_billing_date, billing_anchor_day, active
         ) VALUES ($1, $2, $3, 'Test', '10.00', 'monthly', '9999-12-31', 31, FALSE)`,
        [id, fixture.groupId, prefix],
      );
    }
    await database.query(
      `INSERT INTO payments (id, subscription_id, expected_date, expected_amount)
       VALUES ($1, $2, '2090-01-01', '10.00')`, [fixture.paymentId, fixture.subscriptionId],
    );
    return fixture;
  }

  async function cleanupFixtures(): Promise<void> {
    while (fixtures.length > 0) {
      const fixture = fixtures[fixtures.length - 1];
      await database.query(
        `DELETE FROM payment_shares WHERE payment_id IN (
           SELECT p.id FROM payments p JOIN subscriptions s ON s.id = p.subscription_id
           WHERE s.group_id = $1
         )`, [fixture.groupId],
      );
      await database.query(
        'DELETE FROM payments WHERE subscription_id IN (SELECT id FROM subscriptions WHERE group_id = $1)',
        [fixture.groupId],
      );
      await database.query('DELETE FROM subscriptions WHERE group_id = $1', [fixture.groupId]);
      await database.query('DELETE FROM group_members WHERE group_id = $1', [fixture.groupId]);
      await database.query('DELETE FROM groups WHERE id = $1', [fixture.groupId]);
      await database.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[fixture.ownerId, fixture.memberId]]);
      fixtures.pop();
    }
  }

  afterEach(async () => {
    if (database) await cleanupFixtures();
  });

  afterAll(async () => {
    if (!database) return;
    try {
      await cleanupFixtures();
      const remaining = await database.query<{ count: string }>(
        `SELECT (
           (SELECT COUNT(*) FROM groups WHERE id = ANY($1::uuid[])) +
           (SELECT COUNT(*) FROM group_members WHERE group_id = ANY($1::uuid[])) +
           (SELECT COUNT(*) FROM subscriptions WHERE group_id = ANY($1::uuid[])) +
           (SELECT COUNT(*) FROM users WHERE id = ANY($2::uuid[]))
         )::text AS count`, [allGroupIds, allUserIds],
      );
      expect(remaining.rows[0].count).toBe('0');
    } finally {
      await database.end();
    }
  });

  async function snapshot(fixture: Fixture): Promise<string> {
    const result = await database.query<{ snapshot: string }>(
      `SELECT jsonb_build_object(
         'subscriptions', (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb)
                           FROM subscriptions s WHERE s.group_id = $1),
         'payments', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb)
                      FROM payments p JOIN subscriptions s ON s.id = p.subscription_id WHERE s.group_id = $1),
         'shares', (SELECT COALESCE(jsonb_agg(to_jsonb(ps) ORDER BY ps.id), '[]'::jsonb)
                    FROM payment_shares ps JOIN payments p ON p.id = ps.payment_id
                    JOIN subscriptions s ON s.id = p.subscription_id WHERE s.group_id = $1)
       )::text AS snapshot`, [fixture.groupId],
    );
    return result.rows[0].snapshot;
  }

  async function waitForGroupLock(holderPid: number, finished: () => boolean): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const result = await database.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND $1::integer = ANY(pg_blocking_pids(pid))
         ) AS waiting`, [holderPid],
      );
      if (result.rows[0].waiting) return;
      if (finished()) throw new Error('Write finished before waiting for its fixture group lock');
      // This only spaces observations; pg_blocking_pids supplies the proof of waiting.
      await delay(10);
    }
    throw new Error('Write did not wait for its fixture group lock');
  }

  const writes = [
    ['create subscription', (fixture: Fixture) => subscriptions.createSubscription(fixture.ownerId, fixture.groupId, {
      name: `${prefix}-new`, provider: 'Test', expectedCost: '19.99',
      billingCycle: 'monthly', nextBillingDate: '9999-12-31',
    })],
    ['update subscription', (fixture: Fixture) => subscriptions.updateSubscription(
      fixture.ownerId, fixture.groupId, fixture.subscriptionId, { expectedCost: '19.99' },
    )],
    ['delete subscription', (fixture: Fixture) => subscriptions.deleteSubscription(
      fixture.ownerId, fixture.groupId, fixture.emptySubscriptionId,
    )],
    ['confirm payment', (fixture: Fixture) => payments.confirmPayment(fixture.ownerId, fixture.groupId, fixture.paymentId)],
    ['skip payment', (fixture: Fixture) => payments.skipPayment(fixture.ownerId, fixture.groupId, fixture.paymentId)],
  ] as const;

  describe.each(['member', 'removed'] as const)('owner becomes %s while a write waits', (newState) => {
    it.each(writes)('revalidates permission before %s', async (_operation, write) => {
      const fixture = await createFixture();
      const before = await snapshot(fixture);
      let holder: PoolClient | undefined;
      let holding = false;
      let finished = false;
      let attempted: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
      try {
        holder = await database.connect();
        await holder.query('BEGIN');
        holding = true;
        await holder.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [fixture.groupId]);
        const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        // Handle rejection immediately, including when an assertion fails before COMMIT.
        attempted = write(fixture).then(
          () => { finished = true; return { ok: true as const }; },
          (error: unknown) => { finished = true; return { ok: false as const, error }; },
        );
        await waitForGroupLock(pid, () => finished);
        expect(finished).toBe(false);

        // Fixture SQL simulates a committed future transfer; no transfer API is introduced.
        await holder.query(
          "UPDATE group_members SET role = 'member', status = $3 WHERE group_id = $1 AND user_id = $2",
          [fixture.groupId, fixture.ownerId, newState === 'removed' ? 'removed' : 'active'],
        );
        await holder.query(
          "UPDATE group_members SET role = 'owner' WHERE group_id = $1 AND user_id = $2",
          [fixture.groupId, fixture.memberId],
        );
        await holder.query('UPDATE groups SET owner_id = $2 WHERE id = $1', [fixture.groupId, fixture.memberId]);
        await holder.query('COMMIT');
        holding = false;

        expect(await attempted).toMatchObject({ ok: false, error: { status: 403, message: 'Forbidden' } });
        expect(await snapshot(fixture)).toBe(before);
      } finally {
        try {
          if (holding && holder) await holder.query('ROLLBACK');
        } finally {
          holder?.release();
          if (attempted) await attempted;
        }
      }
    }, 15_000);
  });

  const resolutions = [
    ['confirm', (userId: string, groupId: string, paymentId: string) => payments.confirmPayment(userId, groupId, paymentId)],
    ['skip', (userId: string, groupId: string, paymentId: string) => payments.skipPayment(userId, groupId, paymentId)],
  ] as const;

  describe.each(['no shares', 'pending shares', 'partially confirmed shares'] as const)('family parent with %s', (state) => {
    it.each(resolutions)('enforces the family rule for %s', async (operation, resolve) => {
      const fixture = await createFixture();
      if (state !== 'no shares') {
        const partial = state === 'partially confirmed shares';
        await database.query(
          `INSERT INTO payment_shares (
             payment_id, user_id, share_amount, share_percentage, status, actual_amount, confirmed_at
           ) VALUES ($1, $2, '5.00', '50.0000', $4::payment_share_status,
                     CASE WHEN $4 = 'confirmed' THEN 5.25 ELSE NULL END,
                     CASE WHEN $4 = 'confirmed' THEN '2090-01-02T12:00:00Z'::timestamptz ELSE NULL END),
                    ($1, $3, '5.00', '50.0000', 'pending', NULL, NULL)`,
          [fixture.paymentId, fixture.ownerId, fixture.memberId, partial ? 'confirmed' : 'pending'],
        );
      }
      const before = await snapshot(fixture);
      if (state === 'pending shares' && operation === 'skip') {
        const result = await resolve(fixture.ownerId, fixture.groupId, fixture.paymentId);
        expect(result).toMatchObject({ status: 'skipped', actualAmount: null, priceChanged: false });
        expect(result.resolvedAt).not.toBeNull();
        const shares = await database.query(
          'SELECT status, actual_amount, confirmed_at FROM payment_shares WHERE payment_id = $1',
          [fixture.paymentId],
        );
        expect(shares.rows).toHaveLength(2);
        expect(shares.rows.every((row) => row.status === 'skipped' && row.actual_amount === null && row.confirmed_at === null)).toBe(true);
      } else {
        await expect(resolve(fixture.ownerId, fixture.groupId, fixture.paymentId)).rejects.toMatchObject({ status: 409 });
        expect(await snapshot(fixture)).toBe(before);
      }
    });
  });

  it.each(resolutions)('keeps 404 for missing and foreign payments before the family %s guard', async (_operation, resolve) => {
    const fixture = await createFixture();
    const foreign = await createFixture('personal');
    const before = await snapshot(foreign);
    await expect(resolve(fixture.ownerId, fixture.groupId, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(resolve(fixture.ownerId, fixture.groupId, foreign.paymentId)).rejects.toMatchObject({ status: 404 });
    expect(await snapshot(foreign)).toBe(before);
  });

  describe.each(['active', 'removed'] as const)('family member status %s', (status) => {
    it.each(resolutions)('keeps 403 before the family %s guard', async (_operation, resolve) => {
      const fixture = await createFixture();
      await database.query('UPDATE group_members SET status = $3 WHERE group_id = $1 AND user_id = $2',
        [fixture.groupId, fixture.memberId, status]);
      const before = await snapshot(fixture);
      await expect(resolve(fixture.memberId, fixture.groupId, fixture.paymentId)).rejects.toMatchObject({ status: 403 });
      expect(await snapshot(fixture)).toBe(before);
    });
  });

  it('releases the group lock and rolls back a rejected personal confirmation', async () => {
    const fixture = await createFixture('personal');
    const before = await snapshot(fixture);
    await expect(payments.confirmPayment(fixture.ownerId, fixture.groupId, fixture.paymentId, '-1')).rejects.toMatchObject({ code: '23514' });
    expect(await snapshot(fixture)).toBe(before);
    const observer = await database.connect();
    try {
      await observer.query('BEGIN');
      await observer.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE NOWAIT', [fixture.groupId]);
      await observer.query('COMMIT');
    } catch (error) {
      await observer.query('ROLLBACK');
      throw error;
    } finally {
      observer.release();
    }
    expect((await payments.confirmPayment(fixture.ownerId, fixture.groupId, fixture.paymentId)).status).toBe('confirmed');
  });
});
