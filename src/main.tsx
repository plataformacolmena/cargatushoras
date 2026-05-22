import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthContext'
import { registerServiceWorker } from './pwa'
import { initSingleInstance } from './lib/singleInstance'
import { flushPendingRecalculations } from './services/firestore'

/**
 * Kill-switch único: en versiones previas el Service Worker interceptaba
 * `https://apis.google.com/js/api.js` con StaleWhileRevalidate y devolvía
 * `no-response`, rompiendo el login con Google. Aunque el deploy nuevo
 * arregla la regla, los clientes que ya tienen el SW viejo controlando la
 * pestaña no lo sustituyen hasta una recarga completa. Forzamos una única
 * vez la desregistración del SW viejo y recargamos para registrar el nuevo.
 */
const SW_RESET_KEY = 'sw-reset-v2-google-auth'
async function resetServiceWorkerOnce(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false
  try {
    if (localStorage.getItem(SW_RESET_KEY) === '1') return false
    const regs = await navigator.serviceWorker.getRegistrations()
    if (regs.length === 0) {
      localStorage.setItem(SW_RESET_KEY, '1')
      return false
    }
    await Promise.all(regs.map((r) => r.unregister()))
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
    localStorage.setItem(SW_RESET_KEY, '1')
    return true
  } catch {
    return false
  }
}

async function bootstrap() {
  const didReset = await resetServiceWorkerOnce()
  if (didReset) {
    location.reload()
    return
  }
  // Guard de instancia única (BroadcastChannel). Si esta pestaña detecta
  // otra activa, muestra un overlay bloqueante con opción de "Usar aquí".
  initSingleInstance()
  // Antes de cerrar la pestaña, ejecutar cualquier recálculo de usuario
  // pendiente que esté en el debounce.
  window.addEventListener('pagehide', () => {
    void flushPendingRecalculations()
  })
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </StrictMode>,
  )
  registerServiceWorker()
}

void bootstrap()
