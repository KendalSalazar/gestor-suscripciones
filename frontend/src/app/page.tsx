'use client';

import Link from 'next/link';
import { useState } from 'react';

function ListIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path d="M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <circle cx="12" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  );
}

function FamilyIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <circle cx="9" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="17" cy="9" r="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0M14 14a4.5 4.5 0 0 1 6.5 4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20">
      <rect height="16" rx="2.5" stroke="currentColor" strokeWidth="1.7" width="17" x="3.5" y="5" />
      <path d="M7.5 3.5v3M16.5 3.5v3M3.5 9.5h17M8 13h3M8 16.5h3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  );
}

function SharesIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20">
      <circle cx="7" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="17" cy="7" r="3" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="17" cy="17" r="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="m9.7 10.7 4.6-2.4M9.7 13.3l4.6 2.4" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function HomeMark() {
  return <span aria-hidden="true" className="home-brand-mark">↻</span>;
}

export default function Home() {
  const [space, setSpace] = useState<'personal' | 'family'>('personal');

  return (
    <main className="app-design home-page">
      <div className="home-shell">
        <header className="home-header">
          <Link aria-label="Gestor de suscripciones, inicio" className="home-brand" href="/">
            <HomeMark />
            <span>Gestor de suscripciones</span>
          </Link>
          <nav aria-label="Acceso a tu cuenta" className="home-header-nav">
            <Link href="/login">Iniciar sesión</Link>
          </nav>
        </header>

        <section aria-labelledby="home-title" className="home-hero">
          <div className="home-hero-copy">
            <h1 id="home-title">Todo lo que se repite. Todo bajo control.</h1>
            <p className="home-hero-description">
              Tus servicios, sus fechas y los pagos que compartes. Un lugar para
              tener claro qué viene y qué ya registraste.
            </p>
            <div className="home-actions">
              <Link className="home-button home-button-primary" href="/register">Crear cuenta</Link>
              <Link className="home-button home-button-secondary" href="/login">Ya tengo una cuenta</Link>
            </div>
            <p className="home-hero-detail">
              <PersonIcon />
              Empieza en personal. Comparte cuando lo necesites.
            </p>
          </div>

          <div className="home-hero-visual">
            <div className="home-specimen-label">
              <span>Un vistazo a tu espacio</span>
              <span>Ejemplo ilustrativo</span>
            </div>

            <section aria-label="Ejemplo del producto con datos ficticios" className="home-product-window">
              <div className="home-product-topbar">
                <div className="home-product-brand"><HomeMark />Mi espacio</div>
                <span aria-label="Persona de ejemplo" className="home-account-dot">AL</span>
              </div>

              <div aria-label="Cambiar espacio de ejemplo" className="home-demo-tabs">
                <button aria-pressed={space === 'personal'} onClick={() => setSpace('personal')} type="button">Personal</button>
                <button aria-pressed={space === 'family'} onClick={() => setSpace('family')} type="button">Familia</button>
              </div>

              {space === 'personal' ? (
                <div className="home-product-content">
                  <div className="home-product-context">
                    <div><h2>Mis suscripciones</h2><p>Próximas fechas de cobro</p></div>
                    <span className="home-context-mark"><ListIcon /></span>
                  </div>
                  <div aria-hidden="true" className="home-service-head"><span>Servicio</span><span>Coste previsto</span></div>
                  <div className="home-service-row">
                    <span aria-hidden="true" className="home-service-icon"><PersonIcon /></span>
                    <div><strong>Música</strong><p>Mensual · 05 dic.</p></div>
                    <div className="home-service-value"><strong>6.00</strong><p>Activa</p></div>
                  </div>
                  <div className="home-service-row">
                    <span aria-hidden="true" className="home-service-icon home-service-icon-neutral"><ListIcon /></span>
                    <div><strong>Cine en casa</strong><p>Mensual · 12 dic.</p></div>
                    <div className="home-service-value"><strong>12.00</strong><p>Activa</p></div>
                  </div>
                  <div className="home-notice-preview">
                    <BellIcon />
                    <div><strong>Un pago por registrar</strong><p>Tu próximo paso, a la vista en tus avisos.</p></div>
                  </div>
                  <p className="home-example-foot">Servicios, fechas e importes de muestra.</p>
                </div>
              ) : (
                <div className="home-product-content">
                  <div className="home-product-context">
                    <div><h2>Familia de Alex</h2><p>Partes del pago de Cine en casa</p></div>
                    <span className="home-context-mark"><FamilyIcon /></span>
                  </div>
                  <div aria-hidden="true" className="home-service-head"><span>Miembro</span><span>Su parte</span></div>
                  <div className="home-service-row">
                    <span aria-hidden="true" className="home-service-icon">AL</span>
                    <div><strong>Alex · Tú</strong><p>Confirmada</p></div>
                    <div className="home-service-value"><strong>4.00</strong><p>Registrados</p></div>
                  </div>
                  <div className="home-service-row">
                    <span aria-hidden="true" className="home-service-icon home-service-icon-neutral">SA</span>
                    <div><strong>Sam</strong><p>Pendiente de confirmar</p></div>
                    <div className="home-service-value"><strong>4.00</strong><p>Cuota prevista</p></div>
                  </div>
                  <div className="home-family-shares">
                    <div aria-hidden="true" className="home-avatars"><span>AL</span><span>SA</span><span>LU</span></div>
                    <p><strong>Cada persona registra su parte</strong>El reparto se conserva en el historial.</p>
                  </div>
                  <p className="home-example-foot">Personas e importes de muestra.</p>
                </div>
              )}

              <div className="home-space-note">
                <span aria-hidden="true" className="home-note-check">✓</span>
                <div><strong>Lo personal y lo compartido, en su lugar.</strong><p>Cambia entre tus espacios sin mezclar sus suscripciones.</p></div>
              </div>
            </section>
          </div>
        </section>

        <section aria-labelledby="home-guide-title" className="home-guide">
          <div className="home-guide-heading">
            <h2 id="home-guide-title">Lo que puedes tener a la vista</h2>
            <p>Fechas, reparto y avisos reunidos en el espacio que corresponde.</p>
          </div>

          <ul className="home-guide-list">
            <li className="home-guide-item">
              <span aria-hidden="true" className="home-guide-icon"><CalendarIcon /></span>
              <div className="home-guide-item-copy">
                <h3>Fechas y costes previstos</h3>
                <p>Guarda el coste y la frecuencia de cada servicio; consulta cuándo toca el próximo cobro.</p>
              </div>
            </li>
            <li className="home-guide-item">
              <span aria-hidden="true" className="home-guide-icon"><SharesIcon /></span>
              <div className="home-guide-item-copy">
                <h3>Partes del pago grupal</h3>
                <p>Cada persona registra su parte y puede consultar cómo se reparte el total entre los miembros.</p>
              </div>
            </li>
            <li className="home-guide-item">
              <span aria-hidden="true" className="home-guide-icon"><BellIcon /></span>
              <div className="home-guide-item-copy">
                <h3>Avisos con contexto</h3>
                <p>Consulta pagos pendientes y diferencias de importe desde las notificaciones.</p>
              </div>
            </li>
          </ul>

          <p className="home-manual-note">Los pagos se registran manualmente; la aplicación no mueve dinero.</p>
        </section>
      </div>
    </main>
  );
}
