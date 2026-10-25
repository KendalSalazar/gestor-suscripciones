import { z } from 'zod';

const participantIdSchema = z.string().uuid();
const MAX_PARTICIPANTS = 20;
const TOTAL_PERCENTAGE_UNITS = 1_000_000n; // 100.0000%, in units of 0.0001%.

export type PaymentShareAllocation = {
  userId: string;
  shareAmount: string;
  sharePercentage: string;
};

/** Calculate an equal split without reading or changing database state. */
export function splitPaymentEqually(
  expectedAmount: string,
  participantIds: readonly string[],
): PaymentShareAllocation[] {
  if (
    typeof expectedAmount !== 'string'
    || expectedAmount.trim() !== expectedAmount
    || !/^\d+(\.\d{1,2})?$/.test(expectedAmount)
  ) {
    throw new RangeError('Expected amount must be a non-negative decimal string with at most two decimals');
  }

  const [whole, fraction = ''] = expectedAmount.split('.');
  const normalizedWhole = whole.replace(/^0+/, '') || '0';
  if (normalizedWhole.length > 10) {
    throw new RangeError('Expected amount must not exceed 9999999999.99');
  }
  const totalCents = BigInt(normalizedWhole) * 100n + BigInt(fraction.padEnd(2, '0'));

  if (!Array.isArray(participantIds) || participantIds.length < 1 || participantIds.length > MAX_PARTICIPANTS) {
    throw new RangeError('A payment must have between 1 and 20 participants');
  }

  const sortedIds = Array.from(participantIds, (id) => {
    const parsed = participantIdSchema.safeParse(id);
    if (!parsed.success) throw new RangeError('Participant ids must be UUIDs');
    return parsed.data.toLowerCase();
  }).sort();

  if (new Set(sortedIds).size !== sortedIds.length) {
    throw new RangeError('Participant ids must be unique');
  }

  const count = BigInt(sortedIds.length);
  const centsPerPerson = totalCents / count;
  const remainingCents = totalCents % count;
  const percentagePerPerson = TOTAL_PERCENTAGE_UNITS / count;
  const remainingPercentageUnits = TOTAL_PERCENTAGE_UNITS % count;

  return sortedIds.map((userId, index) => {
    // Canonical UUID order makes the extra units independent of input order.
    const position = BigInt(index);
    const cents = centsPerPerson + (position < remainingCents ? 1n : 0n);
    const percentage = percentagePerPerson + (position < remainingPercentageUnits ? 1n : 0n);

    return {
      userId,
      shareAmount: `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`,
      // Percentages describe the equal split; cents are distributed independently.
      sharePercentage: `${percentage / 10_000n}.${(percentage % 10_000n).toString().padStart(4, '0')}`,
    };
  });
}
