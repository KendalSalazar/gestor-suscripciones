'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiWithSession, refreshSession } from '@/lib/api';
import { session } from '@/lib/session';
import AppShell from '@/components/app-shell';

type Group = { id: string; name: string; type: 'personal' | 'family' };
type Notice = {
  id: string;
  groupId: string;
  type: 'payment_due' | 'payment_overdue' | 'amount_changed';
  subscriptionName: string;
  groupName: string;
  groupType: 'personal' | 'family';
  expectedDate: string;
  expectedAmount: string;
  actualAmount: string | null;
  paymentStatus: 'pending' | 'confirmed' | 'skipped';
  ownShareStatus: 'pending' | 'confirmed' | 'skipped' | null;
  actionRequired: boolean;
  message: string;
  createdAt: string;
  readAt: string | null;
};
type NoticePage = { notifications: Notice[]; nextCursor: string | null; unreadCount: number };
type AuthState = 'loading' | 'ready' | 'unauthenticated' | 'error';
type LoadState = 'loading' | 'ready' | 'error';
type Status = 'all' | 'unread' | 'read';

const typeLabels: Record<Notice['type'], string> = {
  payment_due: 'Pago generado',
  payment_overdue: 'Pago pendiente',
  amount_changed: 'Importe diferente',
};
const paymentLabels: Record<Notice['paymentStatus'], string> = {
  pending: 'Pendiente', confirmed: 'Confirmado', skipped: 'Omitido',
};

