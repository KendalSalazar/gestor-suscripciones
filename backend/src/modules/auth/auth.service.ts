import bcrypt from 'bcrypt';
import type { PoolClient } from 'pg';
import { env } from '../../config/env';
import { authLogger } from '../../config/logger';
import { pool } from '../../db/pool';
import { AppError } from '../../middleware/errorHandler';
import { BCRYPT_COST, createFamilyId, durationToMs, generateRefreshToken, hashRefreshToken, signAccessToken } from './auth.tokens';
import type { LoginInput, RegisterInput } from './auth.schemas';
import type { AuthResult, PublicUser } from './auth.types';

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-not-used', BCRYPT_COST);

type UserRow = PublicUser & { password_hash: string };
type RefreshRow = {
  id: string;
  user_id: string;
  family_id: string;
  email: string;
  expires_at: Date;
  revoked_at: Date | null;
};

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function asPublicUser(row: PublicUser): PublicUser {
  return { id: row.id, email: row.email, name: row.name };
}

async function insertRefreshToken(
  client: PoolClient,
  userId: string,
  familyId: string,
  rawToken: string,
  expiresAt: Date,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userId, familyId, hashRefreshToken(rawToken), expiresAt],
  );
  return result.rows[0].id;
}

async function createSession(client: PoolClient, userId: string): Promise<string> {
  const rawToken = generateRefreshToken();
  const familyId = createFamilyId();
  const expiresAt = new Date(Date.now() + durationToMs(env.jwtRefreshExpiresIn));
  await insertRefreshToken(client, userId, familyId, rawToken, expiresAt);
  return rawToken;
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  const client = await pool.connect();

  try {
    // The user, personal group, owner membership and first session succeed or fail together.
    await client.query('BEGIN');
    const userResult = await client.query<PublicUser>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       RETURNING id, email, name`,
      [input.email, passwordHash, input.name],
    );
    const user = asPublicUser(userResult.rows[0]);
    const groupResult = await client.query<{ id: string }>(
      `INSERT INTO groups (name, type, owner_id)
       VALUES ('Personal', 'personal', $1)
       RETURNING id`,
      [user.id],
    );
    await client.query(
      `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'owner', 'active', NOW())`,
      [groupResult.rows[0].id, user.id],
    );
    const refreshToken = await createSession(client, user.id);
    await client.query('COMMIT');

    authLogger.info('Registration succeeded', { userId: user.id });
    return { user, accessToken: signAccessToken(user), refreshToken };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (isUniqueViolation(error)) {
      authLogger.warn('Registration duplicate');
      throw new AppError(409, 'Email already registered');
    }
    authLogger.error('Registration failed', {
      message: error instanceof Error ? error.message : 'Unknown registration error',
    });
    throw error;
  } finally {
    client.release();
  }
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const result = await pool.query<UserRow>(
    `SELECT id, email, name, password_hash FROM users WHERE email = $1`,
    [input.email],
  );
  const row = result.rows[0];
  const passwordMatches = await bcrypt.compare(input.password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!row || !passwordMatches) {
    authLogger.warn('Login failed', { reason: 'invalid_credentials' });
    throw new AppError(401, 'Invalid credentials');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const refreshToken = await createSession(client, row.id);
    await client.query('COMMIT');
    const user = asPublicUser(row);
    authLogger.info('Login succeeded', { userId: user.id });
    return { user, accessToken: signAccessToken(user), refreshToken };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function refresh(rawToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the token row so two simultaneous refresh requests cannot rotate it twice.
    const result = await client.query<RefreshRow>(
      `SELECT rt.id, rt.user_id, rt.family_id, rt.expires_at, rt.revoked_at, u.email
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1
       FOR UPDATE`,
      [hashRefreshToken(rawToken)],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      authLogger.warn('Refresh invalid', { reason: 'unknown' });
      throw new AppError(401, 'Invalid or expired refresh token');
    }
    if (row.revoked_at) {
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, NOW())
         WHERE family_id = $1 AND revoked_at IS NULL`,
        [row.family_id],
      );
      await client.query('COMMIT');
      authLogger.warn('Refresh reuse detected', { userId: row.user_id, familyId: row.family_id });
      throw new AppError(401, 'Invalid or expired refresh token');
    }
    if (row.expires_at <= new Date()) {
      await client.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [row.id]);
      await client.query('COMMIT');
      authLogger.warn('Refresh invalid', { reason: 'expired' });
      throw new AppError(401, 'Invalid or expired refresh token');
    }

    // Rotation revokes the current token and links it to its successor.
    const newRawToken = generateRefreshToken();
    const newId = await insertRefreshToken(
      client,
      row.user_id,
      row.family_id,
      newRawToken,
      new Date(Date.now() + durationToMs(env.jwtRefreshExpiresIn)),
    );
    await client.query(
      'UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = $1 WHERE id = $2',
      [newId, row.id],
    );
    await client.query('COMMIT');
    authLogger.info('Refresh succeeded', { userId: row.user_id });
    return {
      accessToken: signAccessToken({ id: row.user_id, email: row.email }),
      refreshToken: newRawToken,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function logout(rawToken?: string): Promise<string | undefined> {
  if (!rawToken) {
    authLogger.info('Logout succeeded');
    return undefined;
  }

  const result = await pool.query<{ user_id: string }>(
    `UPDATE refresh_tokens SET revoked_at = NOW()
     WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING user_id`,
    [hashRefreshToken(rawToken)],
  );
  const userId = result.rows[0]?.user_id;
  authLogger.info('Logout succeeded', userId ? { userId } : undefined);
  return userId;
}
