import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PaymentShare, PaymentShareSummary } from './payment-share.types';
import type { Payment } from './payment.types';

const { isolatedPool } = vi.hoisted(() => ({ isolatedPool: { value: undefined as Pool | undefined } }));
vi.mock('../../db/pool', () => ({
  get pool() {
    if (!isolatedPool.value) throw new Error('Isolated PostgreSQL pool is not ready');
    return isolatedPool.value;
  },
}));

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
type Confirmation = { share: PaymentShare; payment: Payment; summary: PaymentShareSummary };
type Fixture = {
  groupId: string;
  subscriptionId: string;
  paymentId: string;
  userIds: string[];
  shareIds: string[];
  outsiderId: string;
};

describeWithDatabase('own payment share confirmation with real PostgreSQL and HTTP', () => {
  const schema = `phase5_test_${randomUUID().replaceAll('-', '')}`;
  const prefix = `phase5-test-${randomUUID()}`;
  let admin: Pool;
  let database: Pool;
  let schemaCreated = false;
  let shares: typeof import('./payment-share.service');
  let signAccessToken: typeof import('../auth/auth.tokens').signAccessToken;
  let server: Server | undefined;
  let baseUrl: string;

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
      const current = await client.query<{ name: string }>('SELECT current_schema() AS name');
      if (current.rows[0].name !== schema) throw new Error('Unexpected PostgreSQL search_path');
      await client.query('BEGIN');
      const directory = path.join(__dirname, '../../db/migrations');
      for (const filename of fs.readdirSync(directory).filter((name) => /^00[1-8]_.*\.sql$/.test(name)).sort()) {
        const source = fs.readFileSync(path.join(directory, filename), 'utf8');
        // PostgreSQL 16 supplies gen_random_uuid; do not change global extensions.
        await client.query(source.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\r?\n/, ''));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    shares = await import('./payment-share.service');
    ({ signAccessToken } = await import('../auth/auth.tokens'));
    const { app } = await import('../../app');
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server?.once('listening', resolve);
      server?.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing confirmation HTTP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    try {
      if (server) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    } finally {
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
    }
  });

  async function createFixture(options: {
    type?: 'family' | 'personal'; count?: 1 | 2 | 3; amount?: string; shareAmounts?: string[];
  } = {}): Promise<Fixture> {
    const type = options.type ?? 'family';
    const count = options.count ?? (type === 'personal' ? 1 : 2);
    const fixture: Fixture = {
      groupId: randomUUID(), subscriptionId: randomUUID(), paymentId: randomUUID(),
      userIds: Array.from({ length: count }, () => randomUUID()),
      shareIds: Array.from({ length: count }, () => randomUUID()), outsiderId: randomUUID(),
    };
    const ids = [...fixture.userIds, fixture.outsiderId];
    await database.query(
      `INSERT INTO users (id, email, password_hash, name)
       SELECT id, email, 'unused-test-hash', $3 FROM UNNEST($1::uuid[], $2::text[]) fixture(id, email)`,
      [ids, ids.map((id) => `${prefix}-${id}@example.com`), prefix],
    );
    await database.query('INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, $3, $4)',
      [fixture.groupId, prefix, type, fixture.userIds[0]]);
    await database.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       SELECT $1::uuid, user_id, role, 'active'::member_status, NOW()
       FROM UNNEST($2::uuid[], $3::member_role[]) fixture(user_id, role)`,
      [fixture.groupId, fixture.userIds, fixture.userIds.map((_id, index) => index === 0 ? 'owner' : 'member')],
    );
    await database.query(
      `INSERT INTO subscriptions (
         id, group_id, name, provider, expected_cost, billing_cycle, next_billing_date, billing_anchor_day, active
       ) VALUES ($1, $2, $3, 'Test', $4, 'monthly', '9999-12-31', 31, FALSE)`,
      [fixture.subscriptionId, fixture.groupId, prefix, options.amount ?? '0.30'],
    );
    await database.query(
      `INSERT INTO payments (id, subscription_id, expected_date, expected_amount)
       VALUES ($1, $2, '2090-01-01', $3)`, [fixture.paymentId, fixture.subscriptionId, options.amount ?? '0.30'],
    );
    if (type === 'family') {
      const amounts = options.shareAmounts ?? Array.from({ length: count }, () => count === 1 ? '0.30' : count === 2 ? '0.15' : '0.10');
      const sortedUsers = [...fixture.userIds].sort();
      await database.query(
        `INSERT INTO payment_shares (id, payment_id, user_id, share_amount, share_percentage)
         SELECT id, $2::uuid, user_id, amount, percentage
         FROM UNNEST($1::uuid[], $3::uuid[], $4::numeric[], $5::numeric[]) fixture(id, user_id, amount, percentage)`,
        [fixture.shareIds, fixture.paymentId, fixture.userIds, amounts, fixture.userIds.map((id) => (
          count === 1 ? '100.0000' : count === 2 ? '50.0000' : sortedUsers[0] === id ? '33.3334' : '33.3333'
        ))],
      );
    }
    return fixture;
  }

  const confirm = (fixture: Fixture, index: number, amount?: string) => shares.confirmPaymentShare(
    fixture.userIds[index], fixture.groupId, fixture.paymentId, fixture.shareIds[index], amount,
  );

  async function snapshot(fixture: Fixture): Promise<string> {
    return (await database.query<{ snapshot: string }>(
      `SELECT jsonb_build_object(
         'subscription', (SELECT to_jsonb(s) FROM subscriptions s WHERE s.id = $1),
         'payment', (SELECT to_jsonb(p) FROM payments p WHERE p.id = $2),
         'shares', (SELECT COALESCE(jsonb_agg(to_jsonb(ps) ORDER BY ps.id), '[]'::jsonb)
                    FROM payment_shares ps WHERE ps.payment_id = $2)
       )::text AS snapshot`, [fixture.subscriptionId, fixture.paymentId],
    )).rows[0].snapshot;
  }

  async function request<T>(pathname: string, userId: string, body: object = {}): Promise<{ status: number; body: T }> {
    const token = signAccessToken({ id: userId, email: `${prefix}-${userId}@example.com` });
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: await response.json() as T };
  }

  const confirmPath = (fixture: Fixture, index: number) => (
    `/groups/${fixture.groupId}/payments/${fixture.paymentId}/shares/${fixture.shareIds[index]}/confirm`
  );

  async function waitForGroupLock(holderPid: number, finished: () => boolean): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const result = await database.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'
             AND $2::integer = ANY(pg_blocking_pids(pid))
         ) AS waiting`, [prefix, holderPid],
      );
      if (result.rows[0].waiting) return;
      if (finished()) throw new Error('Confirmation finished before its fixture group lock wait');
      // pg_blocking_pids proves waiting; this delay only spaces observations.
      await delay(10);
    }
    throw new Error('Confirmation did not wait for its fixture group lock');
  }

  it('uses captured quotas for owner and member even after the subscription cost changes', async () => {
    const fixture = await createFixture();
    await database.query("UPDATE subscriptions SET expected_cost = '9.99' WHERE id = $1", [fixture.subscriptionId]);
    const first = await confirm(fixture, 0);
    expect(first.share).toMatchObject({ shareAmount: '0.15', actualAmount: '0.15', status: 'confirmed' });
    expect(first.payment).toMatchObject({ expectedAmount: '0.30', status: 'pending', actualAmount: null, resolvedAt: null, priceChanged: false });
    expect(first.summary).toEqual({ totalShares: 2, confirmedShares: 1, confirmedAmount: '0.15' });
    const last = await confirm(fixture, 1);
    expect(last.payment).toMatchObject({ expectedAmount: '0.30', actualAmount: '0.30', status: 'confirmed', priceChanged: false });
    expect(new Date(last.payment.resolvedAt ?? '').toISOString()).toBe(last.payment.resolvedAt);
    expect((await database.query('SELECT expected_cost FROM subscriptions WHERE id = $1', [fixture.subscriptionId])).rows)
      .toEqual([{ expected_cost: '9.99' }]);
  });

  it.each(['0.00', '0.25'])('registers corrected amount %s while preserving the expected quota', async (amount) => {
    const fixture = await createFixture({ count: 1 });
    const result = await confirm(fixture, 0, amount);
    expect(result.share).toMatchObject({ userId: fixture.userIds[0], shareAmount: '0.30', actualAmount: amount, status: 'confirmed' });
    expect(new Date(result.share.confirmedAt ?? '').toISOString()).toBe(result.share.confirmedAt);
    expect(result.payment).toMatchObject({ status: 'confirmed', expectedAmount: '0.30', actualAmount: amount, priceChanged: true });
    expect(result.summary).toEqual({ totalShares: 1, confirmedShares: 1, confirmedAmount: amount });
  });

  it('still requires and accepts confirmation of a zero quota', async () => {
    const fixture = await createFixture({ count: 1, amount: '0.00', shareAmounts: ['0.00'] });
    expect((await shares.getPaymentShares(fixture.userIds[0], fixture.groupId, fixture.paymentId)).payment.status).toBe('pending');
    const result = await confirm(fixture, 0);
    expect(result.share).toMatchObject({ shareAmount: '0.00', actualAmount: '0.00', status: 'confirmed' });
    expect(result.payment).toMatchObject({ actualAmount: '0.00', status: 'confirmed', priceChanged: false });
  });

  it('keeps the partial parent unresolved and closes the exact sum of 0.10 and 0.20', async () => {
    const fixture = await createFixture();
    const first = await confirm(fixture, 0, '0.1');
    expect(first.share.actualAmount).toBe('0.10');
    expect(first.payment).toMatchObject({ status: 'pending', actualAmount: null, resolvedAt: null, priceChanged: false });
    const last = await confirm(fixture, 1, '0.2');
    expect(last.share.actualAmount).toBe('0.20');
    expect(last.payment).toMatchObject({ expectedDate: '2090-01-01', actualAmount: '0.30', status: 'confirmed', priceChanged: false });
    expect(last.summary).toEqual({ totalShares: 2, confirmedShares: 2, confirmedAmount: '0.30' });
  });

  it('denies another person share to owner and member before checking whether it is resolved', async () => {
    const fixture = await createFixture();
    const before = await snapshot(fixture);
    await expect(shares.confirmPaymentShare(fixture.userIds[0], fixture.groupId, fixture.paymentId, fixture.shareIds[1]))
      .rejects.toMatchObject({ status: 403 });
    await expect(shares.confirmPaymentShare(fixture.userIds[1], fixture.groupId, fixture.paymentId, fixture.shareIds[0]))
      .rejects.toMatchObject({ status: 403 });
    expect(await snapshot(fixture)).toBe(before);
    await confirm(fixture, 1);
    const resolved = await snapshot(fixture);
    await expect(shares.confirmPaymentShare(fixture.userIds[0], fixture.groupId, fixture.paymentId, fixture.shareIds[1]))
      .rejects.toMatchObject({ status: 403 });
    expect(await snapshot(fixture)).toBe(resolved);
  });

  it.each(['outsider', 'invited', 'removed', 'missing group'] as const)('denies %s without changing a share', async (condition) => {
    const fixture = await createFixture();
    let userId = fixture.userIds[1];
    let groupId = fixture.groupId;
    if (condition === 'outsider') userId = fixture.outsiderId;
    if (condition === 'missing group') groupId = randomUUID();
    if (condition === 'invited' || condition === 'removed') {
      await database.query('UPDATE group_members SET status = $3 WHERE group_id = $1 AND user_id = $2',
        [groupId, userId, condition]);
    }
    const before = await snapshot(fixture);
    await expect(shares.confirmPaymentShare(userId, groupId, fixture.paymentId, fixture.shareIds[1])).rejects.toMatchObject({ status: 403 });
    expect(await snapshot(fixture)).toBe(before);
  });

  it('rejects share confirmation in an authorized personal group', async () => {
    const fixture = await createFixture({ type: 'personal' });
    const before = await snapshot(fixture);
    await expect(confirm(fixture, 0)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(fixture)).toBe(before);
  });

  it('scopes the parent and share to both the authorized group and requested payment', async () => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    const siblingPaymentId = randomUUID();
    const siblingShareId = randomUUID();
    await database.query(
      `INSERT INTO payments (id, subscription_id, expected_date, expected_amount)
       VALUES ($1, $2, '2090-02-01', '0.30')`, [siblingPaymentId, fixture.subscriptionId],
    );
    await database.query(
      `INSERT INTO payment_shares (id, payment_id, user_id, share_amount, share_percentage)
       VALUES ($1, $2, $3, '0.30', '100.0000')`, [siblingShareId, siblingPaymentId, fixture.userIds[0]],
    );
    const before = await snapshot(fixture);
    for (const [paymentId, shareId] of [
      [randomUUID(), fixture.shareIds[0]], [foreign.paymentId, foreign.shareIds[0]],
      [fixture.paymentId, randomUUID()], [fixture.paymentId, foreign.shareIds[0]], [fixture.paymentId, siblingShareId],
    ]) {
      await expect(shares.confirmPaymentShare(fixture.userIds[0], fixture.groupId, paymentId, shareId)).rejects.toMatchObject({ status: 404 });
    }
    expect(await snapshot(fixture)).toBe(before);
  });

  it.each(['confirmed', 'skipped'] as const)('rejects an already %s share while its parent is pending', async (status) => {
    const fixture = await createFixture();
    await database.query(
      `UPDATE payment_shares SET status = $2::payment_share_status,
         actual_amount = CASE WHEN $2 = 'confirmed' THEN share_amount ELSE NULL END,
         confirmed_at = CASE WHEN $2 = 'confirmed' THEN NOW() ELSE NULL END
       WHERE id = $1`, [fixture.shareIds[1], status],
    );
    const before = await snapshot(fixture);
    await expect(confirm(fixture, 1)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(fixture)).toBe(before);
  });

  it.each(['confirmed', 'skipped'] as const)('rejects a pending share of an already %s parent', async (status) => {
    const fixture = await createFixture();
    // Defensive fixture: resolved parent with a pending child must not be changed.
    await database.query(
      `UPDATE payments SET status = $2::payment_status,
         actual_amount = CASE WHEN $2 = 'confirmed' THEN expected_amount ELSE NULL END, resolved_at = NOW()
       WHERE id = $1`, [fixture.paymentId, status],
    );
    const before = await snapshot(fixture);
    await expect(confirm(fixture, 1)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(fixture)).toBe(before);
  });

  it('does not close the parent just because no pending shares remain when another share is skipped', async () => {
    const fixture = await createFixture({ count: 3 });
    await database.query("UPDATE payment_shares SET status = 'skipped' WHERE id = $1", [fixture.shareIds[2]]);
    await confirm(fixture, 0);
    const last = await confirm(fixture, 1);
    expect(last.summary).toEqual({ totalShares: 3, confirmedShares: 2, confirmedAmount: '0.20' });
    expect(last.payment).toMatchObject({ status: 'pending', actualAmount: null, resolvedAt: null, priceChanged: false });
  });

  it('checks the accumulated limit before a non-final confirmation and permits the maximum plus zeros', async () => {
    const fixture = await createFixture({ count: 3, amount: '9999999999.99',
      shareAmounts: ['3333333333.33', '3333333333.33', '3333333333.33'] });
    await confirm(fixture, 0, '9999999999.99');
    const before = await snapshot(fixture);
    await expect(confirm(fixture, 1, '0.01')).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(fixture)).toBe(before);
    const second = await confirm(fixture, 1, '0.00');
    expect(second.payment.status).toBe('pending');
    expect(second.summary).toEqual({ totalShares: 3, confirmedShares: 2, confirmedAmount: '9999999999.99' });
    const last = await confirm(fixture, 2, '0.00');
    expect(last.payment).toMatchObject({ status: 'confirmed', actualAmount: '9999999999.99', priceChanged: false });
  });

  it('serializes competing confirmations that would together exceed the accumulated limit', async () => {
    const fixture = await createFixture({ count: 3, amount: '9999999999.99',
      shareAmounts: ['3333333333.33', '3333333333.33', '3333333333.33'] });
    await confirm(fixture, 0, '9999999999.98');
    const results = await Promise.allSettled([confirm(fixture, 1, '0.01'), confirm(fixture, 2, '0.01')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) }),
    ]);
    const pendingIndex = results.findIndex((result) => result.status === 'rejected') + 1;
    const stored = await shares.getPaymentShares(fixture.userIds[0], fixture.groupId, fixture.paymentId);
    expect(stored.summary).toEqual({ totalShares: 3, confirmedShares: 2, confirmedAmount: '9999999999.99' });
    expect(stored.payment.status).toBe('pending');
    expect(stored.shares.find((share) => share.id === fixture.shareIds[pendingIndex])?.status).toBe('pending');
    expect((await confirm(fixture, pendingIndex, '0.00')).payment.actualAmount).toBe('9999999999.99');
  });

  it('allows only one HTTP confirmation of the same share', async () => {
    const fixture = await createFixture({ count: 1 });
    const results = await Promise.all([
      request<Confirmation>(confirmPath(fixture, 0), fixture.userIds[0]),
      request<Confirmation>(confirmPath(fixture, 0), fixture.userIds[0]),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.find((result) => result.status === 200);
    const stored = await shares.getPaymentShares(fixture.userIds[0], fixture.groupId, fixture.paymentId);
    expect(stored.shares).toHaveLength(1);
    expect(stored.summary).toEqual({ totalShares: 1, confirmedShares: 1, confirmedAmount: '0.30' });
    expect(stored.payment.resolvedAt).toBe(winner?.body.payment.resolvedAt);
  });

  it('closes the parent once when its two last different shares are confirmed concurrently', async () => {
    const fixture = await createFixture({ count: 3 });
    await confirm(fixture, 0);
    const results = await Promise.all([confirm(fixture, 1), confirm(fixture, 2)]);
    expect(results.map((result) => result.payment.status).sort()).toEqual(['confirmed', 'pending']);
    expect(results.map((result) => result.summary.confirmedShares).sort()).toEqual([2, 3]);
    const stored = await shares.getPaymentShares(fixture.userIds[0], fixture.groupId, fixture.paymentId);
    expect(stored.payment).toMatchObject({ actualAmount: '0.30', status: 'confirmed', priceChanged: false });
    expect(stored.shares.every((share) => share.status === 'confirmed')).toBe(true);
    const before = await snapshot(fixture);
    await expect(confirm(fixture, 1)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(fixture)).toBe(before);
  });

  it.each(['removed member', 'demoted owner'] as const)('revalidates a %s after waiting for the group lock', async (change) => {
    const fixture = await createFixture();
    const actor = change === 'demoted owner' ? 0 : 1;
    const before = await snapshot(fixture);
    const holder = await database.connect();
    let holding = false;
    let finished = false;
    let attempted: Promise<{ ok: true; result: Confirmation } | { ok: false; error: unknown }> | undefined;
    try {
      await holder.query('BEGIN');
      holding = true;
      await holder.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [fixture.groupId]);
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      attempted = confirm(fixture, actor).then(
        (result) => { finished = true; return { ok: true as const, result }; },
        (error: unknown) => { finished = true; return { ok: false as const, error }; },
      );
      await waitForGroupLock(pid, () => finished);
      if (change === 'demoted owner') {
        // Direct fixture SQL simulates transfer; confirming one's own part needs no owner role.
        await holder.query("UPDATE group_members SET role = 'member' WHERE group_id = $1 AND user_id = $2",
          [fixture.groupId, fixture.userIds[0]]);
        await holder.query("UPDATE group_members SET role = 'owner' WHERE group_id = $1 AND user_id = $2",
          [fixture.groupId, fixture.userIds[1]]);
        await holder.query('UPDATE groups SET owner_id = $2 WHERE id = $1', [fixture.groupId, fixture.userIds[1]]);
      } else {
        await holder.query("UPDATE group_members SET status = 'removed' WHERE group_id = $1 AND user_id = $2",
          [fixture.groupId, fixture.userIds[1]]);
      }
      await holder.query('COMMIT');
      holding = false;
      const result = await attempted;
      if (change === 'demoted owner') {
        expect(result).toMatchObject({ ok: true, result: { share: { userId: fixture.userIds[0], status: 'confirmed' }, payment: { status: 'pending' } } });
      } else {
        expect(result).toMatchObject({ ok: false, error: { status: 403 } });
        expect(await snapshot(fixture)).toBe(before);
      }
    } finally {
      try {
        if (holding) await holder.query('ROLLBACK');
      } finally {
        holder.release();
        if (attempted) await attempted;
      }
    }
  }, 15_000);

  it('rolls back the share when closing its parent fails and releases every row lock', async () => {
    const fixture = await createFixture({ count: 1 });
    const before = await snapshot(fixture);
    // This constraint is local to the disposable schema; old confirmed fixtures are not validated.
    await database.query(`ALTER TABLE payments ADD CONSTRAINT phase5_reject_parent_confirmation
                          CHECK (status <> 'confirmed') NOT VALID`);
    try {
      await expect(confirm(fixture, 0)).rejects.toMatchObject({ code: '23514', constraint: 'phase5_reject_parent_confirmation' });
      expect(await snapshot(fixture)).toBe(before);
      const observer = await database.connect();
      try {
        await observer.query('BEGIN');
        await observer.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE NOWAIT', [fixture.groupId]);
        await observer.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE NOWAIT', [fixture.paymentId]);
        await observer.query('SELECT id FROM payment_shares WHERE id = $1 FOR UPDATE NOWAIT', [fixture.shareIds[0]]);
        await observer.query('COMMIT');
      } catch (error) {
        await observer.query('ROLLBACK');
        throw error;
      } finally {
        observer.release();
      }
    } finally {
      await database.query('ALTER TABLE payments DROP CONSTRAINT phase5_reject_parent_confirmation');
    }
    expect((await confirm(fixture, 0)).payment.status).toBe('confirmed');
  });

  it('confirms own parts through HTTP while direct confirmation and partial skipping stay blocked', async () => {
    const fixture = await createFixture();
    const pending = await snapshot(fixture);
    expect(await request(`/groups/${fixture.groupId}/payments/${fixture.paymentId}/confirm`, fixture.userIds[0]))
      .toMatchObject({ status: 409, body: { error: { status: 409 } } });
    expect(await snapshot(fixture)).toBe(pending);
    const first = await request<Confirmation>(confirmPath(fixture, 0), fixture.userIds[0]);
    expect(first).toMatchObject({ status: 200, body: { share: { actualAmount: '0.15' }, payment: { status: 'pending' } } });
    const partial = await snapshot(fixture);
    for (const operation of ['confirm', 'skip']) {
      expect(await request(`/groups/${fixture.groupId}/payments/${fixture.paymentId}/${operation}`, fixture.userIds[0]))
        .toMatchObject({ status: 409, body: { error: { status: 409 } } });
    }
    expect(await snapshot(fixture)).toBe(partial);
    const last = await request<Confirmation>(confirmPath(fixture, 1), fixture.userIds[1], { actualAmount: '0.20' });
    expect(last).toMatchObject({ status: 200, body: {
      share: { userId: fixture.userIds[1], actualAmount: '0.20', status: 'confirmed' },
      payment: { actualAmount: '0.35', status: 'confirmed', priceChanged: true },
      summary: { totalShares: 2, confirmedShares: 2, confirmedAmount: '0.35' },
    } });
    const committed = await shares.getPaymentShares(fixture.userIds[1], fixture.groupId, fixture.paymentId);
    expect(last.body.payment).toEqual(committed.payment);
    expect(last.body.summary).toEqual(committed.summary);
    expect(last.body.share).toEqual(committed.shares.find((share) => share.id === fixture.shareIds[1]));
    expect(await request(confirmPath(fixture, 1), fixture.userIds[1])).toMatchObject({ status: 409 });
    expect(await request(confirmPath(fixture, 1), fixture.userIds[0])).toMatchObject({ status: 403 });
  });
});
