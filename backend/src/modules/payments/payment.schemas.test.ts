import { describe, expect, it } from 'vitest';
import { confirmPaymentSchema, paymentParamsSchema, paymentQuerySchema, skipPaymentSchema } from './payment.schemas';

describe('payment query validation', () => {
  it('allows listing without a status filter', () => {
    expect(paymentQuerySchema.parse({})).toEqual({});
  });

  it.each(['pending', 'confirmed', 'skipped'])('allows status %s', (status) => {
    expect(paymentQuerySchema.parse({ status })).toEqual({ status });
  });

  it.each([
    { status: 'paid' },
    { status: '' },
    { status: ['pending', 'confirmed'] },
    { status: 'pending', groupId: 'another-group' },
    { limit: '1000' },
  ])('rejects invalid or unknown query fields: %j', (query) => {
    expect(paymentQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('payment resolution validation', () => {
  it.each(['0', '0.00', '17.9', '17.99', '9999999999.99', '00017.99'])('accepts decimal string %s', (actualAmount) => {
    expect(confirmPaymentSchema.parse({ actualAmount })).toEqual({ actualAmount });
  });

  it('allows the expected amount to be used when no actual amount is sent', () => {
    expect(confirmPaymentSchema.parse({})).toEqual({});
  });

  it.each([-1, 17.99, null, '-1', '17.999', '10000000000', '1e2', 'NaN', 'Infinity', '', ' 17.99', '.99'])('rejects invalid amount %j', (actualAmount) => {
    expect(confirmPaymentSchema.safeParse({ actualAmount }).success).toBe(false);
  });

  it('rejects protected fields, arrays and null bodies', () => {
    expect(confirmPaymentSchema.safeParse({ status: 'confirmed' }).success).toBe(false);
    expect(confirmPaymentSchema.safeParse([]).success).toBe(false);
    expect(confirmPaymentSchema.safeParse(null).success).toBe(false);
  });

  it('accepts an empty skip body and rejects supplied fields', () => {
    expect(skipPaymentSchema.parse(undefined)).toEqual({});
    expect(skipPaymentSchema.parse({})).toEqual({});
    expect(skipPaymentSchema.safeParse({ actualAmount: '17.99' }).success).toBe(false);
  });

  it('validates both UUID parameters', () => {
    const params = {
      groupId: '08dc3ad7-cf55-4199-9fa3-594003beef20',
      paymentId: 'c3f47c53-b125-4e3e-b04d-e2c9a6b31351',
    };
    expect(paymentParamsSchema.safeParse(params).success).toBe(true);
    expect(paymentParamsSchema.safeParse({ ...params, groupId: 'invalid' }).success).toBe(false);
    expect(paymentParamsSchema.safeParse({ ...params, paymentId: 'invalid' }).success).toBe(false);
  });
});
