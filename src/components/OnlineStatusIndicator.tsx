import { useOnlineStatus } from '../hooks/useOnlineStatus'

/**
 * Chip visual en el topbar que indica el estado de conexión.
 * - Online: chip verde discreto "En línea"
 * - Offline: chip rojo pulsante "Sin conexión"
 *
 * La persistencia local de Firestore mantiene la app funcionando offline:
 * lecturas desde caché y escrituras encoladas que se sincronizan al volver.
 */
export function OnlineStatusIndicator() {
  const online = useOnlineStatus()

  if (online) {
    return (
      <span
        className="topbar-online-chip"
        role="status"
        aria-live="polite"
        title="Conectado. Cambios se sincronizan en tiempo real."
      >
        <span className="topbar-online-dot" aria-hidden="true" />
        En línea
      </span>
    )
  }

  return (
    <span
      className="topbar-offline-chip"
      role="status"
      aria-live="polite"
      title="Estás sin conexión. Los cambios se guardarán localmente y sincronizarán al volver online."
    >
      <span className="topbar-offline-dot" aria-hidden="true" />
      Sin conexión
    </span>
  )
}
