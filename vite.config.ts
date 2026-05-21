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
          {
            // NO cachear apis.google.com / accounts.google.com: Firebase Auth
            // los usa con querystrings dinámicos (callbacks JSONP) y cachearlos
            // provoca "FetchEvent.respondWith received an error: no-response"
            // rompiendo el login con Google (especialmente en móviles).
            urlPattern: ({ url }) =>
              url.origin === 'https://apis.google.com' ||
              url.origin === 'https://accounts.google.com' ||
              url.hostname.endsWith('.googleapis.com') ||
              url.hostname.endsWith('.firebaseio.com') ||
              url.hostname.endsWith('.firebaseapp.com'),
            handler: 'NetworkOnly',
          },
        ],
        // No cachear las llamadas a Firestore/Auth/Identity (el SDK ya las gestiona).
        navigateFallbackAllowlist: [/^(?!.*\.(?:googleapis|firebaseio|firebaseapp)\.com).*/],
      },
      devOptions: {
        enabled: false, // habilitar a `true` solo para probar SW en dev
      },
    }),
  ],
  // Eliminar console.* y debugger en builds de producción para evitar
  // exponer datos sensibles o información de depuración en el cliente.
  esbuild: mode === 'production' ? { drop: ['console', 'debugger'] } : {},
}))
