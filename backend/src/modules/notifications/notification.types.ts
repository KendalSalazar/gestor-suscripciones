import type { Group } from '../groups/group.types';
import type { PaymentShareStatus } from '../payments/payment-share.types';
import type { PaymentStatus } from '../payments/payment.types';

export type NotificationType = 'payment_due' | 'payment_overdue' | 'amount_changed';

// Contract planned for the recipient's notification center. Amounts and DATE
// values remain strings, as in the existing payment API.
export type Notification = {
  id: string;
  type: NotificationType;
  paymentId: string;
  subscriptionId: string;
  subscriptionName: string;
  groupId: string;
  groupName: string;
  groupType: Group['type'];
  expectedDate: string;
  expectedAmount: string;
  actualAmount: string | null;
  paymentStatus: PaymentStatus;
  ownShareStatus: PaymentShareStatus | null;
  actionRequired: boolean;
  message: string;
  createdAt: string;
  readAt: string | null;
};
