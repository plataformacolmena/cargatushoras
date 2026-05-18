import { useAuth } from '../auth/useAuth'

export function PendingApprovalPage() {
  const { profile, signOutUser, reloadProfile } = useAuth()

  return (
    <div className="screen pending-screen">
      <div className="pending-card">
        <p className="chip">Estado de acceso</p>
        <h1>Espera a ser aceptado</h1>
        <p className="muted">
          Tu cuenta {profile?.email ? `(${profile.email})` : ''} esta pendiente de aprobacion por un administrador.
        </p>

        <div className="inline-actions">
          <button className="btn" onClick={reloadProfile}>
            Reintentar
          </button>
          <button className="btn btn-outline" onClick={signOutUser}>
            Cerrar sesion
          </button>
        </div>
      </div>
    </div>
  )
}
