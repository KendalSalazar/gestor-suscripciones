import Link from 'next/link';
import type { ReactNode } from 'react';

type AppShellProps = {
  navigation: ReactNode;
  context: ReactNode;
  title: string;
  description: string;
  userName?: string;
  actions?: ReactNode;
  notificationsActive?: boolean;
  children: ReactNode;
};

export default function AppShell({ navigation, context, title, description, userName, actions, notificationsActive = false, children }: AppShellProps) {
  return (
    <div className="app-design app-shell">
      <aside className="app-shell-sidebar" aria-label="Navegación de la aplicación">
        <Link className="app-shell-brand" href="/">
          <span className="app-shell-mark" aria-hidden="true">↻</span>
          <span>Gestor de suscripciones</span>
        </Link>
        <div className="app-shell-navigation-region">{navigation}</div>
        <Link className="app-shell-home" href="/">Volver al inicio</Link>
      </aside>
      <div className="app-shell-workspace">
        <header className="app-shell-context">
          <div className="app-shell-context-fields">{context}</div>
          <div className="app-shell-account">
            {userName && <p className="app-shell-user">{userName}</p>}
            <Link
              aria-current={notificationsActive ? 'page' : undefined}
              aria-label="Notificaciones"
              className="app-shell-notifications"
              href="/notifications"
              title="Notificaciones"
            >
              <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
                <path d="M10 21h4" />
              </svg>
            </Link>
          </div>
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
