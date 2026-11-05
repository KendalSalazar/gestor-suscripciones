import type { NotificationType } from './notification.types';

// These messages describe events. A later read also reports the current payment
// state, which may have changed since a notification was created.
const messages: Record<NotificationType, string> = {
  payment_due: 'Se generó un registro de pago para la fecha prevista.',
  payment_overdue: 'Se detectó un pago sin confirmar al menos siete días después de la fecha prevista.',
  amount_changed: 'El importe registrado del pago es diferente al previsto.',
};

export function getNotificationMessage(type: NotificationType): string {
  return messages[type];
}
