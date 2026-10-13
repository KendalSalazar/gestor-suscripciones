export type BillingCycle = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export type Subscription = {
  id: string;
  groupId: string;
  name: string;
  provider: string;
  expectedCost: string;
  billingCycle: BillingCycle;
  nextBillingDate: string;
  active: boolean;
  createdAt: string;
};

export type Membership = {
  groupId: string;
  userId: string;
  role: 'owner' | 'member';
  status: 'active';
};

export type SubscriptionRow = {
  id: string;
  group_id: string;
  name: string;
  provider: string;
  expected_cost: string;
  billing_cycle: BillingCycle;
  next_billing_date: Date | string;
  active: boolean;
  created_at: Date | string;
};

export function toIsoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export function toSubscription(row: SubscriptionRow): Subscription {
  // Keep NUMERIC as a decimal string and DATE as YYYY-MM-DD to avoid precision
  // loss and timezone shifts when converting database values to the API shape.
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    provider: row.provider,
    expectedCost: row.expected_cost,
    billingCycle: row.billing_cycle,
    nextBillingDate: toIsoDate(row.next_billing_date),
    active: row.active,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
