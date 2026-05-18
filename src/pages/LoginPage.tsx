import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth'

export function LoginPage() {
  const { signInWithGoogle, signInWithEmail, signUpWithEmail } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [registerMode, setRegisterMode] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleEmailAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setLoading(true)

    try {
      if (registerMode) {
        await signUpWithEmail(email, password)
      } else {
        await signInWithEmail(email, password)
      }
    } catch (err) {
      setError('No se pudo autenticar. Revisa credenciales o intenta con Google.')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  async function handleGoogle() {
    setError('')
    setLoading(true)

    try {
      await signInWithGoogle()
    } catch (err) {
      setError('No se pudo iniciar con Google.')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="screen auth-screen">
      <div className="auth-card">
        <p className="chip">Carga de Horarios</p>
        <h1>Ingreso al sistema</h1>
        <p className="muted">
          Inicia sesión para registrar jornadas. Los miembros nuevos requieren aprobación de un administrador.
        </p>

        <button className="btn btn-google" type="button" onClick={handleGoogle} disabled={loading}>
          Continuar con Google
        </button>

        <div className="divider">o</div>

        <form onSubmit={handleEmailAuth} className="stack">
          <label>
            Mail
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
            />
          </label>

          <label>
            Clave
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={6}
              autoComplete={registerMode ? 'new-password' : 'current-password'}
            />
          </label>

          <button className="btn" type="submit" disabled={loading}>
            {registerMode ? 'Crear cuenta' : 'Ingresar'}
          </button>
        </form>

        <button
          className="text-btn"
          type="button"
          onClick={() => setRegisterMode((prev) => !prev)}
          disabled={loading}
        >
          {registerMode ? 'Ya tengo cuenta' : 'No tengo cuenta'}
        </button>

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}
