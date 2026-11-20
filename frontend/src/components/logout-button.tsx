'use client';

import { useEffect, useRef, useState } from 'react';
import { logoutSession } from '@/lib/api';

export default function LogoutButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function handleLogout() {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setError('');
    try {
      await logoutSession();
      // Reload the document to discard all account state and in-flight views.
      window.location.replace('/login');
    } catch {
      sending.current = false;
      if (!mounted.current) return;
      setPending(false);
      setError('No pudimos cerrar la sesión. Comprueba la conexión e inténtalo de nuevo.');
    }
  }

  return (
    <div className="app-shell-logout">
      <button className="ui-button ui-button-secondary" disabled={pending} onClick={() => void handleLogout()} type="button">
        {pending ? 'Cerrando…' : 'Cerrar sesión'}
      </button>
      {error && <p className="app-shell-logout-error" role="alert">{error}</p>}
    </div>
  );
}