function calendarDate(value: string): string {
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

function timestamp(value: string): string {
  return new Date(value).toLocaleString('es-CR', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function NotificationsPage() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const [authVersion, setAuthVersion] = useState(0);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupsState, setGroupsState] = useState<LoadState>('loading');
  const [groupsVersion, setGroupsVersion] = useState(0);
  const [groupId, setGroupId] = useState('');
  const [status, setStatus] = useState<Status>('all');
  const [version, setVersion] = useState(0);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [listState, setListState] = useState<LoadState>('loading');
  const [listError, setListError] = useState('');
  const [contextMessage, setContextMessage] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingReadId, setMarkingReadId] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ notificationId: string; message: string; isError: boolean } | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const markingReadRef = useRef<string | null>(null);

  const invalidateList = useCallback(() => {
    requestIdRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setNotices([]);
    setNextCursor(null);
    setUnreadCount(null);
    setListError('');
    setListState('loading');
  }, []);

  const expireSession = useCallback(() => {
    session.setAccessToken(null);
    invalidateList();
    setGroups([]);
    setAuth('unauthenticated');
  }, [invalidateList]);

  useEffect(() => {
    let active = true;
    async function restoreSession() {
      try {
        if (!session.getAccessToken()) await refreshSession();
        if (active) setAuth('ready');
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) expireSession();
        else setAuth('error');
      }
    }
    void restoreSession();
    return () => { active = false; };
  }, [authVersion, expireSession]);

  useEffect(() => {
    if (auth !== 'ready') return;
    const controller = new AbortController();
    async function loadGroups() {
      try {
        const result = await apiWithSession<{ groups: Group[] }>('/groups', { signal: controller.signal });
        if (!result) throw new Error('Respuesta vacía');
        if (controller.signal.aborted) return;
        setGroups(result.groups);
        setGroupsState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) return expireSession();
        setGroupsState('error');
      }
    }
    void loadGroups();
    return () => controller.abort();
  }, [auth, groupsVersion, expireSession]);

  const loadPage = useCallback(async (cursor: string | null, append: boolean) => {
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    const requestId = ++requestIdRef.current;
    const query = new URLSearchParams({ status });
    if (groupId) query.set('groupId', groupId);
    if (cursor) query.set('cursor', cursor);

    try {
      const result = await apiWithSession<NoticePage>(`/notifications?${query}`, { signal: controller.signal });
      if (!result) throw new Error('Respuesta vacía');
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      setNotices((current) => {
        if (!append) return result.notifications;
        const ids = new Set(current.map((notice) => notice.id));
        return [...current, ...result.notifications.filter((notice) => !ids.has(notice.id))];
      });
      setNextCursor(result.nextCursor);
      setUnreadCount(result.unreadCount);
      setListState('ready');
      setListError('');
    } catch (error) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      if (error instanceof ApiError && error.status === 401) return expireSession();
      if (error instanceof ApiError && error.status === 403 && groupId) {
        invalidateList();
        setGroupId('');
        setContextMessage('Ya no tienes acceso a ese espacio. Mostramos todos tus espacios disponibles.');
        setGroupsState('loading');
        setGroupsVersion((current) => current + 1);
        return;
      }
      setListError(append ? 'No pudimos cargar más avisos. Inténtalo de nuevo.' : 'No pudimos cargar los avisos. Inténtalo de nuevo.');
      if (!append) setListState('error');
    } finally {
      if (requestId === requestIdRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [status, groupId, expireSession, invalidateList]);

  useEffect(() => {
    if (auth !== 'ready') return;
    let active = true;
    void Promise.resolve().then(() => { if (active) void loadPage(null, false); });
    return () => {
      active = false;
      requestIdRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [auth, loadPage, version]);

  function changeFilters(nextGroup: string, nextStatus: Status) {
    if (nextGroup === groupId && nextStatus === status) return;
    invalidateList();
    setContextMessage('');
    setGroupId(nextGroup);
    setStatus(nextStatus);
  }

  function refresh() {
    invalidateList();
    setContextMessage('');
    setVersion((current) => current + 1);
  }

  function loadMore() {
    if (!nextCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setListError('');
    void loadPage(nextCursor, true);
  }

  async function markAsRead(notice: Notice) {
    if (notice.readAt || markingReadRef.current) return;
    markingReadRef.current = notice.id;
    setMarkingReadId(notice.id);
    setActionFeedback(null);
    try {
      const result = await apiWithSession<{ notification: Notice }>(`/notifications/${notice.id}/read`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!result) throw new Error('Respuesta vacía');
      setActionFeedback({ notificationId: notice.id, message: 'Aviso marcado como leído.', isError: false });
      invalidateList();
      setVersion((current) => current + 1);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        expireSession();
      } else if (error instanceof ApiError && error.status === 404) {
        setContextMessage('El aviso ya no está disponible. Actualizamos el listado.');
        invalidateList();
        setVersion((current) => current + 1);
      } else {
        setActionFeedback({ notificationId: notice.id, message: 'No pudimos marcar el aviso como leído. Inténtalo de nuevo.', isError: true });
      }
    } finally {
      if (markingReadRef.current === notice.id) markingReadRef.current = null;
      setMarkingReadId(null);
    }
  }

  if (auth === 'loading') return (
    <main className="app-design notification-gate">
      <h1>Notificaciones</h1>
      <p className="notification-gate-state" role="status">Comprobando tu sesión…</p>
    </main>
  );
  if (auth === 'unauthenticated') return (
    <main className="app-design notification-gate">
      <h1>Notificaciones</h1>
      <p className="notification-gate-state">Inicia sesión para consultar tus avisos.</p>
      <Link className="ui-button" href="/login">Iniciar sesión</Link>
    </main>
  );
  if (auth === 'error') return (
    <main className="app-design notification-gate">
      <h1>Notificaciones</h1>
      <p className="ui-feedback ui-feedback-error" role="alert">No pudimos recuperar tu sesión. Comprueba la conexión e inténtalo de nuevo.</p>
      <button className="ui-button ui-button-secondary" onClick={() => { setAuth('loading'); setAuthVersion((current) => current + 1); }} type="button">Reintentar</button>
    </main>
  );

  return (
    <AppShell
      context={<p className="notification-context">Avisos de tus espacios</p>}
      description="Revisa los avisos de tus suscripciones y las acciones que tienes pendientes."
      navigation={(
        <nav aria-label="Secciones principales" className="app-shell-navigation">
          <Link className="app-shell-nav-item" href="/dashboard">Dashboard</Link>
        </nav>
      )}
      title="Notificaciones"
      notificationsActive
      actions={(
        <button className="ui-button ui-button-secondary" onClick={refresh} type="button">
          Actualizar avisos
        </button>
      )}
    >
      <div className="notification-page">
        {unreadCount !== null && (
          <p aria-live="polite" className="notification-unread-summary">
            <span>Avisos sin leer</span>
            <strong>{unreadCount}</strong>
          </p>
        )}

        <section aria-label="Filtros de notificaciones" className="notification-filters">
          <div className="notification-filter-fields">
            <label htmlFor="notice-group">
              Espacio
              <select
                className="ui-field"
                disabled={groupsState !== 'ready'}
                id="notice-group"
                onChange={(event) => changeFilters(event.target.value, status)}
                value={groupId}
              >
                <option value="">Todos los espacios</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name} ({group.type === 'family' ? 'Familiar' : 'Personal'})
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="notice-status">
              Estado de lectura
              <select
                className="ui-field"
                id="notice-status"
                onChange={(event) => changeFilters(groupId, event.target.value as Status)}
                value={status}
              >
                <option value="all">Todos</option>
                <option value="unread">Sin leer</option>
                <option value="read">Leídos</option>
              </select>
            </label>
          </div>
          {groupsState === 'loading' && <p className="notification-inline-state" role="status">Cargando espacios…</p>}
          {groupsState === 'error' && (
            <div className="notification-inline-error">
              <p role="alert">No pudimos cargar los espacios. Puedes seguir consultando todos tus avisos.</p>
              <button className="ui-button ui-button-secondary" onClick={() => { setGroupsState('loading'); setGroupsVersion((current) => current + 1); }} type="button">
                Reintentar espacios
              </button>
            </div>
          )}
          {contextMessage && <p className="notification-context-message" role="status">{contextMessage}</p>}
        </section>

        <section
          aria-busy={listState === 'loading' || loadingMore}
          aria-labelledby="notification-list-heading"
          className="notification-list-section"
        >
          <header className="notification-list-heading">
            <div>
              <h2 id="notification-list-heading">Actividad</h2>
            </div>
          </header>

          {listState === 'loading' && <p className="notification-state" role="status">Cargando avisos…</p>}
          {listState === 'error' && (
            <div className="notification-state notification-state-error">
              <p role="alert">{listError}</p>
              <button className="ui-button ui-button-secondary" onClick={refresh} type="button">Reintentar avisos</button>
            </div>
          )}
          {listState === 'ready' && notices.length === 0 && (
            <p className="notification-state notification-state-empty">
              {status === 'all' && !groupId ? 'Todavía no tienes avisos.' : 'No hay avisos para estos filtros.'}
            </p>
          )}
          {listState === 'ready' && notices.length > 0 && (
            <ul className="notification-list">
              {notices.map((notice) => (
                <li className={`notification-row${notice.readAt ? '' : ' notification-row-unread'}`} key={notice.id}>
                  <div className="notification-row-heading">
                    <div className="notification-kind-and-state">
                      <h3 className="notification-service">{notice.subscriptionName}</h3>
                      <span className={`notification-read-state${notice.readAt ? ' notification-read-state-read' : ' notification-read-state-unread'}`}>
                        {notice.readAt ? 'Leído' : 'Sin leer'}
                      </span>
                    </div>
                    <time className="notification-created-at" dateTime={notice.createdAt}>{timestamp(notice.createdAt)}</time>
                  </div>

                  <p className="notification-message">{notice.message}</p>
                  <p className="notification-service-context">
                    <span>{typeLabels[notice.type]}</span>
                    <span>{notice.groupName} ({notice.groupType === 'family' ? 'Familiar' : 'Personal'})</span>
                  </p>

                  <details className="notification-details">
                    <summary>Ver detalles<span className="notification-sr-only"> de {notice.subscriptionName}</span></summary>
                    <dl className="notification-facts">
                    <div>
                      <dt>Fecha prevista</dt>
                      <dd><time dateTime={notice.expectedDate}>{calendarDate(notice.expectedDate)}</time></dd>
                    </div>
                    <div>
                      <dt>Importe previsto</dt>
                      <dd>{notice.expectedAmount}</dd>
                    </div>
                    {notice.actualAmount !== null && (
                      <div>
                        <dt>Importe registrado</dt>
                        <dd>{notice.actualAmount}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Estado del pago</dt>
                      <dd>{paymentLabels[notice.paymentStatus]}</dd>
                    </div>
                    {notice.groupType === 'family' && notice.ownShareStatus && (
                      <div>
                        <dt>Tu parte</dt>
                        <dd>{paymentLabels[notice.ownShareStatus]}</dd>
                      </div>
                    )}
                    </dl>
                  </details>

                  {notice.actionRequired && (
                    <p className="notification-action-required">Tu confirmación está pendiente.</p>
                  )}
                  {actionFeedback?.notificationId === notice.id && (
                    <p className={`notification-action-feedback${actionFeedback.isError ? ' notification-action-feedback-error' : ''}`} role={actionFeedback.isError ? 'alert' : 'status'}>
                      {actionFeedback.message}
                    </p>
                  )}
                  <div className="notification-row-actions">
                    <Link className="notification-payments-link" href={`/dashboard?groupId=${encodeURIComponent(notice.groupId)}&view=payments`}>
                      Abrir pagos de este grupo
                    </Link>
                    {!notice.readAt && (
                      <button
                        className="ui-button ui-button-secondary"
                        disabled={markingReadId !== null}
                        onClick={() => void markAsRead(notice)}
                        type="button"
                      >
                        {markingReadId === notice.id ? 'Marcando…' : 'Marcar como leído'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {listState === 'ready' && listError && <p className="notification-load-more-error" role="alert">{listError}</p>}
          {listState === 'ready' && nextCursor && (
            <div className="notification-load-more">
              <button className="ui-button ui-button-secondary" disabled={loadingMore} onClick={loadMore} type="button">
                {loadingMore ? 'Cargando…' : 'Cargar más avisos'}
              </button>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
