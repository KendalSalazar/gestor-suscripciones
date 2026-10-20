import { describe, expect, it } from 'vitest';
import { nextBillingDate, todayInTimeZone } from './billing-date';

describe('nextBillingDate', () => {
  it('adds seven calendar days for a weekly cycle', () => {
    expect(nextBillingDate('2026-12-29', 'weekly', 29)).toBe('2027-01-05');
  });

  it('returns to the anchor day after a short month', () => {
    const february = nextBillingDate('2026-01-31', 'monthly', 31);
    expect(february).toBe('2026-02-28');
    expect(nextBillingDate(february, 'monthly', 31)).toBe('2026-03-31');
  });

  it('uses February 29 in a leap year', () => {
    expect(nextBillingDate('2028-01-31', 'monthly', 31)).toBe('2028-02-29');
  });

  it('advances three months without losing the anchor day', () => {
    const april = nextBillingDate('2026-01-31', 'quarterly', 31);
    expect(april).toBe('2026-04-30');
    expect(nextBillingDate(april, 'quarterly', 31)).toBe('2026-07-31');
  });

  it('restores February 29 when a yearly cycle reaches the next leap year', () => {
    expect(nextBillingDate('2024-02-29', 'yearly', 29)).toBe('2025-02-28');
    expect(nextBillingDate('2027-02-28', 'yearly', 29)).toBe('2028-02-29');
  });

  it('rejects invalid dates and anchor days', () => {
    expect(() => nextBillingDate('2026-02-30', 'monthly', 30)).toThrow(RangeError);
    expect(() => nextBillingDate('2026-01-01', 'monthly', 0)).toThrow(RangeError);
    expect(() => nextBillingDate('2026-01-01', 'monthly', 32)).toThrow(RangeError);
    expect(() => nextBillingDate('2026-01-01', 'monthly', 1.5)).toThrow(RangeError);
  });

  it('uses the configured calendar day for payment generation', () => {
    const now = new Date('2026-10-15T02:00:00.000Z');
    expect(todayInTimeZone(now, 'America/Costa_Rica')).toBe('2026-10-14');
    expect(todayInTimeZone(now, 'UTC')).toBe('2026-10-15');
  });
});
