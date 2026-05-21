import { useAuth } from './auth/useAuth'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { PendingApprovalPage } from './pages/PendingApprovalPage'
import { LoadingOverlay } from './components/Spinner'
import './styles/app.css'

function App() {
  const { user, profile, loading } = useAuth()

  if (loading) {
    return <LoadingOverlay show label="Verificando sesión y permisos…" />
  }

  if (!user) {
    return <LoginPage />
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

  return <DashboardPage />
}

export default App
