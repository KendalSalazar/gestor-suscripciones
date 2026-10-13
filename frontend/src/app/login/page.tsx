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
    <main className="flex flex-1 items-center justify-center px-6 py-12">
      <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-8 shadow-sm sm:p-10">
        <Link className="text-sm font-medium text-violet-700 hover:text-violet-900" href="/">
          ← Inicio
        </Link>
        <p className="mt-8 text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
          Gestor de suscripciones
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
          Inicia sesión
        </h1>
        <p className="mt-3 text-slate-600">
          Usa tu cuenta para consultar las suscripciones de tu grupo personal.
        </p>

        <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="email">
              Correo electrónico
            </label>
            <input
              autoComplete="email"
              className="min-h-12 w-full rounded-xl border border-slate-300 px-4 text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-violet-600 focus:ring-4 focus:ring-violet-100"
              id="email"
              name="email"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="password">
              Contraseña
            </label>
            <input
              autoComplete="current-password"
              className="min-h-12 w-full rounded-xl border border-slate-300 px-4 text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-violet-600 focus:ring-4 focus:ring-violet-100"
              id="password"
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </div>

          {error && (
            <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}

          <button
            className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-violet-700 px-6 font-medium text-white transition hover:bg-violet-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isSubmitting}
            type="submit"
          >
            {isSubmitting ? 'Ingresando…' : 'Entrar'}
          </button>
        </form>
      </section>
    </main>
  );
}
