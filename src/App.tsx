import { useEffect, useRef, useState } from 'react'
import { useAuth } from './auth/useAuth'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { PendingApprovalPage } from './pages/PendingApprovalPage'
import { CompleteProfilePage } from './pages/CompleteProfilePage'
import { LoadingOverlay } from './components/Spinner'
import { MaintenanceScreen } from './components/MaintenanceScreen'
import { subscribeToMaintenance, type MaintenanceState } from './services/firestore'
import { MaintenanceContext } from './hooks/useMaintenance'
import './styles/app.css'

function App() {
  const { user, profile, loading } = useAuth()
  const [maintenance, setMaintenance] = useState<MaintenanceState>({
    enabled: false,
    message: null,
    version: 0,
  })
  const lastVersionRef = useRef<number | null>(null)
  const wasInMaintenanceRef = useRef(false)

  useEffect(() => {
    if (!user) return
    const unsub = subscribeToMaintenance((state) => {
      setMaintenance(state)
      // Si el usuario estaba en pantalla de mantenimiento y ahora se desactivó,
      // forzar reload para traer recursos frescos.
      if (wasInMaintenanceRef.current && !state.enabled) {
        window.location.reload()
        return
      }
      // Si cambió la versión mientras la app está abierta (otro toggle), recargar
      // para que el SU pueda reactivar y forzar refresh.
      if (lastVersionRef.current !== null && state.version !== lastVersionRef.current && !state.enabled) {
        window.location.reload()
        return
      }
      lastVersionRef.current = state.version
      wasInMaintenanceRef.current = state.enabled
    })
    return () => unsub()
  }, [user])

  if (loading) {
    return <LoadingOverlay show label="Verificando sesión y permisos…" />
  }

  if (!user) {
    return <LoginPage />
  }

  // Mantenimiento: visible para todos los autenticados EXCEPTO SUPERUSER
  if (maintenance.enabled && profile?.role !== 'SUPERUSER') {
    return <MaintenanceScreen message={maintenance.message} />
  }

  if (!profile || profile.approvalStatus === 'PENDING') {
    return <PendingApprovalPage />
  }

  if (profile.disabled === true) {
    return (
      <div className="screen" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem', textAlign: 'center' }}>
        <div className="card" style={{ maxWidth: 420 }}>
          <h2>Cuenta inhabilitada</h2>
          <p className="muted">Tu cuenta fue inhabilitada por un administrador. Si creés que es un error, contactalo para que la reactive.</p>
        </div>
      </div>
    )
  }

  // Gate de perfil completo: requerir nombre y Nro de Cédula/DNI antes de operar.
  // Aplica a SUPERUSER, PROJECT_ADMIN y MEMBER por igual.
  const needsProfileCompletion =
    !profile.displayName?.trim() || !profile.idNumber?.trim()
  if (needsProfileCompletion) {
    return <CompleteProfilePage />
  }

  return (
    <MaintenanceContext.Provider value={maintenance}>
      <DashboardPage />
    </MaintenanceContext.Provider>
  )
}

export default App
