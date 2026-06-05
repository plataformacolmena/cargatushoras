import { useMemo, useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth'
import {
  completeUserProfile,
  DuplicateIdNumberError,
  isValidIdNumber,
  normalizeIdNumber,
  submitEmailRecoveryRequest,
} from '../services/firestore'
import { Spinner } from '../components/Spinner'

/**
 * Pantalla bloqueante que aparece tras login si al usuario le falta nombre o
 * Nro de Cédula/DNI. Aplica a SUPERUSER, PROJECT_ADMIN y MEMBER por igual.
 *
 * Si el DNI ingresado ya está reclamado por otro UID, se muestra el modal
 * "duplicado" con el botón "No recuerdo el mail" que crea una solicitud para
 * que un admin asista al usuario.
 */
export function CompleteProfilePage() {
  const { user, profile, signOutUser, reloadProfile } = useAuth()

  const [displayName, setDisplayName] = useState(profile?.displayName ?? '')
  const [idNumberRaw, setIdNumberRaw] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Modal de duplicado
  const [duplicateOpen, setDuplicateOpen] = useState(false)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [recoverySent, setRecoverySent] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)

  const idNumberNormalized = useMemo(() => normalizeIdNumber(idNumberRaw), [idNumberRaw])
  const idNumberOk = isValidIdNumber(idNumberNormalized)
  const formOk = displayName.trim().length >= 2 && idNumberOk

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!user || submitting) return
    if (!formOk) {
      setErrorMsg('Completá nombre completo y un Nro de Cédula/DNI válido (6-12 dígitos).')
      return
    }
    setErrorMsg(null)
    setSubmitting(true)
    try {
      await completeUserProfile(user.uid, {
        displayName: displayName.trim(),
        idNumber: idNumberNormalized,
      })
      // Refrescar el perfil → App.tsx ya verá los datos completos y mostrará el dashboard.
      await reloadProfile()
    } catch (err) {
      if (err instanceof DuplicateIdNumberError) {
        setDuplicateOpen(true)
      } else {
        const msg = err instanceof Error ? err.message : 'Error al guardar el perfil.'
        setErrorMsg(msg)
        console.error('[CompleteProfilePage] submit error:', err)
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRequestRecovery() {
    if (!user || recoveryBusy) return
    setRecoveryBusy(true)
    setRecoveryError(null)
    try {
      await submitEmailRecoveryRequest({
        requestingUid: user.uid,
        requestingEmail: user.email ?? null,
        requestingDisplayName: displayName.trim() || profile?.displayName || null,
        idNumber: idNumberNormalized,
      })
      setRecoverySent(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al enviar la solicitud.'
      setRecoveryError(msg)
      console.error('[CompleteProfilePage] recovery error:', err)
    } finally {
      setRecoveryBusy(false)
    }
  }

  return (
    <div className="screen pending-screen">
      <div className="pending-card" style={{ maxWidth: 480 }}>
        <p className="chip">Completar perfil</p>
        <h1>Falta un paso</h1>
        <p className="muted" style={{ marginBottom: '1rem' }}>
          Antes de continuar, necesitamos que completes tu nombre y Nro de Cédula/DNI.
          Estos datos son obligatorios para todos los usuarios.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Nombre completo</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Nombre y Apellido"
              autoFocus
              required
              minLength={2}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Nro de Cédula/DNI</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={idNumberRaw}
              onChange={(e) => setIdNumberRaw(e.target.value)}
              onBlur={() => setIdNumberRaw(normalizeIdNumber(idNumberRaw))}
              placeholder="Solo números (6 a 12 dígitos)"
              required
            />
            {idNumberRaw && !idNumberOk && (
              <span style={{ color: '#ef4444', fontSize: '0.78rem' }}>
                Debe tener entre 6 y 12 dígitos numéricos.
              </span>
            )}
          </label>

          {errorMsg && (
            <p className="error" style={{ margin: 0, fontSize: '0.85rem' }}>{errorMsg}</p>
          )}

          <div className="inline-actions" style={{ marginTop: '0.5rem' }}>
            <button className="btn" type="submit" disabled={!formOk || submitting}>
              {submitting ? <><Spinner size={14} inline /> Guardando…</> : 'Guardar y continuar'}
            </button>
            <button className="btn btn-outline" type="button" onClick={signOutUser} disabled={submitting}>
              Cerrar sesión
            </button>
          </div>
        </form>
      </div>

      {duplicateOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(e) => { if (e.target === e.currentTarget && !recoveryBusy) setDuplicateOpen(false) }}
        >
          <div className="modal" style={{ maxWidth: 460 }}>
            {!recoverySent ? (
              <>
                <h3>Cédula/DNI ya registrada</h3>
                <p style={{ fontSize: '0.95rem' }}>
                  Ya existe un usuario con ese Nro de Cédula/DNI.
                  Por favor logueate con el mail que indicaste anteriormente.
                </p>
                {recoveryError && (
                  <p className="error" style={{ fontSize: '0.85rem' }}>{recoveryError}</p>
                )}
                <div className="inline-actions" style={{ marginTop: '0.75rem', flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-outline"
                    type="button"
                    onClick={handleRequestRecovery}
                    disabled={recoveryBusy}
                  >
                    {recoveryBusy ? <><Spinner size={14} inline /> Enviando…</> : 'No recuerdo el mail'}
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setDuplicateOpen(false)}
                    disabled={recoveryBusy}
                  >
                    Volver
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>Solicitud enviada</h3>
                <p style={{ fontSize: '0.95rem' }}>
                  Le avisamos a un administrador. En cuanto resuelvan tu caso te contactarán.
                  Mientras tanto, podés cerrar sesión.
                </p>
                <div className="inline-actions" style={{ marginTop: '0.75rem' }}>
                  <button className="btn" type="button" onClick={signOutUser}>
                    Cerrar sesión
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
