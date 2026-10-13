'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ApiError, api, refreshSession } from '@/lib/api';
import { session } from '@/lib/session';

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

type SubscriptionResponse = {
  subscription: Subscription;
};

type PageState = 'loading' | 'ready' | 'unauthenticated' | 'error';

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
  const [pageState, setPageState] = useState<PageState>('loading');
  const [pageError, setPageError] = useState('');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [userName, setUserName] = useState('');
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [form, setForm] = useState(initialForm);
  const [formError, setFormError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [pendingSubscriptionId, setPendingSubscriptionId] = useState<string | null>(null);

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
        const profile = await api<MeResponse>('/auth/me');
        if (!profile) throw new Error('El servidor no devolvió el perfil del usuario.');

        const result = await api<SubscriptionsResponse>(
          `/groups/${profile.personalGroupId}/subscriptions`,
        );
        if (!result) throw new Error('El servidor no devolvió las suscripciones.');

        if (isMounted) {
          setUserName(profile.user.name);
          setGroupId(profile.personalGroupId);
          setSubscriptions(result.subscriptions);
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

  async function createSubscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!groupId) return;

    setFormError('');
    setIsSaving(true);
    try {
      const result = await api<SubscriptionResponse>(`/groups/${groupId}/subscriptions`, {
        method: 'POST',
        body: JSON.stringify(form),
      });
      if (!result) throw new Error('El servidor no devolvió la suscripción creada.');

      setSubscriptions((current) => [result.subscription, ...current]);
      setForm(initialForm);
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setIsSaving(false);
    }
  }

  async function toggleSubscription(subscription: Subscription) {
    if (!groupId) return;
    setFormError('');
    setPendingSubscriptionId(subscription.id);

    try {
      const result = await api<SubscriptionResponse>(
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
      setFormError(errorText(error));
    } finally {
      setPendingSubscriptionId(null);
    }
  }

  async function removeSubscription(subscription: Subscription) {
    if (!groupId || !window.confirm(`¿Eliminar ${subscription.name}?`)) return;
    setFormError('');
    setPendingSubscriptionId(subscription.id);

    try {
      await api<null>(`/groups/${groupId}/subscriptions/${subscription.id}`, {
        method: 'DELETE',
      });
      setSubscriptions((current) => current.filter((item) => item.id !== subscription.id));
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setPendingSubscriptionId(null);
    }
  }

  if (pageState === 'loading') {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <p className="text-slate-600" role="status">Cargando tus suscripciones…</p>
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
              Tu espacio personal
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              Hola{userName ? `, ${userName}` : ''}
            </h1>
            <p className="mt-2 text-slate-600">Administra tus suscripciones y próximas fechas de cobro.</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
            {subscriptions.length} {subscriptions.length === 1 ? 'suscripción' : 'suscripciones'}
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <section className="h-fit rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <h2 className="text-xl font-semibold text-slate-950">Añadir suscripción</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Completa los datos principales del servicio.
            </p>

            <form className="mt-6 space-y-4" onSubmit={createSubscription}>
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
                disabled={isSaving}
                type="submit"
              >
                {isSaving ? 'Guardando…' : 'Guardar suscripción'}
              </button>
            </form>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-semibold text-slate-950">Tus suscripciones</h2>
            {subscriptions.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-center">
                <p className="font-medium text-slate-800">Todavía no tienes suscripciones</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Añade la primera con el formulario para empezar a llevar el control.
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

                    <div className="mt-5 flex flex-wrap gap-2">
                      <button
                        className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                        disabled={pendingSubscriptionId === subscription.id}
                        onClick={() => void toggleSubscription(subscription)}
                        type="button"
                      >
                        {subscription.active ? 'Desactivar' : 'Activar'}
                      </button>
                      <button
                        className="min-h-10 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
                        disabled={pendingSubscriptionId === subscription.id}
                        onClick={() => void removeSubscription(subscription)}
                        type="button"
                      >
                        Eliminar
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
