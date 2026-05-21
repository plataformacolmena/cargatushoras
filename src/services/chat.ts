import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { db } from '../firebase'
import type {
  AppRole,
  ChatMessage,
  ChatScope,
  ChatThread,
  ChatThreadCreateInput,
  UserProfile,
} from '../types/domain'

const THREADS = 'chat_threads'
const MESSAGES = 'messages'

/** Crea un nuevo hilo de soporte. Devuelve el ID. */
export async function createChatThread(
  input: ChatThreadCreateInput,
  creator: UserProfile,
): Promise<string> {
  const title = input.title.trim() || '(sin asunto)'
  const base: Omit<ChatThread, 'id'> = {
    projectId: input.projectId,
    scope: input.scope,
    title,
    status: 'OPEN',
    createdBy: creator.uid,
    createdByName: creator.displayName ?? creator.email ?? creator.uid,
    createdByRole: creator.role,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  if (input.scope === 'AREA' && input.areaId) {
    ;(base as ChatThread).areaId = input.areaId
  }
  const ref = await addDoc(collection(db, THREADS), base)
  return ref.id
}

/** Suscribe a los hilos del proyecto visibles para el usuario actual.
 *  Para evitar errores de permisos cuando un MEMBER recibiría docs que las reglas
 *  deniegan (PRIVATE de otros, AREA de otra área), filtramos a nivel de query
 *  pidiendo sólo lo permitido. Admins/superusers ven todo el proyecto.
 */
export function subscribeToChatThreads(
  projectId: string,
  viewer: UserProfile,
  callback: (threads: ChatThread[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const isAdmin = viewer.role === 'SUPERUSER' || viewer.role === 'PROJECT_ADMIN'

  function emit(all: ChatThread[]) {
    // dedup por id (por si los streams del miembro traen overlap)
    const map = new Map<string, ChatThread>()
    for (const t of all) {
      if (canViewThread(t, viewer)) map.set(t.id, t)
    }
    const visible = Array.from(map.values())
    visible.sort((a, b) => {
      const aT = toMillis(a.lastMessageAt ?? a.createdAt)
      const bT = toMillis(b.lastMessageAt ?? b.createdAt)
      return bT - aT
    })
    callback(visible)
  }

  if (isAdmin) {
    const q = query(
      collection(db, THREADS),
      where('projectId', '==', projectId),
    )
    return onSnapshot(
      q,
      (snap) => emit(snap.docs.map((d) => ({ ...(d.data() as ChatThread), id: d.id }))),
      onError,
    )
  }

  // MEMBER: tres streams (PUBLIC, AREA propia, PRIVATE propios). Combinamos.
  const buckets: Record<string, ChatThread[]> = { pub: [], area: [], priv: [] }
  const unsubs: Array<() => void> = []
  let errored = false
  const safeError = (err: Error) => {
    if (errored) return
    errored = true
    onError?.(err)
  }
  const flush = () => emit([...buckets.pub, ...buckets.area, ...buckets.priv])

  // PUBLIC
  unsubs.push(
    onSnapshot(
      query(
        collection(db, THREADS),
        where('projectId', '==', projectId),
        where('scope', '==', 'PUBLIC'),
      ),
      (snap) => {
        buckets.pub = snap.docs.map((d) => ({ ...(d.data() as ChatThread), id: d.id }))
        flush()
      },
      safeError,
    ),
  )

  // AREA (solo si el miembro tiene área)
  if (viewer.areaId) {
    unsubs.push(
      onSnapshot(
        query(
          collection(db, THREADS),
          where('projectId', '==', projectId),
          where('scope', '==', 'AREA'),
          where('areaId', '==', viewer.areaId),
        ),
        (snap) => {
          buckets.area = snap.docs.map((d) => ({ ...(d.data() as ChatThread), id: d.id }))
          flush()
        },
        safeError,
      ),
    )
  }

  // PRIVATE propios
  unsubs.push(
    onSnapshot(
      query(
        collection(db, THREADS),
        where('projectId', '==', projectId),
        where('scope', '==', 'PRIVATE'),
        where('createdBy', '==', viewer.uid),
      ),
      (snap) => {
        buckets.priv = snap.docs.map((d) => ({ ...(d.data() as ChatThread), id: d.id }))
        flush()
      },
      safeError,
    ),
  )

  return () => {
    for (const u of unsubs) {
      try { u() } catch { /* noop */ }
    }
  }
}

function toMillis(v: unknown): number {
  if (!v) return 0
  if (typeof v === 'object' && v !== null && 'toMillis' in v) {
    try {
      return (v as { toMillis: () => number }).toMillis()
    } catch {
      return 0
    }
  }
  return 0
}

/** Reglas de visibilidad (espejo de las reglas Firestore, evaluadas en cliente). */
export function canViewThread(thread: ChatThread, viewer: UserProfile): boolean {
  if (viewer.role === 'SUPERUSER') return true
  if (viewer.projectId !== thread.projectId) return false
  if (viewer.role === 'PROJECT_ADMIN') return true
  // MEMBER
  if (thread.scope === 'PUBLIC') return true
  if (thread.scope === 'AREA') {
    return !!viewer.areaId && viewer.areaId === thread.areaId
  }
  // PRIVATE: solo el creador
  return thread.createdBy === viewer.uid
}

/** ¿Puede el usuario escribir en este hilo? */
export function canPostInThread(thread: ChatThread, viewer: UserProfile): boolean {
  return canViewThread(thread, viewer)
}

/** ¿Puede el usuario borrar el hilo? */
export function canDeleteThread(thread: ChatThread, viewer: UserProfile): boolean {
  if (viewer.role === 'SUPERUSER') return true
  if (viewer.role === 'PROJECT_ADMIN' && viewer.projectId === thread.projectId) return true
  return thread.createdBy === viewer.uid
}

/** ¿Puede el usuario cerrar/reabrir el hilo? (Marcar como respondida) */
export function canManageThreadStatus(thread: ChatThread, viewer: UserProfile): boolean {
  if (viewer.role === 'SUPERUSER') return true
  if (viewer.role === 'PROJECT_ADMIN' && viewer.projectId === thread.projectId) return true
  return false
}

/** Marca la conversación como cerrada/respondida. */
export async function closeChatThread(threadId: string, closer: UserProfile): Promise<void> {
  const closerName = closer.displayName ?? closer.email ?? closer.uid
  await updateDoc(doc(db, THREADS, threadId), {
    status: 'CLOSED',
    closedAt: serverTimestamp(),
    closedBy: closer.uid,
    closedByName: closerName,
    updatedAt: serverTimestamp(),
  })
}

/** Reabre una conversación previamente cerrada. */
export async function reopenChatThread(threadId: string): Promise<void> {
  await updateDoc(doc(db, THREADS, threadId), {
    status: 'OPEN',
    closedAt: null,
    closedBy: null,
    closedByName: null,
    updatedAt: serverTimestamp(),
  })
}

/** Suscribe a los mensajes de un hilo, ordenados ascendentemente. */
export function subscribeToThreadMessages(
  threadId: string,
  callback: (messages: ChatMessage[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(
    collection(db, THREADS, threadId, MESSAGES),
    orderBy('createdAt', 'asc'),
    limit(500),
  )
  return onSnapshot(
    q,
    (snap) => {
      const items = snap.docs.map((d) => ({ ...(d.data() as ChatMessage), id: d.id, threadId }))
      callback(items)
    },
    onError,
  )
}

/** Envía un mensaje al hilo y actualiza el resumen del hilo. */
export async function sendChatMessage(
  threadId: string,
  text: string,
  sender: UserProfile,
): Promise<void> {
  const clean = text.trim()
  if (!clean) return
  const senderName = sender.displayName ?? sender.email ?? sender.uid
  const senderRole: AppRole = sender.role

  await addDoc(collection(db, THREADS, threadId, MESSAGES), {
    text: clean,
    senderUid: sender.uid,
    senderName,
    senderRole,
    createdAt: serverTimestamp(),
  })

  await updateDoc(doc(db, THREADS, threadId), {
    lastMessageAt: serverTimestamp(),
    lastMessageText: clean.length > 140 ? clean.slice(0, 140) + '…' : clean,
    lastMessageBy: senderName,
    updatedAt: serverTimestamp(),
  })
}

/** Elimina un hilo y todos sus mensajes (en lotes). */
export async function deleteChatThread(threadId: string): Promise<void> {
  // Borrar mensajes
  const msgsSnap = await getDocs(collection(db, THREADS, threadId, MESSAGES))
  const CHUNK = 400
  for (let i = 0; i < msgsSnap.docs.length; i += CHUNK) {
    const b = writeBatch(db)
    for (const m of msgsSnap.docs.slice(i, i + CHUNK)) {
      b.delete(m.ref)
    }
    await b.commit()
  }
  await deleteDoc(doc(db, THREADS, threadId))
}

export function scopeLabel(scope: ChatScope): string {
  if (scope === 'PRIVATE') return 'Privada'
  if (scope === 'AREA') return 'Área'
  return 'Pública'
}
