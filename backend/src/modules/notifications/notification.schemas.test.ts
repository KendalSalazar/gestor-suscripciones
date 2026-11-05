import { describe, expect, it } from 'vitest';
import { notificationQuerySchema } from './notification.schemas';

const id = '11111111-1111-4111-8111-111111111111';
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('notification query cursor', () => {
  it('decodes a valid millisecond timestamp and UUID without losing precision', () => {
    const payload = { createdAt: '2026-11-05T23:59:59.123Z', id };
    expect(notificationQuerySchema.parse({ cursor: encode(payload) })).toEqual({ status: 'all', cursor: payload });
  });

  it.each([
    { createdAt: '0000-01-01T00:00:00.000Z', id },
    { createdAt: '2026-02-30T00:00:00.000Z', id },
    { createdAt: '2026-11-05T23:59:59.123Z', id: 'invalid' },
    { createdAt: '2026-11-05T23:59:59.123Z', id, extra: true },
  ])('rejects a cursor with an invalid payload %#', (payload) => {
    expect(notificationQuerySchema.safeParse({ cursor: encode(payload) }).success).toBe(false);
  });
});
