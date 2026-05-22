/**
 * Single-instance enforcement vía BroadcastChannel.
 *
 * Objetivo: evitar que un mismo navegador tenga la app abierta en múltiples
 * pestañas/ventanas a la vez. Cada vez que se ejecuta una pestaña, anuncia
 * "HELLO" con su id. Si otra responde "HELLO_BACK", la nueva pestaña se
 * declara secundaria y muestra un overlay; la primaria sigue activa.
 *
 * Si el usuario hace clic en "Usar aquí" en la pestaña secundaria, ésta toma
 * el control: emite "TAKEOVER" y las demás se cierran/bloquean.
 */

const CHANNEL_NAME = 'cargatushoras-single-instance'

type Msg =
  | { kind: 'HELLO'; from: string; ts: number }
  | { kind: 'HELLO_BACK'; from: string; ts: number }
  | { kind: 'TAKEOVER'; from: string; ts: number }

const myId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

function showOverlay(onTakeover: () => void): HTMLDivElement {
  const existing = document.getElementById('single-instance-overlay') as HTMLDivElement | null
  if (existing) return existing

  const overlay = document.createElement('div')
  overlay.id = 'single-instance-overlay'
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99999',
    'background:rgba(15,23,42,0.92)', 'color:#f8fafc',
    'display:flex', 'align-items:center', 'justify-content:center',
    'padding:2rem', 'text-align:center', 'font-family:system-ui,sans-serif',
  ].join(';')

  overlay.innerHTML = `
    <div style="max-width:480px;background:#0f172a;border:1px solid #334155;border-radius:12px;padding:2rem;">
      <h2 style="margin:0 0 1rem;font-size:1.25rem;">La aplicación ya está abierta en otra pestaña</h2>
      <p style="margin:0 0 1.5rem;color:#cbd5e1;line-height:1.5;">
        Para evitar conflictos y reducir el consumo de datos, esta app solo
        puede usarse en una pestaña a la vez. Cerrá esta pestaña o tomá el
        control desde aquí.
      </p>
      <button id="single-instance-takeover" style="
        background:#22c55e;color:#0f172a;border:none;border-radius:8px;
        padding:0.75rem 1.5rem;font-weight:600;cursor:pointer;font-size:0.95rem;">
        Usar en esta pestaña
      </button>
    </div>
  `

  document.body.appendChild(overlay)
  const btn = overlay.querySelector('#single-instance-takeover') as HTMLButtonElement | null
  if (btn) btn.addEventListener('click', onTakeover)
  return overlay
}

function hideOverlay(): void {
  const el = document.getElementById('single-instance-overlay')
  if (el && el.parentNode) el.parentNode.removeChild(el)
}

let isBlocked = false

/** Inicia el guard. Debe llamarse una vez al arrancar la app. */
export function initSingleInstance(): void {
  if (typeof window === 'undefined') return
  if (!('BroadcastChannel' in window)) return // Safari muy antiguo: no aplica
  const channel = new BroadcastChannel(CHANNEL_NAME)

  function send(msg: Msg): void {
    try { channel.postMessage(msg) } catch { /* noop */ }
  }

  function takeover(): void {
    isBlocked = false
    hideOverlay()
    send({ kind: 'TAKEOVER', from: myId, ts: Date.now() })
  }

  channel.onmessage = (event: MessageEvent<Msg>) => {
    const msg = event.data
    if (!msg || msg.from === myId) return

    if (msg.kind === 'HELLO') {
      // Otra pestaña entra; si esta es la primaria activa, responder.
      if (!isBlocked) {
        send({ kind: 'HELLO_BACK', from: myId, ts: Date.now() })
      }
      return
    }
    if (msg.kind === 'HELLO_BACK') {
      // Hay otra pestaña primaria → bloquearme.
      if (!isBlocked) {
        isBlocked = true
        showOverlay(takeover)
      }
      return
    }
    if (msg.kind === 'TAKEOVER') {
      // Otra pestaña tomó el control → bloquearme.
      if (!isBlocked) {
        isBlocked = true
        showOverlay(takeover)
      }
      return
    }
  }

  // Anunciarme y esperar respuestas. Si nadie responde en 400ms,
  // asumo que soy la única pestaña.
  send({ kind: 'HELLO', from: myId, ts: Date.now() })

  // Limpieza al cerrar para no dejar timers/canal pendiente.
  window.addEventListener('pagehide', () => {
    try { channel.close() } catch { /* noop */ }
  })
}
