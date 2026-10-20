import type { BillingCycle } from '../subscriptions/subscription.types';

function parseIsoDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError('Billing date must use YYYY-MM-DD');
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1) throw new RangeError('Invalid billing date');

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new RangeError('Invalid billing date');
  }

  return date;
}

function formatIsoDate(date: Date): string {
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) throw new RangeError('Billing date is out of range');

  return [
    String(year).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

export function nextBillingDate(
  currentDate: string,
  billingCycle: BillingCycle,
  anchorDay: number,
): string {
  const date = parseIsoDate(currentDate);
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new RangeError('Billing anchor day must be between 1 and 31');
  }

  if (billingCycle === 'weekly') {
    date.setUTCDate(date.getUTCDate() + 7);
    return formatIsoDate(date);
  }

  const monthsToAdd = {
    monthly: 1,
    quarterly: 3,
    yearly: 12,
  }[billingCycle];
  if (!monthsToAdd) throw new RangeError('Invalid billing cycle');

  const targetMonthIndex = date.getUTCFullYear() * 12 + date.getUTCMonth() + monthsToAdd;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12;
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(targetYear, targetMonth + 1, 0);

  // Reuse the original day each cycle, even if a shorter month required clamping.
  const nextDate = new Date(0);
  nextDate.setUTCFullYear(targetYear, targetMonth, Math.min(anchorDay, lastDay.getUTCDate()));
  return formatIsoDate(nextDate);
}

export function todayInTimeZone(now: Date, timeZone: string): string {
  if (Number.isNaN(now.getTime())) throw new RangeError('Invalid current time');

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const getPart = (type: 'year' | 'month' | 'day'): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) throw new RangeError('Could not format payment date');
    return value;
  };

  return [getPart('year'), getPart('month'), getPart('day')].join('-');
}
