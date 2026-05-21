import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { ChatMessage, ChatScope, ChatThread, ProjectArea, UserProfile } from '../types/domain'
import {
  canDeleteThread,
  canManageThreadStatus,
  canPostInThread,
  closeChatThread,
  createChatThread,
  deleteChatThread,
  reopenChatThread,
  scopeLabel,
  sendChatMessage,
  subscribeToChatThreads,
  subscribeToThreadMessages,
} from '../services/chat'

interface Props {
  viewer: UserProfile
  projectId: string
  projectName: string
  areas: ProjectArea[]
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void
}

const BLOCKED_HINT =
  'No se pudieron cargar las conversaciones. Es posible que una extensión del navegador (bloqueador de anuncios o privacidad) esté bloqueando Firestore. Probá desactivarla para este sitio o usar una ventana de incógnito.'

function isLikelyBlockedError(err: unknown): boolean {
  if (!err) return false
  const e = err as { code?: string; message?: string; name?: string }
  const code = String(e.code ?? '').toLowerCase()
  const msg = String(e.message ?? '').toLowerCase()
  return (
    code === 'unavailable' ||
    code === 'failed-precondition' ||
    msg.includes('blocked_by_client') ||
    msg.includes('err_blocked') ||
    msg.includes('network error') ||
    msg.includes('webchannel') ||
    msg.includes('failed to fetch')
  )
}

