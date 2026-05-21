interface SpinnerProps {
  size?: number
  inline?: boolean
  label?: string
}

/** Spinner de espiral simple (animación pura CSS). */
export function Spinner({ size = 20, inline = false, label }: SpinnerProps) {
  const style: React.CSSProperties = {
    width: size,
    height: size,
    borderWidth: Math.max(2, Math.round(size / 8)),
  }
  return (
    <span className={`spinner ${inline ? 'spinner-inline' : ''}`} role="status" aria-label={label ?? 'Cargando'}>
      <span className="spinner-circle" style={style} />
      {label && !inline && <span className="spinner-label">{label}</span>}
    </span>
  )
}

interface LoadingOverlayProps {
  show: boolean
  label?: string
}

/** Overlay full-screen con espiral, para procesos largos. */
export function LoadingOverlay({ show, label }: LoadingOverlayProps) {
  if (!show) return null
  return (
    <div className="loading-overlay" role="alert" aria-live="assertive">
      <div className="loading-overlay-content">
        <span className="spinner-circle" style={{ width: 56, height: 56, borderWidth: 6 }} />
        {label && <p className="loading-overlay-label">{label}</p>}
      </div>
    </div>
  )
}
