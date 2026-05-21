import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth'
import { Spinner } from '../components/Spinner'

export function LoginPage() {
  const { signInWithGoogle, signInWithEmail, signUpWithEmail, sendPasswordReset } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [registerMode, setRegisterMode] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleEmailAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setInfo('')
    if (registerMode && password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.')
      return
    }
    setLoading(true)

    try {
      if (registerMode) {
        await signUpWithEmail(email, password)
      } else {
        await signInWithEmail(email, password)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      setError(msg && msg.includes('contraseña')
        ? msg
        : 'No se pudo autenticar. Revisa credenciales o intenta con Google.')
      if (import.meta.env.DEV) console.error(err)
    } finally {
      setLoading(false)
    }
  }

  async function handleGoogle() {
    setError('')
    setInfo('')
    setLoading(true)

    try {
      await signInWithGoogle()
    } catch (err) {
      const code = (err as { code?: string })?.code
      // Cancelaciones del usuario: no son un error real, no mostramos nada.
      if (
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request' ||
        code === 'auth/user-cancelled'
      ) {
        // silenciar
      } else if (code === 'auth/network-request-failed') {
        setError('Sin conexión con el servidor. Revivá tu internet y reintentá.')
      } else if (code === 'auth/unauthorized-domain') {
        setError('Este dominio no está autorizado para iniciar con Google. Avisá al administrador.')
      } else if (code === 'auth/account-exists-with-different-credential') {
        setError('Ya existe una cuenta con ese mail con otro método (mail/clave). Ingresá con tu método original.')
      } else if (code === 'auth/popup-blocked') {
        setError('Tu navegador bloqueó el popup de Google. Permitílo o vamos a redirigirte automáticamente.')
      } else {
        setError(`No se pudo iniciar con Google${code ? ` (${code})` : ''}. Reintentá o usá mail/clave.`)
        console.error('[LoginPage] Google sign-in error:', err)
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleForgotPassword() {
    setError('')
    setInfo('')
    if (!email || !email.includes('@')) {
      setError('Ingresá tu mail antes de pedir el reseteo de contraseña.')
      return
    }
    setLoading(true)
    try {
      await sendPasswordReset(email.trim())
      setInfo('Si el mail existe, te enviamos un enlace para restablecer la contraseña.')
    } catch (err) {
      // No revelar si el mail existe o no (anti-enumeración): mensaje genérico.
      setInfo('Si el mail existe, te enviamos un enlace para restablecer la contraseña.')
      if (import.meta.env.DEV) console.error(err)
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
          {loading ? <><Spinner size={14} inline /> Conectando con Google…</> : 'Continuar con Google'}
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
              minLength={8}
              autoComplete={registerMode ? 'new-password' : 'current-password'}
            />
          </label>

          <button className="btn" type="submit" disabled={loading}>
            {loading ? (
              <><Spinner size={14} inline /> {registerMode ? 'Creando cuenta…' : 'Verificando…'}</>
            ) : (
              registerMode ? 'Crear cuenta' : 'Ingresar'
            )}
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

        {!registerMode && (
          <button
            className="text-btn"
            type="button"
            onClick={handleForgotPassword}
            disabled={loading}
          >
            Olvidé mi contraseña
          </button>
        )}

        {error && <p className="error">{error}</p>}
        {info && <p className="muted">{info}</p>}
      </div>
    </div>
  )
}
