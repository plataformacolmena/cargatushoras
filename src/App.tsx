import { useAuth } from './auth/useAuth'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { PendingApprovalPage } from './pages/PendingApprovalPage'
import './styles/app.css'

function App() {
  const { user, profile, loading } = useAuth()

  if (loading) {
    return (
      <div className="screen auth-screen">
        <div className="auth-card">
          <h1>Cargando...</h1>
          <p className="muted">Inicializando sesion y perfil.</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return <LoginPage />
  }

  if (!profile || profile.approvalStatus === 'PENDING') {
    return <PendingApprovalPage />
  }

  return <DashboardPage />
}

export default App
