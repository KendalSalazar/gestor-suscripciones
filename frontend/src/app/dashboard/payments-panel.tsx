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
type PaymentList = { payments: Payment[]; loading: boolean; error: string };
type ConfirmationForm = { paymentId: string; amount: string };

const initialList: PaymentList = { payments: [], loading: true, error: '' };

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
}: {
  groupId: string;
  onSessionExpired: () => void;
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
  const basePath = `/groups/${groupId}/payments`;

  useEffect(() => {
    const controller = new AbortController();

    async function loadPending() {
      try {
        const result = await apiWithSession<PaymentsResponse>(`${basePath}?status=pending`, {
          signal: controller.signal,
        });
        if (!result) throw new Error('Missing payments response');
        if (!controller.signal.aborted) {
          setPending({ payments: result.payments, loading: false, error: '' });
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
          error: paymentErrorText(error, 'No pudimos cargar los pagos pendientes. Inténtalo de nuevo.'),
        });
      }
    }

    void loadPending();
    return () => controller.abort();
  }, [basePath, pendingReload, onSessionExpired]);

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
          setHistory({ payments, loading: false, error: '' });
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
          error: paymentErrorText(error, 'No pudimos cargar el historial de pagos. Inténtalo de nuevo.'),
        });
      }
    }

    void loadHistory();
    return () => controller.abort();
  }, [basePath, historyReload, onSessionExpired]);

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
    <section aria-labelledby="payments-heading" className="mt-10 border-t border-slate-200 pt-8">
      <h2 className="text-2xl font-semibold text-slate-950" id="payments-heading">Tus pagos</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        Registra los cobros de tus suscripciones. Confirmar un pago solo lo anota en tu control personal.
      </p>
      {notice && <p className="mt-4 rounded-xl bg-violet-50 px-4 py-3 text-sm text-violet-900" role="status">{notice}</p>}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
        <section aria-labelledby="pending-payments-heading" className="min-w-0 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-xl font-semibold text-slate-950" id="pending-payments-heading">Pagos pendientes</h3>
            <button
              className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              disabled={pending.loading || sendingId !== null}
              onClick={reloadPending}
              type="button"
            >
              Actualizar pendientes
            </button>
          </div>
          <p className="mt-2 text-sm text-slate-500">Hasta 100 pendientes, por fecha de cobro más reciente.</p>

          {pending.loading ? (
            <p className="mt-6 text-sm text-slate-600" role="status">Cargando pagos pendientes…</p>
          ) : pending.error ? (
            <p className="mt-6 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{pending.error}</p>
          ) : pending.payments.length === 0 ? (
            <p className="mt-6 rounded-xl bg-slate-50 px-4 py-5 text-sm text-slate-600">No tienes pagos pendientes.</p>
          ) : (
            <ul className="mt-5 space-y-5">
              {pending.payments.map((payment) => {
                const isConfirming = confirmation?.paymentId === payment.id;
                const error = actionError?.paymentId === payment.id ? actionError.message : '';
                const errorId = `payment-error-${payment.id}`;

                return (
                  <li className="border-t border-slate-100 pt-5" key={payment.id}>
                    <h4 className="break-words font-semibold text-slate-950">{payment.subscriptionName}</h4>
                    <p className="mt-1 text-sm text-slate-600">
                      Cobro previsto: <time dateTime={payment.expectedDate}>{payment.expectedDate}</time>
                    </p>
                    <p className="mt-2 text-sm text-slate-700">Importe esperado: <strong>{payment.expectedAmount}</strong></p>

                    {isConfirming ? (
                      <form className="mt-4 space-y-3" onSubmit={(event) => submitConfirmation(event, payment)}>
                        <div>
                          <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor={`payment-amount-${payment.id}`}>
                            Importe pagado
                          </label>
                          <input
                            aria-describedby={`${error ? `${errorId} ` : ''}payment-hint-${payment.id}`}
                            aria-invalid={Boolean(error)}
                            className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-slate-950 outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100 disabled:opacity-60"
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
                          <p className="mt-1.5 text-xs text-slate-500" id={`payment-hint-${payment.id}`}>
                            Usa un punto decimal, por ejemplo 17.99. Esto no cambia el coste de tu suscripción.
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            className="min-h-10 rounded-lg bg-violet-700 px-3 text-sm font-medium text-white hover:bg-violet-800 disabled:opacity-60"
                            disabled={sendingId !== null}
                            type="submit"
                          >
                            {sendingId === payment.id ? 'Guardando…' : 'Guardar confirmación'}
                          </button>
                          <button
                            className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                            disabled={sendingId !== null}
                            onClick={() => { setConfirmation(null); setActionError(null); }}
                            type="button"
                          >
                            Cancelar
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          aria-describedby={error ? errorId : undefined}
                          aria-label={`Confirmar pago de ${payment.subscriptionName} del ${payment.expectedDate}`}
                          className="min-h-10 rounded-lg bg-violet-700 px-3 text-sm font-medium text-white hover:bg-violet-800 disabled:opacity-60"
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
                          className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                          disabled={sendingId !== null}
                          onClick={() => skipPayment(payment)}
                          type="button"
                        >
                          {sendingId === payment.id ? 'Guardando…' : 'Omitir'}
                        </button>
                      </div>
                    )}
                    {error && <p className="mt-3 text-sm text-red-700" id={errorId} role="alert">{error}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="payment-history-heading" className="min-w-0 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-xl font-semibold text-slate-950" id="payment-history-heading">Historial de pagos</h3>
            <button
              className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              disabled={history.loading || sendingId !== null}
              onClick={reloadHistory}
              type="button"
            >
              Actualizar historial
            </button>
          </div>
          <p className="mt-2 text-sm text-slate-500">Hasta 100 pagos resueltos, por fecha de cobro más reciente.</p>

          {history.loading ? (
            <p className="mt-6 text-sm text-slate-600" role="status">Cargando historial de pagos…</p>
          ) : history.error ? (
            <p className="mt-6 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{history.error}</p>
          ) : history.payments.length === 0 ? (
            <p className="mt-6 rounded-xl bg-slate-50 px-4 py-5 text-sm text-slate-600">Todavía no has confirmado ni omitido pagos.</p>
          ) : (
            <ul className="mt-5 space-y-5">
              {history.payments.map((payment) => (
                <li className="border-t border-slate-100 pt-5" key={payment.id}>
                  <h4 className="break-words font-semibold text-slate-950">{payment.subscriptionName}</h4>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${payment.status === 'confirmed' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                      {payment.status === 'confirmed' ? 'Confirmado' : 'Omitido'}
                    </span>
                    {payment.priceChanged && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">Importe diferente al esperado</span>}
                  </div>
                  <p className="mt-2 text-sm text-slate-600">
                    Cobro previsto: <time dateTime={payment.expectedDate}>{payment.expectedDate}</time>
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="text-slate-500">Esperado</dt>
                      <dd className="mt-1 font-medium text-slate-800">{payment.expectedAmount}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Pagado</dt>
                      <dd className="mt-1 font-medium text-slate-800">{payment.actualAmount ?? 'Sin importe registrado'}</dd>
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
