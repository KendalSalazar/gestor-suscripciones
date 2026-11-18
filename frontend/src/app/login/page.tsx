'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, api } from '@/lib/api';
import { session } from '@/lib/session';

type LoginResponse = {
  user: {
    id: string;
    email: string;
    name: string;
  };
  accessToken: string;
};

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const result = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });

      if (!result) throw new Error('El servidor no devolvió los datos de sesión.');

      session.setAccessToken(result.accessToken);
      router.replace('/dashboard');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setError('El correo o la contraseña no son correctos.');
      } else {
        setError(cause instanceof Error ? cause.message : 'No se pudo iniciar sesión.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="app-design login-page">
      <section aria-labelledby="login-heading" className="login-panel">
        <div className="login-brand">
          <span aria-hidden="true" className="login-brand-mark">↻</span>
          <span>Gestor de suscripciones</span>
        </div>

        <Link className="login-home" href="/">Volver al inicio</Link>

        <header className="login-heading">
          <h1 id="login-heading">Inicia sesión</h1>
          <p>Accede a tus suscripciones y pagos compartidos.</p>
        </header>

        <form aria-busy={isSubmitting} className="login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label className="app-design-label" htmlFor="email">Correo electrónico</label>
            <input
              autoComplete="email"
              autoCapitalize="none"
              className="ui-field"
              id="email"
              name="email"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
              aria-describedby={error ? 'login-error' : undefined}
            />
          </div>

          <div className="login-field">
            <label className="app-design-label" htmlFor="password">Contraseña</label>
            <input
              autoComplete="current-password"
              className="ui-field"
              id="password"
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
              aria-describedby={error ? 'login-error' : undefined}
            />
          </div>

          {error && <p className="ui-feedback ui-feedback-error login-error" id="login-error" role="alert">{error}</p>}

          <button className="ui-button login-submit" disabled={isSubmitting} type="submit">
            {isSubmitting ? 'Ingresando…' : 'Entrar'}
          </button>
        </form>
      </section>
    </main>
  );
}
