import crypto from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../../config/env';
import type { AccessTokenPayload } from './auth.types';

export const BCRYPT_COST = 12;

/** Hashes the opaque cookie value; the raw refresh token never reaches the database. */
export function hashRefreshToken(rawToken: string): string {
  return crypto.createHash('sha256')
    .update(`${rawToken}:${env.jwtRefreshSecret}`)
    .digest('hex');
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function createFamilyId(): string {
  return crypto.randomUUID();
}

export function durationToMs(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * multipliers[match[2] as keyof typeof multipliers];
}

/** Creates the short-lived JWT used in the Authorization header. */
export function signAccessToken(user: { id: string; email: string }): string {
  const payload: AccessTokenPayload = { sub: user.id, email: user.email, type: 'access' };
  return jwt.sign(payload, env.jwtAccessSecret, {
    algorithm: 'HS256',
    expiresIn: env.jwtAccessExpiresIn as SignOptions['expiresIn'],
  });
}

/** Verifies both the signature and the application-specific access-token claims. */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, env.jwtAccessSecret, { algorithms: ['HS256'] });
  if (
    typeof payload === 'string'
    || payload.type !== 'access'
    || typeof payload.sub !== 'string'
    || !/^[0-9a-f-]{36}$/i.test(payload.sub)
    || typeof payload.email !== 'string'
  ) {
    throw new Error('Invalid access token claims');
  }
  return { sub: payload.sub, email: payload.email, type: 'access' };
}

export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'lax' as const,
    maxAge: durationToMs(env.jwtRefreshExpiresIn),
    path: '/auth',
  };
}
