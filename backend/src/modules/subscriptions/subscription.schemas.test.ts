import { describe, expect, it } from 'vitest';
import {
  createSubscriptionSchema,
  subscriptionQuerySchema,
  updateSubscriptionSchema,
} from './subscription.schemas';
import { toIsoDate } from './subscription.types';

const validSubscription = {
  name: ' Plan Premium ',
  provider: ' Netflix ',
  expectedCost: '17.9',
  billingCycle: 'monthly',
  nextBillingDate: '2026-10-01',
};

describe('subscription schemas', () => {
  it('trims names and normalizes money to two decimal places', () => {
    const result = createSubscriptionSchema.parse(validSubscription);

    expect(result.name).toBe('Plan Premium');
    expect(result.provider).toBe('Netflix');
    expect(result.expectedCost).toBe('17.90');
  });

  it('rejects a negative cost', () => {
    expect(createSubscriptionSchema.safeParse({
      ...validSubscription,
      expectedCost: -1,
    }).success).toBe(false);
  });

  it('rejects a cost with more than two decimal places or above NUMERIC(12, 2)', () => {
    expect(createSubscriptionSchema.safeParse({
      ...validSubscription,
      expectedCost: '17.999',
    }).success).toBe(false);
    expect(createSubscriptionSchema.safeParse({
      ...validSubscription,
      expectedCost: '10000000000.00',
    }).success).toBe(false);
  });

  it('rejects an unsupported billing cycle', () => {
    expect(createSubscriptionSchema.safeParse({
      ...validSubscription,
      billingCycle: 'custom',
    }).success).toBe(false);
  });

  it('rejects an impossible calendar date', () => {
    expect(createSubscriptionSchema.safeParse({
      ...validSubscription,
      nextBillingDate: '2026-02-30',
    }).success).toBe(false);
  });

  it('requires at least one field in a partial update', () => {
    expect(updateSubscriptionSchema.safeParse({}).success).toBe(false);
    expect(updateSubscriptionSchema.safeParse({ active: false }).success).toBe(true);
  });

  it('rejects unknown fields instead of accepting protected properties', () => {
    expect(updateSubscriptionSchema.safeParse({ groupId: 'attacker-value' }).success).toBe(false);
  });

  it('transforms the active query filter explicitly', () => {
    expect(subscriptionQuerySchema.parse({ active: 'true' })).toEqual({ active: true });
    expect(subscriptionQuerySchema.parse({ active: 'false' })).toEqual({ active: false });
    expect(subscriptionQuerySchema.safeParse({ active: 'yes' }).success).toBe(false);
  });

  it('preserves a DATE as YYYY-MM-DD without a timezone shift', () => {
    expect(toIsoDate(new Date('2026-10-01T00:00:00.000Z'))).toBe('2026-10-01');
    expect(toIsoDate('2026-10-01')).toBe('2026-10-01');
  });
});
