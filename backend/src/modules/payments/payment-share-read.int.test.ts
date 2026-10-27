import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OwnPaymentShare, PaymentShareBreakdown } from './payment-share.types';

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
type UserRole = 'owner' | 'member' | 'past' | 'newcomer' | 'outsider';
type Fixture = {
  users: Record<UserRole, string>;
  groups: Record<'family' | 'personal' | 'foreign', string>;
  subscriptions: Record<'family' | 'personal' | 'foreign', string>;
  payments: Record<'partial' | 'confirmed' | 'skipped' | 'empty' | 'personal' | 'foreign', string>;
  shareIds: string[];
  extraSubscriptionIds: string[];
  extraPaymentIds: string[];
};

describeWithDatabase('payment share reads with real PostgreSQL and HTTP', () => {
  let database: Pool;
  let reads: typeof import('./payment-share.service');
  let signAccessToken: typeof import('../auth/auth.tokens').signAccessToken;
  let server: Server | undefined;
  let baseUrl: string;
  let ready = false;
  const prefix = `phase5-test-${randomUUID()}`;
  const resolvedAt = '2026-10-16T12:00:00.000Z';
  const fixtures: Fixture[] = [];
  const trackedGroups: string[] = [];
  const trackedUsers: string[] = [];
  const trackedPayments: string[] = [];
  const trackedShares: string[] = [];

  beforeAll(async () => {
    database = (await import('../../db/pool')).pool;
    const migration = await database.query(
      'SELECT filename FROM schema_migrations WHERE filename = $1', ['008_create_payment_shares.sql'],
    );
    if (migration.rowCount !== 1) throw new Error('Apply migration 008 before running share read tests');
    ready = true;
    reads = await import('./payment-share.service');
    ({ signAccessToken } = await import('../auth/auth.tokens'));
    const { app } = await import('../../app');
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server?.once('listening', resolve);
      server?.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing share read HTTP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  async function createFixture(): Promise<Fixture> {
    const fixture: Fixture = {
      users: { owner: randomUUID(), member: randomUUID(), past: randomUUID(), newcomer: randomUUID(), outsider: randomUUID() },
      groups: { family: randomUUID(), personal: randomUUID(), foreign: randomUUID() },
      subscriptions: { family: randomUUID(), personal: randomUUID(), foreign: randomUUID() },
      payments: {
        partial: randomUUID(), confirmed: randomUUID(), skipped: randomUUID(),
        empty: randomUUID(), personal: randomUUID(), foreign: randomUUID(),
      },
      shareIds: [], extraSubscriptionIds: [], extraPaymentIds: [],
    };
    // Record UUIDs first, so a partially inserted fixture still belongs to cleanup.
    fixtures.push(fixture);
    trackedGroups.push(...Object.values(fixture.groups));
    trackedUsers.push(...Object.values(fixture.users));
    trackedPayments.push(...Object.values(fixture.payments));
    const users = Object.entries(fixture.users);
    await database.query(
      `INSERT INTO users (id, email, password_hash, name)
       SELECT id, email, 'unused-test-hash', name
       FROM UNNEST($1::uuid[], $2::text[], $3::text[]) fixture(id, email, name)`,
      [users.map(([, id]) => id), users.map(([, id]) => `${prefix}-${id}@example.com`), users.map(([role]) => `${prefix}-${role}`)],
    );
    const groupIds = [fixture.groups.family, fixture.groups.personal, fixture.groups.foreign];
    await database.query(
      `INSERT INTO groups (id, name, type, owner_id)
       SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::group_type[], $4::uuid[])`,
      [groupIds, ['family', 'personal', 'foreign'].map((label) => `${prefix}-${label}`),
        ['family', 'personal', 'family'], [fixture.users.owner, fixture.users.owner, fixture.users.outsider]],
    );
    await database.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       SELECT group_id, user_id, role, status, NOW()
       FROM UNNEST($1::uuid[], $2::uuid[], $3::member_role[], $4::member_status[])
         fixture(group_id, user_id, role, status)`,
      [[fixture.groups.family, fixture.groups.family, fixture.groups.family, fixture.groups.family,
        fixture.groups.personal, fixture.groups.foreign],
      [fixture.users.owner, fixture.users.member, fixture.users.past, fixture.users.newcomer,
        fixture.users.owner, fixture.users.outsider],
      ['owner', 'member', 'member', 'member', 'owner', 'owner'],
      ['active', 'active', 'removed', 'active', 'active', 'active']],
    );
    const subscriptionIds = [fixture.subscriptions.family, fixture.subscriptions.personal, fixture.subscriptions.foreign];
    await database.query(
      `INSERT INTO subscriptions (
         id, group_id, name, provider, expected_cost, billing_cycle, next_billing_date, billing_anchor_day, active
       ) SELECT id, group_id, name, 'Test', amount, 'monthly'::billing_cycle, DATE '9999-12-31', 31, FALSE
         FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::numeric[]) fixture(id, group_id, name, amount)`,
      [subscriptionIds, groupIds, ['family', 'personal', 'foreign'].map((label) => `${prefix}-${label}`), ['0.60', '9.99', '5.00']],
    );
    await database.query(
      `INSERT INTO payments (
         id, subscription_id, expected_date, expected_amount, actual_amount, status, price_changed, resolved_at
       ) SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::date[], $4::numeric[], $5::numeric[],
                             $6::payment_status[], $7::boolean[], $8::timestamptz[])`,
      [[fixture.payments.partial, fixture.payments.confirmed, fixture.payments.skipped, fixture.payments.empty,
        fixture.payments.personal, fixture.payments.foreign],
      [fixture.subscriptions.family, fixture.subscriptions.family, fixture.subscriptions.family, fixture.subscriptions.family,
        fixture.subscriptions.personal, fixture.subscriptions.foreign],
      ['2026-10-15', '2026-09-15', '2026-08-15', '2026-07-15', '2026-10-15', '2026-10-15'],
      ['0.60', '0.60', '0.60', '0.60', '9.99', '5.00'], [null, '0.70', null, null, null, null],
      ['pending', 'confirmed', 'skipped', 'pending', 'pending', 'pending'], [false, true, false, false, false, false],
      [null, resolvedAt, resolvedAt, null, null, null]],
    );
    const shareRows: {
      id: string; paymentId: string; userId: string; amount: string; percentage: string;
      status: string; actualAmount: string | null; confirmedAt: string | null;
    }[] = [];
    const oldMembers = [fixture.users.owner, fixture.users.member, fixture.users.past].sort();
    for (const payment of ['partial', 'confirmed', 'skipped'] as const) {
      for (const [index, userId] of oldMembers.entries()) {
        const status = payment === 'skipped' ? 'skipped'
          : payment === 'confirmed' || userId !== fixture.users.member ? 'confirmed' : 'pending';
        const actualAmount = status !== 'confirmed' ? null
          : payment === 'confirmed' ? userId === fixture.users.owner ? '0.30' : '0.20'
            : userId === fixture.users.owner ? '0.10' : '0.20';
        shareRows.push({ id: randomUUID(), paymentId: fixture.payments[payment], userId, amount: '0.20',
          percentage: index === 0 ? '33.3334' : '33.3333', status, actualAmount,
          confirmedAt: status === 'confirmed' ? resolvedAt : null });
      }
    }
    shareRows.push({ id: randomUUID(), paymentId: fixture.payments.foreign, userId: fixture.users.outsider,
      amount: '5.00', percentage: '100.0000', status: 'pending', actualAmount: null, confirmedAt: null });
    fixture.shareIds.push(...shareRows.map((row) => row.id));
    trackedShares.push(...fixture.shareIds);
    await database.query(
      `INSERT INTO payment_shares (
         id, payment_id, user_id, share_amount, share_percentage, status, actual_amount, confirmed_at
       ) SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::numeric[], $5::numeric[],
                             $6::payment_share_status[], $7::numeric[], $8::timestamptz[])`,
      [shareRows.map((row) => row.id), shareRows.map((row) => row.paymentId), shareRows.map((row) => row.userId),
        shareRows.map((row) => row.amount), shareRows.map((row) => row.percentage), shareRows.map((row) => row.status),
        shareRows.map((row) => row.actualAmount), shareRows.map((row) => row.confirmedAt)],
    );
    return fixture;
  }

  async function cleanupFixtures(): Promise<void> {
    while (fixtures.length > 0) {
      const fixture = fixtures[fixtures.length - 1];
      await database.query('DELETE FROM payment_shares WHERE id = ANY($1::uuid[])', [fixture.shareIds]);
      await database.query('DELETE FROM payments WHERE id = ANY($1::uuid[])',
        [[...Object.values(fixture.payments), ...fixture.extraPaymentIds]]);
      await database.query('DELETE FROM subscriptions WHERE id = ANY($1::uuid[])',
        [[...Object.values(fixture.subscriptions), ...fixture.extraSubscriptionIds]]);
      await database.query('DELETE FROM group_members WHERE group_id = ANY($1::uuid[])', [Object.values(fixture.groups)]);
      await database.query('DELETE FROM groups WHERE id = ANY($1::uuid[])', [Object.values(fixture.groups)]);
      await database.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(fixture.users)]);
      fixtures.pop();
    }
  }

  afterEach(async () => {
    if (database) await cleanupFixtures();
  });

  afterAll(async () => {
    try {
      if (server) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    } finally {
      if (database) {
        try {
          await cleanupFixtures();
          if (ready) {
            const remaining = await database.query<{ count: string }>(
              `SELECT (
                 (SELECT COUNT(*) FROM groups WHERE id = ANY($1::uuid[])) +
                 (SELECT COUNT(*) FROM group_members WHERE group_id = ANY($1::uuid[])) +
                 (SELECT COUNT(*) FROM users WHERE id = ANY($2::uuid[])) +
                 (SELECT COUNT(*) FROM payments WHERE id = ANY($3::uuid[])) +
                 (SELECT COUNT(*) FROM payment_shares WHERE id = ANY($4::uuid[]))
               )::text AS count`, [trackedGroups, trackedUsers, trackedPayments, trackedShares],
            );
            expect(remaining.rows[0].count).toBe('0');
          }
        } finally {
          await database.end();
        }
      }
    }
  });

  async function request<T>(pathname: string, userId?: string): Promise<{ status: number; body: T }> {
    const token = userId ? signAccessToken({ id: userId, email: `${prefix}-${userId}@example.com` }) : undefined;
    const response = await fetch(`${baseUrl}${pathname}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: await response.json() as T };
  }

  async function snapshot(fixture: Fixture): Promise<string> {
    return (await database.query<{ snapshot: string }>(
      `SELECT jsonb_build_object(
         'subscriptions', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM subscriptions s WHERE s.id = ANY($1::uuid[])),
         'payments', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM payments p WHERE p.id = ANY($2::uuid[])),
         'shares', (SELECT jsonb_agg(to_jsonb(ps) ORDER BY ps.id) FROM payment_shares ps WHERE ps.id = ANY($3::uuid[]))
       )::text AS snapshot`, [Object.values(fixture.subscriptions), Object.values(fixture.payments), fixture.shareIds],
    )).rows[0].snapshot;
  }

  it.each(['owner', 'member'] as const)('lists only the active %s shares with global summaries independent of status', async (role) => {
    const fixture = await createFixture();
    const userId = fixture.users[role];
    const all = await reads.listOwnPaymentShares(userId, fixture.groups.family);
    expect(all.map((share) => share.paymentId)).toEqual([
      fixture.payments.partial, fixture.payments.confirmed, fixture.payments.skipped,
    ]);
    expect(all.every((share) => share.userId === userId)).toBe(true);
    expect(all[0]).toMatchObject({
      userName: `${prefix}-${role}`, shareAmount: '0.20',
      actualAmount: role === 'owner' ? '0.10' : null, status: role === 'owner' ? 'confirmed' : 'pending',
      payment: { id: fixture.payments.partial, expectedDate: '2026-10-15', expectedAmount: '0.60', status: 'pending', actualAmount: null },
      summary: { totalShares: 3, confirmedShares: 2, confirmedAmount: '0.30' },
    });
    expect(Object.keys(all[0]).sort()).toEqual([
      'id', 'paymentId', 'userId', 'userName', 'shareAmount', 'sharePercentage', 'actualAmount',
      'status', 'confirmedAt', 'createdAt', 'payment', 'summary',
    ].sort());
    expect(new Date(all[0].createdAt).toISOString()).toBe(all[0].createdAt);
    expect(all.every((share) => /^\d+\.\d{4}$/.test(share.sharePercentage))).toBe(true);
    expect(all[1].summary).toEqual({ totalShares: 3, confirmedShares: 3, confirmedAmount: '0.70' });
    const breakdown = await reads.getPaymentShares(userId, fixture.groups.family, fixture.payments.partial);
    expect(breakdown.shares).toHaveLength(3);
    expect(breakdown.summary).toEqual({ totalShares: 3, confirmedShares: 2, confirmedAmount: '0.30' });
    const pending = await reads.listOwnPaymentShares(userId, fixture.groups.family, { status: 'pending' });
    const confirmed = await reads.listOwnPaymentShares(userId, fixture.groups.family, { status: 'confirmed' });
    const skipped = await reads.listOwnPaymentShares(userId, fixture.groups.family, { status: 'skipped' });
    expect(pending.map((share) => share.paymentId)).toEqual(role === 'member' ? [fixture.payments.partial] : []);
    expect(confirmed.map((share) => share.paymentId)).toEqual(role === 'owner'
      ? [fixture.payments.partial, fixture.payments.confirmed] : [fixture.payments.confirmed]);
    expect(skipped.map((share) => share.paymentId)).toEqual([fixture.payments.skipped]);
    expect(skipped[0].summary).toEqual({ totalShares: 3, confirmedShares: 0, confirmedAmount: '0.00' });
    const partial = [...pending, ...confirmed].find((share) => share.paymentId === fixture.payments.partial);
    expect(partial?.summary).toEqual({ totalShares: 3, confirmedShares: 2, confirmedAmount: '0.30' });
    expect(confirmed.every((share) => share.confirmedAt === resolvedAt)).toBe(true);
  });

  it('lets a newly joined member without a share read the full historic breakdown including removed users', async () => {
    const fixture = await createFixture();
    expect(await reads.listOwnPaymentShares(fixture.users.newcomer, fixture.groups.family)).toEqual([]);
    const result = await reads.getPaymentShares(fixture.users.newcomer, fixture.groups.family, fixture.payments.partial);
    expect(result.payment).toMatchObject({ id: fixture.payments.partial, status: 'pending', actualAmount: null });
    expect(result.shares.map((share) => share.userId)).toEqual([
      fixture.users.owner, fixture.users.member, fixture.users.past,
    ].sort());
    expect(result.shares.find((share) => share.userId === fixture.users.past)).toMatchObject({
      userName: `${prefix}-past`, status: 'confirmed', actualAmount: '0.20', confirmedAt: resolvedAt,
    });
    expect(result.summary).toEqual({ totalShares: 3, confirmedShares: 2, confirmedAmount: '0.30' });
    expect(Object.keys(result.shares[0]).sort()).toEqual([
      'id', 'paymentId', 'userId', 'userName', 'shareAmount', 'sharePercentage', 'actualAmount', 'status', 'confirmedAt', 'createdAt',
    ].sort());
  });

  it('distinguishes an existing payment without shares from a missing payment', async () => {
    const fixture = await createFixture();
    expect(await reads.getPaymentShares(fixture.users.member, fixture.groups.family, fixture.payments.empty)).toMatchObject({
      payment: { id: fixture.payments.empty, expectedDate: '2026-07-15' }, shares: [],
      summary: { totalShares: 0, confirmedShares: 0, confirmedAmount: '0.00' },
    });
  });

  it.each(['outsider', 'missing group', 'invited', 'removed'] as const)('denies %s before reading own or full shares', async (condition) => {
    const fixture = await createFixture();
    let userId = fixture.users.owner;
    let groupId = fixture.groups.family;
    if (condition === 'outsider') userId = fixture.users.outsider;
    if (condition === 'missing group') groupId = randomUUID();
    if (condition === 'invited' || condition === 'removed') {
      userId = fixture.users.member;
      await database.query('UPDATE group_members SET status = $3 WHERE group_id = $1 AND user_id = $2',
        [groupId, userId, condition]);
    }
    await expect(reads.listOwnPaymentShares(userId, groupId)).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
    await expect(reads.getPaymentShares(userId, groupId, fixture.payments.partial)).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
  });

  it('rejects share operations on an authorized personal group with 409', async () => {
    const fixture = await createFixture();
    await expect(reads.listOwnPaymentShares(fixture.users.owner, fixture.groups.personal)).rejects.toMatchObject({ status: 409 });
    await expect(reads.getPaymentShares(fixture.users.owner, fixture.groups.personal, fixture.payments.personal)).rejects.toMatchObject({ status: 409 });
  });

  it('returns 404 for missing and foreign payment UUIDs inside an authorized family', async () => {
    const fixture = await createFixture();
    await expect(reads.getPaymentShares(fixture.users.owner, fixture.groups.family, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(reads.getPaymentShares(fixture.users.owner, fixture.groups.family, fixture.payments.foreign)).rejects.toMatchObject({ status: 404 });
  });

  it('limits HTTP own shares to 100 in date/id order and filters before limiting', async () => {
    const fixture = await createFixture();
    const extraSubscriptionId = randomUUID();
    fixture.extraSubscriptionIds.push(extraSubscriptionId);
    await database.query(
      `INSERT INTO subscriptions (
         id, group_id, name, provider, expected_cost, billing_cycle, next_billing_date, billing_anchor_day, active
       ) VALUES ($1, $2, $3, 'Test', '0.01', 'monthly', '9999-12-31', 31, FALSE)`,
      [extraSubscriptionId, fixture.groups.family, prefix],
    );
    const rows = Array.from({ length: 101 }, (_, index) => ({
      paymentId: randomUUID(), shareId: randomUUID(),
      subscriptionId: index === 1 ? extraSubscriptionId : fixture.subscriptions.family,
      date: index < 2 ? '2027-12-31' : new Date(Date.UTC(2027, 0, index - 1)).toISOString().slice(0, 10),
    }));
    fixture.extraPaymentIds.push(...rows.map((row) => row.paymentId));
    fixture.shareIds.push(...rows.map((row) => row.shareId));
    trackedPayments.push(...rows.map((row) => row.paymentId));
    trackedShares.push(...rows.map((row) => row.shareId));
    await database.query(
      `INSERT INTO payments (id, subscription_id, expected_date, expected_amount)
       SELECT id, subscription_id, expected_date, '0.01'::numeric
       FROM UNNEST($1::uuid[], $2::uuid[], $3::date[]) fixture(id, subscription_id, expected_date)`,
      [rows.map((row) => row.paymentId), rows.map((row) => row.subscriptionId), rows.map((row) => row.date)],
    );
    await database.query(
      `INSERT INTO payment_shares (id, payment_id, user_id, share_amount, share_percentage)
       SELECT id, payment_id, $3::uuid, '0.01'::numeric, '100.0000'::numeric
       FROM UNNEST($1::uuid[], $2::uuid[]) fixture(id, payment_id)`,
      [rows.map((row) => row.shareId), rows.map((row) => row.paymentId), fixture.users.owner],
    );
    const expected = [...rows].sort((left, right) => (
      left.date < right.date ? 1 : left.date > right.date ? -1 : left.shareId < right.shareId ? 1 : -1
    )).slice(0, 100);
    const pathname = `/groups/${fixture.groups.family}/payment-shares`;
    for (const suffix of ['', '?status=pending']) {
      const response = await request<{ shares: OwnPaymentShare[] }>(`${pathname}${suffix}`, fixture.users.owner);
      expect(response.status).toBe(200);
      expect(response.body.shares).toHaveLength(100);
      expect(response.body.shares.map((share) => ({ id: share.id, date: share.payment.expectedDate })))
        .toEqual(expected.map((row) => ({ id: row.shareId, date: row.date })));
    }
    const confirmed = await request<{ shares: OwnPaymentShare[] }>(`${pathname}?status=confirmed`, fixture.users.owner);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.shares.map((share) => share.paymentId)).toEqual([fixture.payments.partial, fixture.payments.confirmed]);
  });

  it('serves both authenticated GET routes without mutations and preserves personal routes', async () => {
    const fixture = await createFixture();
    const before = await snapshot(fixture);
    const own = await request<{ shares: OwnPaymentShare[] }>(
      `/groups/${fixture.groups.family}/payment-shares?status=pending`, fixture.users.member,
    );
    expect(own.status).toBe(200);
    expect(own.body.shares).toEqual([expect.objectContaining({
      userId: fixture.users.member, status: 'pending',
      payment: expect.objectContaining({ id: fixture.payments.partial, status: 'pending' }),
      summary: { totalShares: 3, confirmedShares: 2, confirmedAmount: '0.30' },
    })]);
    const detail = await request<PaymentShareBreakdown>(
      `/groups/${fixture.groups.family}/payments/${fixture.payments.partial}/shares`, fixture.users.newcomer,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.shares).toHaveLength(3);
    expect(detail.body.summary).toEqual({ totalShares: 3, confirmedShares: 2, confirmedAmount: '0.30' });
    expect(detail.body.payment).toMatchObject({ expectedDate: '2026-10-15', expectedAmount: '0.60', status: 'pending' });
    expect((await request('/health')).status).toBe(200);
    const personalPayments = await request<{ payments: { id: string }[] }>(
      `/groups/${fixture.groups.personal}/payments`, fixture.users.owner,
    );
    expect(personalPayments.status).toBe(200);
    expect(personalPayments.body.payments.map((payment) => payment.id)).toEqual([fixture.payments.personal]);
    const personalSubscriptions = await request<{ subscriptions: { id: string }[] }>(
      `/groups/${fixture.groups.personal}/subscriptions`, fixture.users.owner,
    );
    expect(personalSubscriptions.status).toBe(200);
    expect(personalSubscriptions.body.subscriptions.map((subscription) => subscription.id)).toEqual([fixture.subscriptions.personal]);
    expect(await snapshot(fixture)).toBe(before);
  });

  it('preserves real HTTP 401, 403, 404 and 409 responses for the new routes', async () => {
    const fixture = await createFixture();
    const familyOwn = `/groups/${fixture.groups.family}/payment-shares`;
    const familyDetail = `/groups/${fixture.groups.family}/payments/${fixture.payments.partial}/shares`;
    for (const pathname of [familyOwn, familyDetail]) {
      const unauthenticated = await request<{ error: { status: number } }>(pathname);
      expect(unauthenticated).toMatchObject({ status: 401, body: { error: { status: 401 } } });
      const outsider = await request<{ error: { status: number; message: string } }>(pathname, fixture.users.outsider);
      expect(outsider).toMatchObject({ status: 403, body: { error: { status: 403, message: 'Forbidden' } } });
    }
    for (const pathname of [
      `/groups/${fixture.groups.personal}/payment-shares`,
      `/groups/${fixture.groups.personal}/payments/${fixture.payments.personal}/shares`,
    ]) {
      expect(await request(pathname, fixture.users.owner)).toMatchObject({ status: 409, body: { error: { status: 409 } } });
    }
    for (const paymentId of [randomUUID(), fixture.payments.foreign]) {
      expect(await request(`/groups/${fixture.groups.family}/payments/${paymentId}/shares`, fixture.users.owner))
        .toMatchObject({ status: 404, body: { error: { status: 404 } } });
    }
  });
});
