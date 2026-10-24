import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

describeWithDatabase('payment resolution with PostgreSQL', () => {
  let database: Pool;
  let payments: typeof import('./payment.service');
  let subscriptions: typeof import('../subscriptions/subscription.service');
  const prefix = `phase4-resolution-${randomUUID()}`;
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const groupId = randomUUID();
  const otherGroupId = randomUUID();
  const subscriptionIds: string[] = [];
  let subscriptionId: string;
  let paymentSequence = 0;

  beforeAll(async () => {
    database = (await import('../../db/pool')).pool;
    payments = await import('./payment.service');
    subscriptions = await import('../subscriptions/subscription.service');
    const migration = await database.query(
      'SELECT filename FROM schema_migrations WHERE filename = $1', ['006_create_payments.sql'],
    );
    if (migration.rows.length !== 1) throw new Error('Apply migration 006 before running database tests');

    for (const [id, label] of [[ownerId, 'owner'], [memberId, 'member']]) {
      await database.query(
        'INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)',
        [id, `${prefix}-${label}@example.com`, 'unused-test-hash', `${prefix}-${label}`],
      );
    }
    for (const [id, owner] of [[groupId, ownerId], [otherGroupId, memberId]]) {
      await database.query(
        "INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, 'personal', $3)",
        [id, prefix, owner],
      );
      await database.query(
        `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
         VALUES ($1, $2, 'owner', 'active', NOW())`, [id, owner],
      );
    }
    await database.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'member', 'active', NOW())`, [groupId, memberId],
    );
    const subscription = await subscriptions.createSubscription(ownerId, groupId, {
      name: prefix, provider: 'Test', expectedCost: '17.99',
      billingCycle: 'monthly', nextBillingDate: '2026-01-31',
    });
    subscriptionId = subscription.id;
    subscriptionIds.push(subscription.id);
  });

  afterAll(async () => {
    if (!database) return;
    try {
      // Every cleanup query is limited to UUIDs created exclusively for this suite.
      await database.query('DELETE FROM payments WHERE subscription_id = ANY($1::uuid[])', [subscriptionIds]);
      await database.query('DELETE FROM subscriptions WHERE id = ANY($1::uuid[])', [subscriptionIds]);
      await database.query('DELETE FROM group_members WHERE group_id = ANY($1::uuid[])', [[groupId, otherGroupId]]);
      await database.query('DELETE FROM groups WHERE id = ANY($1::uuid[])', [[groupId, otherGroupId]]);
      await database.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[ownerId, memberId]]);
    } finally {
      await database.end();
    }
  });

  async function pendingPayment(expectedAmount = '17.99'): Promise<string> {
    paymentSequence += 1;
    const result = await database.query<{ id: string }>(
      `INSERT INTO payments (subscription_id, expected_date, expected_amount)
       VALUES ($1, $2::date, $3::numeric) RETURNING id`,
      [subscriptionId, `2026-01-${String(paymentSequence).padStart(2, '0')}`, expectedAmount],
    );
    return result.rows[0].id;
  }

  it('confirms the original expected amount even after the subscription cost changes', async () => {
    const id = await pendingPayment();
    await subscriptions.updateSubscription(ownerId, groupId, subscriptionId, { expectedCost: '25.00' });
    const result = await payments.confirmPayment(ownerId, groupId, id);
    expect(result).toMatchObject({ expectedAmount: '17.99', actualAmount: '17.99', priceChanged: false, status: 'confirmed' });
    expect(result.resolvedAt).not.toBeNull();
    expect((await subscriptions.getSubscription(ownerId, groupId, subscriptionId)).expectedCost).toBe('25.00');
  });

  it.each([
    ['17.90', '17.9', false], ['9999999999.99', '9999999999.98', true], ['17.99', '0', true],
  ])('compares expected %s and actual %s with NUMERIC', async (expected, actual, changed) => {
    const id = await pendingPayment(expected);
    const result = await payments.confirmPayment(ownerId, groupId, id, actual);
    expect(result.expectedAmount).toBe(expected);
    expect(result.priceChanged).toBe(changed);
    const stored = await database.query<{ actual_amount: string }>('SELECT actual_amount FROM payments WHERE id = $1', [id]);
    expect(result.actualAmount).toBe(stored.rows[0].actual_amount);
    await expect(payments.skipPayment(ownerId, groupId, id)).rejects.toMatchObject({ status: 409 });
  });

  it('skips once and preserves the payment history', async () => {
    const id = await pendingPayment();
    const result = await payments.skipPayment(ownerId, groupId, id);
    expect(result).toMatchObject({ status: 'skipped', actualAmount: null, priceChanged: false });
    expect(result.resolvedAt).not.toBeNull();
    await expect(payments.skipPayment(ownerId, groupId, id)).rejects.toMatchObject({ status: 409 });
    await expect(payments.confirmPayment(ownerId, groupId, id)).rejects.toMatchObject({ status: 409 });
  });

  it('allows only one resolution when confirm and skip run concurrently', async () => {
    const id = await pendingPayment();
    const results = await Promise.allSettled([
      payments.confirmPayment(ownerId, groupId, id), payments.skipPayment(ownerId, groupId, id),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { status: 409 } });
  });

  it('rolls back the payment when PostgreSQL rejects the update', async () => {
    const id = await pendingPayment();
    // Bypass the HTTP validation here to force a database CHECK failure.
    await expect(payments.confirmPayment(ownerId, groupId, id, '-1')).rejects.toMatchObject({ code: '23514' });
    const stored = await database.query(
      'SELECT status, actual_amount, resolved_at, price_changed FROM payments WHERE id = $1', [id],
    );
    expect(stored.rows[0]).toEqual({ status: 'pending', actual_amount: null, resolved_at: null, price_changed: false });
    expect((await payments.confirmPayment(ownerId, groupId, id)).status).toBe('confirmed');
  });

  it('resolves payments and preserves history through HTTP with real PostgreSQL', async () => {
    const { app } = await import('../../app');
    const { signAccessToken } = await import('../auth/auth.tokens');
    const ownerToken = signAccessToken({ id: ownerId, email: `${prefix}-owner@example.com` });
    const memberToken = signAccessToken({ id: memberId, email: `${prefix}-member@example.com` });
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP test address');
      const baseUrl = `http://127.0.0.1:${address.port}/groups/${groupId}`;
      const request = (path: string, method = 'GET', body?: object, token = ownerToken) => fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const expectedCost = (await subscriptions.getSubscription(ownerId, groupId, subscriptionId)).expectedCost;
      const expectedId = await pendingPayment();
      const changedId = await pendingPayment();
      const skippedId = await pendingPayment();
      const expectedResponse = await request(`/payments/${expectedId}/confirm`, 'POST', {});
      expect(expectedResponse.status).toBe(200);
      expect(await expectedResponse.json()).toMatchObject({ payment: {
        status: 'confirmed', expectedAmount: '17.99', actualAmount: '17.99', priceChanged: false,
      } });
      const changedResponse = await request(`/payments/${changedId}/confirm`, 'POST', { actualAmount: '19.99' });
      expect(changedResponse.status).toBe(200);
      expect(await changedResponse.json()).toMatchObject({ payment: {
        status: 'confirmed', actualAmount: '19.99', priceChanged: true,
      } });
      const skippedResponse = await request(`/payments/${skippedId}/skip`, 'POST');
      expect(skippedResponse.status).toBe(200);
      expect(await skippedResponse.json()).toMatchObject({ payment: {
        status: 'skipped', actualAmount: null, priceChanged: false,
      } });
      expect((await request(`/payments/${expectedId}/confirm`, 'POST', {})).status).toBe(409);
      expect((await request(`/payments/${changedId}/confirm`, 'POST', {})).status).toBe(409);
      expect((await request(`/payments/${skippedId}/skip`, 'POST')).status).toBe(409);
      expect((await request(`/payments/${expectedId}/confirm`, 'POST', {}, memberToken)).status).toBe(403);
      expect((await request(`/subscriptions/${subscriptionId}`, 'DELETE')).status).toBe(409);
      const deactivated = await request(`/subscriptions/${subscriptionId}`, 'PATCH', { active: false });
      expect(deactivated.status).toBe(200);
      expect(await deactivated.json()).toMatchObject({ subscription: { active: false, expectedCost } });
      const listed = await request('/payments');
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({ payments: expect.arrayContaining([
        expect.objectContaining({ id: expectedId, status: 'confirmed' }),
        expect.objectContaining({ id: changedId, status: 'confirmed' }),
        expect.objectContaining({ id: skippedId, status: 'skipped' }),
      ]) });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('enforces active membership, owner role and payment isolation between groups', async () => {
    const id = await pendingPayment();
    await expect(payments.confirmPayment(memberId, groupId, id)).rejects.toMatchObject({ status: 403 });
    await expect(payments.confirmPayment(memberId, otherGroupId, id)).rejects.toMatchObject({ status: 404 });
    await expect(payments.confirmPayment(ownerId, randomUUID(), id)).rejects.toMatchObject({ status: 403 });
    for (const status of ['invited', 'removed']) {
      await database.query('UPDATE group_members SET status = $3 WHERE group_id = $1 AND user_id = $2', [groupId, memberId, status]);
      await expect(payments.listPayments(memberId, groupId)).rejects.toMatchObject({ status: 403 });
      await expect(payments.skipPayment(memberId, groupId, id)).rejects.toMatchObject({ status: 403 });
    }
  });

  it('preserves history on DELETE and still allows deactivation', async () => {
    const id = await pendingPayment();
    await expect(subscriptions.deleteSubscription(ownerId, groupId, subscriptionId)).rejects.toMatchObject({
      status: 409, message: 'Subscription has payment history; deactivate it instead',
    });
    await subscriptions.updateSubscription(ownerId, groupId, subscriptionId, { active: false });
    expect((await payments.listPayments(ownerId, groupId)).some((payment) => payment.id === id)).toBe(true);
  });

  it('sets and resets the anchor day and can delete a subscription without payments', async () => {
    const subscription = await subscriptions.createSubscription(ownerId, groupId, {
      name: `${prefix}-empty`, provider: 'Test', expectedCost: '0.00',
      billingCycle: 'monthly', nextBillingDate: '2026-01-31',
    });
    subscriptionIds.push(subscription.id);
    const anchor = async () => (await database.query<{ billing_anchor_day: number }>(
      'SELECT billing_anchor_day FROM subscriptions WHERE id = $1', [subscription.id],
    )).rows[0].billing_anchor_day;
    expect(await anchor()).toBe(31);
    await subscriptions.updateSubscription(ownerId, groupId, subscription.id, { nextBillingDate: '2026-02-28' });
    expect(await anchor()).toBe(28);
    await subscriptions.updateSubscription(ownerId, groupId, subscription.id, { active: false });
    expect(await anchor()).toBe(28);
    await subscriptions.deleteSubscription(ownerId, groupId, subscription.id);
    await expect(subscriptions.getSubscription(ownerId, groupId, subscription.id)).rejects.toMatchObject({ status: 404 });
  });
});
