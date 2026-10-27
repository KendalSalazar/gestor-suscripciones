'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiWithSession } from '@/lib/api';

type PaymentStatus = 'pending' | 'confirmed' | 'skipped';
type ShareStatus = 'pending' | 'confirmed' | 'skipped';

type Payment = {
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

type PaymentShare = {
  id: string;
  paymentId: string;
  userId: string;
  userName: string;
  shareAmount: string;
  sharePercentage: string;
  actualAmount: string | null;
  status: ShareStatus;
  confirmedAt: string | null;
  createdAt: string;
};

type PaymentShareSummary = {
  totalShares: number;
  confirmedShares: number;
  confirmedAmount: string;
};

type OwnPaymentShare = PaymentShare & {
  payment: Payment;
  summary: PaymentShareSummary;
};

type PaymentShareBreakdown = {
  payment: Payment;
  shares: PaymentShare[];
  summary: PaymentShareSummary;
};

type ShareList = { groupId: string | null; shares: OwnPaymentShare[]; loading: boolean; error: string; refreshVersion: number };
type PaymentList = { groupId: string | null; payments: Payment[]; loading: boolean; error: string; refreshVersion: number };
type BreakdownState = { groupId: string; paymentId: string; data: PaymentShareBreakdown | null; loading: boolean; error: string; refreshVersion: number };
type ConfirmationInput = { shareId: string; amount: string };

type ListResponse = { shares: OwnPaymentShare[] };
type PaymentsResponse = { payments: Payment[] };
type BreakdownResponse = PaymentShareBreakdown;
type ConfirmationResponse = { share: PaymentShare; payment: Payment; summary: PaymentShareSummary };
type PaymentResponse = { payment: Payment };

const emptyList: ShareList = { groupId: null, shares: [], loading: true, error: '', refreshVersion: -1 };
const emptyPaymentList: PaymentList = { groupId: null, payments: [], loading: true, error: '', refreshVersion: -1 };

function amountInCents(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, '0'));
}

function apiErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return 'La solicitud no tiene un formato válido. Actualiza la lista e inténtalo de nuevo.';
    if (error.status === 403) return 'Ya no tienes acceso a este grupo. Actualiza la lista de grupos.';
    if (error.status === 404) return 'El pago o sus partes ya no están disponibles. Actualiza la lista.';
  }
  return fallback;
}

function shareStatusLabel(status: ShareStatus): string {
  if (status === 'confirmed') return 'Confirmada';
  if (status === 'skipped') return 'Omitida';
  return 'Pendiente';
}

function ownShareStatusLabel(status: ShareStatus): string {
  if (status === 'confirmed') return 'Tu parte confirmada';
  if (status === 'skipped') return 'Tu parte omitida';
  return 'Tu parte pendiente';
}

function paymentStatusLabel(status: PaymentStatus): string {
  if (status === 'confirmed') return 'Pago del grupo confirmado';
  if (status === 'skipped') return 'Pago del grupo omitido';
  return 'Pago del grupo pendiente';
}

