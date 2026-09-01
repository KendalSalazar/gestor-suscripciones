import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import {
  BCRYPT_COST,
  durationToMs,
  generateRefreshToken,
  hashRefreshToken,
  verifyAccessToken,
} from './auth.tokens';
import { loginSchema, registerSchema } from './auth.schemas';

describe('auth foundations', () => {
  it('normalizes the registration email', () => {
    const result = registerSchema.parse({
      email: ' Ada@Example.com ',
      password: 'secret123',
      name: 'Ada',
    });

    expect(result.email).toBe('ada@example.com');
  });

  it('rejects passwords shorter than eight characters', () => {
    const result = registerSchema.safeParse({
      email: 'ada@example.com',
      password: 'short',
      name: 'Ada',
    });
    expect(result.success).toBe(false);
  });

  it('creates unpredictable refresh tokens and hashes them deterministically', () => {
    const first = generateRefreshToken();
    const second = generateRefreshToken();

    expect(first).not.toBe(second);
    expect(hashRefreshToken(first)).toBe(hashRefreshToken(first));
    expect(hashRefreshToken(first)).not.toBe(hashRefreshToken(second));
    expect(hashRefreshToken(first)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('converts supported durations to milliseconds', () => {
    expect(durationToMs('15m')).toBe(900_000);
    expect(durationToMs('7d')).toBe(604_800_000);
    expect(() => durationToMs('invalid')).toThrow();
  });

  it('rejects access tokens with the wrong type claim', () => {
    expect(BCRYPT_COST).toBe(12);
    const token = jwt.sign(
      {
        sub: '00000000-0000-4000-8000-000000000000',
        email: 'ada@example.com',
        type: 'refresh',
      },
      env.jwtAccessSecret,
      { algorithm: 'HS256' },
    );
    expect(() => verifyAccessToken(token)).toThrow();
  });

  it('rejects a registration name containing only spaces', () => {
    const result = registerSchema.safeParse({
      email: 'ada@example.com',
      password: 'secret123',
      name: '   ',
    });
    expect(result.success).toBe(false);
  });
});
