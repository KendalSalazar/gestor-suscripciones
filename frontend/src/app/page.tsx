import Link from 'next/link';

export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <section className="w-full max-w-3xl rounded-3xl border border-slate-200 bg-white p-8 shadow-sm sm:p-12">
        <div className="mb-10 inline-flex items-center gap-2 rounded-full bg-violet-50 px-3 py-1 text-sm font-medium text-violet-700">
          <span aria-hidden="true">●</span>
          Gestor de suscripciones
        </div>

        <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
          Tus pagos recurrentes, más claros
        </p>
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
          Organiza las suscripciones que compartes.
        </h1>
        <p className="mt-5 max-w-xl text-lg leading-8 text-slate-600">
          Registra servicios, consulta sus próximos cobros y mantén la información
          de tu grupo en un solo lugar.
        </p>

        <div className="mt-9 flex flex-col gap-3 sm:flex-row">
          <Link
            className="inline-flex min-h-12 items-center justify-center rounded-xl bg-violet-700 px-6 font-medium text-white transition hover:bg-violet-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700"
            href="/login"
          >
            Iniciar sesión
          </Link>
          <Link
            className="inline-flex min-h-12 items-center justify-center rounded-xl border border-slate-300 px-6 font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700"
            href="/dashboard"
          >
            Ir al dashboard
          </Link>
        </div>
      </section>
    </main>
  );
}
