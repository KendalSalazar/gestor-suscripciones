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
    <section aria-labelledby="invitations-heading" className="invitation-admin">
      <div className="invitation-admin-heading">
        <div>
          <h2 id="invitations-heading">Invitaciones</h2>
          <p>Invita a una persona a <strong>{groupName}</strong>. El código se muestra una sola vez y vence en siete días; debes compartirlo tú.</p>
        </div>
        <button
          className="ui-button ui-button-secondary"
          disabled={invitationsLoading || working !== null}
          onClick={reloadInvitations}
          type="button"
        >
          Actualizar invitaciones
        </button>
      </div>

      {notice && <p className="ui-feedback invitation-notice" role="status">{notice}</p>}
      {error && <p className="ui-feedback ui-feedback-error invitation-error" role="alert">{error}</p>}

      <form className="invitation-create-form" onSubmit={createInvitation}>
        <div className="invitation-create-copy">
          <h3>Invitar a alguien</h3>
          <p>El correo se usa para proteger el acceso al grupo.</p>
        </div>
        <div className="invitation-create-field">
          <label className="app-design-label" htmlFor="invitation-email">Correo de la persona</label>
          <input
            autoComplete="off"
            className="ui-field"
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
          className="ui-button invitation-create-submit"
          disabled={working !== null || oneTimeCode !== null || !email.trim()}
          type="submit"
        >
          {working === 'create' ? 'Creando…' : 'Crear invitación'}
        </button>
      </form>

      {oneTimeCode && (
        <div className="invitation-secret">
          <div className="invitation-secret-heading">
            <h3>Copia este código ahora</h3>
            <p>Por seguridad, no podrás volver a consultarlo.</p>
          </div>
          <code className="invitation-secret-code select-all">{oneTimeCode.code}</code>
          <div className="invitation-secret-actions">
            <button className="ui-button invitation-copy-button" onClick={() => void copyCode()} type="button">
              Copiar y ocultar código
            </button>
            <button className="ui-button ui-button-secondary" onClick={() => { setOneTimeCode(null); setNotice('Código ocultado. Si no lo guardaste, revoca la invitación y crea otra.'); }} type="button">
              Ocultar sin copiar
            </button>
          </div>
        </div>
      )}

      <div className="invitation-history">
        <div className="invitation-history-heading">
          <div>
            <h3>Enviadas</h3>
            <p>Hasta 100 invitaciones recientes. El historial no muestra códigos.</p>
          </div>
        </div>
        {invitationsLoading ? (
          <p className="invitation-state" role="status">Cargando invitaciones…</p>
        ) : invitations.error ? (
          <div className="invitation-state invitation-state-error">
            <p className="ui-feedback ui-feedback-error" role="alert">{invitations.error}</p>
            <button className="ui-button ui-button-secondary" onClick={reloadInvitations} type="button">Reintentar</button>
          </div>
        ) : invitations.invitations.length === 0 ? (
          <p className="invitation-state invitation-state-empty">Todavía no hay invitaciones enviadas a esta familia.</p>
        ) : (
          <ul className="invitation-list">
            {invitations.invitations.map((invitation) => (
              <li className="invitation-row" key={invitation.id}>
                <div className="invitation-row-copy">
                  <p className="invitation-recipient-email">{invitation.email}</p>
                  <dl className="invitation-row-dates">
                    <div><dt>Creada</dt><dd><time dateTime={invitation.createdAt}>{formatDate(invitation.createdAt)}</time></dd></div>
                    <div><dt>Vence</dt><dd><time dateTime={invitation.expiresAt}>{formatDate(invitation.expiresAt)}</time></dd></div>
                    <div><dt>Invitó</dt><dd>{invitation.invitedByName}</dd></div>
                  </dl>
                </div>
                <div className="invitation-row-actions">
                  <span className={`invitation-status invitation-status-${invitation.status}`}>
                    {statusLabel(invitation.status)}
                  </span>
                  {invitation.status === 'pending' && (
                    <button
                      className="ui-button ui-button-danger"
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
