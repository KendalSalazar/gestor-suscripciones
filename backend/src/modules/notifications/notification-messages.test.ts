import { describe, expect, it } from 'vitest';
import { getNotificationMessage } from './notification-messages';

describe('notification messages', () => {
  it('describes the creation of a payment record', () => {
    expect(getNotificationMessage('payment_due')).toBe(
      'Se generó un registro de pago para la fecha prevista.',
    );
  });

  it('describes a detected lack of confirmation without claiming a bank payment failed', () => {
    expect(getNotificationMessage('payment_overdue')).toBe(
      'Se detectó un pago sin confirmar al menos siete días después de la fecha prevista.',
    );
  });

  it('describes any amount difference without claiming the provider raised its price', () => {
    expect(getNotificationMessage('amount_changed')).toBe(
      'El importe registrado del pago es diferente al previsto.',
    );
  });
});
