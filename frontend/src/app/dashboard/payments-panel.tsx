'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiWithSession } from '@/lib/api';

type Payment = {
  id: string;
  subscriptionId: string;
  subscriptionName: string;
  expectedDate: string;
  expectedAmount: string;
  actualAmount: string | null;
  status: 'pending' | 'confirmed' | 'skipped';
  priceChanged: boolean;
  resolvedAt: string | null;
  createdAt: string;
};

type PaymentsResponse = { payments: Payment[] };
type PaymentResponse = { payment: Payment };
type PaymentList = { payments: Payment[]; loading: boolean; error: string; refreshVersion: number };
type ConfirmationForm = { paymentId: string; amount: string };

const initialList: PaymentList = { payments: [], loading: true, error: '', refreshVersion: -1 };

function paymentErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return 'Revisa los datos e inténtalo de nuevo.';
    if (error.status === 403) return 'No tienes permiso para realizar esta acción en el grupo.';
    if (error.status === 404) return 'El pago ya no está disponible. Actualiza los pendientes.';
  }
  return fallback;
}

export default function PaymentsPanel({
  groupId,
  onSessionExpired,
  refreshVersion = 0,
}: {
  groupId: string;
  onSessionExpired: () => void;
  refreshVersion?: number;
}) {
  const [pending, setPending] = useState<PaymentList>(initialList);
  const [history, setHistory] = useState<PaymentList>(initialList);
  const [pendingReload, setPendingReload] = useState(0);
  const [historyReload, setHistoryReload] = useState(0);
  const [confirmation, setConfirmation] = useState<ConfirmationForm | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ paymentId: string; message: string } | null>(null);
  const [notice, setNotice] = useState('');
  const actionRequest = useRef<AbortController | null>(null);
  const confirmationReturnFocusRef = useRef<string | null>(null);
  const confirmationPaymentId = confirmation?.paymentId ?? null;
  const basePath = `/groups/${groupId}/payments`;
  const pendingLoading = pending.loading || pending.refreshVersion !== refreshVersion;
  const historyLoading = history.loading || history.refreshVersion !== refreshVersion;

  useEffect(() => {
    if (confirmationPaymentId) {
      document.getElementById(`payment-amount-${confirmationPaymentId}`)?.focus();
      return;
    }
    const paymentId = confirmationReturnFocusRef.current;
    if (!paymentId || pendingLoading || sendingId !== null) return;
    confirmationReturnFocusRef.current = null;
    document.getElementById(`payment-confirm-${paymentId}`)?.focus();
  }, [confirmationPaymentId, pendingLoading, sendingId]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadPending() {
      try {
        const result = await apiWithSession<PaymentsResponse>(`${basePath}?status=pending`, {
          signal: controller.signal,
        });
        if (!result) throw new Error('Missing payments response');
        if (!controller.signal.aborted) {
          setPending({ payments: result.payments, loading: false, error: '', refreshVersion });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        setPending({
          payments: [],
          loading: false,
          refreshVersion,
          error: paymentErrorText(error, 'No pudimos cargar los pagos pendientes. Inténtalo de nuevo.'),
        });
      }
    }

    void loadPending();
    return () => controller.abort();
  }, [basePath, pendingReload, onSessionExpired, refreshVersion]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadHistory() {
      try {
        const [confirmed, skipped] = await Promise.all([
          apiWithSession<PaymentsResponse>(`${basePath}?status=confirmed`, { signal: controller.signal }),
          apiWithSession<PaymentsResponse>(`${basePath}?status=skipped`, { signal: controller.signal }),
        ]);
        if (!confirmed || !skipped) throw new Error('Missing payment history response');

        const payments = [...confirmed.payments, ...skipped.payments]
          .sort((first, second) => (
            second.expectedDate.localeCompare(first.expectedDate) || second.id.localeCompare(first.id)
          ))
          .slice(0, 100);

        if (!controller.signal.aborted) {
          setHistory({ payments, loading: false, error: '', refreshVersion });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        setHistory({
          payments: [],
          loading: false,
          refreshVersion,
          error: paymentErrorText(error, 'No pudimos cargar el historial de pagos. Inténtalo de nuevo.'),
        });
      }
    }

    void loadHistory();
    return () => controller.abort();
  }, [basePath, historyReload, onSessionExpired, refreshVersion]);

  useEffect(() => () => {
    actionRequest.current?.abort();
    actionRequest.current = null;
  }, [groupId]);

  function reloadPending() {
    setPending((current) => ({ ...current, loading: true, error: '' }));
    setPendingReload((current) => current + 1);
  }

  function reloadHistory() {
    setHistory((current) => ({ ...current, loading: true, error: '' }));
    setHistoryReload((current) => current + 1);
  }

  async function resolvePayment(payment: Payment, action: 'confirm' | 'skip', amount?: string) {
    // The ref also prevents a second submission before React renders the disabled buttons.
    if (actionRequest.current) return;
    const controller = new AbortController();
    actionRequest.current = controller;
    setSendingId(payment.id);
    setActionError(null);
    setNotice('');

    try {
      const result = await apiWithSession<PaymentResponse>(`${basePath}/${payment.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(action === 'confirm' ? { actualAmount: amount } : {}),
        signal: controller.signal,
      });
      if (!result) throw new Error('Missing resolved payment response');
      if (controller.signal.aborted) return;

      setConfirmation(null);
      setNotice(action === 'skip'
        ? 'Pago omitido. Puedes consultarlo en el historial.'
        : result.payment.priceChanged
          ? 'Pago confirmado con un importe diferente al esperado. El coste de la suscripción se conserva.'
          : 'Pago confirmado. Puedes consultarlo en el historial.');
      reloadPending();
      reloadHistory();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        setConfirmation(null);
        setNotice('Este pago ya fue confirmado u omitido. Actualizamos las listas para mostrar su estado actual.');
        reloadPending();
        reloadHistory();
        return;
      }
      setActionError({
        paymentId: payment.id,
        message: paymentErrorText(error, 'No pudimos guardar la acción. Comprueba la conexión e inténtalo de nuevo.'),
      });
    } finally {
      if (actionRequest.current === controller) actionRequest.current = null;
      if (!controller.signal.aborted) setSendingId(null);
    }
  }

  function submitConfirmation(event: FormEvent<HTMLFormElement>, payment: Payment) {
    event.preventDefault();
    if (!confirmation || confirmation.paymentId !== payment.id || actionRequest.current) return;

    const amount = confirmation.amount.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(amount)
      || amount.split('.')[0].replace(/^0+/, '').length > 10) {
      setActionError({
        paymentId: payment.id,
        message: 'Introduce un importe entre 0 y 9999999999.99, con un punto y hasta dos decimales.',
      });
      return;
    }
    void resolvePayment(payment, 'confirm', amount);
  }

  function skipPayment(payment: Payment) {
    if (actionRequest.current) return;
    if (window.confirm(`¿Omitir el pago de ${payment.subscriptionName} del ${payment.expectedDate}? Esta acción no se puede deshacer.`)) {
      void resolvePayment(payment, 'skip');
    }
  }

  return (
    <section aria-label="Pagos personales" className="payments-panel">
      <p className="payments-description">
        Registra los cobros de tus suscripciones. Confirmar un pago solo lo anota en tu control personal.
      </p>
      {notice && <p className="ui-feedback payment-notice" role="status">{notice}</p>}

      <div className="payments-stack">
        <section aria-labelledby="pending-payments-heading" className="payments-section">
          <div className="payments-section-heading">
            <h2 id="pending-payments-heading">Pagos pendientes</h2>
            <button
              className="ui-button ui-button-secondary"
              disabled={pendingLoading || sendingId !== null}
              onClick={reloadPending}
              type="button"
            >
              Actualizar pendientes
            </button>
          </div>
          <p className="payments-description">Hasta 100 pendientes, por fecha de cobro más reciente.</p>

          {pendingLoading ? (
            <p className="payment-state" role="status">Cargando pagos pendientes…</p>
          ) : pending.error ? (
            <p className="ui-feedback ui-feedback-error mt-5" role="alert">{pending.error}</p>
          ) : pending.payments.length === 0 ? (
            <p className="payment-state">No tienes pagos pendientes.</p>
          ) : (
            <ul className="payments-list">
              {pending.payments.map((payment) => {
                const isConfirming = confirmation?.paymentId === payment.id;
                const error = actionError?.paymentId === payment.id ? actionError.message : '';
                const errorId = `payment-error-${payment.id}`;

                return (
                  <li className="payment-row" key={payment.id}>
                    <h3 className="payment-name">{payment.subscriptionName}</h3>
                    <p className="payment-date">
                      Cobro previsto: <time dateTime={payment.expectedDate}>{payment.expectedDate}</time>
                    </p>
                    <dl className="payment-values"><div><dt>Importe previsto</dt><dd>{payment.expectedAmount}</dd></div><div><dt>Estado</dt><dd><span className="payment-badge payment-badge-pending">Pendiente de confirmar</span></dd></div></dl>

                    {isConfirming ? (
                      <form className="payment-confirmation" onSubmit={(event) => submitConfirmation(event, payment)}>
                        <div>
                          <label className="app-design-label mb-1.5 block text-sm font-medium" htmlFor={`payment-amount-${payment.id}`}>
                            Importe pagado
                          </label>
                          <input
                            aria-describedby={`${error ? `${errorId} ` : ''}payment-hint-${payment.id}`}
                            aria-invalid={Boolean(error)}
                            className="ui-field"
                            disabled={sendingId !== null}
                            id={`payment-amount-${payment.id}`}
                            inputMode="decimal"
                            onChange={(event) => {
                              setConfirmation({ paymentId: payment.id, amount: event.target.value });
                              setActionError(null);
                            }}
                            required
                            type="text"
                            value={confirmation.amount}
                          />
                          <p className="payment-hint" id={`payment-hint-${payment.id}`}>
                            Usa un punto decimal, por ejemplo 17.99. Esto no cambia el coste de tu suscripción.
                          </p>
                        </div>
                        <div className="payment-actions">
                          <button
                            className="ui-button"
                            disabled={sendingId !== null}
                            type="submit"
                          >
                            {sendingId === payment.id ? 'Guardando…' : 'Guardar confirmación'}
                          </button>
                          <button
                            className="ui-button ui-button-secondary"
                            disabled={sendingId !== null}
                            onClick={() => { confirmationReturnFocusRef.current = payment.id; setConfirmation(null); setActionError(null); }}
                            type="button"
                          >
                            Cancelar
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="payment-actions">
                        <button
                          aria-describedby={error ? errorId : undefined}
                          aria-label={`Confirmar pago de ${payment.subscriptionName} del ${payment.expectedDate}`}
                          id={`payment-confirm-${payment.id}`}
                          className="ui-button"
                          disabled={sendingId !== null}
                          onClick={() => {
                            setConfirmation({ paymentId: payment.id, amount: payment.expectedAmount });
                            setActionError(null);
                            setNotice('');
                          }}
                          type="button"
                        >
                          Confirmar
                        </button>
                        <button
                          aria-describedby={error ? errorId : undefined}
                          aria-label={`Omitir pago de ${payment.subscriptionName} del ${payment.expectedDate}`}
                          className="ui-button ui-button-secondary"
                          disabled={sendingId !== null}
                          onClick={() => skipPayment(payment)}
                          type="button"
                        >
                          {sendingId === payment.id ? 'Guardando…' : 'Omitir'}
                        </button>
                      </div>
                    )}
                    {error && <p className="ui-feedback ui-feedback-error mt-4" id={errorId} role="alert">{error}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="payment-history-heading" className="payments-section">
          <div className="payments-section-heading">
            <h2 id="payment-history-heading">Historial de pagos</h2>
            <button
              className="ui-button ui-button-secondary"
              disabled={historyLoading || sendingId !== null}
              onClick={reloadHistory}
              type="button"
            >
              Actualizar historial
            </button>
          </div>
          <p className="payments-description">Hasta 100 pagos resueltos, por fecha de cobro más reciente.</p>

          {historyLoading ? (
            <p className="payment-state" role="status">Cargando historial de pagos…</p>
          ) : history.error ? (
            <p className="ui-feedback ui-feedback-error mt-5" role="alert">{history.error}</p>
          ) : history.payments.length === 0 ? (
            <p className="payment-state">Todavía no has confirmado ni omitido pagos.</p>
          ) : (
            <ul className="payments-list">
              {history.payments.map((payment) => (
                <li className="payment-row" key={payment.id}>
                  <h3 className="payment-name">{payment.subscriptionName}</h3>
                  <div className="payment-badges mt-2">
                    <span className={`payment-badge ${payment.status === 'confirmed' ? 'payment-badge-confirmed' : ''}`}>
                      {payment.status === 'confirmed' ? 'Confirmado' : 'Omitido'}
                    </span>
                    {payment.priceChanged && <span className="payment-badge payment-badge-changed">Importe diferente al esperado</span>}
                  </div>
                  <p className="payment-date">
                    Cobro previsto: <time dateTime={payment.expectedDate}>{payment.expectedDate}</time>
                  </p>
                  <dl className="payment-values">
                    <div>
                      <dt>Importe previsto</dt>
                      <dd>{payment.expectedAmount}</dd>
                    </div>
                    <div>
                      <dt>Importe registrado</dt>
                      <dd>{payment.actualAmount ?? 'Sin importe registrado'}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
