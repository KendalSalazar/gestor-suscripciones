'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ApiError, apiWithSession } from '@/lib/api';
import { session } from '@/lib/session';

type Invitation = {
  id: string;
  groupId: string;
  groupName: string;
  email: string;
  invitedByName: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
};

type InvitationResponse = { invitation: Invitation };
type AcceptanceResponse = { group: { id: string; name: string; type: 'family'; ownerId: string }; membership: { userId: string; role: 'member'; status: 'active' } };
type Credentials = { invitationId: string; token: string };
type AuthState = 'loading' | 'ready' | 'unauthenticated' | 'error';

const invitationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invitationTokenPattern = /^[A-Za-z0-9_-]{43}$/;

function invitationError(error: unknown, action: 'preview' | 'accept' | 'decline'): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return 'El código no tiene un formato válido. Pégalo completo e inténtalo de nuevo.';
    if (error.status === 404) return 'No hay una invitación disponible para este código y esta cuenta. Comprueba el código e inicia sesión con el correo invitado.';
    if (error.status === 409) {
      if (action === 'accept') return 'No se pudo aceptar: la invitación pudo vencer, ya resolverse, o la familia pudo alcanzar su límite.';
      if (action === 'decline') return 'La invitación ya venció o fue resuelta. No se hicieron más cambios.';
      return 'La invitación ya venció o fue resuelta. Pide al owner que cree una nueva.';
    }
  }
  return 'No pudimos comunicarnos con el servidor. Inténtalo de nuevo.';
}

