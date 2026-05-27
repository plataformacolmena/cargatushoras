// ─── Soporte (tickets) ───────────────────────────────────────────────
// Modelo minimalista: el usuario envía un ticket (1 escritura) y los admins
// los listan bajo demanda (1 getDocs por click "Cargar"). NO hay listeners
// permanentes — reemplaza al SupportChatPanel para reducir lecturas.
//
// Estructura: /support_tickets/{projectId}/items/{ticketId}
import {
  addDoc,
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore'
import { db } from '../firebase'

export type SupportTicketStatus = 'open' | 'closed'

export type SupportTicket = {
  id: string
  projectId: string
  userId: string
  userEmail: string | null
  userName: string | null
  subject: string
  body: string
  status: SupportTicketStatus
  createdAt: Date | null
  closedAt: Date | null
  closedBy: string | null
}

function itemsCol(projectId: string) {
  return collection(db, 'support_tickets', projectId, 'items')
}

function toDate(ts: unknown): Date | null {
  if (ts instanceof Timestamp) return ts.toDate()
  return null
}

export async function createSupportTicket(input: {
  projectId: string
  userId: string
  userEmail: string | null
  userName: string | null
  subject: string
  body: string
}): Promise<string> {
  const subject = input.subject.trim().slice(0, 200)
  const body = input.body.trim().slice(0, 4000)
  if (!subject) throw new Error('El asunto es obligatorio')
  if (!body) throw new Error('El mensaje es obligatorio')
  const ref = await addDoc(itemsCol(input.projectId), {
    projectId: input.projectId,
    userId: input.userId,
    userEmail: input.userEmail ?? null,
    userName: input.userName ?? null,
    subject,
    body,
    status: 'open' as SupportTicketStatus,
    createdAt: serverTimestamp(),
    closedAt: null,
    closedBy: null,
  })
  return ref.id
}

export async function listSupportTickets(
  projectId: string,
  opts: { status?: SupportTicketStatus } = {},
): Promise<SupportTicket[]> {
  const filters = [orderBy('createdAt', 'desc')]
  const q = opts.status
    ? query(itemsCol(projectId), where('status', '==', opts.status), ...filters)
    : query(itemsCol(projectId), ...filters)
  const snap = await getDocs(q)
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>
    return {
      id: d.id,
      projectId: String(data.projectId ?? projectId),
      userId: String(data.userId ?? ''),
      userEmail: (data.userEmail as string | null) ?? null,
      userName: (data.userName as string | null) ?? null,
      subject: String(data.subject ?? ''),
      body: String(data.body ?? ''),
      status: (data.status as SupportTicketStatus) ?? 'open',
      createdAt: toDate(data.createdAt),
      closedAt: toDate(data.closedAt),
      closedBy: (data.closedBy as string | null) ?? null,
    }
  })
}

export async function closeSupportTicket(
  projectId: string,
  ticketId: string,
  closedByUid: string,
): Promise<void> {
  await updateDoc(doc(db, 'support_tickets', projectId, 'items', ticketId), {
    status: 'closed' as SupportTicketStatus,
    closedAt: serverTimestamp(),
    closedBy: closedByUid,
  })
}

export async function reopenSupportTicket(
  projectId: string,
  ticketId: string,
): Promise<void> {
  await updateDoc(doc(db, 'support_tickets', projectId, 'items', ticketId), {
    status: 'open' as SupportTicketStatus,
    closedAt: null,
    closedBy: null,
  })
}
