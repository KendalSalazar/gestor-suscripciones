import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Payment } from './payment.types';
import type { OwnPaymentShare, PaymentShareBreakdown, PaymentShareConfirmation } from './payment-share.types';

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
  paymentId: string;
  userIds: string[];
  shareIds: string[];
  outsiderId: string;
};

describeWithDatabase('family payment skipping with real PostgreSQL and HTTP', () => {
  const schema = `phase5_test_${randomUUID().replaceAll('-', '')}`;
  const prefix = `phase5-test-${randomUUID()}`;
  let admin: Pool;
  let database: Pool;
  let schemaCreated = false;
  let payments: typeof import('./payment.service');
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
        // PostgreSQL 16 provides gen_random_uuid. Do not change global extensions.
        await client.query(source.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\r?\n/, ''));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    payments = await import('./payment.service');
    shares = await import('./payment-share.service');
    ({ signAccessToken } = await import('../auth/auth.tokens'));
    const { app } = await import('../../app');
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server?.once('listening', resolve);
      server?.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing family skip HTTP address');
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

  async function createFixture(options: { type?: 'family' | 'personal'; parts?: boolean } = {}): Promise<Fixture> {
    const type = options.type ?? 'family';
    const count = type === 'family' ? 3 : 1;
    const includeParts = type === 'family' && options.parts !== false;
    const fixture: Fixture = {
      groupId: randomUUID(), subscriptionId: randomUUID(), paymentId: randomUUID(),
      userIds: Array.from({ length: count }, () => randomUUID()),
      shareIds: includeParts ? Array.from({ length: count }, () => randomUUID()) : [], outsiderId: randomUUID(),
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
       ) VALUES ($1, $2, $3, 'Test', '10.00', 'monthly', '9999-12-31', 31, FALSE)`,
      [fixture.subscriptionId, fixture.groupId, prefix],
    );
    await database.query(
      `INSERT INTO payments (id, subscription_id, expected_date, expected_amount)
       VALUES ($1, $2, '2090-01-01', '10.00')`, [fixture.paymentId, fixture.subscriptionId],
    );
    if (includeParts) {
      const firstUser = [...fixture.userIds].sort()[0];
      await database.query(
        `INSERT INTO payment_shares (id, payment_id, user_id, share_amount, share_percentage)
         SELECT id, $2::uuid, user_id, amount, percentage
         FROM UNNEST($1::uuid[], $3::uuid[], $4::numeric[], $5::numeric[]) fixture(id, user_id, amount, percentage)`,
        [fixture.shareIds, fixture.paymentId, fixture.userIds,
          fixture.userIds.map((id) => id === firstUser ? '3.34' : '3.33'),
          fixture.userIds.map((id) => id === firstUser ? '33.3334' : '33.3333')],
      );
    }
    return fixture;
  }

  const skipPath = (fixture: Fixture) => `/groups/${fixture.groupId}/payments/${fixture.paymentId}/skip`;
  const detailPath = (fixture: Fixture) => `/groups/${fixture.groupId}/payments/${fixture.paymentId}/shares`;
  const confirmPartPath = (fixture: Fixture, index: number) => (
    `/groups/${fixture.groupId}/payments/${fixture.paymentId}/shares/${fixture.shareIds[index]}/confirm`
  );

  async function request<T>(pathname: string, userId: string, options: {
    method?: 'GET' | 'POST'; body?: object;
  } = {}): Promise<{ status: number; body: T }> {
    const token = signAccessToken({ id: userId, email: `${prefix}-${userId}@example.com` });
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: options.method ?? 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: await response.json() as T };
  }

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
      if (finished()) throw new Error('Skip finished before its fixture group lock wait');
      await delay(10);
    }
    throw new Error('Skip did not wait for its fixture group lock');
  }

  it('skips every pending share through HTTP, preserves the saved photo and exposes the committed summary', async () => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    const foreignBefore = await snapshot(foreign);
    const before = await shares.getPaymentShares(fixture.userIds[0], fixture.groupId, fixture.paymentId);
    // Whole-payment confirmation remains unavailable for family payments.
    const direct = await request(`/groups/${fixture.groupId}/payments/${fixture.paymentId}/confirm`, fixture.userIds[0], { body: {} });
    expect(direct.status).toBe(409);
    const skipped = await request<{ payment: Payment }>(skipPath(fixture), fixture.userIds[0], { body: {} });
    expect(skipped).toMatchObject({ status: 200, body: { payment: {
      id: fixture.paymentId, expectedAmount: '10.00', status: 'skipped', actualAmount: null, priceChanged: false,
    } } });
    expect(new Date(skipped.body.payment.resolvedAt ?? '').toISOString()).toBe(skipped.body.payment.resolvedAt);
    const detail = await request<PaymentShareBreakdown>(detailPath(fixture), fixture.userIds[1], { method: 'GET' });
    expect(detail.status).toBe(200);
    expect(detail.body.payment).toEqual(skipped.body.payment);
    expect(detail.body.shares).toEqual(before.shares.map((share) => ({ ...share, status: 'skipped' })));
    expect(detail.body.shares.every((share) => share.actualAmount === null && share.confirmedAt === null)).toBe(true);
    expect(detail.body.summary).toEqual({ totalShares: 3, confirmedShares: 0, confirmedAmount: '0.00' });
    const own = await request<{ shares: OwnPaymentShare[] }>(
      `/groups/${fixture.groupId}/payment-shares?status=skipped`, fixture.userIds[1], { method: 'GET' },
    );
    expect(own.status).toBe(200);
    expect(own.body.shares).toEqual([expect.objectContaining({
      id: fixture.shareIds[1], status: 'skipped', payment: skipped.body.payment,
      summary: { totalShares: 3, confirmedShares: 0, confirmedAmount: '0.00' },
    })]);
    const after = await snapshot(fixture);
    expect((await request(skipPath(fixture), fixture.userIds[0])).status).toBe(409);
    expect((await request(confirmPartPath(fixture, 1), fixture.userIds[1], { body: {} })).status).toBe(409);
    expect(await snapshot(fixture)).toBe(after);
    expect(await snapshot(foreign)).toBe(foreignBefore);
  });

  it('rejects a family parent without shares rather than inventing an empty omission', async () => {
    const fixture = await createFixture({ parts: false });
    const before = await snapshot(fixture);
    await expect(payments.skipPayment(fixture.userIds[0], fixture.groupId, fixture.paymentId)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(fixture)).toBe(before);
  });

  it.each(['confirmed', 'skipped'] as const)('preserves history when a pending parent already has a %s share', async (status) => {
    const fixture = await createFixture();
    if (status === 'confirmed') {
      await shares.confirmPaymentShare(fixture.userIds[1], fixture.groupId, fixture.paymentId, fixture.shareIds[1], '4.25');
    } else {
      // Defensive historical fixture: the all-pending rule must reject a mixed set.
      await database.query("UPDATE payment_shares SET status = 'skipped' WHERE id = $1", [fixture.shareIds[1]]);
    }
    const before = await snapshot(fixture);
    const result = await request(skipPath(fixture), fixture.userIds[0]);
    expect(result).toMatchObject({ status: 409, body: { error: { status: 409 } } });
    expect(await snapshot(fixture)).toBe(before);
  });

  it('rejects an already confirmed parent without changing its resolved history', async () => {
    const fixture = await createFixture();
    await database.query(
      `UPDATE payment_shares SET status = 'confirmed', actual_amount = share_amount,
         confirmed_at = NOW() WHERE payment_id = $1`, [fixture.paymentId],
    );
    await database.query(
      `UPDATE payments SET status = 'confirmed', actual_amount = expected_amount, resolved_at = NOW()
       WHERE id = $1`, [fixture.paymentId],
    );
    const before = await snapshot(fixture);
    await expect(payments.skipPayment(fixture.userIds[0], fixture.groupId, fixture.paymentId)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(fixture)).toBe(before);
  });

  it.each(['member', 'outsider', 'invited', 'removed', 'missing group'] as const)('returns HTTP 403 to %s without modifying the parent or shares', async (condition) => {
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
    const response = await request(`/groups/${groupId}/payments/${fixture.paymentId}/skip`, userId);
    expect(response).toMatchObject({ status: 403, body: { error: { status: 403, message: 'Forbidden' } } });
    expect(await snapshot(fixture)).toBe(before);
  });

  it('keeps HTTP 404 for missing and crossed group/payment ids within authorized groups', async () => {
    const first = await createFixture();
    const second = await createFixture();
    const beforeFirst = await snapshot(first);
    const beforeSecond = await snapshot(second);
    for (const [groupId, paymentId, userId] of [
      [first.groupId, randomUUID(), first.userIds[0]],
      [first.groupId, second.paymentId, first.userIds[0]],
      [second.groupId, first.paymentId, second.userIds[0]],
    ]) {
      expect(await request(`/groups/${groupId}/payments/${paymentId}/skip`, userId))
        .toMatchObject({ status: 404, body: { error: { status: 404 } } });
    }
    expect(await snapshot(first)).toBe(beforeFirst);
    expect(await snapshot(second)).toBe(beforeSecond);
  });

  it('rejects unsupported skip body and query with HTTP 400 before changing data', async () => {
    const fixture = await createFixture();
    const before = await snapshot(fixture);
    for (const [query, body] of [['', { actualAmount: '1.00' }], ['?status=pending', {}]] as const) {
      expect(await request(`${skipPath(fixture)}${query}`, fixture.userIds[0], { body }))
        .toMatchObject({ status: 400, body: { error: { status: 400 } } });
    }
    expect(await snapshot(fixture)).toBe(before);
  });

  it('preserves bodyless personal skipping without creating shares', async () => {
    const fixture = await createFixture({ type: 'personal' });
    const result = await request<{ payment: Payment }>(skipPath(fixture), fixture.userIds[0]);
    expect(result).toMatchObject({ status: 200, body: { payment: {
      expectedAmount: '10.00', expectedDate: '2090-01-01', status: 'skipped', actualAmount: null, priceChanged: false,
    } } });
    expect(new Date(result.body.payment.resolvedAt ?? '').toISOString()).toBe(result.body.payment.resolvedAt);
    expect((await database.query('SELECT COUNT(*)::text AS count FROM payment_shares WHERE payment_id = $1', [fixture.paymentId])).rows)
      .toEqual([{ count: '0' }]);
    const before = await snapshot(fixture);
    expect((await request(skipPath(fixture), fixture.userIds[0])).status).toBe(409);
    expect(await snapshot(fixture)).toBe(before);
  });

  it('serializes HTTP skipping against own-part confirmation without a mixed or lost result', async () => {
    const fixture = await createFixture();
    const before = await shares.getPaymentShares(fixture.userIds[0], fixture.groupId, fixture.paymentId);
    const [skipResult, confirmResult] = await Promise.all([
      request<{ payment: Payment }>(skipPath(fixture), fixture.userIds[0]),
      request<PaymentShareConfirmation>(confirmPartPath(fixture, 1), fixture.userIds[1], { body: {} }),
    ]);
    expect([skipResult.status, confirmResult.status].sort()).toEqual([200, 409]);
    const after = await shares.getPaymentShares(fixture.userIds[0], fixture.groupId, fixture.paymentId);
    if (skipResult.status === 200) {
      expect(after.payment).toEqual(skipResult.body.payment);
      expect(after.payment).toMatchObject({ status: 'skipped', actualAmount: null, priceChanged: false });
      expect(after.shares).toEqual(before.shares.map((share) => ({ ...share, status: 'skipped' })));
      expect(after.summary).toEqual({ totalShares: 3, confirmedShares: 0, confirmedAmount: '0.00' });
    } else {
      const expectedShare = before.shares.find((share) => share.id === fixture.shareIds[1]);
      expect(confirmResult.body.share).toMatchObject({
        ...expectedShare, status: 'confirmed', actualAmount: expectedShare?.shareAmount, confirmedAt: expect.any(String),
      });
      expect(after.payment).toEqual(before.payment);
      expect(after.shares).toEqual(before.shares.map((share) => (
        share.id === fixture.shareIds[1] ? confirmResult.body.share : share
      )));
      expect(confirmResult.body.share).toMatchObject({ id: fixture.shareIds[1], status: 'confirmed' });
      expect(after.shares.every((share) => share.status !== 'skipped')).toBe(true);
      expect(after.summary).toEqual({ totalShares: 3, confirmedShares: 1, confirmedAmount: confirmResult.body.share.shareAmount });
    }
  });

  it('allows only one of two concurrent HTTP skips and preserves the whole skipped snapshot', async () => {
    const fixture = await createFixture();
    const before = await shares.getPaymentShares(fixture.userIds[0], fixture.groupId, fixture.paymentId);
    const results = await Promise.all([
      request<{ payment: Payment }>(skipPath(fixture), fixture.userIds[0]),
      request<{ payment: Payment }>(skipPath(fixture), fixture.userIds[0]),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.find((result) => result.status === 200);
    const after = await shares.getPaymentShares(fixture.userIds[0], fixture.groupId, fixture.paymentId);
    expect(after.payment).toEqual(winner?.body.payment);
    expect(after.payment).toMatchObject({ status: 'skipped', actualAmount: null, priceChanged: false });
    expect(after.shares).toEqual(before.shares.map((share) => ({ ...share, status: 'skipped' })));
    expect(after.summary).toEqual({ totalShares: 3, confirmedShares: 0, confirmedAmount: '0.00' });
  });

  it.each(['member', 'removed'] as const)('rejects a former owner changed to %s while skipping waits for the group lock', async (newState) => {
    const fixture = await createFixture();
    const before = await snapshot(fixture);
    const holder = await database.connect();
    let holding = false;
    let finished = false;
    let attempted: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    try {
      await holder.query('BEGIN');
      holding = true;
      await holder.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [fixture.groupId]);
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      attempted = payments.skipPayment(fixture.userIds[0], fixture.groupId, fixture.paymentId).then(
        () => { finished = true; return { ok: true as const }; },
        (error: unknown) => { finished = true; return { ok: false as const, error }; },
      );
      await waitForGroupLock(pid, () => finished);
      // Fixture SQL simulates transfer/removal solely to exercise permission revalidation.
      await holder.query("UPDATE group_members SET role = 'member', status = $3 WHERE group_id = $1 AND user_id = $2",
        [fixture.groupId, fixture.userIds[0], newState === 'removed' ? 'removed' : 'active']);
      await holder.query("UPDATE group_members SET role = 'owner' WHERE group_id = $1 AND user_id = $2",
        [fixture.groupId, fixture.userIds[1]]);
      await holder.query('UPDATE groups SET owner_id = $2 WHERE id = $1', [fixture.groupId, fixture.userIds[1]]);
      await holder.query('COMMIT');
      holding = false;
      expect(await attempted).toMatchObject({ ok: false, error: { status: 403, message: 'Forbidden' } });
      expect(await snapshot(fixture)).toBe(before);
    } finally {
      try {
        if (holding) await holder.query('ROLLBACK');
      } finally {
        holder.release();
        if (attempted) await attempted;
      }
    }
  }, 15_000);

  it('rolls back every share when the parent update fails and releases all row locks before retry', async () => {
    const fixture = await createFixture();
    const before = await snapshot(fixture);
    // NOT VALID ignores earlier fixture rows but checks the new UPDATE in this schema.
    await database.query(`ALTER TABLE payments ADD CONSTRAINT phase5_reject_parent_skip
                          CHECK (status <> 'skipped') NOT VALID`);
    try {
      await expect(payments.skipPayment(fixture.userIds[0], fixture.groupId, fixture.paymentId))
        .rejects.toMatchObject({ code: '23514', constraint: 'phase5_reject_parent_skip' });
      expect(await snapshot(fixture)).toBe(before);
      const observer = await database.connect();
      try {
        await observer.query('BEGIN');
        await observer.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE NOWAIT', [fixture.groupId]);
        await observer.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE NOWAIT', [fixture.paymentId]);
        await observer.query('SELECT id FROM payment_shares WHERE payment_id = $1 ORDER BY id FOR UPDATE NOWAIT', [fixture.paymentId]);
        await observer.query('COMMIT');
      } catch (error) {
        await observer.query('ROLLBACK');
        throw error;
      } finally {
        observer.release();
      }
    } finally {
      await database.query('ALTER TABLE payments DROP CONSTRAINT phase5_reject_parent_skip');
    }
    expect((await payments.skipPayment(fixture.userIds[0], fixture.groupId, fixture.paymentId)).status).toBe('skipped');
    const after = await shares.getPaymentShares(fixture.userIds[0], fixture.groupId, fixture.paymentId);
    expect(after.shares.every((share) => share.status === 'skipped')).toBe(true);
  });
});