export default function InvitationRecipientPage() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [authError, setAuthError] = useState('');
  const [code, setCode] = useState('');
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [busyAction, setBusyAction] = useState<'preview' | 'accept' | 'decline' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [finished, setFinished] = useState<'accepted' | 'declined' | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function verifySession() {
      try {
        const result = await apiWithSession<{ user: { id: string } }>('/auth/me', { signal: controller.signal });
        if (!result) throw new Error('No se pudo confirmar la sesión.');
        if (!controller.signal.aborted) setAuthState('ready');
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) {
          session.setAccessToken(null);
          setAuthState('unauthenticated');
          return;
        }
        setAuthError('No pudimos comprobar tu sesión. Inténtalo de nuevo.');
        setAuthState('error');
      }
    }
    void verifySession();
    return () => {
      controller.abort();
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, []);

  function clearInvitation() {
    setCredentials(null);
    setInvitation(null);
    setError('');
    setNotice('');
  }

  async function previewInvitation(invitationId: string, token: string) {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setBusyAction('preview');
    setError('');
    setNotice('');
    setInvitation(null);
    try {
      const result = await apiWithSession<InvitationResponse>(`/invitations/${invitationId}/preview`, {
        method: 'POST',
        body: JSON.stringify({ token }),
        signal: controller.signal,
      });
      if (!result) throw new Error('El servidor no devolvió la invitación.');
      if (!controller.signal.aborted) {
        setInvitation(result.invitation);
        setCredentials({ invitationId, token });
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 401) {
        session.setAccessToken(null);
        clearInvitation();
        setCode('');
        setAuthState('unauthenticated');
        setError('Tu sesión terminó. Inicia sesión y pega el código de nuevo; no se guarda al salir de esta página.');
      } else if (cause instanceof ApiError && (cause.status === 404 || cause.status === 409 || cause.status === 400)) {
        clearInvitation();
        setCode('');
        setError(invitationError(cause, 'preview'));
      } else {
        setCredentials({ invitationId, token });
        setError(invitationError(cause, 'preview'));
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setBusyAction(null);
    }
  }

  function handleCodeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyAction) return;
    const parts = code.trim().split('.');
    if (parts.length !== 2 || !invitationIdPattern.test(parts[0]) || !invitationTokenPattern.test(parts[1])) {
      setError('Pega el código completo con formato UUID.token.');
      return;
    }
    setCode('');
    setCredentials({ invitationId: parts[0], token: parts[1] });
    void previewInvitation(parts[0], parts[1]);
  }

  async function resolveInvitation(action: 'accept' | 'decline') {
    if (!credentials || !invitation || busyAction) return;
    if (action === 'decline' && !window.confirm(`¿Rechazar la invitación a ${invitation.groupName}?`)) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setBusyAction(action);
    setError('');
    setNotice('');
    try {
      const result = action === 'accept'
        ? await apiWithSession<AcceptanceResponse>(`/invitations/${credentials.invitationId}/accept`, {
          method: 'POST', body: JSON.stringify({ token: credentials.token }), signal: controller.signal,
        })
        : await apiWithSession<InvitationResponse>(`/invitations/${credentials.invitationId}/decline`, {
          method: 'POST', body: JSON.stringify({ token: credentials.token }), signal: controller.signal,
        });
      if (!result) throw new Error('El servidor no confirmó la invitación.');
      if (controller.signal.aborted) return;
      setCredentials(null);
      setInvitation(null);
      setCode('');
      setFinished(action === 'accept' ? 'accepted' : 'declined');
      setNotice(action === 'accept'
        ? `Te incorporaste a ${'group' in result ? result.group.name : 'la familia'}. Abre el dashboard para seleccionarla.`
        : 'Rechazaste la invitación.');
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 401) {
        session.setAccessToken(null);
        clearInvitation();
        setCode('');
        setAuthState('unauthenticated');
        setError('Tu sesión terminó. Inicia sesión y pega el código de nuevo para continuar.');
      } else {
        if (cause instanceof ApiError && (cause.status === 404 || cause.status === 409 || cause.status === 400)) {
          clearInvitation();
          setCode('');
        }
        setError(invitationError(cause, action));
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setBusyAction(null);
    }
  }

  return (
    <main className="app-design invitation-page">
      <section aria-labelledby="invitation-page-heading" className="invitation-recipient">
        <header className="invitation-recipient-heading">
          <p>Gestor de suscripciones</p>
          <h1 id="invitation-page-heading">Invitación a una familia</h1>
          <p>Inicia sesión con el correo que recibió la invitación. Después podrás revisar a qué familia te unirías.</p>
        </header>

        {authState === 'loading' && <p className="invitation-recipient-state" role="status">Comprobando sesión…</p>}
        {authState === 'unauthenticated' && (
          <div className="invitation-recipient-callout invitation-recipient-callout-warning">
            <p>Necesitas iniciar sesión para comprobar el código. Por seguridad, no lo guardamos al ir al login; tendrás que pegarlo otra vez después.</p>
            <Link className="ui-button invitation-recipient-link" href="/login" onClick={() => { setCode(''); clearInvitation(); }}>
              Ir a iniciar sesión
            </Link>
          </div>
        )}
        {authState === 'error' && (
          <div className="invitation-recipient-callout invitation-recipient-callout-error">
            <p className="ui-feedback ui-feedback-error" role="alert">{authError}</p>
            <button className="ui-button ui-button-secondary" onClick={() => window.location.reload()} type="button">Reintentar</button>
          </div>
        )}

        {authState === 'ready' && !finished && (
          <form className="invitation-recipient-form" onSubmit={handleCodeSubmit}>
            <div className="invitation-recipient-form-heading">
              <h2>Introduce tu código</h2>
              <p>Pégalo completo. Lo comprobaremos antes de mostrarte los detalles.</p>
            </div>
            <label className="app-design-label" htmlFor="invitation-code">Código de invitación</label>
            <textarea
              autoComplete="off"
              autoCapitalize="off"
              className="ui-field invitation-code-field"
              disabled={busyAction !== null || invitation !== null}
              id="invitation-code"
              onChange={(event) => setCode(event.target.value)}
              placeholder="UUID.token"
              spellCheck={false}
              value={code}
            />
            <p className="invitation-recipient-hint">El código solo se usa en esta sesión. No lo incluyas en enlaces ni lo guardes en un equipo compartido.</p>
            <div className="invitation-recipient-actions">
              <button className="ui-button" disabled={busyAction !== null || !code.trim() || invitation !== null} type="submit">
                {busyAction === 'preview' ? 'Comprobando…' : 'Comprobar invitación'}
              </button>
              {credentials && !invitation && busyAction === null && (
                <button className="ui-button ui-button-secondary" onClick={() => void previewInvitation(credentials.invitationId, credentials.token)} type="button">Reintentar comprobación</button>
              )}
            </div>
          </form>
        )}

        {error && <p className="ui-feedback ui-feedback-error invitation-recipient-message" role="alert">{error}</p>}
        {notice && <p className="ui-feedback invitation-recipient-notice" role="status">{notice}</p>}

        {invitation && authState === 'ready' && (
          <section aria-labelledby="invitation-preview-heading" className="invitation-preview">
            <div className="invitation-preview-heading">
              <h2 id="invitation-preview-heading">Revisa antes de aceptar</h2>
              <p>Comprueba que reconoces la familia y el correo invitado.</p>
            </div>
            <dl className="invitation-preview-facts">
              <div><dt>Familia</dt><dd>{invitation.groupName}</dd></div>
              <div><dt>Invitada a</dt><dd>{invitation.email}</dd></div>
              <div><dt>Invitó</dt><dd>{invitation.invitedByName}</dd></div>
              <div><dt>Vence</dt><dd><time dateTime={invitation.expiresAt}>{new Intl.DateTimeFormat('es-CR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(invitation.expiresAt))}</time></dd></div>
            </dl>
            <p className="invitation-preview-note">Al aceptar, te unirás como miembro activo. El reparto de pagos anteriores no se modifica.</p>
            <div className="invitation-preview-actions">
              <button className="ui-button" disabled={busyAction !== null} onClick={() => void resolveInvitation('accept')} type="button">
                {busyAction === 'accept' ? 'Aceptando…' : 'Aceptar invitación'}
              </button>
              <button className="ui-button ui-button-secondary" disabled={busyAction !== null} onClick={() => void resolveInvitation('decline')} type="button">
                {busyAction === 'decline' ? 'Rechazando…' : 'Rechazar'}
              </button>
              <button className="ui-button ui-button-text" disabled={busyAction !== null} onClick={clearInvitation} type="button">Usar otro código</button>
            </div>
          </section>
        )}

        {finished && (
          <div className="invitation-result">
            <p className="invitation-result-title">{finished === 'accepted' ? 'Invitación aceptada' : 'Invitación rechazada'}</p>
            {finished === 'accepted' && <p>Abre el dashboard para elegir la familia. Tu grupo personal sigue disponible.</p>}
            <Link className="ui-button invitation-recipient-link" href="/dashboard">{finished === 'accepted' ? 'Ir al dashboard' : 'Volver al dashboard'}</Link>
          </div>
        )}
      </section>
    </main>
  );
}
