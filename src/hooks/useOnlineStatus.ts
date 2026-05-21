import { useEffect, useState } from 'react'

/**
 * Hook que indica si el navegador detecta conexión a internet.
 * Combina `navigator.onLine` con eventos `online`/`offline`.
 *
 * Nota: `navigator.onLine === true` no garantiza conectividad real con
 * Firestore (puede haber wifi sin internet), pero es suficiente como
 * señal visual al usuario.
 */
export function useOnlineStatus(): boolean {
  const getInitial = () =>
    typeof navigator === 'undefined' ? true : navigator.onLine

  const [online, setOnline] = useState<boolean>(getInitial)

  useEffect(() => {
    const handleOnline = () => setOnline(true)
    const handleOffline = () => setOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return online
}
