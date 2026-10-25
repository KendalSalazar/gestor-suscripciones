import { describe, expect, it } from 'vitest';
import { splitPaymentEqually } from './payment-sharing';

const users = Array.from({ length: 21 }, (_, index) => (
  `aaaaaaaa-aaaa-4aaa-8aaa-${(index + 1).toString(16).padStart(12, '0')}`
));
const threeUsers = users.slice(0, 3);

function toUnits(value: string): bigint {
  return BigInt(value.replace('.', ''));
}

describe('splitPaymentEqually', () => {
  it('allocates the extra cent and percentage unit to the first canonical UUID', () => {
    expect(splitPaymentEqually('10.00', [users[2], users[0], users[1]])).toEqual([
      { userId: users[0], shareAmount: '3.34', sharePercentage: '33.3334' },
      { userId: users[1], shareAmount: '3.33', sharePercentage: '33.3333' },
      { userId: users[2], shareAmount: '3.33', sharePercentage: '33.3333' },
    ]);
  });

  it('preserves a single cent split between three people, including zero shares', () => {
    expect(splitPaymentEqually('0.01', threeUsers)).toEqual([
      { userId: users[0], shareAmount: '0.01', sharePercentage: '33.3334' },
      { userId: users[1], shareAmount: '0.00', sharePercentage: '33.3333' },
      { userId: users[2], shareAmount: '0.00', sharePercentage: '33.3333' },
    ]);
  });

  it('allocates a remainder of more than one cent to different participants', () => {
    expect(splitPaymentEqually('0.02', threeUsers).map((share) => share.shareAmount)).toEqual(['0.01', '0.01', '0.00']);
  });

  it('keeps zero amounts while still allocating the full percentage', () => {
    const shares = splitPaymentEqually('0.00', threeUsers);
    expect(shares.map((share) => share.shareAmount)).toEqual(['0.00', '0.00', '0.00']);
    expect(shares.map((share) => share.sharePercentage)).toEqual(['33.3334', '33.3333', '33.3333']);
  });

  it('gives the full amount and 100 percent to a single participant', () => {
    expect(splitPaymentEqually('9999999999.99', [users[0]])).toEqual([
      { userId: users[0], shareAmount: '9999999999.99', sharePercentage: '100.0000' },
    ]);
  });

  it.each([
    ['10', '10.00'],
    ['10.1', '10.10'],
    ['00010.01', '10.01'],
    ['0000', '0.00'],
  ])('normalizes the valid input %s to two decimals', (input, expected) => {
    expect(splitPaymentEqually(input, [users[0]])[0].shareAmount).toBe(expected);
  });

  it('normalizes UUID casing and gives the same result for every input permutation', () => {
    const expected = splitPaymentEqually('10.00', threeUsers);
    const permutations = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ];
    for (const order of permutations) {
      expect(splitPaymentEqually('10.00', order.map((index) => users[index].toUpperCase()))).toEqual(expected);
    }
  });

  it('does not mutate the caller array and returns JSON-serializable strings', () => {
    const participants = Object.freeze([users[2], users[0], users[1]]);
    const shares = splitPaymentEqually('10.00', participants);
    expect(participants).toEqual([users[2], users[0], users[1]]);
    expect(JSON.parse(JSON.stringify(shares))).toEqual(shares);
    expect(shares.every((share) => Object.values(share).every((value) => typeof value === 'string'))).toBe(true);
  });

  it.each(Array.from({ length: 20 }, (_, index) => index + 1))(
    'conserves exact totals and balances shares for %i participants',
    (count) => {
      const participants = users.slice(0, count);
      for (const amount of ['0.00', '0.01', '0.02', '0.19', '0.20', '10.00', '10.01', '9999999999.99']) {
        const shares = splitPaymentEqually(amount, [...participants].reverse());
        const cents = shares.map((share) => toUnits(share.shareAmount));
        const percentages = shares.map((share) => toUnits(share.sharePercentage));
        expect(shares.map((share) => share.userId)).toEqual(participants);
        expect(shares).toHaveLength(count);
        expect(cents.reduce((sum, value) => sum + value, 0n)).toBe(toUnits(amount));
        expect(percentages.reduce((sum, value) => sum + value, 0n)).toBe(1_000_000n);
        expect(cents.every((value) => value >= 0n)).toBe(true);
        expect(percentages.every((value) => value >= 0n && value <= 1_000_000n)).toBe(true);
        for (const values of [cents, percentages]) {
          const smallest = values.reduce((minimum, value) => value < minimum ? value : minimum);
          const largest = values.reduce((maximum, value) => value > maximum ? value : maximum);
          expect(largest - smallest <= 1n).toBe(true);
        }
        expect(shares.every((share) => /^\d+\.\d{2}$/.test(share.shareAmount))).toBe(true);
        expect(shares.every((share) => /^\d+\.\d{4}$/.test(share.sharePercentage))).toBe(true);
      }
    },
  );

  it.each([
    '', '-0.01', '+1', 'NaN', 'Infinity', '1e2', '1,00', '.50', '1.', '1.001',
    ' 1', '1 ', '1\n', '1\r\n', '10000000000.00', '00010000000000.00',
  ])('rejects invalid or out-of-range amount %j', (amount) => {
    expect(() => splitPaymentEqually(amount, threeUsers)).toThrow(RangeError);
  });

  it('rejects a runtime number instead of silently rounding it', () => {
    expect(() => splitPaymentEqually(10.01 as unknown as string, threeUsers)).toThrow(RangeError);
  });

  it('rejects an empty group and more than twenty participants', () => {
    expect(() => splitPaymentEqually('10.00', [])).toThrow(RangeError);
    expect(() => splitPaymentEqually('10.00', users)).toThrow(RangeError);
  });

  it('rejects missing participant values, including holes in an array', () => {
    expect(() => splitPaymentEqually('10.00', [undefined as unknown as string])).toThrow(RangeError);
    expect(() => splitPaymentEqually('10.00', new Array<string>(1))).toThrow(RangeError);
  });

  it.each(['not-a-uuid', ' aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000g'])(
    'rejects invalid participant UUID %j',
    (userId) => {
      expect(() => splitPaymentEqually('10.00', [userId])).toThrow(RangeError);
    },
  );

  it('rejects duplicate UUIDs including different casing', () => {
    expect(() => splitPaymentEqually('10.00', [users[0], users[0]])).toThrow(RangeError);
    expect(() => splitPaymentEqually('10.00', [users[0], users[0].toUpperCase()])).toThrow(RangeError);
  });
});