export default function FamilyPaymentsPanel({
  groupId,
  isOwner,
  onAccessForbidden,
  onSessionExpired,
  refreshVersion = 0,
}: {
  groupId: string;
  isOwner: boolean;
  onAccessForbidden: () => void;
  onSessionExpired: () => void;
  refreshVersion?: number;
}) {
  const [pending, setPending] = useState<ShareList>(emptyList);
  const [history, setHistory] = useState<ShareList>(emptyList);
  const [unresolvedPayments, setUnresolvedPayments] = useState<PaymentList>(emptyPaymentList);
  const [pendingReload, setPendingReload] = useState(0);
  const [historyReload, setHistoryReload] = useState(0);
  const [paymentsReload, setPaymentsReload] = useState(0);
  const [confirmation, setConfirmation] = useState<ConfirmationInput | null>(null);
  const [sendingPaymentId, setSendingPaymentId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ shareId: string; message: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [expandedPaymentId, setExpandedPaymentId] = useState<string | null>(null);
  const [breakdown, setBreakdown] = useState<BreakdownState | null>(null);
  const [breakdownReload, setBreakdownReload] = useState(0);
  const actionRequest = useRef<AbortController | null>(null);
  const basePath = `/groups/${groupId}`;
  const pendingLoading = pending.groupId !== groupId || pending.loading || pending.refreshVersion !== refreshVersion;
  const historyLoading = history.groupId !== groupId || history.loading || history.refreshVersion !== refreshVersion;
  const paymentsLoading = unresolvedPayments.groupId !== groupId || unresolvedPayments.loading || unresolvedPayments.refreshVersion !== refreshVersion;

  useEffect(() => {
    const controller = new AbortController();

    async function loadPendingShares() {
      try {
        const result = await apiWithSession<ListResponse>(`${basePath}/payment-shares?status=pending`, {
          signal: controller.signal,
        });
        if (!result) throw new Error('Missing pending payment shares response');
        if (!controller.signal.aborted) setPending({ groupId, shares: result.shares, loading: false, error: '', refreshVersion });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        if (error instanceof ApiError && error.status === 403) onAccessForbidden();
        setPending({
          groupId, shares: [], loading: false, refreshVersion,
          error: apiErrorText(error, 'No pudimos cargar tus partes pendientes. Inténtalo de nuevo.'),
        });
      }
    }

    void loadPendingShares();
    return () => controller.abort();
  }, [basePath, groupId, pendingReload, onAccessForbidden, onSessionExpired, refreshVersion]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadShareHistory() {
      try {
        const [confirmed, skipped] = await Promise.all([
          apiWithSession<ListResponse>(`${basePath}/payment-shares?status=confirmed`, { signal: controller.signal }),
          apiWithSession<ListResponse>(`${basePath}/payment-shares?status=skipped`, { signal: controller.signal }),
        ]);
        if (!confirmed || !skipped) throw new Error('Missing payment share history response');
        const shares = [...confirmed.shares, ...skipped.shares]
          .sort((first, second) => (
            second.payment.expectedDate.localeCompare(first.payment.expectedDate)
            || second.id.localeCompare(first.id)
          ))
          .slice(0, 100);
        if (!controller.signal.aborted) setHistory({ groupId, shares, loading: false, error: '', refreshVersion });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        if (error instanceof ApiError && error.status === 403) onAccessForbidden();
        setHistory({
          groupId, shares: [], loading: false, refreshVersion,
          error: apiErrorText(error, 'No pudimos cargar el historial de tus partes. Inténtalo de nuevo.'),
        });
      }
    }

    void loadShareHistory();
    return () => controller.abort();
  }, [basePath, groupId, historyReload, onAccessForbidden, onSessionExpired, refreshVersion]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadPendingPayments() {
      try {
        const result = await apiWithSession<PaymentsResponse>(`${basePath}/payments?status=pending`, {
          signal: controller.signal,
        });
        if (!result) throw new Error('Missing pending family payments response');
        if (!controller.signal.aborted) {
          setUnresolvedPayments({ groupId, payments: result.payments, loading: false, error: '', refreshVersion });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        if (error instanceof ApiError && error.status === 403) onAccessForbidden();
        setUnresolvedPayments({
          groupId, payments: [], loading: false, refreshVersion,
          error: apiErrorText(error, 'No pudimos cargar los pagos grupales pendientes. Inténtalo de nuevo.'),
        });
      }
    }

    void loadPendingPayments();
    return () => controller.abort();
  }, [basePath, groupId, paymentsReload, onAccessForbidden, onSessionExpired, refreshVersion]);

  useEffect(() => {
    if (!expandedPaymentId) return;
    const paymentId = expandedPaymentId;
    const controller = new AbortController();

    async function loadBreakdown() {
      try {
        const result = await apiWithSession<BreakdownResponse>(
          `${basePath}/payments/${paymentId}/shares`, { signal: controller.signal },
        );
        if (!result) throw new Error('Missing payment share breakdown response');
        if (!controller.signal.aborted) {
          setBreakdown({ groupId, paymentId, data: result, loading: false, error: '', refreshVersion });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        if (error instanceof ApiError && error.status === 403) onAccessForbidden();
        setBreakdown({
          groupId, paymentId, data: null, loading: false, refreshVersion,
          error: apiErrorText(error, 'No pudimos cargar el reparto. Inténtalo de nuevo.'),
        });
      }
    }

    void loadBreakdown();
    return () => controller.abort();
  }, [basePath, groupId, expandedPaymentId, breakdownReload, onAccessForbidden, onSessionExpired, refreshVersion]);

  useEffect(() => () => {
    actionRequest.current?.abort();
    actionRequest.current = null;
  }, [groupId]);

  function reloadPending() {
    setPending((current) => ({ ...current, groupId, loading: true, error: '' }));
    setPendingReload((current) => current + 1);
  }

  function reloadHistory() {
    setHistory((current) => ({ ...current, groupId, loading: true, error: '' }));
    setHistoryReload((current) => current + 1);
  }

  function reloadPayments() {
    setUnresolvedPayments((current) => ({ ...current, groupId, loading: true, error: '' }));
    setPaymentsReload((current) => current + 1);
  }

  function reloadLists() {
    reloadPending();
    reloadHistory();
    reloadPayments();
  }

  function toggleBreakdown(paymentId: string) {
    if (expandedPaymentId === paymentId) {
      setExpandedPaymentId(null);
      setBreakdown(null);
    } else {
      setExpandedPaymentId(paymentId);
      setBreakdown({ groupId, paymentId, data: null, loading: true, error: '', refreshVersion });
    }
  }

  function reloadBreakdown(paymentId: string) {
    setBreakdown({ groupId, paymentId, data: null, loading: true, error: '', refreshVersion });
    setBreakdownReload((current) => current + 1);
  }

  async function confirmShare(share: OwnPaymentShare, amount: string) {
    if (actionRequest.current) return;
    const controller = new AbortController();
    actionRequest.current = controller;
    setSendingPaymentId(share.paymentId);
    setActionError(null);
    setNotice('');

    try {
      const result = await apiWithSession<ConfirmationResponse>(
        `${basePath}/payments/${share.paymentId}/shares/${share.id}/confirm`,
        { method: 'POST', body: JSON.stringify({ actualAmount: amount }), signal: controller.signal },
      );
      if (!result) throw new Error('Missing payment share confirmation response');
      if (controller.signal.aborted) return;
      setConfirmation(null);
      setNotice(result.payment.status === 'confirmed'
        ? 'Tu parte quedó confirmada y ya se completaron las partes del pago grupal.'
        : 'Tu parte quedó confirmada. El pago del grupo sigue pendiente de las demás personas.');
      reloadLists();
      if (expandedPaymentId === share.paymentId) reloadBreakdown(share.paymentId);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      if (error instanceof ApiError && error.status === 403) onAccessForbidden();
      if (error instanceof ApiError && error.status === 409 && error.message === 'Member amount cannot exceed the assigned share') {
        setActionError({ shareId: share.id, message: `Tu rol actual no permite superar la cuota prevista de ${share.shareAmount}. Corrige el importe e inténtalo de nuevo.` });
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        setConfirmation(null);
        setNotice('La parte o el pago cambió de estado. Actualizamos tus listas para mostrar el estado actual.');
        reloadLists();
        if (expandedPaymentId === share.paymentId) reloadBreakdown(share.paymentId);
        return;
      }
      setActionError({
        shareId: share.id,
        message: apiErrorText(error, 'No pudimos confirmar tu parte. Comprueba la conexión e inténtalo de nuevo.'),
      });
    } finally {
      if (actionRequest.current === controller) actionRequest.current = null;
      if (!controller.signal.aborted) setSendingPaymentId(null);
    }
  }

  function submitConfirmation(event: FormEvent<HTMLFormElement>, share: OwnPaymentShare) {
    event.preventDefault();
    if (actionRequest.current) return;
    const amount = confirmation?.shareId === share.id
      ? confirmation.amount.trim()
      : share.shareAmount;
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || amount.split('.')[0].replace(/^0+/, '').length > 10) {
      setActionError({
        shareId: share.id,
        message: 'Usa un importe entre 0 y 9999999999.99, con punto decimal y hasta dos decimales.',
      });
      return;
    }
    if (!isOwner && amountInCents(amount) > amountInCents(share.shareAmount)) {
      setActionError({ shareId: share.id, message: `El importe no puede superar tu cuota prevista de ${share.shareAmount}.` });
      return;
    }
    void confirmShare(share, amount);
  }

  async function skipFamilyPayment(payment: Payment) {
    if (!isOwner || actionRequest.current) return;
    if (!window.confirm(
      `¿Omitir el pago grupal de ${payment.subscriptionName} del ${payment.expectedDate} junto con todas sus partes pendientes?`,
    )) return;

    const controller = new AbortController();
    actionRequest.current = controller;
    setSendingPaymentId(payment.id);
    setActionError(null);
    setNotice('');
    try {
      const result = await apiWithSession<PaymentResponse>(
        `${basePath}/payments/${payment.id}/skip`,
        { method: 'POST', body: JSON.stringify({}), signal: controller.signal },
      );
      if (!result) throw new Error('Missing skipped family payment response');
      if (controller.signal.aborted) return;
      setConfirmation(null);
      setNotice('Se omitieron el pago grupal y todas sus partes pendientes.');
      reloadLists();
      if (expandedPaymentId === payment.id) reloadBreakdown(payment.id);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      if (error instanceof ApiError && error.status === 403) onAccessForbidden();
      if (error instanceof ApiError && error.status === 409) {
        setNotice('No se puede omitir el conjunto si alguna parte ya se confirmó u omitió. Actualizamos el estado del pago.');
        reloadLists();
        if (expandedPaymentId === payment.id) reloadBreakdown(payment.id);
        return;
      }
      setActionError({
        shareId: payment.id,
        message: apiErrorText(error, 'No pudimos omitir el pago grupal. Comprueba la conexión e inténtalo de nuevo.'),
      });
    } finally {
      if (actionRequest.current === controller) actionRequest.current = null;
      if (!controller.signal.aborted) setSendingPaymentId(null);
    }
  }

  function renderBreakdown(paymentId: string) {
    if (expandedPaymentId !== paymentId) return null;
    const state = breakdown?.groupId === groupId && breakdown.paymentId === paymentId ? breakdown : null;
    const panelId = `family-breakdown-${paymentId}`;

    return (
      <div className="mt-4 rounded-2xl bg-slate-50 p-4" id={panelId}>
        {!state || state.loading || state.refreshVersion !== refreshVersion ? (
          <p className="text-sm text-slate-600" role="status">Cargando reparto…</p>
        ) : state?.error ? (
          <div>
            <p className="text-sm text-red-700" role="alert">{state.error}</p>
            <button
              className="mt-2 min-h-9 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-white"
              onClick={() => reloadBreakdown(paymentId)}
              type="button"
            >
              Reintentar reparto
            </button>
          </div>
        ) : state?.data ? (
          <>
            <h5 className="font-semibold text-slate-900">Reparto de {state.data.payment.subscriptionName}</h5>
            <p className="mt-1 text-sm text-slate-600">
              {state.data.summary.confirmedShares} de {state.data.summary.totalShares} partes confirmadas ·
              importe confirmado {state.data.summary.confirmedAmount}
            </p>
            {state.data.shares.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600">Este pago no tiene partes registradas.</p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-200">
                {state.data.shares.map((item) => (
                  <li className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-center sm:justify-between" key={item.id}>
                    <span className="font-medium text-slate-800">{item.userName}</span>
                    <span className="text-slate-600">
                      Cuota {item.shareAmount} · {item.sharePercentage}% · {shareStatusLabel(item.status)}
                      {item.status === 'confirmed' && item.actualAmount !== null ? ` (${item.actualAmount})` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </div>
    );
  }

  function renderShareItem(share: OwnPaymentShare, isHistory: boolean) {
    const isSending = sendingPaymentId === share.paymentId;
    const isConfirming = confirmation?.shareId === share.id;
    const error = actionError?.shareId === share.id ? actionError.message : '';
    const errorId = `share-action-error-${share.id}`;
    const breakdownId = `family-breakdown-${share.paymentId}`;

    return (
      <li className="rounded-2xl border border-slate-200 p-4" key={share.id}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h4 className="break-words font-semibold text-slate-950">{share.payment.subscriptionName}</h4>
            <p className="mt-1 text-sm text-slate-600">
              Cobro previsto: <time dateTime={share.payment.expectedDate}>{share.payment.expectedDate}</time>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${share.status === 'pending' ? 'bg-amber-50 text-amber-800' : share.status === 'confirmed' ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
              {ownShareStatusLabel(share.status)}
            </span>
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${share.payment.status === 'pending' ? 'bg-slate-100 text-slate-700' : share.payment.status === 'confirmed' ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
              {paymentStatusLabel(share.payment.status)}
            </span>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-slate-500">Tu cuota prevista</dt>
            <dd className="mt-1 font-medium text-slate-900">{share.shareAmount}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Importe de tu parte</dt>
              <dd className="mt-1 font-medium text-slate-900">{share.actualAmount ?? (share.status === 'skipped' ? 'Sin importe' : 'Pendiente')}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Progreso grupal</dt>
            <dd className="mt-1 font-medium text-slate-900">
              {share.summary.confirmedShares} de {share.summary.totalShares}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Confirmado por el grupo</dt>
            <dd className="mt-1 font-medium text-slate-900">{share.summary.confirmedAmount}</dd>
          </div>
        </dl>

        {!isHistory && (
          <form className="mt-4 space-y-3 border-t border-slate-100 pt-4" onSubmit={(event) => submitConfirmation(event, share)}>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor={`share-amount-${share.id}`}>
                Importe real de tu parte
              </label>
              <input
                aria-describedby={`${error ? `${errorId} ` : ''}share-amount-help-${share.id}`}
                className="min-h-10 w-full rounded-xl border border-slate-300 px-3 text-slate-950 outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100 sm:max-w-xs"
                disabled={sendingPaymentId !== null}
                id={`share-amount-${share.id}`}
                inputMode="decimal"
                type="number"
                min="0"
                max={isOwner ? '9999999999.99' : share.shareAmount}
                step="0.01"
                onChange={(event) => {
                  setConfirmation({ shareId: share.id, amount: event.target.value });
                  setActionError(null);
                }}
                value={isConfirming ? confirmation.amount : share.shareAmount}
              />
              <p className="mt-1 text-xs text-slate-500" id={`share-amount-help-${share.id}`}>
                {isOwner
                  ? 'Como owner puedes corregir el importe real de tu propia parte; el coste de la suscripción se conserva.'
                  : `Puedes registrar un importe menor o igual a tu cuota prevista de ${share.shareAmount}.`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="min-h-10 rounded-lg bg-violet-700 px-3 text-sm font-medium text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={sendingPaymentId !== null}
                type="submit"
              >
                {isSending ? 'Guardando…' : 'Confirmar mi parte'}
              </button>
              {isOwner && share.payment.status === 'pending' && (
                <button
                  className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={sendingPaymentId !== null}
                  onClick={() => void skipFamilyPayment(share.payment)}
                  type="button"
                >
                  {isSending ? 'Guardando…' : 'Omitir el pago grupal'}
                </button>
              )}
            </div>
            {error && <p className="text-sm text-red-700" id={errorId} role="alert">{error}</p>}
          </form>
        )}
        {isHistory && error && <p className="mt-3 text-sm text-red-700" id={errorId} role="alert">{error}</p>}

        <button
          aria-controls={breakdownId}
          aria-expanded={expandedPaymentId === share.paymentId}
          className="mt-4 min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
          onClick={() => toggleBreakdown(share.paymentId)}
          type="button"
        >
          {expandedPaymentId === share.paymentId ? 'Ocultar reparto' : 'Ver reparto completo'}
        </button>
        {renderBreakdown(share.paymentId)}
      </li>
    );
  }

  const ownShareListsReady = !pendingLoading && !pending.error && !historyLoading && !history.error;
  const ownPaymentIds = new Set([...pending.shares, ...history.shares].map((share) => share.paymentId));
  const paymentsWithoutOwnShare = ownShareListsReady && unresolvedPayments.groupId === groupId
    ? unresolvedPayments.payments.filter((payment) => !ownPaymentIds.has(payment.id))
    : [];

  function renderPaymentWithoutOwnShare(payment: Payment) {
    const isSending = sendingPaymentId === payment.id;
    const error = actionError?.shareId === payment.id ? actionError.message : '';
    const breakdownId = `family-breakdown-${payment.id}`;

    return (
      <li className="rounded-2xl border border-slate-200 p-4" key={payment.id}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h4 className="break-words font-semibold text-slate-950">{payment.subscriptionName}</h4>
            <p className="mt-1 text-sm text-slate-600">
              Cobro previsto: <time dateTime={payment.expectedDate}>{payment.expectedDate}</time>
            </p>
            <p className="mt-2 text-sm text-slate-600">
              Pago grupal pendiente · importe esperado {payment.expectedAmount}. No tienes una parte registrada; no se crea una cuota retroactiva.
            </p>
          </div>
          <span className="w-fit rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
            {paymentStatusLabel(payment.status)}
          </span>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
          <button
            aria-controls={breakdownId}
            aria-expanded={expandedPaymentId === payment.id}
            className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
            onClick={() => toggleBreakdown(payment.id)}
            type="button"
          >
            {expandedPaymentId === payment.id ? 'Ocultar reparto' : 'Ver reparto completo'}
          </button>
          {isOwner && payment.status === 'pending' && (
            <button
              className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={sendingPaymentId !== null}
              onClick={() => void skipFamilyPayment(payment)}
              type="button"
            >
              {isSending ? 'Guardando…' : 'Omitir el pago grupal'}
            </button>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}
        {renderBreakdown(payment.id)}
      </li>
    );
  }

  return (
    <section aria-labelledby="family-payments-heading" className="mt-10 border-t border-slate-200 pt-8">
      <h2 className="text-2xl font-semibold text-slate-950" id="family-payments-heading">Partes de pago familiares</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
        Aquí ves tus propias partes y el progreso de cada pago grupal. Confirmar tu parte no confirma por sí solo el pago completo.
      </p>
      {notice && <p className="mt-4 rounded-xl bg-violet-50 px-4 py-3 text-sm text-violet-900" role="status">{notice}</p>}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
        <section aria-labelledby="family-pending-heading" className="min-w-0 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-xl font-semibold text-slate-950" id="family-pending-heading">Mis partes pendientes</h3>
            <button
              className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              disabled={pendingLoading || sendingPaymentId !== null}
              onClick={reloadPending}
              type="button"
            >
              Actualizar pendientes
            </button>
          </div>
          <p className="mt-2 text-sm text-slate-500">Hasta 100 partes propias, por fecha prevista del pago más reciente.</p>
          {pendingLoading ? (
            <p className="mt-6 text-sm text-slate-600" role="status">Cargando tus partes…</p>
          ) : pending.error ? (
            <div className="mt-5 rounded-xl bg-red-50 px-4 py-3">
              <p className="text-sm text-red-700" role="alert">{pending.error}</p>
              <button className="mt-3 min-h-9 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-800" onClick={reloadPending} type="button">
                Reintentar pendientes
              </button>
            </div>
          ) : pending.shares.length === 0 ? (
            <p className="mt-6 rounded-xl bg-slate-50 px-4 py-5 text-sm text-slate-600">
              No tienes partes pendientes. Si te incorporaste después de generar un pago, no se crea una cuota retroactiva.
            </p>
          ) : (
            <ul className="mt-5 space-y-4">{pending.shares.map((share) => renderShareItem(share, false))}</ul>
          )}
        </section>

        <section aria-labelledby="family-history-heading" className="min-w-0 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-xl font-semibold text-slate-950" id="family-history-heading">Historial de mis partes</h3>
            <button
              className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              disabled={historyLoading || sendingPaymentId !== null}
              onClick={reloadHistory}
              type="button"
            >
              Actualizar historial
            </button>
          </div>
          <p className="mt-2 text-sm text-slate-500">Partes confirmadas u omitidas; el estado del pago completo puede ser distinto.</p>
          {historyLoading ? (
            <p className="mt-6 text-sm text-slate-600" role="status">Cargando historial…</p>
          ) : history.error ? (
            <div className="mt-5 rounded-xl bg-red-50 px-4 py-3">
              <p className="text-sm text-red-700" role="alert">{history.error}</p>
              <button className="mt-3 min-h-9 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-800" onClick={reloadHistory} type="button">
                Reintentar historial
              </button>
            </div>
          ) : history.shares.length === 0 ? (
            <p className="mt-6 rounded-xl bg-slate-50 px-4 py-5 text-sm text-slate-600">Todavía no tienes partes confirmadas u omitidas.</p>
          ) : (
            <ul className="mt-5 space-y-4">{history.shares.map((share) => renderShareItem(share, true))}</ul>
          )}
        </section>
      </div>

      <section aria-labelledby="family-unassigned-heading" className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-xl font-semibold text-slate-950" id="family-unassigned-heading">Pagos grupales sin una parte tuya</h3>
          <button
            className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            disabled={paymentsLoading || sendingPaymentId !== null}
            onClick={reloadPayments}
            type="button"
          >
            Actualizar pagos grupales
          </button>
        </div>
        <p className="mt-2 text-sm text-slate-500">
          Pagos pendientes generados antes de que tuvieras una parte. Puedes consultar el reparto; solo el owner puede omitir el pago completo.
        </p>
        {paymentsLoading ? (
          <p className="mt-6 text-sm text-slate-600" role="status">Comprobando pagos y tus partes…</p>
        ) : unresolvedPayments.error ? (
          <div className="mt-5 rounded-xl bg-red-50 px-4 py-3">
            <p className="text-sm text-red-700" role="alert">{unresolvedPayments.error}</p>
            <button className="mt-3 min-h-9 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-800" onClick={reloadPayments} type="button">
              Reintentar pagos grupales
            </button>
          </div>
        ) : pendingLoading || historyLoading ? (
          <p className="mt-6 text-sm text-slate-600" role="status">Comprobando pagos y tus partes…</p>
        ) : pending.error || history.error ? (
          <p className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
            No podemos determinar con seguridad cuáles pagos carecen de una parte tuya. Reintenta cargar tus partes y el historial.
          </p>
        ) : paymentsWithoutOwnShare.length === 0 ? (
          <p className="mt-6 rounded-xl bg-slate-50 px-4 py-5 text-sm text-slate-600">No hay pagos pendientes sin una parte tuya registrada.</p>
        ) : (
          <ul className="mt-5 space-y-4">{paymentsWithoutOwnShare.map(renderPaymentWithoutOwnShare)}</ul>
        )}
      </section>
    </section>
  );
}
