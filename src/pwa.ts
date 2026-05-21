/**
 * Registro del Service Worker generado por vite-plugin-pwa.
 * Configurado en modo autoUpdate con skipWaiting + clientsClaim: el SW nuevo
 * toma control de las pestañas abiertas en cuanto se descarga, y aplicamos
 * una recarga automática para asegurar que el usuario quede con la versión
 * actualizada inmediatamente (crítico para hotfixes).
 */
import { registerSW } from 'virtual:pwa-register'

export function registerServiceWorker(): void {
  // En desarrollo el SW está deshabilitado (devOptions.enabled=false).
  if (!('serviceWorker' in navigator)) return

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      // Hay una versión nueva esperando. Aplicamos la actualización
      // automáticamente: el SW nuevo ya hizo skipWaiting, así que llamamos
      // a updateSW(true) para que recargue la pestaña con la versión nueva.
      void updateSW(true)
    },
    onOfflineReady() {
      // App lista para funcionar sin conexión. Log silencioso (se elimina en prod build).
      if (import.meta.env.DEV) console.info('[PWA] App lista para funcionar offline.')
    },
    onRegisterError(error) {
      if (import.meta.env.DEV) console.error('[PWA] Error registrando service worker:', error)
    },
  })
}
