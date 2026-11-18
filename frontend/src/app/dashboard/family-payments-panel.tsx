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
      <div className="payment-breakdown" id={panelId}>
        {!state || state.loading || state.refreshVersion !== refreshVersion ? (
          <p className="payments-description" role="status">Cargando reparto…</p>
        ) : state?.error ? (
          <div>
            <p className="ui-feedback ui-feedback-error" role="alert">{state.error}</p>
            <button
              className="ui-button ui-button-secondary mt-3"
              onClick={() => reloadBreakdown(paymentId)}
              type="button"
            >
              Reintentar reparto
            </button>
          </div>
        ) : state?.data ? (
          <>
            <h4>Reparto de {state.data.payment.subscriptionName}</h4>
            <p className="payments-description">
              {state.data.summary.confirmedShares} de {state.data.summary.totalShares} partes confirmadas ·
              importe confirmado {state.data.summary.confirmedAmount}
            </p>
            {state.data.shares.length === 0 ? (
              <p className="payments-description">Este pago no tiene partes registradas.</p>
            ) : (
              <ul className="payment-participants" aria-label="Participantes del pago">
                {state.data.shares.map((item) => (
                  <li className="payment-participant" key={item.id}>
                    <h5>{item.userName}</h5>
                    <dl className="payment-group-values">
                      <div><dt>Cuota prevista</dt><dd>{item.shareAmount}</dd></div>
                      <div><dt>Porcentaje asignado</dt><dd>{item.sharePercentage}%</dd></div>
                      <div><dt>Importe registrado</dt><dd>{item.actualAmount ?? (item.status === 'skipped' ? 'Sin importe' : 'Sin registrar')}</dd></div>
                      <div><dt>Estado de la parte</dt><dd>{shareStatusLabel(item.status)}</dd></div>
                    </dl>
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
      <li className="payment-row" key={share.id}>
        <div className={`payment-top${isHistory ? ' payment-history-top' : ''}`}>
          {isHistory && (
            <span
              aria-hidden="true"
              className={`payment-history-mark payment-history-mark-${share.status}`}
            >
              {share.status === 'confirmed' ? '✓' : '×'}
            </span>
          )}
          <div>
            <h3 className="payment-name">{share.payment.subscriptionName}</h3>
            <p className="payment-date">
              Cobro previsto: <time dateTime={share.payment.expectedDate}>{share.payment.expectedDate}</time>
            </p>
          </div>
        </div>
        <h4 className="payment-scope-title">Tu parte</h4>
        <dl className="payment-values payment-own-values">
          <div><dt>Tu cuota prevista</dt><dd>{share.shareAmount}</dd></div>
          <div><dt>Tu importe registrado</dt><dd>{share.actualAmount ?? (share.status === 'skipped' ? 'Sin importe' : 'Sin registrar')}</dd></div>
          <div><dt>Estado de tu parte</dt><dd><span className={`payment-badge ${share.status === 'pending' ? 'payment-badge-pending' : share.status === 'confirmed' ? 'payment-badge-confirmed' : 'payment-badge-skipped'}`}>{ownShareStatusLabel(share.status)}</span></dd></div>
        </dl>
        <div className="payment-group-context">
          <h4 className="payment-scope-title">Pago del grupo</h4>
          <dl className="payment-group-values">
            <div><dt>Total previsto</dt><dd>{share.payment.expectedAmount}</dd></div>
            <div><dt>Confirmado por el grupo</dt><dd>{share.summary.confirmedAmount}</dd></div>
            <div><dt>Partes confirmadas</dt><dd>{share.summary.confirmedShares} de {share.summary.totalShares}</dd></div>
            <div><dt>Estado del pago completo</dt><dd>{paymentStatusLabel(share.payment.status)}</dd></div>
          </dl>
        </div>

        {!isHistory && (
          <form className="payment-confirmation" onSubmit={(event) => submitConfirmation(event, share)}>
            <div>
              <label className="app-design-label mb-1.5 block text-sm font-medium" htmlFor={`share-amount-${share.id}`}>
                Importe real de tu parte
              </label>
              <input
                aria-describedby={`${error ? `${errorId} ` : ''}share-amount-help-${share.id}`}
                className="ui-field"
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
              <p className="payment-hint" id={`share-amount-help-${share.id}`}>
                {isOwner
                  ? 'Como responsable puedes corregir el importe real de tu propia parte; el coste de la suscripción se conserva.'
                  : `Puedes registrar un importe menor o igual a tu cuota prevista de ${share.shareAmount}.`}
              </p>
            </div>
            <div className="payment-actions payment-pending-actions">
              <button className="ui-button" disabled={sendingPaymentId !== null} type="submit">
                <span>{isSending ? 'Guardando…' : 'Confirmar mi parte'}</span>
              </button>
              {isOwner && share.payment.status === 'pending' && (
                <button
                  className="ui-button ui-button-secondary"
                  disabled={sendingPaymentId !== null}
                  onClick={() => void skipFamilyPayment(share.payment)}
                  type="button"
                >
                  <span>{isSending ? 'Guardando…' : 'Omitir el pago grupal'}</span>
                </button>
              )}
              <button
                aria-controls={breakdownId}
                aria-expanded={expandedPaymentId === share.paymentId}
                className="ui-button ui-button-secondary"
                onClick={() => toggleBreakdown(share.paymentId)}
                type="button"
              >
                <span>{expandedPaymentId === share.paymentId ? 'Ocultar reparto' : 'Ver reparto completo'}</span>
              </button>
            </div>
            {error && <p className="ui-feedback ui-feedback-error mt-4" id={errorId} role="alert">{error}</p>}
          </form>
        )}
        {isHistory && error && <p className="ui-feedback ui-feedback-error mt-4" id={errorId} role="alert">{error}</p>}

        {isHistory && (
          <div className="payment-actions">
            <button
              aria-controls={breakdownId}
              aria-expanded={expandedPaymentId === share.paymentId}
              className="ui-button ui-button-secondary"
              onClick={() => toggleBreakdown(share.paymentId)}
              type="button"
            >
              {expandedPaymentId === share.paymentId ? 'Ocultar reparto' : 'Ver reparto completo'}
            </button>
          </div>
        )}
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
      <li className="payment-row" key={payment.id}>
        <div className="payment-top">
          <div>
            <h3 className="payment-name">{payment.subscriptionName}</h3>
            <p className="payment-date">Cobro previsto: <time dateTime={payment.expectedDate}>{payment.expectedDate}</time></p>
          </div>
          <span className="payment-badge payment-badge-pending">{paymentStatusLabel(payment.status)}</span>
        </div>
        <dl className="payment-values">
          <div><dt>Total previsto del grupo</dt><dd>{payment.expectedAmount}</dd></div>
          <div><dt>Tu parte</dt><dd>Sin parte asignada</dd></div>
        </dl>
        <p className="payment-hint">Puedes consultar el reparto. No se crea una cuota retroactiva para ti.</p>

        <div className="payment-actions">
          <button
            aria-controls={breakdownId}
            aria-expanded={expandedPaymentId === payment.id}
            className="ui-button ui-button-secondary"
            onClick={() => toggleBreakdown(payment.id)}
            type="button"
          >
            {expandedPaymentId === payment.id ? 'Ocultar reparto' : 'Ver reparto completo'}
          </button>
          {isOwner && payment.status === 'pending' && (
            <button
              className="ui-button ui-button-secondary"
              disabled={sendingPaymentId !== null}
              onClick={() => void skipFamilyPayment(payment)}
              type="button"
            >
              {isSending ? 'Guardando…' : 'Omitir el pago grupal'}
            </button>
          )}
        </div>
        {error && <p className="ui-feedback ui-feedback-error mt-4" role="alert">{error}</p>}
        {renderBreakdown(payment.id)}
      </li>
    );
  }

  return (
    <section aria-label="Pagos familiares" className="payments-panel">
      <p className="payments-description">
        Aquí ves tus propias partes y el progreso de cada pago grupal. Confirmar tu parte no confirma por sí solo el pago completo.
      </p>
      {notice && <p className="ui-feedback payment-notice" role="status">{notice}</p>}

      <div className="payments-stack">
        <section aria-labelledby="family-pending-heading" className="payments-section">
          <div className="payments-section-heading">
            <h2 id="family-pending-heading">Mis partes pendientes</h2>
            <button
              className="ui-button ui-button-secondary"
              disabled={pendingLoading || sendingPaymentId !== null}
              onClick={reloadPending}
              type="button"
            >
              Actualizar pendientes
            </button>
          </div>
          <p className="payments-description">Hasta 100 partes propias, por fecha prevista del pago más reciente.</p>
          {pendingLoading ? (
            <p className="payment-state" role="status">Cargando tus partes…</p>
          ) : pending.error ? (
            <div className="ui-feedback ui-feedback-error mt-5">
              <p className="text-sm text-red-700" role="alert">{pending.error}</p>
              <button className="ui-button ui-button-secondary mt-3" onClick={reloadPending} type="button">
                Reintentar pendientes
              </button>
            </div>
          ) : pending.shares.length === 0 ? (
            <p className="payment-state">
              No tienes partes pendientes. Si te incorporaste después de generar un pago, no se crea una cuota retroactiva.
            </p>
          ) : (
            <ul className="payments-list">{pending.shares.map((share) => renderShareItem(share, false))}</ul>
          )}
        </section>

        <section aria-labelledby="family-history-heading" className="payments-section">
          <div className="payments-section-heading">
            <h2 id="family-history-heading">Historial de mis partes</h2>
            <button
              className="ui-button ui-button-secondary"
              disabled={historyLoading || sendingPaymentId !== null}
              onClick={reloadHistory}
              type="button"
            >
              Actualizar historial
            </button>
          </div>
          <p className="payments-description">Partes confirmadas u omitidas; el estado del pago completo puede ser distinto.</p>
          {historyLoading ? (
            <p className="payment-state" role="status">Cargando historial…</p>
          ) : history.error ? (
            <div className="ui-feedback ui-feedback-error mt-5">
              <p className="text-sm text-red-700" role="alert">{history.error}</p>
              <button className="ui-button ui-button-secondary mt-3" onClick={reloadHistory} type="button">
                Reintentar historial
              </button>
            </div>
          ) : history.shares.length === 0 ? (
            <p className="payment-state">Todavía no tienes partes confirmadas u omitidas.</p>
          ) : (
            <ul className="payments-list">{history.shares.map((share) => renderShareItem(share, true))}</ul>
          )}
        </section>
      </div>

      <section aria-labelledby="family-unassigned-heading" className="payments-section mt-9">
        <div className="payments-section-heading">
          <h2 id="family-unassigned-heading">Pagos grupales sin una parte tuya</h2>
          <button
            className="ui-button ui-button-secondary"
            disabled={paymentsLoading || sendingPaymentId !== null}
            onClick={reloadPayments}
            type="button"
          >
            Actualizar pagos grupales
          </button>
        </div>
        <p className="payments-description">
          Pagos pendientes generados antes de que tuvieras una parte. Puedes consultar el reparto; solo el responsable puede omitir el pago completo.
        </p>
        {paymentsLoading ? (
          <p className="payment-state" role="status">Comprobando pagos y tus partes…</p>
        ) : unresolvedPayments.error ? (
          <div className="ui-feedback ui-feedback-error mt-5">
            <p className="text-sm text-red-700" role="alert">{unresolvedPayments.error}</p>
            <button className="ui-button ui-button-secondary mt-3" onClick={reloadPayments} type="button">
              Reintentar pagos grupales
            </button>
          </div>
        ) : pendingLoading || historyLoading ? (
          <p className="payment-state" role="status">Comprobando pagos y tus partes…</p>
        ) : pending.error || history.error ? (
          <p className="payment-state" role="status">
            No podemos determinar con seguridad cuáles pagos carecen de una parte tuya. Reintenta cargar tus partes y el historial.
          </p>
        ) : paymentsWithoutOwnShare.length === 0 ? (
          <p className="payment-state">No hay pagos pendientes sin una parte tuya registrada.</p>
        ) : (
          <ul className="payments-list">{paymentsWithoutOwnShare.map(renderPaymentWithoutOwnShare)}</ul>
        )}
      </section>
    </section>
  );
}
