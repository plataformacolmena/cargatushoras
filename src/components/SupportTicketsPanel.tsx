import { useState, type FormEvent } from 'react'
import type { UserProfile } from '../types/domain'
import {
  closeSupportTicket,
  createSupportTicket,
  listSupportTickets,
  reopenSupportTicket,
  type SupportTicket,
} from '../services/support'
import { Spinner } from './Spinner'

type Props = {
  viewer: UserProfile
  projectId: string
  projectName: string
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void
}

function isAdmin(role: UserProfile['role']): boolean {
  return role === 'SUPERUSER' || role === 'PROJECT_ADMIN'
}

function formatDate(d: Date | null): string {
  if (!d) return '—'
  try {
    return d.toLocaleString('es-UY', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return d.toISOString()
  }
}

export function SupportTicketsPanel({ viewer, projectId, projectName, showToast }: Props) {
  const admin = isAdmin(viewer.role)
  // Form (todos los usuarios)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  // Admin: lista bajo demanda
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [filterStatus, setFilterStatus] = useState<'all' | 'open' | 'closed'>('open')
  const [busyId, setBusyId] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (sending) return
    if (!subject.trim() || !body.trim()) {
      showToast('Completá el asunto y el mensaje.', 'error')
      return
    }
    setSending(true)
    try {
      await createSupportTicket({
        projectId,
        userId: viewer.uid,
        userEmail: viewer.email ?? null,
        userName: viewer.displayName ?? viewer.email ?? null,
        subject,
        body,
      })
      setSubject('')
      setBody('')
      showToast('Consulta enviada. Te respondemos a la brevedad.', 'success')
    } catch (err) {
      console.error('[support] createTicket error:', err)
      showToast(`Error al enviar: ${err instanceof Error ? err.message : 'Desconocido'}`, 'error')
    } finally {
      setSending(false)
    }
  }

  async function loadTickets() {
    if (loading) return
    setLoading(true)
    try {
      const status = filterStatus === 'all' ? undefined : filterStatus
      const items = await listSupportTickets(projectId, { status })
      setTickets(items)
    } catch (err) {
      console.error('[support] listTickets error:', err)
      showToast(`Error al cargar tickets: ${err instanceof Error ? err.message : 'Desconocido'}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  async function onClose(id: string) {
    setBusyId(id)
    try {
      await closeSupportTicket(projectId, id, viewer.uid)
      setTickets((prev) => prev?.map((t) => t.id === id ? { ...t, status: 'closed', closedAt: new Date(), closedBy: viewer.uid } : t) ?? null)
      showToast('Ticket cerrado.', 'success')
    } catch (err) {
      showToast(`Error: ${err instanceof Error ? err.message : 'Desconocido'}`, 'error')
    } finally {
      setBusyId(null)
    }
  }

  async function onReopen(id: string) {
    setBusyId(id)
    try {
      await reopenSupportTicket(projectId, id)
      setTickets((prev) => prev?.map((t) => t.id === id ? { ...t, status: 'open', closedAt: null, closedBy: null } : t) ?? null)
      showToast('Ticket reabierto.', 'success')
    } catch (err) {
      showToast(`Error: ${err instanceof Error ? err.message : 'Desconocido'}`, 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <p className="muted" style={{ marginTop: 0 }}>
          Enviá tu consulta sobre <strong>{projectName}</strong> al equipo de soporte.
          {admin && ' Como administrador también podés revisar los tickets recibidos abajo.'}
        </p>
        <form onSubmit={onSubmit} className="stack" style={{ gap: 8 }}>
          <input
            type="text"
            placeholder="Asunto"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={200}
            disabled={sending}
          />
          <textarea
            placeholder="Contanos qué necesitás (máx 4000 caracteres)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={4000}
            rows={5}
            disabled={sending}
          />
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={sending || !subject.trim() || !body.trim()}>
              {sending ? <><Spinner size={14} inline /> Enviando…</> : 'Enviar consulta'}
            </button>
          </div>
        </form>
      </div>

      {admin && (
        <div>
          <hr />
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>Tickets recibidos</h3>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as 'all' | 'open' | 'closed')} disabled={loading}>
              <option value="open">Abiertos</option>
              <option value="closed">Cerrados</option>
              <option value="all">Todos</option>
            </select>
            <button className="btn btn-outline" onClick={() => { void loadTickets() }} disabled={loading}>
              {loading ? <><Spinner size={14} inline /> Cargando…</> : tickets === null ? 'Cargar tickets' : 'Refrescar'}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              No se cargan automáticamente para reducir lecturas a Firestore.
            </span>
          </div>

          {tickets === null ? (
            <p className="muted">Tocá <strong>Cargar tickets</strong> para ver las consultas.</p>
          ) : tickets.length === 0 ? (
            <p className="muted">No hay tickets con ese estado.</p>
          ) : (
            <div className="stack" style={{ gap: 8, marginTop: 8 }}>
              {tickets.map((t) => (
                <div key={t.id} className="entry-item">
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <strong>{t.subject}</strong>
                    <span className={`chip ${t.status === 'open' ? 'chip-warn' : ''}`}>
                      {t.status === 'open' ? 'Abierto' : 'Cerrado'}
                    </span>
                  </div>
                  <p className="muted" style={{ margin: '4px 0', fontSize: 12 }}>
                    {t.userName ?? t.userEmail ?? t.userId} · {formatDate(t.createdAt)}
                  </p>
                  <p style={{ whiteSpace: 'pre-wrap', margin: '6px 0' }}>{t.body}</p>
                  <div className="row" style={{ gap: 6 }}>
                    {t.userEmail && (
                      <a className="btn btn-outline" href={`mailto:${t.userEmail}?subject=Re: ${encodeURIComponent(t.subject)}`}>
                        Responder por email
                      </a>
                    )}
                    {t.status === 'open' ? (
                      <button className="btn btn-outline" onClick={() => { void onClose(t.id) }} disabled={busyId === t.id}>
                        {busyId === t.id ? 'Cerrando…' : 'Marcar cerrado'}
                      </button>
                    ) : (
                      <button className="btn btn-outline" onClick={() => { void onReopen(t.id) }} disabled={busyId === t.id}>
                        {busyId === t.id ? 'Reabriendo…' : 'Reabrir'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
