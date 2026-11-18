import Link from 'next/link';
import type { ReactNode } from 'react';

type AppShellProps = {
  navigation: ReactNode;
  context: ReactNode;
  title: string;
  description: string;
  userName?: string;
  actions?: ReactNode;
  children: ReactNode;
};

export default function AppShell({ navigation, context, title, description, userName, actions, children }: AppShellProps) {
  return (
    <div className="app-design app-shell">
      <aside className="app-shell-sidebar" aria-label="Navegación de la aplicación">
        <Link className="app-shell-brand" href="/">
          <span className="app-shell-mark" aria-hidden="true">↻</span>
          <span>Gestor de suscripciones</span>
        </Link>
        {navigation}
        <Link className="app-shell-home" href="/">Volver al inicio</Link>
      </aside>
      <div className="app-shell-workspace">
        <header className="app-shell-context">
          {context}
          {userName && <p className="app-shell-user">{userName}</p>}
        </header>
        <main className="app-shell-main">
          <div className="app-shell-heading">
            <div>
              <h1>{title}</h1>
              <p>{description}</p>
            </div>
            {actions}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
