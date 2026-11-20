'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, apiWithSession, logoutSession, refreshSession } from '@/lib/api';
import { session } from '@/lib/session';

type RegisterFields = {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
};

type FieldName = keyof RegisterFields;
type FieldErrors = Partial<Record<FieldName, string>>;

const fieldOrder: FieldName[] = ['name', 'email', 'password', 'confirmPassword'];

type PublicUser = { id: string; email: string; name: string };
type RegisterResponse = { user: PublicUser; accessToken: string };
type SubmitFeedback = { message: string; showLoginLink: boolean };

class InvalidRegistrationResponseError extends Error {}

function hasPublicUser(value: unknown): value is { user: PublicUser } {
  if (typeof value !== 'object' || value === null || !('user' in value)) return false;
  const user = value.user;
  return typeof user === 'object' && user !== null
    && 'id' in user && typeof user.id === 'string' && user.id.length > 0
    && 'email' in user && typeof user.email === 'string'
    && 'name' in user && typeof user.name === 'string';
}

function isRegisterResponse(value: unknown): value is RegisterResponse {
  return hasPublicUser(value) && 'accessToken' in value
    && typeof value.accessToken === 'string' && value.accessToken.length > 0;
}

function PersonIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20">
      <circle cx="12" cy="7" r="3.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5 21v-3a7 7 0 0 1 14 0v3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  );
}

