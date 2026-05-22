import { useEffect, useState } from 'react'

interface Props {
  message?: string | null
}

/**
 * Pantalla bloqueante de "App en mantenimiento".
 * Al montar:
 *  1. Borra todas las cachés del navegador (Cache Storage usado por el SW PWA).
 *  2. Desregistra el Service Worker.
 *  3. Muestra un botón "Recargar ahora" que fuerza un reload limpio.
 *
 * Cuando el SUPERUSER desactive el mantenimiento, el suscriptor global hará
 * window.location.reload() automáticamente para que los usuarios reentren con
 * recursos frescos.
 */
export function MaintenanceScreen({ message }: Props) {
  const [status, setStatus] = useState<'cleaning' | 'ready' | 'error'>('cleaning')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        if ('caches' in window) {
          const keys = await caches.keys()
          await Promise.all(keys.map((k) => caches.delete(k)))
        }
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations()
          await Promise.all(regs.map((r) => r.unregister()))
        }
        try {
          localStorage.removeItem('vite-pwa:installed')
        } catch {
          /* ignore */
        }
        if (!cancelled) setStatus('ready')
      } catch (err) {
        console.error('[MaintenanceScreen] cleanup error:', err)
        if (!cancelled) setStatus('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleReload = () => {
    window.location.reload()
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        textAlign: 'center',
        background: '#0f172a',
        color: '#f1f5f9',
      }}
    >
      <div
        className="card"
        style={{
          maxWidth: 480,
          background: '#1e293b',
          border: '1px solid #334155',
          padding: '2rem',
          borderRadius: 12,
        }}
      >
        <h1 style={{ marginTop: 0, fontSize: '1.5rem' }}>🛠️ App en mantenimiento</h1>
        <p style={{ color: '#cbd5e1' }}>
          {message ||
            'Estamos aplicando una actualización. La aplicación no está disponible en este momento.'}
        </p>
        <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>
          {status === 'cleaning' && 'Limpiando caché local…'}
          {status === 'ready' && 'Caché limpia. Cuando finalice el mantenimiento, recargá para volver a usar la app.'}
          {status === 'error' && 'No se pudo limpiar la caché automáticamente. Por favor, cerrá y reabrí la app.'}
        </p>
        <button
          className="btn"
          onClick={handleReload}
          disabled={status === 'cleaning'}
          style={{ marginTop: '1rem' }}
        >
          {status === 'cleaning' ? 'Limpiando…' : 'Recargar ahora'}
        </button>
      </div>
    </div>
  )
}
