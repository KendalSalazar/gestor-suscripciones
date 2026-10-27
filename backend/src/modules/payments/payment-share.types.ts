import type { Payment } from './payment.types';

export type PaymentShareStatus = 'pending' | 'confirmed' | 'skipped';

export type PaymentShare = {
  id: string;
  paymentId: string;
  userId: string;
  userName: string;
  shareAmount: string;
  sharePercentage: string;
  actualAmount: string | null;
  status: PaymentShareStatus;
  confirmedAt: string | null;
  createdAt: string;
};

export type PaymentShareSummary = {
  totalShares: number;
  confirmedShares: number;
  confirmedAmount: string;
};

export type OwnPaymentShare = PaymentShare & {
  payment: Payment;
  summary: PaymentShareSummary;
};

export type PaymentShareBreakdown = {
  payment: Payment;
  shares: PaymentShare[];
  summary: PaymentShareSummary;
};

export type PaymentShareConfirmation = {
  share: PaymentShare;
  payment: Payment;
  summary: PaymentShareSummary;
};

export type PaymentShareRow = {
  id: string;
  payment_id: string;
  user_id: string;
  user_name: string;
  share_amount: string;
  share_percentage: string;
  actual_amount: string | null;
  status: PaymentShareStatus;
  confirmed_at: Date | null;
  created_at: Date;
};

export function toPaymentShare(row: PaymentShareRow): PaymentShare {
  return {
    id: row.id,
    paymentId: row.payment_id,
    userId: row.user_id,
    userName: row.user_name,
    shareAmount: row.share_amount,
    sharePercentage: row.share_percentage,
    actualAmount: row.actual_amount,
    status: row.status,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}
