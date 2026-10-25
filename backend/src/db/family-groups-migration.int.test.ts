import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const describeWithDatabase = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
const migrationDirectory = path.join(__dirname, 'migrations');
const migration007 = fs.readFileSync(path.join(migrationDirectory, '007_family_groups_and_invitations.sql'), 'utf8');

type InvitationInput = {
  groupId: string;
  invitedBy: string;
  email: string;
  tokenHash: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
  acceptedBy: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
};

describeWithDatabase('migration 007 with PostgreSQL in an isolated schema', () => {
  let database: Pool;
  let client: PoolClient;
  const schema = `phase5_test_${randomUUID().replaceAll('-', '')}`;
  const prefix = `phase5-test-${randomUUID()}`;
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const inviterId = randomUUID();
  const familyId = randomUUID();
  const personalId = randomUUID();
  const createdAt = '2090-01-01T12:00:00.000Z';
  const resolvedAt = '2090-01-02T12:00:00.000Z';

  beforeAll(async () => {
    database = (await import('./pool')).pool;
    client = await database.connect();
    if (!/^phase5_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", pg_catalog`);
    await client.query('BEGIN');
    try {
      for (const filename of fs.readdirSync(migrationDirectory).filter((name) => /^00[1-6]_.*\.sql$/.test(name)).sort()) {
        const source = fs.readFileSync(path.join(migrationDirectory, filename), 'utf8');
        // PostgreSQL 16 supplies gen_random_uuid natively. Skip the extension DDL
        // from 001 so this suite never creates or changes a database-wide extension.
        const sql = source.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\r?\n/, '');
        await client.query(sql);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    for (const [id, label] of [[ownerId, 'owner'], [memberId, 'member'], [inviterId, 'inviter']]) {
      await client.query(
        'INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)',
        [id, `${prefix}-${label}@example.com`, 'unused-test-hash', `${prefix}-${label}`],
      );
    }
    for (const [id, type] of [[familyId, 'family'], [personalId, 'personal']]) {
      await client.query(
        'INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, $3, $4)',
        [id, prefix, type, ownerId],
      );
      await client.query(
        `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
         VALUES ($1, $2, 'owner', 'active', NOW())`, [id, ownerId],
      );
    }
  });

  afterEach(async () => {
    if (client) await client.query('ROLLBACK');
  });

  afterAll(async () => {
    try {
      if (client) {
        await client.query('ROLLBACK');
        await client.query('RESET search_path');
        if (!/^phase5_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Unsafe test schema');
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        const remaining = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM pg_namespace WHERE nspname = $1', [schema],
        );
        expect(remaining.rows[0].count).toBe('0');
      }
    } finally {
      client?.release();
      if (database) await database.end();
    }
  });

  async function expectRejected(operation: () => Promise<unknown>, expected: Record<string, unknown>) {
    await client.query('SAVEPOINT rejected_operation');
    let failure: unknown;
    try {
      await operation();
    } catch (error) {
      failure = error;
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT rejected_operation');
      await client.query('RELEASE SAVEPOINT rejected_operation');
    }
    expect(failure).toMatchObject(expected);
  }

  async function insertInvitation(overrides: Partial<InvitationInput> = {}) {
    const input: InvitationInput = {
      groupId: familyId,
      invitedBy: inviterId,
      email: `${randomUUID()}@example.com`,
      tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
      status: 'pending',
      acceptedBy: null,
      createdAt,
      expiresAt: '2090-01-08T12:00:00.000Z',
      resolvedAt: null,
      ...overrides,
    };
    const result = await client.query<{ id: string; email: string; status: string; accepted_by: string | null }>(
      `INSERT INTO group_invitations (
         group_id, invited_by, email, token_hash, status, accepted_by, created_at, expires_at, resolved_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz)
       RETURNING id, email, status, accepted_by`,
      [input.groupId, input.invitedBy, input.email, input.tokenHash, input.status,
        input.acceptedBy, input.createdAt, input.expiresAt, input.resolvedAt],
    );
    return result.rows[0];
  }

  async function assert007Absent() {
    const objects = await client.query<{ table_present: boolean; enum_present: boolean; index_present: boolean; check_present: boolean }>(
      `SELECT
         to_regclass('group_invitations') IS NOT NULL AS table_present,
         EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = $1 AND t.typname = 'group_invitation_status') AS enum_present,
         to_regclass('idx_group_members_one_active_owner') IS NOT NULL AS index_present,
         EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'group_members'::regclass
                 AND conname = 'group_members_owner_is_active') AS check_present`, [schema],
    );
    expect(objects.rows[0]).toEqual({ table_present: false, enum_present: false, index_present: false, check_present: false });
  }

  it('preserves personal data and permits the existing registration writes', async () => {
    await client.query(migration007);
    const personal = await client.query<{ owner_id: string; role: string; status: string }>(
      `SELECT g.owner_id, gm.role, gm.status FROM groups g
       JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = g.owner_id WHERE g.id = $1`, [personalId],
    );
    expect(personal.rows).toEqual([{ owner_id: ownerId, role: 'owner', status: 'active' }]);
    const registeredGroupId = randomUUID();
    await client.query("INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, 'personal', $3)", [registeredGroupId, prefix, memberId]);
    await client.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'owner', 'active', NOW())`, [registeredGroupId, memberId],
    );
    const result = await client.query('SELECT user_id FROM group_members WHERE group_id = $1', [registeredGroupId]);
    expect(result.rows).toEqual([{ user_id: memberId }]);
  });

  it('rejects a second active owner', async () => {
    await client.query(migration007);
    await expectRejected(() => client.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'owner', 'active', NOW())`, [familyId, memberId],
    ), { code: '23505', constraint: 'idx_group_members_one_active_owner' });
  });

  it.each(['invited', 'removed'])('rejects an owner with %s status', async (status) => {
    await client.query(migration007);
    await expectRejected(() => client.query(
      'UPDATE group_members SET status = $2 WHERE group_id = $1 AND user_id = $3', [familyId, status, ownerId],
    ), { code: '23514', constraint: 'group_members_owner_is_active' });
  });

  it('allows ownership transfer in the planned transactional order', async () => {
    await client.query(migration007);
    await client.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'member', 'active', NOW())`, [familyId, memberId],
    );
    await client.query("UPDATE group_members SET role = 'member' WHERE group_id = $1 AND user_id = $2", [familyId, ownerId]);
    await client.query("UPDATE group_members SET role = 'owner' WHERE group_id = $1 AND user_id = $2", [familyId, memberId]);
    await client.query('UPDATE groups SET owner_id = $2 WHERE id = $1', [familyId, memberId]);
    const result = await client.query(
      `SELECT g.owner_id, gm.user_id FROM groups g JOIN group_members gm ON gm.group_id = g.id
       WHERE g.id = $1 AND gm.role = 'owner' AND gm.status = 'active'`, [familyId],
    );
    expect(result.rows).toEqual([{ owner_id: memberId, user_id: memberId }]);
  });

  it.each(['active', 'invited', 'removed'])('keeps ordinary member status %s valid', async (status) => {
    await client.query(migration007);
    const result = await client.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'member', $3, NOW()) RETURNING status`, [familyId, memberId, status],
    );
    expect(result.rows).toEqual([{ status }]);
  });

  it.each(['pending', 'accepted', 'declined', 'revoked', 'expired'] as const)('accepts coherent invitation state %s', async (status) => {
    await client.query(migration007);
    const invitation = await insertInvitation({
      status, acceptedBy: status === 'accepted' ? memberId : null, resolvedAt: status === 'pending' ? null : resolvedAt,
    });
    expect(invitation.status).toBe(status);
    expect(invitation.accepted_by).toBe(status === 'accepted' ? memberId : null);
  });

  const invalidInvitations: [string, Partial<InvitationInput>, string][] = [
    ['uppercase email', { email: 'Person@example.com' }, 'group_invitations_email_normalized'],
    ['untrimmed email', { email: ' person@example.com ' }, 'group_invitations_email_normalized'],
    ['tab-wrapped email', { email: '\tperson@example.com\t' }, 'group_invitations_email_normalized'],
    ['newline-wrapped email', { email: '\nperson@example.com\r\n' }, 'group_invitations_email_normalized'],
    ['nonbreaking-space-wrapped email', { email: '\u00a0person@example.com\u00a0' }, 'group_invitations_email_normalized'],
    ['BOM-wrapped email', { email: '\ufeffperson@example.com\ufeff' }, 'group_invitations_email_normalized'],
    ['whitespace-only email', { email: '\t\n\u00a0\ufeff' }, 'group_invitations_email_normalized'],
    ['empty email', { email: '' }, 'group_invitations_email_normalized'],
    ['email longer than 254', { email: `${'a'.repeat(243)}@example.com` }, 'group_invitations_email_normalized'],
    ['short hash', { tokenHash: 'a'.repeat(63) }, 'group_invitations_token_hash_valid'],
    ['non-hex hash', { tokenHash: 'g'.repeat(64) }, 'group_invitations_token_hash_valid'],
    ['expiry equal to creation', { expiresAt: createdAt }, 'group_invitations_expiry_valid'],
    ['expiry before creation', { expiresAt: '2089-12-31T12:00:00.000Z' }, 'group_invitations_expiry_valid'],
    ['pending with resolution date', { resolvedAt }, 'group_invitations_resolution_consistent'],
    ['accepted without resolution date', { status: 'accepted', acceptedBy: memberId }, 'group_invitations_resolution_consistent'],
    ['declined without resolution date', { status: 'declined' }, 'group_invitations_resolution_consistent'],
    ['revoked without resolution date', { status: 'revoked' }, 'group_invitations_resolution_consistent'],
    ['expired without resolution date', { status: 'expired' }, 'group_invitations_resolution_consistent'],
    ['accepted without accepting user', { status: 'accepted', resolvedAt }, 'group_invitations_acceptance_consistent'],
    ['pending with accepting user', { acceptedBy: memberId }, 'group_invitations_acceptance_consistent'],
    ['declined with accepting user', { status: 'declined', resolvedAt, acceptedBy: memberId }, 'group_invitations_acceptance_consistent'],
    ['revoked with accepting user', { status: 'revoked', resolvedAt, acceptedBy: memberId }, 'group_invitations_acceptance_consistent'],
    ['expired with accepting user', { status: 'expired', resolvedAt, acceptedBy: memberId }, 'group_invitations_acceptance_consistent'],
  ];
  it.each(invalidInvitations)('rejects %s', async (_label, input, constraint) => {
    await client.query(migration007);
    await expectRejected(() => insertInvitation(input), { code: '23514', constraint });
  });

  it('accepts a normalized email of 254 characters', async () => {
    await client.query(migration007);
    const email = `${'a'.repeat(242)}@example.com`;
    expect(email.length).toBe(254);
    expect((await insertInvitation({ email })).email).toBe(email);
  });

  it('rejects a reused hash across invitations', async () => {
    await client.query(migration007);
    const tokenHash = createHash('sha256').update(randomUUID()).digest('hex');
    await insertInvitation({ tokenHash });
    await expectRejected(() => insertInvitation({ tokenHash }), { code: '23505', constraint: 'group_invitations_token_hash_unique' });
  });

  it('allows the same pending email in different groups', async () => {
    await client.query(migration007);
    const email = 'future-user@example.com';
    await insertInvitation({ email });
    const otherFamilyId = randomUUID();
    await client.query("INSERT INTO groups (id, name, type, owner_id) VALUES ($1, $2, 'family', $3)", [otherFamilyId, prefix, ownerId]);
    await client.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'owner', 'active', NOW())`, [otherFamilyId, ownerId],
    );
    expect((await insertInvitation({ email, groupId: otherFamilyId })).email).toBe(email);
  });

  it('requires materializing expiry before reinviting the same email', async () => {
    await client.query(migration007);
    const email = 'future-user@example.com';
    // Expired by wall clock, but still pending in SQL: the unique predicate is state-based.
    const old = await insertInvitation({ email, createdAt: '2000-01-01T00:00:00.000Z', expiresAt: '2000-01-08T00:00:00.000Z' });
    await expectRejected(() => insertInvitation({ email }), { code: '23505', constraint: 'idx_group_invitations_one_pending_email' });
    await client.query("UPDATE group_invitations SET status = 'expired', resolved_at = NOW() WHERE id = $1", [old.id]);
    expect((await insertInvitation({ email })).status).toBe('pending');
    const history = await client.query('SELECT status FROM group_invitations WHERE id = $1', [old.id]);
    expect(history.rows).toEqual([{ status: 'expired' }]);
  });

  it.each([
    ['group', { groupId: randomUUID() }, 'group_invitations_group_id_fkey'],
    ['inviter', { invitedBy: randomUUID() }, 'group_invitations_invited_by_fkey'],
    ['accepting user', { status: 'accepted', resolvedAt, acceptedBy: randomUUID() }, 'group_invitations_accepted_by_fkey'],
  ] as [string, Partial<InvitationInput>, string][])('rejects an invitation referencing a missing %s', async (_label, input, constraint) => {
    await client.query(migration007);
    await expectRejected(() => insertInvitation(input), { code: '23503', constraint });
  });

  it.each([
    ['group', 'DELETE FROM groups WHERE id = $1', familyId, 'group_invitations_group_id_fkey'],
    ['inviter', 'DELETE FROM users WHERE id = $1', inviterId, 'group_invitations_invited_by_fkey'],
    ['accepting user', 'DELETE FROM users WHERE id = $1', memberId, 'group_invitations_accepted_by_fkey'],
  ])('retains invitation history when deleting its %s', async (_label, sql, id, constraint) => {
    await client.query(migration007);
    const invitation = await insertInvitation({ status: 'accepted', acceptedBy: memberId, resolvedAt });
    await expectRejected(() => client.query(sql, [id]), { code: '23503', constraint });
    expect((await client.query('SELECT id FROM group_invitations WHERE id = $1', [invitation.id])).rowCount).toBe(1);
  });

  it.each(['missing', 'mismatched', 'multiple', 'inactive'] as const)('stops on %s ownership without applying schema changes', async (condition) => {
    if (condition === 'missing') {
      await client.query('DELETE FROM group_members WHERE group_id = $1', [familyId]);
    } else if (condition === 'mismatched') {
      await client.query('UPDATE groups SET owner_id = $2 WHERE id = $1', [familyId, memberId]);
    } else if (condition === 'multiple') {
      await client.query(
        `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
         VALUES ($1, $2, 'owner', 'active', NOW())`, [familyId, memberId],
      );
    } else {
      await client.query("UPDATE group_members SET status = 'removed' WHERE group_id = $1", [familyId]);
    }
    await expectRejected(() => client.query(migration007), {
      code: 'P0001', message: expect.stringContaining('Migration 007 precondition failed:'),
    });
    await assert007Absent();
    expect((await client.query('SELECT id FROM groups WHERE id = $1', [familyId])).rowCount).toBe(1);
  });

  it('stops on existing family payments without deleting or inventing payment history', async () => {
    const subscription = await client.query<{ id: string }>(
      `INSERT INTO subscriptions (
         group_id, name, provider, expected_cost, billing_cycle, next_billing_date, active
       ) VALUES ($1, $2, 'Test', '10.00', 'monthly', '9999-12-31', FALSE) RETURNING id`, [familyId, prefix],
    );
    const payment = await client.query<{ id: string }>(
      `INSERT INTO payments (subscription_id, expected_date, expected_amount)
       VALUES ($1, '2090-01-01', '10.00') RETURNING id`, [subscription.rows[0].id],
    );
    await expectRejected(() => client.query(migration007), {
      code: 'P0001', message: expect.stringContaining('existing_family_payments=1'),
    });
    await assert007Absent();
    expect((await client.query('SELECT id FROM payments WHERE id = $1', [payment.rows[0].id])).rows).toEqual([payment.rows[0]]);
    expect((await client.query("SELECT to_regclass('payment_shares') AS shares")).rows).toEqual([{ shares: null }]);
  });
});