export function SupportChatPanel({ viewer, projectId, projectName, areas, showToast }: Props) {
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newScope, setNewScope] = useState<ChatScope>('PRIVATE')
  const [newAreaId, setNewAreaId] = useState<string>(viewer.areaId ?? '')
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const messagesContainerRef = useRef<HTMLDivElement | null>(null)
  const threadsErrorShownRef = useRef(false)
  const messagesErrorShownRef = useRef(false)

  // Suscripción a hilos del proyecto
  useEffect(() => {
    if (!projectId) {
      setThreads([])
      return
    }
    threadsErrorShownRef.current = false
    const unsub = subscribeToChatThreads(
      projectId,
      viewer,
      setThreads,
      (err) => {
        console.error('[chat] subscribeToChatThreads error:', err)
        if (threadsErrorShownRef.current) return
        threadsErrorShownRef.current = true
        const msg = isLikelyBlockedError(err)
          ? BLOCKED_HINT
          : 'No se pudieron cargar las conversaciones.'
        showToast(msg, 'error')
      },
    )
    return unsub
  }, [projectId, viewer, showToast])

  // Suscripción a mensajes del hilo seleccionado
  useEffect(() => {
    if (!selectedThreadId) {
      setMessages([])
      return
    }
    messagesErrorShownRef.current = false
    const unsub = subscribeToThreadMessages(
      selectedThreadId,
      setMessages,
      (err) => {
        console.error('[chat] subscribeToThreadMessages error:', err)
        if (messagesErrorShownRef.current) return
        messagesErrorShownRef.current = true
        const msg = isLikelyBlockedError(err)
          ? 'No se pudieron cargar los mensajes. Es posible que una extensión del navegador esté bloqueando Firestore. Probá desactivarla para este sitio.'
          : 'No se pudieron cargar los mensajes.'
        showToast(msg, 'error')
      },
    )
    return unsub
  }, [selectedThreadId, showToast])

  // Auto scroll al final cuando llegan mensajes (solo dentro del contenedor,
  // sin afectar el scroll de la página).
  useEffect(() => {
    const c = messagesContainerRef.current
    if (c) {
      c.scrollTop = c.scrollHeight
    }
  }, [messages])

  const selectedThread = useMemo(
    () => threads.find((t) => t.id === selectedThreadId) ?? null,
    [threads, selectedThreadId],
  )

  async function handleCreateThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!newTitle.trim()) {
      showToast('Indicá un asunto para la conversación.', 'error')
      return
    }
    if (newScope === 'AREA' && !newAreaId) {
      showToast('Seleccioná un área.', 'error')
      return
    }
    try {
      const id = await createChatThread(
        {
          projectId,
          scope: newScope,
          title: newTitle.trim(),
          ...(newScope === 'AREA' ? { areaId: newAreaId } : {}),
        },
        viewer,
      )
      setShowNew(false)
      setNewTitle('')
      setSelectedThreadId(id)
      showToast('Conversación creada.')
    } catch (err) {
      console.error(err)
      const msg = isLikelyBlockedError(err)
        ? 'No se pudo crear la conversación. Es posible que una extensión del navegador esté bloqueando Firestore. Probá desactivarla para este sitio.'
        : 'No se pudo crear la conversación.'
      showToast(msg, 'error')
    }
  }

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedThread || !draft.trim()) return
    try {
      await sendChatMessage(selectedThread.id, draft, viewer)
      setDraft('')
    } catch (err) {
      console.error(err)
      const msg = isLikelyBlockedError(err)
        ? 'No se pudo enviar el mensaje. Es posible que una extensión del navegador esté bloqueando Firestore.'
        : 'No se pudo enviar el mensaje.'
      showToast(msg, 'error')
    }
  }

  async function handleDeleteThread() {
    if (!selectedThread) return
    if (!confirm(`¿Eliminar la conversación "${selectedThread.title}"? Se borrarán todos los mensajes.`)) return
    try {
      await deleteChatThread(selectedThread.id)
      setSelectedThreadId(null)
      showToast('Conversación eliminada.')
    } catch (err) {
      console.error(err)
      showToast('No se pudo eliminar.', 'error')
    }
  }

  async function handleToggleStatus() {
    if (!selectedThread) return
    const isClosed = selectedThread.status === 'CLOSED'
    try {
      if (isClosed) {
        await reopenChatThread(selectedThread.id)
        showToast('Conversación reabierta.')
      } else {
        await closeChatThread(selectedThread.id, viewer)
        showToast('Conversación marcada como respondida.')
      }
    } catch (err) {
      console.error(err)
      showToast('No se pudo actualizar el estado.', 'error')
    }
  }

  const isClosed = selectedThread?.status === 'CLOSED'
  const canPost = selectedThread ? canPostInThread(selectedThread, viewer) && !isClosed : false
  const canDelete = selectedThread ? canDeleteThread(selectedThread, viewer) : false
  const canManageStatus = selectedThread ? canManageThreadStatus(selectedThread, viewer) : false

  // MEMBER no puede iniciar AREA si no tiene area asignada
  const memberHasArea = !!viewer.areaId
  const isMember = viewer.role === 'MEMBER'

  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="chat-layout">
        {/* Sidebar: lista de hilos */}
        <aside className="chat-sidebar">
          <div className="chat-sidebar-header">
            <div>
              <p className="chip">Soporte</p>
              <h3 style={{ margin: '0.25rem 0 0' }}>Conversaciones</h3>
              <p className="muted" style={{ fontSize: '0.8rem', margin: '0.25rem 0 0' }}>{projectName}</p>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => setShowNew((s) => !s)}>
              {showNew ? 'Cancelar' : '+ Nueva'}
            </button>
          </div>

          {showNew && (
            <form className="stack chat-new-form" onSubmit={handleCreateThread}>
              <label>
                Asunto
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Ej: Consulta sobre cargas"
                  maxLength={120}
                  required
                />
              </label>
              <label>
                Privacidad
                <select value={newScope} onChange={(e) => setNewScope(e.target.value as ChatScope)}>
                  <option value="PRIVATE">Privada (yo + administradores)</option>
                  <option value="AREA" disabled={isMember && !memberHasArea}>
                    Área (mi área + administradores)
                  </option>
                  <option value="PUBLIC">Pública (todo el proyecto)</option>
                </select>
              </label>
              {newScope === 'AREA' && (
                <label>
                  Área
                  <select value={newAreaId} onChange={(e) => setNewAreaId(e.target.value)} required>
                    <option value="">Seleccioná...</option>
                    {areas
                      .filter((a) => (isMember ? a.id === viewer.areaId : true))
                      .map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                  </select>
                </label>
              )}
              <button type="submit" className="btn btn-primary">Crear conversación</button>
            </form>
          )}

          <div className="chat-thread-list">
            {threads.length === 0 ? (
              <p className="muted" style={{ padding: '1rem', textAlign: 'center', fontSize: '0.85rem' }}>
                No hay conversaciones aún.
              </p>
            ) : (
              threads.map((t) => (
                <button
                  key={t.id}
                  className={`chat-thread-item ${selectedThreadId === t.id ? 'active' : ''} ${t.status === 'CLOSED' ? 'closed' : ''}`}
                  onClick={() => setSelectedThreadId(t.id)}
                >
                  <div className="chat-thread-title">
                    {t.status === 'CLOSED' && <span className="chat-status-badge closed" title="Cerrada/Respondida">✓</span>}
                    {t.title}
                  </div>
                  <div className="chat-thread-meta">
                    <span className={`chat-scope-badge scope-${t.scope.toLowerCase()}`}>{scopeLabel(t.scope)}</span>
                    <span className="muted">{t.createdByName}</span>
                  </div>
                  {t.lastMessageText && (
                    <div className="chat-thread-preview muted">
                      <strong>{t.lastMessageBy}:</strong> {t.lastMessageText}
                    </div>
                  )}
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Panel principal: mensajes */}
        <div className="chat-main">
          {!selectedThread ? (
            <div className="chat-empty">
              <p className="muted">Seleccioná una conversación o creá una nueva.</p>
            </div>
          ) : (
            <>
              <div className="chat-main-header">
                <div>
                  <h3 style={{ margin: 0 }}>
                    {selectedThread.title}
                    {isClosed && <span className="chat-status-badge closed" style={{ marginLeft: 8 }}>✓ Respondida</span>}
                  </h3>
                  <p className="muted" style={{ margin: '0.25rem 0 0', fontSize: '0.85rem' }}>
                    <span className={`chat-scope-badge scope-${selectedThread.scope.toLowerCase()}`}>
                      {scopeLabel(selectedThread.scope)}
                    </span>
                    {' '}· Iniciada por {selectedThread.createdByName}
                    {isClosed && selectedThread.closedByName && (
                      <> · Cerrada por {selectedThread.closedByName}</>
                    )}
                  </p>
                </div>
                <div className="row" style={{ gap: '6px' }}>
                  {canManageStatus && (
                    <button
                      className={`btn btn-sm ${isClosed ? 'btn-outline' : 'btn-primary'}`}
                      onClick={handleToggleStatus}
                      title={isClosed ? 'Reabrir conversación' : 'Marcar como respondida/cerrada'}
                    >
                      {isClosed ? 'Reabrir' : 'Marcar respondida'}
                    </button>
                  )}
                  {canDelete && (
                    <button className="btn btn-outline btn-sm" onClick={handleDeleteThread}>
                      Eliminar
                    </button>
                  )}
                </div>
              </div>

              <div className="chat-messages" ref={messagesContainerRef}>
                {messages.length === 0 ? (
                  <p className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                    Aún no hay mensajes. Escribí el primero.
                  </p>
                ) : (
                  messages.map((m) => {
                    const mine = m.senderUid === viewer.uid
                    return (
                      <div key={m.id} className={`chat-message ${mine ? 'mine' : ''}`}>
                        <div className="chat-message-bubble">
                          {!mine && (
                            <div className="chat-message-sender">
                              {m.senderName}{' '}
                              {m.senderRole !== 'MEMBER' && (
                                <span className="chip-mini">{m.senderRole === 'SUPERUSER' ? 'Super' : 'Admin'}</span>
                              )}
                            </div>
                          )}
                          <div className="chat-message-text">{m.text}</div>
                        </div>
                      </div>
                    )
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {isClosed && (
                <div className="chat-closed-banner">
                  Esta conversación está cerrada. {canManageStatus ? 'Podés reabrirla con el botón superior.' : 'Solo un administrador puede reabrirla.'}
                </div>
              )}

              {canPost && (
                <form className="chat-composer" onSubmit={handleSend}>
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Escribí un mensaje..."
                    rows={2}
                    maxLength={4000}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        if (draft.trim()) {
                          void sendChatMessage(selectedThread.id, draft, viewer).then(() => setDraft(''))
                        }
                      }
                    }}
                  />
                  <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
                    Enviar
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
