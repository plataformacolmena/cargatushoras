import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // se hace manualmente en src/main.tsx para mostrar prompt
      includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'CargaTusHoras',
        short_name: 'CargaTusHoras',
        description: 'Gestor de jornadas y liquidaciones',
        theme_color: '#863bff',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        lang: 'es',
        icons: [
          {
            src: 'pwa-64x64.png',
            sizes: '64x64',
            type: 'image/png',
          },
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Forzar que el SW nuevo reemplace inmediatamente al viejo, sin esperar
        // a que el usuario cierre todas las pestañas. Crítico para distribuir
        // hotfixes (p. ej. bug de Google Auth interceptado por el SW).
        skipWaiting: true,
        clientsClaim: true,
        // Cachear el shell de la app (JS, CSS, HTML, fuentes, imágenes propias).
        // Datos de Firestore quedan fuera: ya los maneja la caché persistente
        // de Firestore (IndexedDB) configurada en src/firebase.ts.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallback: '/index.html',
        // No interceptar requests de Firebase/Google (Auth, Firestore, etc.):
        // dejarlas pasar al SDK para que maneje el offline/sync.
        navigateFallbackDenylist: [/^\/__/, /^\/api\//],
        runtimeCaching: [
          {
            // gstatic.com sí es estático y se puede cachear sin problemas.
            urlPattern: ({ url }) => url.origin === 'https://www.gstatic.com',
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-static',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
          // IMPORTANTE: NO registrar ninguna regla para apis.google.com /
          // accounts.google.com / *.googleapis.com / *.firebaseio.com /
          // *.firebaseapp.com. Cualquier regla (incluso NetworkOnly) hace que
          // Workbox llame respondWith() y, en Safari, los fetch JSONP/iframe
          // de Firebase Auth fallan con "no-response: no-response" rompiendo
          // el login. Sin regla, el SW no intercepta y el navegador maneja
          // esas peticiones de forma nativa.
        ],
        // No cachear las llamadas a Firestore/Auth/Identity (el SDK ya las gestiona).
        navigateFallbackAllowlist: [/^(?!.*\.(?:googleapis|firebaseio|firebaseapp)\.com).*/],
      },
      devOptions: {
        enabled: false, // habilitar a `true` solo para probar SW en dev
      },
    }),
  ],
  // Eliminar console.log/debug/info y debugger en builds de producción para
  // no exponer logs de depuración. Mantenemos console.warn y console.error
  // porque son críticos para diagnosticar problemas en producción (rule
  // denials de Firestore, fallos de red, etc.) que de otro modo quedarían
  // silenciosos para el usuario y para nosotros.
  esbuild: mode === 'production' ? { pure: ['console.log', 'console.debug', 'console.info'], drop: ['debugger'] } : {},
}))