export default function RegisterPage() {
  const router = useRouter();
  const [fields, setFields] = useState<RegisterFields>({ name: '', email: '', password: '', confirmPassword: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [sessionState, setSessionState] = useState<'checking' | 'guest' | 'error' | 'authenticated' | 'redirecting'>('checking');
  const [sessionVersion, setSessionVersion] = useState(0);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitFeedback | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const mounted = useRef(false);
  const submissionPending = useRef(false);
  const logoutPending = useRef(false);
  const sessionDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    const controller = new AbortController();

    async function checkSession() {
      try {
        // Refresh is shared across callers: do not abort it with this page.
        if (!session.getAccessToken()) await refreshSession();
        if (!active) return;
        const profile = await apiWithSession<unknown>('/auth/me', { signal: controller.signal });
        if (!hasPublicUser(profile) || !('personalGroupId' in profile)
          || typeof profile.personalGroupId !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profile.personalGroupId)) {
          throw new Error('Invalid profile response');
        }
        if (!active) return;
        setSessionState('authenticated');
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) {
          session.setAccessToken(null);
          setSessionState('guest');
        } else {
          setSessionState('error');
        }
      }
    }

    void checkSession();
    return () => {
      active = false;
      mounted.current = false;
      controller.abort();
    };
  }, [router, sessionVersion]);

  useEffect(() => {
    const dialog = sessionDialog.current;
    if (!dialog) return;
    if (sessionState === 'authenticated' && !dialog.open) dialog.showModal();
    else if (sessionState !== 'authenticated' && dialog.open) dialog.close();
  }, [sessionState]);

  async function handleContinueToRegistration() {
    if (logoutPending.current) return;
    logoutPending.current = true;
    setIsLoggingOut(true);
    setLogoutError('');
    try {
      await logoutSession();
      // A full navigation resets the shared logout lock and all in-memory account state.
      window.location.replace('/register');
    } catch {
      logoutPending.current = false;
      if (!mounted.current) return;
      setIsLoggingOut(false);
      setLogoutError('No pudimos cerrar la sesión. Comprueba la conexión e inténtalo de nuevo.');
    }
  }

  function updateField(field: FieldName, value: string) {
    setFields((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined, ...(field === 'password' ? { confirmPassword: undefined } : {}) }));
    setSubmitError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sessionState !== 'guest' || submissionPending.current) return;
    setSubmitError(null);

    const normalizedName = fields.name.trim();
    const normalizedEmail = fields.email.trim().toLowerCase();
    const nextErrors: FieldErrors = {};
    const form = event.currentTarget;
    const emailInput = form.elements.namedItem('email') as HTMLInputElement;

    // Validate the normalized address with the browser's email rules.
    emailInput.value = normalizedEmail;
    setFields((current) => ({ ...current, name: normalizedName, email: normalizedEmail }));

    if (!normalizedName) nextErrors.name = 'Escribe tu nombre.';
    else if (normalizedName.length > 100) nextErrors.name = 'El nombre debe tener como máximo 100 caracteres.';

    if (!normalizedEmail) nextErrors.email = 'Escribe tu correo electrónico.';
    else if (normalizedEmail.length > 255 || !emailInput.validity.valid) nextErrors.email = 'Escribe un correo electrónico válido de hasta 255 caracteres.';

    if (fields.password.length < 8 || fields.password.length > 72) nextErrors.password = 'Usa entre 8 y 72 caracteres para la contraseña.';

    if (!fields.confirmPassword) nextErrors.confirmPassword = 'Escribe de nuevo la contraseña.';
    else if (fields.confirmPassword !== fields.password) nextErrors.confirmPassword = 'Las contraseñas deben coincidir.';

    setErrors(nextErrors);
    const firstInvalid = fieldOrder.find((field) => nextErrors[field]);
    if (firstInvalid) {
      (form.elements.namedItem(firstInvalid) as HTMLInputElement).focus();
      return;
    }

    submissionPending.current = true;
    setIsSubmitting(true);
    try {
      // Registration is a single mutation, never automatically retried.
      const result = await api<unknown>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name: normalizedName, email: normalizedEmail, password: fields.password }),
      });
      if (!isRegisterResponse(result)) throw new InvalidRegistrationResponseError('Invalid registration response');
      if (!mounted.current) return;
      session.setAccessToken(result.accessToken);
      setFields((current) => ({ ...current, password: '', confirmPassword: '' }));
      setShowPassword(false);
      setShowConfirmation(false);
      setSessionState('redirecting');
      router.replace('/dashboard');
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError && error.status === 409) {
        setSubmitError({ message: 'Ese correo ya tiene una cuenta.', showLoginLink: true });
      } else if (error instanceof ApiError && error.status === 400) {
        setSubmitError({ message: 'El servidor rechazó algunos datos. Revisa el nombre, el correo y la contraseña e inténtalo de nuevo.', showLoginLink: false });
      } else if (error instanceof ApiError && error.status >= 500) {
        setSubmitError({ message: 'El servidor tuvo un problema y no pudo confirmar el registro. Inténtalo de nuevo más tarde.', showLoginLink: false });
      } else if (error instanceof InvalidRegistrationResponseError || error instanceof SyntaxError) {
        setSubmitError({ message: 'Recibimos una respuesta inesperada. Comprueba si puedes iniciar sesión antes de volver a enviar el formulario.', showLoginLink: true });
      } else {
        setSubmitError({ message: 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo. Si el registro alcanzó a completarse, podrás iniciar sesión.', showLoginLink: true });
      }
    } finally {
      submissionPending.current = false;
      if (mounted.current) setIsSubmitting(false);
    }
  }

  if (sessionState !== 'guest') {
    return (
      <main className="app-design register-page register-gate">
        <section aria-label="Acceso al registro" className="register-gate-panel">
          <Link className="register-brand" href="/">
            <span aria-hidden="true" className="register-brand-symbol">↻</span>
            <span>Gestor de suscripciones</span>
          </Link>
          {sessionState === 'authenticated' ? (
            <dialog
              aria-describedby="register-session-dialog-description"
              aria-labelledby="register-session-dialog-title"
              className="register-session-dialog"
              onCancel={(event) => {
                event.preventDefault();
                if (!logoutPending.current) router.replace('/');
              }}
              ref={sessionDialog}
            >
              <h1 id="register-session-dialog-title">Ya tienes una sesión abierta</h1>
              <p id="register-session-dialog-description">Puedes volver a tu espacio actual o cerrar la sesión antes de crear otra cuenta.</p>
              {logoutError && <p className="ui-feedback ui-feedback-error" role="alert">{logoutError}</p>}
              <div className="register-session-dialog-actions">
                <button className="ui-button" disabled={isLoggingOut} onClick={() => { setSessionState('redirecting'); router.replace('/dashboard'); }} type="button">
                  Ir al dashboard
                </button>
                <button className="ui-button ui-button-secondary" disabled={isLoggingOut} onClick={() => void handleContinueToRegistration()} type="button">
                  {isLoggingOut ? 'Cerrando sesión…' : 'Cerrar sesión y crear cuenta'}
                </button>
                <Link
                  aria-disabled={isLoggingOut}
                  className="register-session-dialog-cancel"
                  href="/"
                  onClick={(event) => { if (logoutPending.current) event.preventDefault(); }}
                  tabIndex={isLoggingOut ? -1 : undefined}
                >Ahora no, volver al inicio</Link>
              </div>
            </dialog>
          ) : sessionState === 'error' ? (
            <>
              <p className="ui-feedback ui-feedback-error" role="alert">No pudimos comprobar tu sesión. Comprueba la conexión e inténtalo de nuevo.</p>
              <button className="ui-button ui-button-secondary" onClick={() => { setSessionState('checking'); setSessionVersion((current) => current + 1); }} type="button">Reintentar</button>
            </>
          ) : sessionState !== 'redirecting' ? (
            <p className="register-session-message" role="status">{sessionState === 'checking' ? 'Comprobando tu sesión…' : 'Abriendo tu espacio…'}</p>
          ) : <p className="register-session-message" role="status">Abriendo tu espacio…</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="app-design register-page">
      <header className="register-header register-wrap">
        <Link className="register-brand" href="/">
          <span aria-hidden="true" className="register-brand-symbol">↻</span>
          <span>Gestor de suscripciones</span>
        </Link>
        <Link className="register-login-link" href="/login">Iniciar sesión</Link>
      </header>

      <div className="register-main register-wrap">
        <div className="register-layout">
          <section aria-labelledby="register-title" className="register-story">
            <Link className="register-back" href="/">
              <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
                <path d="m10 5-7 7 7 7M3 12h18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
              </svg>
              Volver al inicio
            </Link>
            <h1 id="register-title">Tu espacio empieza aquí.</h1>
            <p>Crea tu cuenta y reúne tus suscripciones. Tendrás tu espacio personal desde el primer momento.</p>

            <div aria-label="Ilustración de espacio personal" className="register-personal-sheet">
              <div className="register-sheet-title">
                <span className="register-sheet-person"><PersonIcon /></span>
                <div>
                  <strong>Tu espacio personal</strong>
                  <p>Para tus servicios y tus registros.</p>
                </div>
              </div>
              <div aria-hidden="true" className="register-sheet-lines"><span /><span /></div>
              <div className="register-sheet-bottom">
                <p>La familia, cuando tú decidas.</p>
                <div aria-hidden="true" className="register-avatars"><span>TÚ</span><span>+</span></div>
              </div>
            </div>
            <p className="register-manual-note">
              <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
                <path d="m5 12 4 4L19 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" />
              </svg>
              Lleva tu control. Los pagos se anotan manualmente y la aplicación no mueve dinero.
            </p>
          </section>

          <section aria-labelledby="register-form-title" className="register-form-panel">
            <h2 id="register-form-title">Crea tu cuenta</h2>
            <p className="register-form-intro">Completa tus datos para empezar.</p>
            <form aria-busy={isSubmitting} noValidate onSubmit={handleSubmit}>
              <fieldset className="register-fields" disabled={isSubmitting}>
              <div className="register-field">
                <label htmlFor="register-name">Nombre</label>
                <input
                  aria-describedby={errors.name ? 'register-name-hint register-name-error' : 'register-name-hint'}
                  aria-invalid={Boolean(errors.name)}
                  autoComplete="name"
                  className="ui-field"
                  id="register-name"
                  maxLength={100}
                  name="name"
                  onChange={(event) => updateField('name', event.target.value)}
                  placeholder="Cómo quieres que te llamemos"
                  required
                  type="text"
                  value={fields.name}
                />
                <p className="register-field-hint" id="register-name-hint">Hasta 100 caracteres.</p>
                {errors.name && <p className="register-field-error" id="register-name-error" role="alert">{errors.name}</p>}
              </div>

              <div className="register-field">
                <label htmlFor="register-email">Correo electrónico</label>
                <input
                  aria-describedby={errors.email ? 'register-email-error' : undefined}
                  aria-invalid={Boolean(errors.email)}
                  autoCapitalize="none"
                  autoComplete="email"
                  className="ui-field"
                  id="register-email"
                  maxLength={255}
                  name="email"
                  onChange={(event) => updateField('email', event.target.value)}
                  placeholder="nombre@ejemplo.com"
                  required
                  spellCheck={false}
                  type="email"
                  value={fields.email}
                />
                {errors.email && <p className="register-field-error" id="register-email-error" role="alert">{errors.email}</p>}
              </div>

              <div className="register-field">
                <label htmlFor="register-password">Contraseña</label>
                <div className="register-password-wrap">
                  <input
                    aria-describedby={errors.password ? 'register-password-hint register-password-error' : 'register-password-hint'}
                    aria-invalid={Boolean(errors.password)}
                    autoComplete="new-password"
                    className="ui-field"
                    id="register-password"
                    maxLength={72}
                    minLength={8}
                    name="password"
                    onChange={(event) => updateField('password', event.target.value)}
                    placeholder="Crea una contraseña"
                    required
                    type={showPassword ? 'text' : 'password'}
                    value={fields.password}
                  />
                  <button aria-controls="register-password" aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={showPassword} className="register-password-toggle" onClick={() => setShowPassword((current) => !current)} type="button">
                    {showPassword ? 'Ocultar' : 'Mostrar'}
                  </button>
                </div>
                <p className="register-field-hint" id="register-password-hint">Entre 8 y 72 caracteres.</p>
                {errors.password && <p className="register-field-error" id="register-password-error" role="alert">{errors.password}</p>}
              </div>

              <div className="register-field">
                <label htmlFor="register-confirm-password">Confirma la contraseña</label>
                <div className="register-password-wrap">
                  <input
                    aria-describedby={errors.confirmPassword ? 'register-confirm-password-error' : undefined}
                    aria-invalid={Boolean(errors.confirmPassword)}
                    autoComplete="new-password"
                    className="ui-field"
                    id="register-confirm-password"
                    maxLength={72}
                    name="confirmPassword"
                    onChange={(event) => updateField('confirmPassword', event.target.value)}
                    placeholder="Escríbela una vez más"
                    required
                    type={showConfirmation ? 'text' : 'password'}
                    value={fields.confirmPassword}
                  />
                  <button aria-controls="register-confirm-password" aria-label={showConfirmation ? 'Ocultar confirmación de contraseña' : 'Mostrar confirmación de contraseña'} aria-pressed={showConfirmation} className="register-password-toggle" onClick={() => setShowConfirmation((current) => !current)} type="button">
                    {showConfirmation ? 'Ocultar' : 'Mostrar'}
                  </button>
                </div>
                {errors.confirmPassword && <p className="register-field-error" id="register-confirm-password-error" role="alert">{errors.confirmPassword}</p>}
              </div>

              <button className="ui-button register-submit" type="submit">{isSubmitting ? 'Creando cuenta…' : 'Crear cuenta'}</button>
              </fieldset>
              {submitError && (
                <p className="ui-feedback ui-feedback-error register-submit-error" role="alert">
                  {submitError.message}{submitError.showLoginLink && <> <Link href="/login">Iniciar sesión</Link></>}
                </p>
              )}
            </form>
            <p className="register-form-login">¿Ya tienes cuenta? <Link href="/login">Inicia sesión</Link></p>
          </section>
        </div>
      </div>

      <footer className="register-footer">
        <div className="register-wrap"><strong>Gestor de suscripciones</strong><p>Un espacio para lo tuyo. Otro para lo compartido.</p></div>
      </footer>
    </main>
  );
}
