'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiWithSession, refreshSession } from '@/lib/api';
import { session } from '@/lib/session';

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

  if (auth === 'loading') return <main className="mx-auto max-w-4xl p-6"><p role="status">Cargando sesión...</p></main>;
  if (auth === 'unauthenticated') return <main className="mx-auto max-w-4xl p-6"><h1 className="text-2xl font-semibold">Notificaciones</h1><p className="mt-4">Inicia sesión para consultar tus avisos.</p><Link className="mt-4 inline-block underline" href="/login">Ir a iniciar sesión</Link></main>;
  if (auth === 'error') return <main className="mx-auto max-w-4xl p-6"><h1 className="text-2xl font-semibold">Notificaciones</h1><p className="mt-4" role="alert">No pudimos recuperar tu sesión. Comprueba la conexión e inténtalo de nuevo.</p><button className="mt-4 underline" onClick={() => { setAuth('loading'); setAuthVersion((current) => current + 1); }}>Reintentar</button></main>;

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold">Notificaciones</h1>
        <p>Consulta los avisos de tus suscripciones.</p>
        {unreadCount !== null && <p aria-live="polite">Sin leer: <strong>{unreadCount}</strong></p>}
      </header>

      <section aria-label="Filtros de notificaciones" className="space-y-4 rounded-xl border border-slate-300 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1" htmlFor="notice-group">Espacio
            <select id="notice-group" className="min-w-0 max-w-full rounded border border-slate-400 p-2" value={groupId} onChange={(event) => changeFilters(event.target.value, status)} disabled={groupsState !== 'ready'}>
              <option value="">Todos los espacios</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name} ({group.type === 'family' ? 'Familiar' : 'Personal'})</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1" htmlFor="notice-status">Estado de lectura
            <select id="notice-status" className="rounded border border-slate-400 p-2" value={status} onChange={(event) => changeFilters(groupId, event.target.value as Status)}>
              <option value="all">Todos</option><option value="unread">Sin leer</option><option value="read">Leídos</option>
            </select>
          </label>
        </div>
        {groupsState === 'loading' && <p role="status">Cargando espacios...</p>}
        {groupsState === 'error' && <p role="alert">No pudimos cargar los espacios. Puedes seguir consultando los avisos. <button className="underline" onClick={() => { setGroupsState('loading'); setGroupsVersion((current) => current + 1); }}>Reintentar espacios</button></p>}
        {contextMessage && <p role="status">{contextMessage}</p>}
        <button className="rounded border border-slate-500 px-4 py-2 hover:bg-slate-100 hover:text-slate-900" onClick={refresh}>Actualizar</button>
      </section>

      <section aria-label="Listado de notificaciones" aria-busy={listState === 'loading' || loadingMore} className="space-y-4">
        {listState === 'loading' && <p role="status">Cargando avisos...</p>}
        {listState === 'error' && <div role="alert"><p>{listError}</p><button className="mt-2 underline" onClick={refresh}>Reintentar</button></div>}
        {listState === 'ready' && notices.length === 0 && <p>{status === 'all' && !groupId ? 'Todavía no tienes avisos.' : 'No hay avisos para estos filtros.'}</p>}
        {listState === 'ready' && notices.length > 0 && (
          <ul className="space-y-4">
            {notices.map((notice) => (
              <li key={notice.id} className="space-y-2 rounded-xl border border-slate-300 p-4 [overflow-wrap:anywhere]">
                <div className="flex flex-wrap justify-between gap-2"><strong>{typeLabels[notice.type]}</strong><span>{notice.readAt ? 'Leído' : 'Sin leer'}</span></div>
                <p>{notice.message}</p>
                <p><strong>{notice.subscriptionName}</strong> · {notice.groupName} ({notice.groupType === 'family' ? 'Familiar' : 'Personal'})</p>
                <p>Fecha prevista: {calendarDate(notice.expectedDate)} · Importe previsto: {notice.expectedAmount}{notice.actualAmount !== null && ` · Importe registrado: ${notice.actualAmount}`}</p>
                <p>Pago: {paymentLabels[notice.paymentStatus]}{notice.groupType === 'family' && notice.ownShareStatus && ` · Tu parte: ${paymentLabels[notice.ownShareStatus]}`}</p>
                {notice.actionRequired && <p>Tu confirmación está pendiente.</p>}
                <p className="text-sm">Aviso creado: <time dateTime={notice.createdAt}>{timestamp(notice.createdAt)}</time></p>
                <Link className="inline-block underline text-violet-700 hover:text-violet-900" href={`/dashboard?groupId=${encodeURIComponent(notice.groupId)}&view=payments`}>Abrir pagos de este grupo</Link>
                {actionFeedback?.notificationId === notice.id && <p role={actionFeedback.isError ? 'alert' : 'status'}>{actionFeedback.message}</p>}
                {!notice.readAt && <button className="rounded border border-slate-500 px-4 py-2 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50" disabled={markingReadId !== null} onClick={() => void markAsRead(notice)}>{markingReadId === notice.id ? 'Marcando...' : 'Marcar como leído'}</button>}
              </li>
            ))}
          </ul>
        )}
        {listState === 'ready' && listError && <p role="alert">{listError}</p>}
        {listState === 'ready' && nextCursor && <button className="rounded border border-slate-500 px-4 py-2 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50" disabled={loadingMore} onClick={loadMore}>{loadingMore ? 'Cargando...' : 'Cargar más'}</button>}
      </section>
    </main>
  );
}
