'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ApiError, apiWithSession, refreshSession } from '@/lib/api';
import { session } from '@/lib/session';
import PaymentsPanel from './payments-panel';
import FamilyPaymentsPanel from './family-payments-panel';
import FamilyGroupsPanel from './family-groups-panel';
import InvitationsPanel from './invitations-panel';

type Group = {
  id: string;
  name: string;
  type: 'personal' | 'family';
  ownerId: string;
  role: 'owner' | 'member';
  createdAt: string;
};

type Subscription = {
  id: string;
  name: string;
  provider: string;
  expectedCost: string;
  billingCycle: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  nextBillingDate: string;
  active: boolean;
};

type MeResponse = {
  user: {
    id: string;
    email: string;
    name: string;
  };
  personalGroupId: string;
};

type SubscriptionsResponse = {
  subscriptions: Subscription[];
};

type GroupsResponse = { groups: Group[] };

type SubscriptionResponse = {
  subscription: Subscription;
};

type PageState = 'loading' | 'ready' | 'unauthenticated' | 'error';
type DashboardView = 'subscriptions' | 'payments' | 'family';

const dashboardViews: { id: DashboardView; label: string }[] = [
  { id: 'subscriptions', label: 'Suscripciones' },
  { id: 'payments', label: 'Pagos' },
  { id: 'family', label: 'Familia' },
];

const initialForm = {
  name: '',
  provider: '',
  expectedCost: '',
  billingCycle: 'monthly' as Subscription['billingCycle'],
  nextBillingDate: '',
};

const cycleLabels: Record<Subscription['billingCycle'], string> = {
  weekly: 'Semanal',
  monthly: 'Mensual',
  quarterly: 'Trimestral',
  yearly: 'Anual',
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Ocurrió un error inesperado.';
}

function displayDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('es-CR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export default function DashboardPage() {
  const selectedGroupIdRef = useRef<string | null>(null);
  const [pageState, setPageState] = useState<PageState>('loading');
  const [activeView, setActiveView] = useState<DashboardView>('subscriptions');
  const [viewVersions, setViewVersions] = useState<Record<DashboardView, number>>({ subscriptions: 0, payments: 0, family: 0 });
  const [pageError, setPageError] = useState('');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [personalGroupId, setPersonalGroupId] = useState<string | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupsState, setGroupsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [groupsError, setGroupsError] = useState('');
  const [groupsVersion, setGroupsVersion] = useState(0);
  const [groupContextNotice, setGroupContextNotice] = useState('');
  const [userName, setUserName] = useState('');
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [subscriptionsContextId, setSubscriptionsContextId] = useState<string | null>(null);
  const [form, setForm] = useState(initialForm);
  const [formError, setFormError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [groupActionPending, setGroupActionPending] = useState(false);
  const [pendingSubscriptionId, setPendingSubscriptionId] = useState<string | null>(null);
  const [subscriptionsState, setSubscriptionsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [subscriptionsError, setSubscriptionsError] = useState('');
  const [subscriptionActionError, setSubscriptionActionError] = useState('');
  const [subscriptionsVersion, setSubscriptionsVersion] = useState(0);
  const [editingCostId, setEditingCostId] = useState<string | null>(null);
  const [editedCost, setEditedCost] = useState('');

  const handleSessionExpired = useCallback(() => {
    session.setAccessToken(null);
    setPageState('unauthenticated');
  }, []);

  const retryGroups = useCallback(() => {
    setGroupsState('loading');
    setGroupsError('');
    setGroupsVersion((current) => current + 1);
  }, []);
  const accessRefreshInFlight = useRef(false);
  const refreshGroupsAfterForbidden = useCallback(() => {
    if (accessRefreshInFlight.current) return;
    accessRefreshInFlight.current = true;
    retryGroups();
  }, [retryGroups]);

  useEffect(() => {
    let isMounted = true;

    async function loadDashboard() {
      if (!session.getAccessToken()) {
        try {
          await refreshSession();
        } catch {
          if (isMounted) setPageState('unauthenticated');
          return;
        }
      }

      try {
        const profile = await apiWithSession<MeResponse>('/auth/me');
        if (!profile) throw new Error('El servidor no devolvió el perfil del usuario.');

        if (isMounted) {
          setUserName(profile.user.name);
          setPersonalGroupId(profile.personalGroupId);
          selectedGroupIdRef.current = profile.personalGroupId;
          setGroupId(profile.personalGroupId);
          setPageState('ready');
        }
      } catch (error) {
        if (!isMounted) return;

        if (error instanceof ApiError && error.status === 401) {
          session.setAccessToken(null);
          setPageState('unauthenticated');
          return;
        }

        setPageError(errorText(error));
        setPageState('error');
      }
    }

    void loadDashboard();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (pageState !== 'ready' || !personalGroupId) return;
    const controller = new AbortController();

    async function loadGroups() {
      try {
        const result = await apiWithSession<GroupsResponse>('/groups', { signal: controller.signal });
        if (!result) throw new Error('El servidor no devolvió tus grupos.');
        if (controller.signal.aborted) return;
        setGroups(result.groups);
        setGroupsState('ready');
        setGroupsError('');
        accessRefreshInFlight.current = false;
        if (!result.groups.some((group) => group.id === selectedGroupIdRef.current)) {
          if (selectedGroupIdRef.current !== personalGroupId) {
            setGroupContextNotice('Ya no tienes acceso a esa familia. Volvimos a tu grupo personal.');
          }
          selectedGroupIdRef.current = personalGroupId;
          setGroupId(personalGroupId);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          handleSessionExpired();
          return;
        }
        setGroupsError('No pudimos cargar tus grupos. Puedes seguir usando el grupo personal e intentarlo de nuevo.');
        setGroupsState('error');
        accessRefreshInFlight.current = false;
      }
    }

    void loadGroups();
    return () => controller.abort();
  }, [pageState, personalGroupId, groupsVersion, handleSessionExpired]);

  useEffect(() => {
    if (!groupId) return;
    const controller = new AbortController();

    async function loadSubscriptions() {
      setSubscriptionsState('loading');
      setSubscriptionsError('');
      try {
        const result = await apiWithSession<SubscriptionsResponse>(`/groups/${groupId}/subscriptions`, {
          signal: controller.signal,
        });
        if (!result) throw new Error('El servidor no devolvió las suscripciones.');
        if (controller.signal.aborted) return;
        setSubscriptions(result.subscriptions);
        setSubscriptionsContextId(groupId);
        setSubscriptionsState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          handleSessionExpired();
          return;
        }
        if (error instanceof ApiError && error.status === 403) refreshGroupsAfterForbidden();
        setSubscriptionsContextId(groupId);
        setSubscriptionsError('No pudimos cargar tus suscripciones. Inténtalo de nuevo.');
        setSubscriptionsState('error');
      }
    }

    void loadSubscriptions();
    return () => controller.abort();
  }, [groupId, subscriptionsVersion, handleSessionExpired, refreshGroupsAfterForbidden]);

  const selectedGroup = groups.find((group) => group.id === groupId) ?? null;
  const isPersonalGroup = groupId !== null && groupId === personalGroupId;
  const canManageSubscriptions = isPersonalGroup || (groupsState === 'ready' && selectedGroup?.role === 'owner');

  function changeView(view: DashboardView) {
    if (isSaving || pendingSubscriptionId !== null || groupActionPending) return;
    setActiveView(view);
    setViewVersions((current) => ({ ...current, [view]: current[view] + 1 }));
    setSubscriptionsState('loading');
    setSubscriptionsVersion((current) => current + 1);
    // Revalidate memberships in the background without discarding unchanged drafts.
    setGroupsVersion((current) => current + 1);
  }

  function changeSelectedGroup(nextGroupId: string) {
    if (nextGroupId === groupId || isSaving || pendingSubscriptionId !== null) return;
    selectedGroupIdRef.current = nextGroupId;
    setGroupId(nextGroupId);
    setGroupContextNotice('');
    setForm(initialForm);
    setFormError('');
    setSubscriptionActionError('');
    setEditingCostId(null);
    setEditedCost('');
  }

  function applyGroupUpdate(updatedGroup: Group, selectGroup = false) {
    setGroups((current) => {
      const exists = current.some((group) => group.id === updatedGroup.id);
      return exists
        ? current.map((group) => (group.id === updatedGroup.id ? updatedGroup : group))
        : [...current, updatedGroup];
    });
    if (selectGroup) {
      setGroupContextNotice('');
      selectedGroupIdRef.current = updatedGroup.id;
      setGroupId(updatedGroup.id);
      setForm(initialForm);
      setFormError('');
      setSubscriptionActionError('');
      setEditingCostId(null);
      setEditedCost('');
    }
    retryGroups();
  }

  function returnToPersonalGroup() {
    if (personalGroupId) {
      setGroupContextNotice('Saliste de la familia y volviste a tu grupo personal.');
      selectedGroupIdRef.current = personalGroupId;
      setGroupId(personalGroupId);
      setForm(initialForm);
      setFormError('');
      setSubscriptionActionError('');
      setEditingCostId(null);
      setEditedCost('');
    }
    retryGroups();
  }

  async function createSubscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageSubscriptions || !groupId || isSaving || pendingSubscriptionId !== null || subscriptionsState !== 'ready') return;

    setFormError('');
    setIsSaving(true);
    try {
      const result = await apiWithSession<SubscriptionResponse>(`/groups/${groupId}/subscriptions`, {
        method: 'POST',
        body: JSON.stringify(form),
      });
      if (!result) throw new Error('El servidor no devolvió la suscripción creada.');

      setSubscriptions((current) => [result.subscription, ...current]);
      setForm(initialForm);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) handleSessionExpired();
      setFormError(errorText(error));
    } finally {
      setIsSaving(false);
    }
  }

  async function toggleSubscription(subscription: Subscription) {
    if (!canManageSubscriptions || !groupId || pendingSubscriptionId !== null || isSaving) return;
    setSubscriptionActionError('');
    setPendingSubscriptionId(subscription.id);

    try {
      const result = await apiWithSession<SubscriptionResponse>(
        `/groups/${groupId}/subscriptions/${subscription.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ active: !subscription.active }),
        },
      );
      if (!result) throw new Error('El servidor no devolvió la suscripción actualizada.');

      setSubscriptions((current) => current.map((item) => (
        item.id === result.subscription.id ? result.subscription : item
      )));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) handleSessionExpired();
      setSubscriptionActionError(errorText(error));
    } finally {
      setPendingSubscriptionId(null);
    }
  }

  async function removeSubscription(subscription: Subscription) {
    if (!canManageSubscriptions || !groupId || pendingSubscriptionId !== null || isSaving || !window.confirm(`¿Eliminar ${subscription.name}?`)) return;
    setSubscriptionActionError('');
    setPendingSubscriptionId(subscription.id);

    try {
      await apiWithSession<null>(`/groups/${groupId}/subscriptions/${subscription.id}`, {
        method: 'DELETE',
      });
      setSubscriptions((current) => current.filter((item) => item.id !== subscription.id));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) handleSessionExpired();
      setSubscriptionActionError(error instanceof ApiError && error.status === 409
        ? 'Esta suscripción tiene pagos registrados. Puedes desactivarla para conservar su historial.'
        : errorText(error));
    } finally {
      setPendingSubscriptionId(null);
    }
  }

  async function saveExpectedCost(event: FormEvent<HTMLFormElement>, subscription: Subscription) {
    event.preventDefault();
    if (!canManageSubscriptions || !groupId || pendingSubscriptionId !== null || isSaving) return;
    setSubscriptionActionError('');
    setPendingSubscriptionId(subscription.id);
    try {
      const result = await apiWithSession<SubscriptionResponse>(`/groups/${groupId}/subscriptions/${subscription.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedCost: editedCost }),
      });
      if (!result) throw new Error('El servidor no devolvió la suscripción actualizada.');
      setSubscriptions((current) => current.map((item) => item.id === subscription.id ? result.subscription : item));
      setEditingCostId(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) handleSessionExpired();
      setSubscriptionActionError(errorText(error));
    } finally {
      setPendingSubscriptionId(null);
    }
  }

  if (pageState === 'loading') {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <p className="text-slate-600" role="status">Cargando tu espacio personal…</p>
      </main>
    );
  }

  if (pageState === 'unauthenticated') {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <section className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-2xl font-semibold text-slate-950">No has iniciado sesión</h1>
          <p className="mt-3 text-slate-600">Inicia sesión para consultar tu grupo personal.</p>
          <Link className="mt-6 inline-flex min-h-12 items-center rounded-xl bg-violet-700 px-6 font-medium text-white hover:bg-violet-800" href="/login">
            Ir a iniciar sesión
          </Link>
        </section>
      </main>
    );
  }

  if (pageState === 'error') {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <section className="w-full max-w-lg rounded-3xl border border-red-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-2xl font-semibold text-slate-950">No pudimos cargar el dashboard</h1>
          <p className="mt-3 text-red-700" role="alert">{pageError}</p>
          <button
            className="mt-6 min-h-12 rounded-xl border border-slate-300 px-6 font-medium text-slate-700 hover:bg-slate-50"
            onClick={() => window.location.reload()}
            type="button"
          >
            Intentar de nuevo
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="flex flex-1 justify-center px-6 py-10 sm:py-14">
      <div className="w-full max-w-5xl">
        <header className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <Link className="text-sm font-medium text-violet-700 hover:text-violet-900" href="/">
              ← Inicio
            </Link>
            <p className="mt-6 text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
              {isPersonalGroup ? 'Tu espacio personal' : selectedGroup?.name ?? 'Grupo familiar'}
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              Hola{userName ? `, ${userName}` : ''}
            </h1>
            <p className="mt-2 text-slate-600">
              {canManageSubscriptions
                ? 'Administra las suscripciones y consulta las próximas fechas de cobro.'
                : 'Consulta las suscripciones y las partes de pago de este grupo.'}
            </p>
          </div>
          <div className="w-full space-y-3 sm:w-auto sm:min-w-64">
            <label className="block text-sm font-medium text-slate-700" htmlFor="dashboard-group">Espacio</label>
            <select
              className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-slate-950 outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100 disabled:bg-slate-100"
              disabled={groupsState !== 'ready' || isSaving || pendingSubscriptionId !== null || groupActionPending}
              id="dashboard-group"
              onChange={(event) => changeSelectedGroup(event.target.value)}
              value={groupId ?? ''}
            >
              {groupsState !== 'ready' && (
                <option value={groupId ?? ''}>{isPersonalGroup ? 'Tu espacio personal' : 'Cargando espacios…'}</option>
              )}
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name} · {group.type === 'personal' ? 'Personal' : group.role === 'owner' ? 'Familiar · owner' : 'Familiar · miembro'}
                </option>
              ))}
            </select>
            {groupsState === 'error' && (
              <div className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <p role="alert">{groupsError}</p>
                <button className="mt-2 font-medium underline" onClick={retryGroups} type="button">Reintentar grupos</button>
              </div>
            )}
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
              {subscriptionsContextId === groupId && subscriptionsState === 'ready'
                ? `${subscriptions.length} ${subscriptions.length === 1 ? 'suscripción' : 'suscripciones'}`
                : 'Suscripciones'}
            </div>
          </div>
        </header>

        {groupContextNotice && (
          <p className="mb-6 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">{groupContextNotice}</p>
        )}

        <nav aria-label="Secciones del dashboard" className="mb-8 grid grid-cols-3 gap-1 rounded-2xl bg-slate-100 p-1">
          {dashboardViews.map((view) => (
            <button
              aria-controls={`dashboard-view-${view.id}`}
              aria-pressed={activeView === view.id}
              className={`min-h-11 rounded-xl px-1 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 disabled:cursor-wait disabled:opacity-60 sm:px-4 sm:text-sm ${activeView === view.id ? 'bg-white text-violet-800 shadow-sm' : 'text-slate-600 hover:bg-white/60 hover:text-slate-950'}`}
              disabled={isSaving || pendingSubscriptionId !== null || groupActionPending}
              id={`dashboard-nav-${view.id}`}
              key={view.id}
              onClick={() => changeView(view.id)}
              type="button"
            >
              {view.label}
            </button>
          ))}
        </nav>

        {/* Cada entrada recarga los datos; hidden conserva borradores y operaciones del mismo grupo. */}
        <section aria-labelledby="dashboard-nav-subscriptions" hidden={activeView !== 'subscriptions'} id="dashboard-view-subscriptions">
        <div className={`grid gap-6 ${canManageSubscriptions ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]' : ''}`}>
          {canManageSubscriptions && <section className="h-fit rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <h2 className="text-xl font-semibold text-slate-950">Añadir suscripción</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Completa los datos principales del servicio.
            </p>

            <form className="mt-6 space-y-4" onSubmit={createSubscription}>
              <fieldset className="space-y-4 disabled:opacity-60" disabled={!canManageSubscriptions}>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="subscription-name">
                  Nombre
                </label>
                <input
                  className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-slate-950 outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100"
                  id="subscription-name"
                  maxLength={255}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  required
                  value={form.name}
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="subscription-provider">
                  Proveedor
                </label>
                <input
                  className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-slate-950 outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100"
                  id="subscription-provider"
                  maxLength={255}
                  onChange={(event) => setForm({ ...form, provider: event.target.value })}
                  required
                  value={form.provider}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="subscription-cost">
                    Coste esperado
                  </label>
                  <input
                    className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-slate-950 outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100"
                    id="subscription-cost"
                    min="0"
                    onChange={(event) => setForm({ ...form, expectedCost: event.target.value })}
                    required
                    step="0.01"
                    type="number"
                    value={form.expectedCost}
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="subscription-cycle">
                    Ciclo
                  </label>
                  <select
                    className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-slate-950 outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100"
                    id="subscription-cycle"
                    onChange={(event) => setForm({ ...form, billingCycle: event.target.value as Subscription['billingCycle'] })}
                    value={form.billingCycle}
                  >
                    <option value="weekly">Semanal</option>
                    <option value="monthly">Mensual</option>
                    <option value="quarterly">Trimestral</option>
                    <option value="yearly">Anual</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="subscription-date">
                  Próxima fecha de cobro
                </label>
                <input
                  className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-slate-950 outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100"
                  id="subscription-date"
                  onChange={(event) => setForm({ ...form, nextBillingDate: event.target.value })}
                  required
                  type="date"
                  value={form.nextBillingDate}
                />
              </div>

              {formError && (
                <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
                  {formError}
                </p>
              )}

              <button
                className="inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-violet-700 px-5 font-medium text-white transition hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isSaving || pendingSubscriptionId !== null || subscriptionsState !== 'ready'}
                type="submit"
              >
                {isSaving ? 'Guardando…' : 'Guardar suscripción'}
              </button>
              </fieldset>
            </form>
          </section>}

          <section>
            <h2 className="mb-4 text-xl font-semibold text-slate-950">Suscripciones</h2>
            {!canManageSubscriptions && (
              <p className="mb-4 text-sm text-slate-600">Solo el owner puede modificar las suscripciones de este grupo.</p>
            )}
            {subscriptionActionError && (
              <p className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
                {subscriptionActionError}
              </p>
            )}
            {subscriptionsContextId !== groupId || subscriptionsState === 'loading' ? (
              <p className="rounded-3xl border border-slate-200 bg-white p-6 text-slate-600" role="status">Cargando suscripciones…</p>
            ) : subscriptionsState === 'error' ? (
              <div className="rounded-3xl border border-red-200 bg-white p-6">
                <p className="text-sm text-red-700" role="alert">{subscriptionsError}</p>
                <button className="mt-3 min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50" onClick={() => setSubscriptionsVersion((current) => current + 1)} type="button">
                  Reintentar suscripciones
                </button>
              </div>
            ) : subscriptions.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-center">
                <p className="font-medium text-slate-800">Este grupo todavía no tiene suscripciones</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {canManageSubscriptions
                    ? 'Añade la primera con el formulario para empezar a llevar el control.'
                    : 'El owner puede añadir la primera suscripción del grupo.'}
                </p>
              </div>
            ) : (
              <ul className="space-y-4">
                {subscriptions.map((subscription) => (
                  <li className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" key={subscription.id}>
                    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-lg font-semibold text-slate-950">{subscription.name}</h3>
                          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${subscription.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                            {subscription.active ? 'Activa' : 'Inactiva'}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-slate-600">{subscription.provider}</p>
                      </div>
                      <p className="text-lg font-semibold text-slate-950">{subscription.expectedCost}</p>
                    </div>

                    <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-slate-100 pt-4 text-sm">
                      <div>
                        <dt className="text-slate-500">Ciclo</dt>
                        <dd className="mt-1 font-medium text-slate-800">{cycleLabels[subscription.billingCycle]}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Próximo cobro</dt>
                        <dd className="mt-1 font-medium text-slate-800">{displayDate(subscription.nextBillingDate)}</dd>
                      </div>
                    </dl>

                    {editingCostId === subscription.id && (
                      <form className="mt-5 space-y-3 border-t border-slate-100 pt-4" onSubmit={(event) => void saveExpectedCost(event, subscription)}>
                        <label className="block text-sm font-medium text-slate-700" htmlFor={`expected-cost-${subscription.id}`}>
                          Nuevo coste esperado de {subscription.name}
                        </label>
                        <input
                          aria-describedby={`cost-help-${subscription.id}`}
                          className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-slate-950 focus:border-violet-600 focus:ring-4 focus:ring-violet-100"
                          disabled={pendingSubscriptionId !== null || isSaving}
                          id={`expected-cost-${subscription.id}`}
                          max="9999999999.99"
                          min="0"
                          onChange={(event) => setEditedCost(event.target.value)}
                          required
                          step="0.01"
                          type="number"
                          value={editedCost}
                        />
                        <p className="text-sm text-slate-600" id={`cost-help-${subscription.id}`}>
                          Se usará en los próximos pagos que se generen. Los pagos ya registrados conservarán su importe esperado.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <button className="min-h-10 rounded-lg bg-violet-700 px-3 text-sm font-medium text-white hover:bg-violet-800 disabled:opacity-60" disabled={pendingSubscriptionId !== null || isSaving} type="submit">
                            {pendingSubscriptionId === subscription.id ? 'Guardando…' : 'Guardar coste'}
                          </button>
                          <button className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 disabled:opacity-60" disabled={pendingSubscriptionId !== null || isSaving} onClick={() => setEditingCostId(null)} type="button">
                            Cancelar edición
                          </button>
                        </div>
                      </form>
                    )}

                    {canManageSubscriptions && <div className="mt-5 flex flex-wrap gap-2">
                      <button
                        className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                        disabled={pendingSubscriptionId !== null || isSaving}
                        onClick={() => void toggleSubscription(subscription)}
                        type="button"
                      >
                        {subscription.active ? 'Desactivar' : 'Activar'}
                      </button>
                      <button
                        className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                        disabled={pendingSubscriptionId !== null || isSaving}
                        onClick={() => { setEditingCostId(subscription.id); setEditedCost(subscription.expectedCost); setSubscriptionActionError(''); }}
                        type="button"
                      >
                        Editar coste
                      </button>
                      <button
                        className="min-h-10 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
                        disabled={pendingSubscriptionId !== null || isSaving}
                        onClick={() => void removeSubscription(subscription)}
                        type="button"
                      >
                        Eliminar
                      </button>
                    </div>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        </section>

        <section aria-labelledby="dashboard-nav-payments" hidden={activeView !== 'payments'} id="dashboard-view-payments">
        {groupId && isPersonalGroup && (
          <PaymentsPanel groupId={groupId} key={groupId} onSessionExpired={handleSessionExpired} refreshVersion={viewVersions.payments} />
        )}
        {groupId && selectedGroup?.type === 'family' && groupsState === 'ready' && (
          <FamilyPaymentsPanel
            groupId={groupId}
            isOwner={selectedGroup.role === 'owner'}
            key={`${groupId}:${selectedGroup.ownerId}:${selectedGroup.role}`}
            onAccessForbidden={refreshGroupsAfterForbidden}
            onSessionExpired={handleSessionExpired}
            refreshVersion={viewVersions.payments}
          />
        )}
        {groupId && selectedGroup?.type === 'family' && groupsState !== 'ready' && (
          <p className="mt-10 border-t border-slate-200 pt-8 text-sm text-slate-600" role="status">Actualizando los permisos de esta familia…</p>
        )}
        </section>

        <section aria-labelledby="dashboard-nav-family" hidden={activeView !== 'family'} id="dashboard-view-family">
        <FamilyGroupsPanel
          group={selectedGroup?.type === 'family' ? selectedGroup : null}
          groupsReady={groupsState === 'ready'}
          key={`${groupId}:${selectedGroup?.ownerId}:${selectedGroup?.role}`}
          onGroupUpdated={applyGroupUpdate}
          onLeftGroup={returnToPersonalGroup}
          onRefreshGroups={refreshGroupsAfterForbidden}
          onSessionExpired={handleSessionExpired}
          onWorkingChange={setGroupActionPending}
          refreshVersion={viewVersions.family}
        />
        {groupId && selectedGroup?.type === 'family' && selectedGroup.role === 'owner' && groupsState === 'ready' && (
          <InvitationsPanel
            groupId={groupId}
            groupName={selectedGroup.name}
            key={`${groupId}:${selectedGroup.ownerId}:${selectedGroup.role}`}
            onAccessForbidden={refreshGroupsAfterForbidden}
            onSessionExpired={handleSessionExpired}
            refreshVersion={viewVersions.family}
          />
        )}
        </section>
      </div>
    </main>
  );
}
