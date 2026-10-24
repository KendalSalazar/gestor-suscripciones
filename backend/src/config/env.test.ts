import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Loading configuration must never read the developer's .env file in these tests.
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

describe('payment timezone configuration', () => {
  beforeEach(() => {
    vi.resetModules();
    const testEnv = {
      NODE_ENV: 'test',
      PORT: '3001',
      DATABASE_URL: 'postgresql://localhost/payment_config_test',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'b'.repeat(32),
      JWT_ACCESS_EXPIRES_IN: '15m',
      JWT_REFRESH_EXPIRES_IN: '7d',
      LOG_LEVEL: 'info',
      LOG_DIR: 'test-logs',
    };
    for (const [name, value] of Object.entries(testEnv)) vi.stubEnv(name, value);
    vi.stubEnv('PAYMENT_TIME_ZONE', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to America/Costa_Rica', async () => {
    const { env } = await import('./env');
    expect(env.paymentTimeZone).toBe('America/Costa_Rica');
  });

  it('accepts a valid alternative IANA timezone', async () => {
    vi.stubEnv('PAYMENT_TIME_ZONE', 'Asia/Tokyo');
    const { env } = await import('./env');
    expect(env.paymentTimeZone).toBe('Asia/Tokyo');
  });

  it('rejects an invalid timezone during configuration loading', async () => {
    vi.stubEnv('PAYMENT_TIME_ZONE', 'Invalid/Timezone');
    await expect(import('./env')).rejects.toThrow('PAYMENT_TIME_ZONE must be a valid IANA time zone');
  });
});
