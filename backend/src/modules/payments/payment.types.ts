export type PaymentStatus = 'pending' | 'confirmed' | 'skipped';

export type Payment = {
  id: string;
  subscriptionId: string;
  subscriptionName: string;
  expectedDate: string;
  expectedAmount: string;
  actualAmount: string | null;
  status: PaymentStatus;
  priceChanged: boolean;
  resolvedAt: string | null;
  createdAt: string;
};

export type PaymentRow = {
  id: string;
  subscription_id: string;
  subscription_name: string;
  expected_date: string;
  expected_amount: string;
  actual_amount: string | null;
  status: PaymentStatus;
  price_changed: boolean;
  resolved_at: Date | null;
  created_at: Date;
};

export function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    subscriptionName: row.subscription_name,
    expectedDate: row.expected_date,
    expectedAmount: row.expected_amount,
    actualAmount: row.actual_amount,
    status: row.status,
    priceChanged: row.price_changed,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}
