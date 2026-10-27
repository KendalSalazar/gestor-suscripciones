import { describe, expect, it, vi } from 'vitest';

vi.mock('./env', () => ({ env: { isProd: false, logLevel: 'error' } }));

import { sanitizeMeta } from './logger';

describe('logger metadata redaction', () => {
  const keys = [
    'token', 'token_hash', 'tokenhash', 'invitation_token', 'invitationtoken',
    'invitation_code', 'invitationcode', 'tokenHash', 'invitationToken', 'invitationCode',
  ];

  it.each(keys)('redacts the %s key without mutating the original metadata', (key) => {
    const original = { [key]: 'dummy-secret-for-tests', operation: 'test' };
    expect(sanitizeMeta(original)).toEqual({ [key]: '[REDACTED]', operation: 'test' });
    expect(original[key]).toBe('dummy-secret-for-tests');
  });

  it('redacts invitation secrets recursively in objects and arrays', () => {
    const metadata = {
      operation: 'test', nested: { TOKEN_HASH: 'dummy-hash', children: [
        { invitation_token: 'dummy-token', value: 7 },
        { invitationCode: 'dummy-code', more: { token: 'dummy-token' } },
      ] },
    };
    expect(sanitizeMeta(metadata)).toEqual({
      operation: 'test', nested: { TOKEN_HASH: '[REDACTED]', children: [
        { invitation_token: '[REDACTED]', value: 7 },
        { invitationCode: '[REDACTED]', more: { token: '[REDACTED]' } },
      ] },
    });
  });

  it('retains harmless primitives and ordinary metadata', () => {
    expect(sanitizeMeta({ count: 3, success: true, missing: null, tags: ['test', 5] }))
      .toEqual({ count: 3, success: true, missing: null, tags: ['test', 5] });
  });
});
