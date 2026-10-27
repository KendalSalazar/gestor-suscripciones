'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, apiWithSession } from '@/lib/api';

type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';

type Invitation = {
  id: string;
  groupId: string;
  groupName: string;
  email: string;
  invitedByName: string;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
};

type CreatedInvitation = { invitation: Invitation; token: string };
type InvitationsResponse = { invitations: Invitation[] };
type InvitationResponse = { invitation: Invitation };
type InvitationsState = { groupId: string | null; invitations: Invitation[]; loading: boolean; error: string; refreshVersion: number };
type OneTimeCode = { invitationId: string; code: string };

const initialInvitations: InvitationsState = { groupId: null, invitations: [], loading: true, error: '', refreshVersion: -1 };

function statusLabel(status: InvitationStatus): string {
  if (status === 'accepted') return 'Aceptada';
  if (status === 'declined') return 'Rechazada';
  if (status === 'revoked') return 'Revocada';
  if (status === 'expired') return 'Vencida';
  return 'Pendiente';
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('es-CR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export default function InvitationsPanel({
  groupId,
  groupName,
  onAccessForbidden,
  onSessionExpired,
  refreshVersion = 0,
}: {
  groupId: string;
  groupName: string;
  onAccessForbidden: () => void;
  onSessionExpired: () => void;
  refreshVersion?: number;
}) {
  const [invitations, setInvitations] = useState<InvitationsState>(initialInvitations);
  const [version, setVersion] = useState(0);
  const [email, setEmail] = useState('');
  const [working, setWorking] = useState<string | null>(null);
  const [oneTimeCode, setOneTimeCode] = useState<OneTimeCode | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const invitationsLoading = invitations.groupId !== groupId || invitations.loading || invitations.refreshVersion !== refreshVersion;

  useEffect(() => {
    const controller = new AbortController();

    async function loadInvitations() {
      try {
        const result = await apiWithSession<InvitationsResponse>(`/groups/${groupId}/invitations`, {
          signal: controller.signal,
        });
        if (!result) throw new Error('El servidor no devolvió las invitaciones.');
        if (!controller.signal.aborted) {
          setInvitations({ groupId, invitations: result.invitations, loading: false, error: '', refreshVersion });
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) {
          onSessionExpired();
          return;
        }
        if (cause instanceof ApiError && cause.status === 403) onAccessForbidden();
        setInvitations({
          groupId, invitations: [], loading: false, refreshVersion,
          error: cause instanceof ApiError && cause.status === 403
            ? 'Tu rol ya no permite administrar invitaciones. Actualizamos los permisos.'
            : 'No pudimos cargar las invitaciones. Inténtalo de nuevo.',
        });
      }
    }

    void loadInvitations();
    return () => controller.abort();
  }, [groupId, version, onAccessForbidden, onSessionExpired, refreshVersion]);

  function reloadInvitations() {
    setInvitations((current) => ({ ...current, groupId, loading: true, error: '' }));
    setVersion((current) => current + 1);
  }

  function actionError(cause: unknown, fallback: string): string {
    if (cause instanceof ApiError) {
      if (cause.status === 400) return 'Escribe un correo válido e inténtalo de nuevo.';
      if (cause.status === 403) {
        onAccessForbidden();
        return 'Tu rol ya no permite administrar invitaciones. Actualizamos los permisos.';
      }
      if (cause.status === 404) {
        reloadInvitations();
        return 'La invitación ya no está disponible. Actualizamos la lista.';
      }
      if (cause.status === 409) {
        reloadInvitations();
        return 'La invitación ya existe, venció o la persona ya pertenece al grupo. Actualizamos la lista.';
      }
    }
    return fallback;
  }

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || working || oneTimeCode) return;
    setWorking('create');
    setError('');
    setNotice('');
    try {
      const result = await apiWithSession<CreatedInvitation>(`/groups/${groupId}/invitations`, {
        method: 'POST',
        body: JSON.stringify({ email: normalizedEmail }),
      });
      if (!result) throw new Error('El servidor no devolvió el código de invitación.');
      setEmail('');
      setOneTimeCode({ invitationId: result.invitation.id, code: `${result.invitation.id}.${result.token}` });
      setNotice('Guarda y comparte este código ahora. No se podrá volver a consultar.');
      reloadInvitations();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      setError(actionError(cause, 'No pudimos crear la invitación. Comprueba la conexión e inténtalo de nuevo.'));
    } finally {
      setWorking(null);
    }
  }

  async function copyCode() {
    if (!oneTimeCode) return;
    try {
      await navigator.clipboard.writeText(oneTimeCode.code);
      setOneTimeCode(null);
      setError('');
      setNotice('Código copiado. Ya no se mostrará en esta pantalla.');
    } catch {
      setError('No pudimos copiar el código. Selecciónalo y cópialo manualmente antes de cerrar esta pantalla.');
    }
  }

  async function revokeInvitation(invitation: Invitation) {
    if (working || invitation.status !== 'pending') return;
    if (!window.confirm(`¿Revocar la invitación para ${invitation.email}? La persona ya no podrá usar su código.`)) return;
    setWorking(invitation.id);
    setError('');
    setNotice('');
    try {
      const result = await apiWithSession<InvitationResponse>(
        `/groups/${groupId}/invitations/${invitation.id}/revoke`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      if (!result) throw new Error('El servidor no devolvió la invitación revocada.');
      if (oneTimeCode?.invitationId === invitation.id) setOneTimeCode(null);
      setNotice('Invitación revocada.');
      reloadInvitations();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      setError(actionError(cause, 'No pudimos revocar la invitación. Comprueba la conexión e inténtalo de nuevo.'));
    } finally {
      setWorking(null);
    }
  }

  return (
    <section aria-labelledby="invitations-heading" className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-950" id="invitations-heading">Invitaciones de {groupName}</h2>
          <p className="mt-1 text-sm text-slate-600">El código se entrega una vez y vence después de siete días. No se envía por correo automáticamente.</p>
        </div>
        <button
          className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          disabled={invitationsLoading || working !== null}
          onClick={reloadInvitations}
          type="button"
        >
          Actualizar invitaciones
        </button>
      </div>

      {notice && <p className="mt-4 rounded-xl bg-violet-50 px-4 py-3 text-sm text-violet-900" role="status">{notice}</p>}
      {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{error}</p>}

      <form className="mt-5 flex flex-col gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:items-end" onSubmit={createInvitation}>
        <div className="min-w-0 flex-1">
          <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="invitation-email">Correo de la persona</label>
          <input
            autoComplete="off"
            className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-slate-950 outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100 disabled:bg-slate-100"
            disabled={working !== null || oneTimeCode !== null}
            id="invitation-email"
            maxLength={254}
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </div>
        <button
          className="min-h-11 rounded-lg bg-violet-700 px-4 text-sm font-medium text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={working !== null || oneTimeCode !== null || !email.trim()}
          type="submit"
        >
          {working === 'create' ? 'Creando…' : 'Crear invitación'}
        </button>
      </form>

      {oneTimeCode && (
        <div className="mt-5 rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <h3 className="font-semibold text-amber-950">Código de un solo uso</h3>
          <p className="mt-1 text-sm text-amber-900">Compártelo con la persona destinataria ahora. No lo pegues en enlaces ni mensajes públicos.</p>
          <code className="mt-3 block select-all break-all rounded-lg bg-white p-3 text-sm text-slate-900">{oneTimeCode.code}</code>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="min-h-10 rounded-lg bg-amber-800 px-3 text-sm font-medium text-white hover:bg-amber-900" onClick={() => void copyCode()} type="button">
              Copiar y ocultar código
            </button>
            <button className="min-h-10 rounded-lg border border-amber-700 px-3 text-sm font-medium text-amber-950" onClick={() => { setOneTimeCode(null); setNotice('Código ocultado. Si no lo guardaste, revoca la invitación y crea otra.'); }} type="button">
              Ocultar sin copiar
            </button>
          </div>
        </div>
      )}

      <div className="mt-6 border-t border-slate-100 pt-5">
        <h3 className="font-semibold text-slate-900">Historial de invitaciones</h3>
        <p className="mt-1 text-sm text-slate-500">Hasta 100 invitaciones recientes. El historial nunca incluye el código secreto.</p>
        {invitationsLoading ? (
          <p className="mt-4 text-sm text-slate-600" role="status">Cargando invitaciones…</p>
        ) : invitations.error ? (
          <div className="mt-4 rounded-xl bg-red-50 px-4 py-3">
            <p className="text-sm text-red-700" role="alert">{invitations.error}</p>
            <button className="mt-3 min-h-9 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-800" onClick={reloadInvitations} type="button">Reintentar</button>
          </div>
        ) : invitations.invitations.length === 0 ? (
          <p className="mt-4 rounded-xl bg-slate-50 px-4 py-4 text-sm text-slate-600">Todavía no hay invitaciones para esta familia.</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-100">
            {invitations.invitations.map((invitation) => (
              <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between" key={invitation.id}>
                <div className="min-w-0">
                  <p className="break-words font-medium text-slate-900">{invitation.email}</p>
                  <p className="mt-1 text-sm text-slate-600">Creada {formatDate(invitation.createdAt)} · vence {formatDate(invitation.expiresAt)}</p>
                  <p className="text-sm text-slate-500">Creada por {invitation.invitedByName}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${invitation.status === 'pending' ? 'bg-amber-50 text-amber-800' : invitation.status === 'accepted' ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>
                    {statusLabel(invitation.status)}
                  </span>
                  {invitation.status === 'pending' && (
                    <button
                      className="min-h-9 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
                      disabled={working !== null}
                      onClick={() => void revokeInvitation(invitation)}
                      type="button"
                    >
                      {working === invitation.id ? 'Revocando…' : 'Revocar'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
