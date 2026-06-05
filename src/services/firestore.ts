// ─── Recordatorios de jornada ─────────────────────────────────────────────
export interface Reminder {
  projectId: string
  userId: string
  workDate: string // YYYY-MM-DD
  createdBy: string // uid del admin que lo envió
  createdAt: any
}

/** Crea un recordatorio para un usuario y fecha. */
export async function createReminder(projectId: string, userId: string, workDate: string, createdBy: string) {
  const id = `${userId}_${workDate}`
  const ref = doc(collection(db, 'reminders', projectId, 'items'), id)
  await setDoc(ref, {
    projectId,
    userId,
    workDate,
    createdBy,
    createdAt: serverTimestamp(),
  })
}

/** Elimina el recordatorio (cuando el usuario informa la jornada). */
export async function deleteReminder(projectId: string, userId: string, workDate: string) {
  const id = `${userId}_${workDate}`
  const ref = doc(collection(db, 'reminders', projectId, 'items'), id)
  await deleteDoc(ref)
}

/** Obtiene todos los recordatorios pendientes para un usuario. */
export async function listRemindersForUser(projectId: string, userId: string): Promise<Reminder[]> {
  const q = query(collection(db, 'reminders', projectId, 'items'), where('userId', '==', userId))
  const snap = await getDocs(q)
  return snap.docs.map((d) => d.data() as Reminder)
}

/** Obtiene todos los recordatorios pendientes del proyecto en una sola consulta.
 *  Pensado para que el admin compute el estado "Recordado" de muchos usuarios
 *  con UNA sola lectura en lugar de N (una por usuario). */
export async function listRemindersForProject(projectId: string): Promise<Reminder[]> {
  const snap = await getDocs(collection(db, 'reminders', projectId, 'items'))
  return snap.docs.map((d) => d.data() as Reminder)
}

import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { getDownloadURL, ref as storageRef, uploadBytes } from 'firebase/storage'
import { db, storage } from '../firebase'
import { calcEngancheExtras, calculateEntry, calculateSettlement, getDefaultProjectConfig } from '../lib/calc'
import type {
  AppRole,
  AuditLock,
  CycleMode,
  EmailRecoveryRequest,
  EmailRecoveryStatus,
  Project,
  ProjectArea,
  ProjectConfig,
  ProjectCreateInput,
  ProjectRole,
  ProjectRoleInput,
  ProjectTemplate,
  ProjectUpdateInput,
  Settlement,
  SystemLog,
  TimeEntry,
  TimeEntryInput,
  UserProfile,
  WorkCycle,
} from '../types/domain'

const CALCULATION_VERSION = 'v1-client'

// ─── Utilidad: elimina campos undefined (Firestore los rechaza) ──────────────
function stripUndefined<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map(stripUndefined) as unknown as T
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as object)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, stripUndefined(v)]),
    ) as T
  }
  return obj
}

// ─── Debounce de recalculateUserEntries ───────────────────────────────────
// Agrupa ediciones consecutivas del mismo usuario en un único recálculo,
// reduciendo lecturas/escrituras a Firestore cuando el usuario edita varias
// jornadas seguidas.
const RECALC_DEBOUNCE_MS = 7000
const pendingRecalcs = new Map<string, { projectId: string; userId: string; timer: ReturnType<typeof setTimeout> }>()

function recalcKey(projectId: string, userId: string): string {
  return `${projectId}::${userId}`
}

/** Programa un recálculo del usuario; reintenta agrupar llamadas en una ventana corta. */
export function scheduleRecalculateUserEntries(projectId: string, userId: string): void {
  const key = recalcKey(projectId, userId)
  const existing = pendingRecalcs.get(key)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => {
    pendingRecalcs.delete(key)
    void recalculateUserEntries(projectId, userId).catch((err) => {
      if (import.meta.env.DEV) console.warn('[recalc][debounced] failed:', err)
    })
  }, RECALC_DEBOUNCE_MS)
  pendingRecalcs.set(key, { projectId, userId, timer })
}

/** Ejecuta de inmediato todos los recálculos pendientes (e.g. antes de cerrar pestaña). */
export async function flushPendingRecalculations(): Promise<void> {
  const tasks: Array<Promise<void>> = []
  for (const [key, info] of pendingRecalcs.entries()) {
    clearTimeout(info.timer)
    pendingRecalcs.delete(key)
    tasks.push(
      recalculateUserEntries(info.projectId, info.userId).catch((err) => {
        if (import.meta.env.DEV) console.warn('[recalc][flush] failed:', err)
      }),
    )
  }
  await Promise.all(tasks)
}

// ─── Cache en memoria para user_work_cycles ───────────────────────────────
const WORK_CYCLES_TTL_MS = 5 * 60 * 1000
interface WorkCyclesCacheEntry { data: WorkCycle[]; ts: number }
const workCyclesCacheByProject = new Map<string, WorkCyclesCacheEntry>()

function invalidateWorkCyclesCache(projectId?: string): void {
  if (projectId) {
    workCyclesCacheByProject.delete(projectId)
  } else {
    workCyclesCacheByProject.clear()
  }
}


// ---------- Validadores defensivos (defensa en profundidad) ----------
// Las reglas de Firestore son la fuente de verdad de seguridad, pero
// validar también en cliente evita escrituras inválidas y reduce
// errores ruidosos en la UI.

const VALID_REVIEW_COLORS = new Set(['', 'green', 'yellow', 'red', 'orange', 'blue'])
const VALID_APP_ROLES: ReadonlySet<AppRole> = new Set<AppRole>([
  'SUPERUSER',
  'PROJECT_ADMIN',
  'MEMBER',
])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}$/

function assertReviewColor(color: string): void {
  if (!VALID_REVIEW_COLORS.has(color)) {
    throw new Error(`Color de revisión inválido: "${color}"`)
  }
}

function assertAppRole(role: string): asserts role is AppRole {
  if (!VALID_APP_ROLES.has(role as AppRole)) {
    throw new Error(`Rol inválido: "${role}"`)
  }
}

function assertTimeEntryInput(input: TimeEntryInput): void {
  if (!DATE_RE.test(input.workDate)) {
    throw new Error(`Fecha de jornada inválida: "${input.workDate}" (formato esperado YYYY-MM-DD)`)
  }
  if (!TIME_RE.test(input.timeIn) || !TIME_RE.test(input.timeOut)) {
    throw new Error('Hora inválida (formato esperado HH:MM)')
  }
  const penalties = input.penalties
  if (penalties != null) {
    if (!Number.isInteger(penalties) || penalties < 0 || penalties > 10) {
      throw new Error('Penalizaciones inválidas (entero entre 0 y 10)')
    }
  }
  if (!input.projectId || typeof input.projectId !== 'string') {
    throw new Error('Proyecto inválido')
  }
}

export async function upsertUserProfile(payload: {
  uid: string
  email: string | null
  displayName: string | null
}): Promise<UserProfile> {
  const userRef = doc(db, 'users', payload.uid)

  let snapshot: Awaited<ReturnType<typeof getDoc>>
  try {
    snapshot = await getDoc(userRef)
  } catch (e) {
    if (import.meta.env.DEV) console.error('[upsert] getDoc(userRef) failed:', e)
    throw e
  }

  const emailLower = payload.email ? payload.email.toLowerCase().trim() : null

  // Helper: reasignar time_entries de un uid placeholder al uid real.
  // Best-effort: si una sub-batch falla (permisos, red), loguea y continúa.
  // La reconciliación admin posterior limpia lo que quede.
  async function reassignEntriesBestEffort(fromUid: string, toUid: string): Promise<void> {
    let entriesSnap
    try {
      entriesSnap = await getDocs(
        query(collection(db, 'time_entries'), where('userId', '==', fromUid)),
      )
    } catch (e) {
      if (import.meta.env.DEV) console.warn('[migration] reassign getDocs skipped:', e)
      return
    }
    const CHUNK = 440
    for (let i = 0; i < entriesSnap.docs.length; i += CHUNK) {
      const b = writeBatch(db)
      for (const e of entriesSnap.docs.slice(i, i + CHUNK)) {
        b.update(e.ref, { userId: toUid })
      }
      try {
        await b.commit()
      } catch (e) {
        if (import.meta.env.DEV) console.warn('[migration] reassign batch skipped:', e)
        // continuar con el siguiente chunk; no abortar
      }
    }
  }

  // Helper: busca un placeholder no fusionado con el email indicado.
  async function findUnmergedPlaceholderByEmail(email: string) {
    const q = query(
      collection(db, 'users'),
      where('email', '==', email),
      where('isPlaceholder', '==', true),
    )
    let snap
    try {
      snap = await getDocs(q)
    } catch (e) {
      if (import.meta.env.DEV) console.warn('[upsert] placeholder query failed:', e)
      return null
    }
    return snap.docs.find((d) => !(d.data() as UserProfile).mergedToUid) ?? null
  }

  // ─── CASO 1: el doc real NO existe (primer login) ───────────────────────
  if (!snapshot.exists()) {
    if (emailLower) {
      const placeholderDoc = await findUnmergedPlaceholderByEmail(emailLower)

      if (placeholderDoc) {
        const placeholderData = placeholderDoc.data() as UserProfile
        const placeholderUid = placeholderDoc.id

        const newProfile: UserProfile = {
          uid: payload.uid,
          email: emailLower,
          displayName: payload.displayName ?? placeholderData.displayName ?? null,
          role: placeholderData.role ?? 'MEMBER',
          approvalStatus: placeholderData.approvalStatus ?? 'PENDING',
          ...(placeholderData.projectId ? { projectId: placeholderData.projectId } : {}),
          ...(placeholderData.areaId ? { areaId: placeholderData.areaId } : {}),
          ...(placeholderData.roleId ? { roleId: placeholderData.roleId } : {}),
          ...(placeholderData.cycleMode ? { cycleMode: placeholderData.cycleMode } : {}),
          migratedFromUid: placeholderUid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }

        // Paso 1+3 ATÓMICO: crear doc real + marcar placeholder fusionado en un solo batch.
        // Si falla, no se escribe nada (rollback automático de Firestore).
        const fuseBatch = writeBatch(db)
        fuseBatch.set(userRef, newProfile)
        fuseBatch.update(placeholderDoc.ref, {
          isPlaceholder: false,
          mergedToUid: payload.uid,
          updatedAt: serverTimestamp(),
        })
        try {
          await fuseBatch.commit()
        } catch (e) {
          if (import.meta.env.DEV) console.error('[migration] fuseBatch failed, fallback a setDoc:', e)
          // Si el batch falla (p.ej. reglas), al menos crear el doc real para no dejar al usuario sin acceso
          await setDoc(userRef, newProfile)
        }

        // Paso 2 (best effort): reasignar time_entries al uid real.
        // Si el placeholder estaba APPROVED, el usuario ya es approved y puede reasignar.
        await reassignEntriesBestEffort(placeholderUid, payload.uid)

        return newProfile
      }
    }

    // Usuario nuevo sin pre-registro
    const initial: UserProfile = {
      uid: payload.uid,
      email: payload.email,
      displayName: payload.displayName,
      role: 'MEMBER',
      approvalStatus: 'PENDING',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }
    await setDoc(userRef, initial)
    return initial
  }

  // ─── CASO 2: el doc real YA existe ──────────────────────────────────────
  const data = snapshot.data() as UserProfile
  const updateData: Record<string, unknown> = { email: payload.email, updatedAt: serverTimestamp() }
  if (payload.displayName != null) updateData.displayName = payload.displayName

  // RECONCILIACIÓN PASIVA: si quedó un placeholder huérfano con mi email
  // (caso típico: admin aprobó/configuró el placeholder DESPUÉS de mi primer
  // login), propagar sus campos al doc real y marcar placeholder fusionado.
  let orphan: Awaited<ReturnType<typeof findUnmergedPlaceholderByEmail>> = null
  if (emailLower) {
    orphan = await findUnmergedPlaceholderByEmail(emailLower)
  }

  if (orphan) {
    const orphanData = orphan.data() as UserProfile
    const orphanUid = orphan.id

    // Propagar SOLO campos que el doc real no tiene (no sobrescribir nada existente)
    if (orphanData.projectId && !data.projectId) updateData.projectId = orphanData.projectId
    if (orphanData.areaId && !data.areaId) updateData.areaId = orphanData.areaId
    if (orphanData.roleId && !data.roleId) updateData.roleId = orphanData.roleId
    if (orphanData.cycleMode && !data.cycleMode) updateData.cycleMode = orphanData.cycleMode
    // Rol: si el placeholder tenía un rol elevado, propagarlo
    if (
      orphanData.role &&
      orphanData.role !== 'MEMBER' &&
      data.role === 'MEMBER'
    ) {
      updateData.role = orphanData.role
    }
    // approvalStatus: si el placeholder está APPROVED y el doc real PENDING, propagar
    if (orphanData.approvalStatus === 'APPROVED' && data.approvalStatus !== 'APPROVED') {
      updateData.approvalStatus = 'APPROVED'
    }
    if (!data.migratedFromUid) updateData.migratedFromUid = orphanUid

    // Batch atómico: actualizar doc real + marcar placeholder fusionado.
    const reconcileBatch = writeBatch(db)
    reconcileBatch.update(userRef, updateData)
    reconcileBatch.update(orphan.ref, {
      isPlaceholder: false,
      mergedToUid: payload.uid,
      updatedAt: serverTimestamp(),
    })
    try {
      await reconcileBatch.commit()
    } catch (e) {
      if (import.meta.env.DEV) console.warn('[upsert] reconcile batch failed, fallback a updateDoc:', e)
      try {
        await updateDoc(userRef, updateData)
      } catch (e2) {
        if (import.meta.env.DEV) console.error('[upsert] updateDoc fallback failed:', e2)
        throw e2
      }
    }

    // Reasignar entries del placeholder al uid real
    await reassignEntriesBestEffort(orphanUid, payload.uid)

    return { ...data, ...updateData } as UserProfile
  }

  // Sin placeholder huérfano: actualizar normal (email/displayName)
  try {
    await updateDoc(userRef, updateData)
  } catch (e) {
    if (import.meta.env.DEV) console.error('[upsert] updateDoc(existing) failed:', e)
    throw e
  }
  return { ...data, email: payload.email, displayName: payload.displayName ?? data.displayName }
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const userRef = doc(db, 'users', uid)
  const snapshot = await getDoc(userRef)
  if (!snapshot.exists()) {
    return null
  }

  return snapshot.data() as UserProfile
}

export async function listProjects(): Promise<Project[]> {
  const q = query(collection(db, 'projects'), where('active', '==', true), orderBy('name'))
  const snapshot = await getDocs(q)

  if (snapshot.empty) return []

  return snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Project, 'id'>) }))
}

export async function getProject(projectId: string): Promise<Project | null> {
  const projectRef = doc(db, 'projects', projectId)
  const snapshot = await getDoc(projectRef)
  if (!snapshot.exists()) {
    return null
  }

  return { id: snapshot.id, ...(snapshot.data() as Omit<Project, 'id'>) }
}

export async function createProject(input: ProjectCreateInput): Promise<Project> {
  const newProject = {
    ...input,
    active: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  const docRef = await addDoc(collection(db, 'projects'), newProject)
  return {
    id: docRef.id,
    ...input,
    active: true,
  }
}

export async function updateProject(projectId: string, updates: ProjectUpdateInput): Promise<void> {
  const projectRef = doc(db, 'projects', projectId)
  await updateDoc(projectRef, {
    ...updates,
    updatedAt: serverTimestamp(),
  })
}

export async function deleteProject(projectId: string): Promise<void> {
  const projectRef = doc(db, 'projects', projectId)
  await updateDoc(projectRef, {
    active: false,
    updatedAt: serverTimestamp(),
  })
}

export async function listAllProjects(): Promise<Project[]> {
  const q = query(collection(db, 'projects'), orderBy('name'))
  const snapshot = await getDocs(q)
  return snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Project, 'id'>) }))
}

export async function getProjectConfig(projectId: string): Promise<ProjectConfig> {
  const configRef = doc(db, 'project_configs', projectId)
  const snapshot = await getDoc(configRef)

  if (!snapshot.exists()) {
    const defaultConfig = getDefaultProjectConfig(projectId)
    await setDoc(configRef, {
      ...defaultConfig,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })

    return defaultConfig
  }

  return { ...getDefaultProjectConfig(projectId), ...snapshot.data() as ProjectConfig }
}

export async function setEntryReviewColor(entryId: string, color: string): Promise<void> {
  assertReviewColor(color)
  await updateDoc(doc(db, 'time_entries', entryId), { reviewColor: color })
}

export async function saveProjectConfig(
  projectId: string,
  updates: Omit<ProjectConfig, 'projectId'>,
): Promise<void> {
  const configRef = doc(db, 'project_configs', projectId)
  await setDoc(
    configRef,
    {
      ...updates,
      projectId,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
}

export async function saveTimeEntry(
  input: TimeEntryInput,
  user: Pick<UserProfile, 'uid' | 'displayName' | 'email'> & { areaId?: string | null },
): Promise<void> {
  assertTimeEntryInput(input)
  const config = await getProjectConfig(input.projectId)
  const calculation = calculateEntry(input.timeIn, input.timeOut, config, {
    penalties: input.penalties,
    isJornadaAdicional: input.isJornadaAdicional,
  })

  await addDoc(collection(db, 'time_entries'), {
    ...input,
    userId: user.uid,
    userName: user.displayName || 'Sin nombre',
    userEmail: user.email ?? null,
    areaId: user.areaId ?? null,
    calculation,
    calculationSource: 'client',
    calculationVersion: CALCULATION_VERSION,
    lockedByAdmin: false,
    lockedByAudit: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  void writeSystemLog({
    type: 'entry_create',
    userId: user.uid,
    userName: user.displayName || 'Sin nombre',
    email: (user as { email?: string | null }).email ?? null,
    projectId: input.projectId,
    workDate: input.workDate,
    details: `${input.timeIn}→${input.timeOut}`,
  })
  // Recalcular enganche/reenganche (debounced para agrupar ediciones consecutivas)
  scheduleRecalculateUserEntries(input.projectId, user.uid)
}

export async function saveTimeEntryForUser(
  input: TimeEntryInput,
  targetUser: Pick<UserProfile, 'uid' | 'displayName' | 'areaId' | 'email'>,
  actorEmail?: string | null,
): Promise<void> {
  assertTimeEntryInput(input)
  const config = await getProjectConfig(input.projectId)
  const calculation = calculateEntry(input.timeIn, input.timeOut, config, {
    penalties: input.penalties,
    isJornadaAdicional: input.isJornadaAdicional,
  })

  await addDoc(collection(db, 'time_entries'), {
    ...input,
    userId: targetUser.uid,
    userName: targetUser.displayName || 'Sin nombre',
    userEmail: targetUser.email ?? null,
    areaId: targetUser.areaId ?? null,
    calculation,
    calculationSource: 'client',
    calculationVersion: CALCULATION_VERSION,
    lockedByAdmin: false,
    lockedByAudit: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  void writeSystemLog({
    type: 'entry_create',
    userId: targetUser.uid,
    userName: targetUser.displayName || 'Sin nombre',
    email: actorEmail ?? null,
    projectId: input.projectId,
    workDate: input.workDate,
    details: `${input.timeIn}→${input.timeOut} (cargado por admin)`,
  })
  scheduleRecalculateUserEntries(input.projectId, targetUser.uid)
}

export async function listMyTimeEntries(
  userId: string,
  projectId: string,
  opts?: { since?: string },
): Promise<TimeEntry[]> {
  const conditions = [
    where('userId', '==', userId),
    where('projectId', '==', projectId),
  ]
  if (opts?.since) conditions.push(where('workDate', '>=', opts.since))
  const q = query(collection(db, 'time_entries'), ...conditions, orderBy('workDate', 'desc'))
  const snapshot = await getDocs(q)
  return snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<TimeEntry, 'id'>) }))
}

export async function listPendingUsers(): Promise<UserProfile[]> {
  const q = query(collection(db, 'users'), where('approvalStatus', '==', 'PENDING'))
  const snapshot = await getDocs(q)
  return snapshot.docs.map((d) => d.data() as UserProfile)
}

export async function listProjectUsers(projectId: string): Promise<UserProfile[]> {
  const q = query(
    collection(db, 'users'),
    where('approvalStatus', '==', 'APPROVED'),
    where('projectId', '==', projectId),
  )
  const snapshot = await getDocs(q)
  const users = snapshot.docs
    .map((d) => d.data() as UserProfile)
    .filter((u) => !u.mergedToUid) // excluir placeholders ya fusionados
  return users.sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''))
}

/**
 * Error específico para conflicto de email duplicado al aprobar/promover un usuario.
 * La UI puede detectarlo (`err instanceof EmailConflictError`) y mostrar mensaje accionable.
 */
export class EmailConflictError extends Error {
  readonly email: string
  readonly conflictingUids: string[]
  constructor(email: string, conflictingUids: string[]) {
    super(
      `Ya existe otro usuario activo con el email "${email}" (uid${conflictingUids.length > 1 ? 's' : ''}: ${conflictingUids.join(', ')}). ` +
        `Ejecutá "Reconciliar duplicados" antes de aprobar.`,
    )
    this.name = 'EmailConflictError'
    this.email = email
    this.conflictingUids = conflictingUids
  }
}

/**
 * Busca docs /users activos (no fusionados) con el mismo email, excluyendo opcionalmente un uid.
 * Devuelve la lista de uids en conflicto. Email se normaliza a minúsculas + trim.
 */
export async function findActiveUsersByEmail(
  email: string,
  excludeUid?: string,
): Promise<string[]> {
  const normalized = email.toLowerCase().trim()
  if (!normalized) return []
  const q = query(collection(db, 'users'), where('email', '==', normalized))
  const snap = await getDocs(q)
  const conflicts: string[] = []
  for (const d of snap.docs) {
    if (d.id === excludeUid) continue
    const data = d.data() as UserProfile
    // Filtrar fusionados o placeholders ya migrados
    if (data.mergedToUid) continue
    conflicts.push(d.id)
  }
  return conflicts
}

export async function approveUser(
  userId: string,
  role: AppRole = 'MEMBER',
  projectId?: string,
  areaId?: string,
  roleId?: string,
): Promise<void> {
  const userRef = doc(db, 'users', userId)
  // Plan C: verificar unicidad de email antes de aprobar
  const snap = await getDoc(userRef)
  if (snap.exists()) {
    const data = snap.data() as UserProfile
    if (data.email) {
      const conflicts = await findActiveUsersByEmail(data.email, userId)
      if (conflicts.length > 0) throw new EmailConflictError(data.email, conflicts)
    }
  }
  const updates: Record<string, unknown> = {
    approvalStatus: 'APPROVED',
    role,
    updatedAt: serverTimestamp(),
  }
  if (projectId) updates.projectId = projectId
  if (areaId) updates.areaId = areaId
  if (roleId) updates.roleId = roleId
  await updateDoc(userRef, updates)
}

export async function setUserRole(userId: string, role: AppRole): Promise<void> {
  assertAppRole(role)
  const userRef = doc(db, 'users', userId)
  await updateDoc(userRef, { role, updatedAt: serverTimestamp() })
}

/**
 * Devuelve cuántas jornadas (time_entries) tiene un usuario en total.
 * Usado para decidir si un usuario aprobado puede ser eliminado o solo inhabilitado.
 * Usa getCountFromServer para evitar leer todos los documentos (1 lectura facturada).
 */
export async function countUserTimeEntries(userId: string): Promise<number> {
  const q = query(collection(db, 'time_entries'), where('userId', '==', userId))
  const snap = await getCountFromServer(q)
  return snap.data().count
}

/**
 * Elimina el documento /users/{uid} en Firestore. NO borra la cuenta de Firebase
 * Auth (eso requiere Admin SDK). El usuario perderá acceso automáticamente porque
 * en su próximo onAuthStateChanged el perfil no se encontrará.
 * Esta función solo debe invocarse cuando el usuario NO tiene time_entries.
 */
export async function deleteUserProfile(userId: string): Promise<void> {
  await deleteDoc(doc(db, 'users', userId))
}

/**
 * Plan D: Encuentra todos los uids "relacionados" a un usuario:
 *  - El uid en sí.
 *  - Su `migratedFromUid` (placeholder original del primer login).
 *  - Cualquier doc en /users con `mergedToUid == uid` (placeholders fusionados a él).
 *  - Cualquier doc activo con el mismo email (no fusionado).
 * Útil para contar entries y borrar TODOS los rastros de una identidad antes de eliminar.
 */
export async function findRelatedUserUids(userId: string): Promise<string[]> {
  const related = new Set<string>([userId])
  const snap = await getDoc(doc(db, 'users', userId))
  if (!snap.exists()) return Array.from(related)
  const data = snap.data() as UserProfile & { migratedFromUid?: string }
  if (data.migratedFromUid) related.add(data.migratedFromUid)

  // Docs fusionados hacia este uid
  const mergedQ = query(collection(db, 'users'), where('mergedToUid', '==', userId))
  const mergedSnap = await getDocs(mergedQ)
  for (const d of mergedSnap.docs) related.add(d.id)

  // Docs activos (no fusionados) con el mismo email — también deben contar al eliminar
  if (data.email) {
    const sameEmail = await findActiveUsersByEmail(data.email, userId)
    for (const uid of sameEmail) related.add(uid)
  }
  return Array.from(related)
}

/**
 * Plan D: cuenta time_entries de TODOS los uids relacionados a este usuario.
 * Usa getCountFromServer (1 lectura facturada por uid).
 */
export async function countUserTimeEntriesDeep(userId: string): Promise<{
  total: number
  byUid: Record<string, number>
  relatedUids: string[]
}> {
  const relatedUids = await findRelatedUserUids(userId)
  const byUid: Record<string, number> = {}
  let total = 0
  for (const uid of relatedUids) {
    try {
      const q = query(collection(db, 'time_entries'), where('userId', '==', uid))
      const snap = await getCountFromServer(q)
      const n = snap.data().count
      byUid[uid] = n
      total += n
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[countUserTimeEntriesDeep] failed for', uid, err)
      byUid[uid] = -1 // marca de error; no podemos confirmar 0
    }
  }
  return { total, byUid, relatedUids }
}

/**
 * Plan D: elimina /users/{uid} + TODOS los docs relacionados (placeholders fusionados,
 * placeholder original, duplicados por email). NO borra time_entries — se asume que
 * el caller ya verificó vía countUserTimeEntriesDeep que no hay entries.
 * Borrado en batch (atómico hasta 500 ops).
 */
export async function deleteUserProfileDeep(userId: string): Promise<{ deletedUids: string[] }> {
  const relatedUids = await findRelatedUserUids(userId)
  // Firestore batch admite hasta 500 ops; relatedUids realista es <10
  const batch = writeBatch(db)
  for (const uid of relatedUids) {
    batch.delete(doc(db, 'users', uid))
  }
  await batch.commit()
  return { deletedUids: relatedUids }
}

/** Marca un usuario como inhabilitado / rehabilitado. */
export async function setUserDisabled(userId: string, disabled: boolean): Promise<void> {
  await updateDoc(doc(db, 'users', userId), {
    disabled,
    updatedAt: serverTimestamp(),
  })
}

export async function listApprovedUsers(): Promise<UserProfile[]> {
  const q = query(collection(db, 'users'), where('approvalStatus', '==', 'APPROVED'))
  const snapshot = await getDocs(q)
  const users = snapshot.docs
    .map((d) => d.data() as UserProfile)
    .filter((u) => !u.mergedToUid) // excluir placeholders ya fusionados
  return users.sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''))
}

/**
 * Recalcula enganche/reenganche de todas las entradas no bloqueadas del usuario.
 * El reenganche se decide por el flag manual `isJornadaAdicional` de la jornada previa.
 * Se llama automáticamente tras guardar, editar o eliminar.
 */
export async function recalculateUserEntries(projectId: string, userId: string): Promise<void> {
  // Limitar a 90 días: la lógica de streak solo necesita días consecutivos recientes.
  // Reduce lecturas drásticamente en usuarios con historial largo.
  const since90 = (() => {
    const d = new Date()
    d.setDate(d.getDate() - 90)
    return d.toISOString().slice(0, 10)
  })()
  const [entries, config, userSnap] = await Promise.all([
    listMyTimeEntries(userId, projectId, { since: since90 }),
    getProjectConfig(projectId),
    getDoc(doc(db, 'users', userId)),
  ])
  const userCycleMode = (userSnap.data() as UserProfile | undefined)?.cycleMode ?? 'CYCLE'
  const userCycleModes = new Map<string, 'CYCLE' | 'REINFORCEMENT'>([[userId, userCycleMode]])

  const toUpdate = entries.filter((e) => !e.lockedByAdmin)

  // Se usan TODAS las entries (incluyendo bloqueadas) para el cálculo de racha,
  // de modo que entradas previas bloqueadas contribuyen a detectar N días consecutivos.
  // Solo se actualizan las de toUpdate.
  const entriesForExtras = entries.map((e) => ({
    id: e.id,
    userId: e.userId,
    workDate: e.workDate,
    timeIn: e.timeIn,
    timeOut: e.timeOut,
    isJornadaAdicional: (e as TimeEntry & { isJornadaAdicional?: boolean }).isJornadaAdicional ?? false,
  }))
  const engancheMap = calcEngancheExtras(entriesForExtras, config, userCycleModes)

  for (let i = 0; i < toUpdate.length; i += 400) {
    const batch = writeBatch(db)
    for (const entry of toUpdate.slice(i, i + 400)) {
      const extras = engancheMap.get(entry.id)

      // 6to día es MANUAL: respetar el valor guardado por el usuario.
      const effectiveAdicional = (entry as TimeEntry & { isJornadaAdicional?: boolean }).isJornadaAdicional ?? false

      const calculation = calculateEntry(entry.timeIn, entry.timeOut, config, {
        penalties: (entry as TimeEntry & { penalties?: number }).penalties ?? 0,
        isJornadaAdicional: effectiveAdicional,
        engancheExtraHours: extras?.enganche ?? 0,
        reengancheExtraHours: extras?.reenganche ?? 0,
      })

      // Borrar campos derivados del ciclo (legado): ya no se usan.
      batch.update(doc(db, 'time_entries', entry.id), {
        calculation,
        updatedAt: serverTimestamp(),
        cycleScope: deleteField(),
        cycleDayInWeek: deleteField(),
        cycleWeekIndex: deleteField(),
      })
    }
    await batch.commit()
  }
}

export async function deleteTimeEntry(
  entryId: string,
  projectId: string,
  userId: string,
  actor?: { userName: string; email?: string | null; workDate?: string },
): Promise<void> {
  await deleteDoc(doc(db, 'time_entries', entryId))
  if (actor) {
    void writeSystemLog({
      type: 'entry_delete',
      userId,
      userName: actor.userName,
      email: actor.email ?? null,
      projectId,
      entryId,
      workDate: actor.workDate,
    })
  }
  scheduleRecalculateUserEntries(projectId, userId)
}

export async function updateTimeEntry(
  entryId: string,
  input: Omit<TimeEntryInput, 'projectId'>,
  projectId: string,
  userId: string,
  actor?: { userName: string; email?: string | null },
): Promise<void> {
  assertTimeEntryInput({ ...input, projectId })
  const config = await getProjectConfig(projectId)
  const calculation = calculateEntry(input.timeIn, input.timeOut, config, {
    penalties: input.penalties,
    isJornadaAdicional: input.isJornadaAdicional,
  })
  const entryRef = doc(db, 'time_entries', entryId)
  await updateDoc(entryRef, {
    workDate: input.workDate,
    shiftLabel: input.shiftLabel,
    timeIn: input.timeIn,
    timeOut: input.timeOut,
    notes: input.notes,
    penalties: input.penalties,
    isJornadaAdicional: input.isJornadaAdicional,
    calculation,
    updatedAt: serverTimestamp(),
  })
  if (actor) {
    void writeSystemLog({
      type: 'entry_edit',
      userId,
      userName: actor.userName,
      email: actor.email ?? null,
      projectId,
      entryId,
      workDate: input.workDate,
      details: `${input.timeIn}→${input.timeOut}`,
    })
  }
  scheduleRecalculateUserEntries(projectId, userId)
}

export async function listProjectAreas(projectId: string): Promise<ProjectArea[]> {
  const q = query(
    collection(db, 'project_areas'),
    where('projectId', '==', projectId),
    where('active', '==', true),
    orderBy('name'),
  )

  const snapshot = await getDocs(q)
  return snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ProjectArea, 'id'>) }))
}

export async function createProjectArea(projectId: string, name: string): Promise<void> {
  await addDoc(collection(db, 'project_areas'), {
    projectId,
    name,
    active: true,
    createdAt: serverTimestamp(),
  })
}

export async function deleteProjectArea(areaId: string): Promise<void> {
  await deleteDoc(doc(db, 'project_areas', areaId))
}

export async function updateProjectArea(areaId: string, name: string): Promise<void> {
  await updateDoc(doc(db, 'project_areas', areaId), { name, updatedAt: serverTimestamp() })
}

// ── Roles de proyecto ──────────────────────────────────────────────────────

export async function listProjectRoles(projectId: string): Promise<ProjectRole[]> {
  const q = query(
    collection(db, 'project_roles'),
    where('projectId', '==', projectId),
    where('active', '==', true),
    orderBy('name'),
  )
  const snap = await getDocs(q)
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ProjectRole, 'id'>) }))
}

export async function createProjectRole(projectId: string, input: ProjectRoleInput): Promise<void> {
  await addDoc(collection(db, 'project_roles'), {
    projectId,
    ...input,
    active: true,
    createdAt: serverTimestamp(),
  })
}

export async function updateProjectRole(roleId: string, input: ProjectRoleInput): Promise<void> {
  await updateDoc(doc(db, 'project_roles', roleId), { ...input, updatedAt: serverTimestamp() })
}

export async function deleteProjectRole(roleId: string): Promise<void> {
  await updateDoc(doc(db, 'project_roles', roleId), { active: false, updatedAt: serverTimestamp() })
}

// ── Administración de usuarios ─────────────────────────────────────────────

export async function updateUserProfileAdmin(
  userId: string,
  updates: Partial<Pick<UserProfile, 'displayName' | 'areaId' | 'roleId' | 'projectId' | 'role' | 'cycleMode'>>,
): Promise<void> {
  const userRef = doc(db, 'users', userId)
  // Convert undefined values to null for Firestore (to actually clear fields)
  const firestoreUpdates: Record<string, unknown> = { updatedAt: serverTimestamp() }
  for (const [k, v] of Object.entries(updates)) {
    firestoreUpdates[k] = v ?? null
  }
  await updateDoc(userRef, firestoreUpdates)
}

// ── Recálculo masivo ───────────────────────────────────────────────────────

export async function recalculateProjectEntries(
  projectId: string,
  lockedRanges: Array<{ dateFrom: string; dateTo: string }>,
  range?: { dateFrom?: string; dateTo?: string },
): Promise<number> {
  const [entries, config, usersSnap] = await Promise.all([
    listAllTimeEntries(projectId, { dateFrom: range?.dateFrom, dateTo: range?.dateTo }),
    getProjectConfig(projectId),
    getDocs(query(collection(db, 'users'), where('projectId', '==', projectId))),
  ])

  const userCycleModes = new Map<string, 'CYCLE' | 'REINFORCEMENT'>()
  const userNameMap = new Map<string, string>()
  for (const d of usersSnap.docs) {
    const u = d.data() as UserProfile
    userCycleModes.set(u.uid, u.cycleMode ?? 'CYCLE')
    if (u.displayName) userNameMap.set(u.uid, u.displayName)
  }

  const toUpdate = entries.filter(
    (e) =>
      !e.lockedByAdmin &&
      !lockedRanges.some((r) => e.workDate >= r.dateFrom && e.workDate <= r.dateTo),
  )

  // Se usan TODAS las entries (incluyendo bloqueadas/fuera de rango) para el cálculo
  // de racha de días consecutivos, de modo que semanas previas contribuyan al streak.
  // Solo se actualizan las de toUpdate.
  const entriesForExtras = entries.map((e) => ({
    id: e.id,
    userId: e.userId,
    workDate: e.workDate,
    timeIn: e.timeIn,
    timeOut: e.timeOut,
    isJornadaAdicional: (e as TimeEntry & { isJornadaAdicional?: boolean }).isJornadaAdicional ?? false,
  }))
  const engancheMap = calcEngancheExtras(entriesForExtras, config, userCycleModes)

  for (let i = 0; i < toUpdate.length; i += 400) {
    const batch = writeBatch(db)
    for (const entry of toUpdate.slice(i, i + 400)) {
      const extras = engancheMap.get(entry.id)
      // 6to día es MANUAL: respetar el valor guardado.
      const effectiveAdicional = (entry as TimeEntry & { isJornadaAdicional?: boolean }).isJornadaAdicional ?? false
      const calculation = calculateEntry(entry.timeIn, entry.timeOut, config, {
        penalties: (entry as TimeEntry & { penalties?: number }).penalties ?? 0,
        isJornadaAdicional: effectiveAdicional,
        engancheExtraHours: extras?.enganche ?? 0,
        reengancheExtraHours: extras?.reenganche ?? 0,
      })
      const currentUserName = userNameMap.get(entry.userId)
      const userNamePatch = currentUserName && currentUserName !== entry.userName
        ? { userName: currentUserName }
        : {}
      // Borrar campos derivados del ciclo (legado): ya no se usan.
      batch.update(doc(db, 'time_entries', entry.id), {
        calculation,
        ...userNamePatch,
        updatedAt: serverTimestamp(),
        cycleScope: deleteField(),
        cycleDayInWeek: deleteField(),
        cycleWeekIndex: deleteField(),
      })
    }
    await batch.commit()
  }

  return toUpdate.length
}

// ── Sincronización de áreas en entradas ───────────────────────────────────

export async function syncUserAreasToEntries(
  projectId: string,
  lockedRanges: Array<{ dateFrom: string; dateTo: string }>,
  range?: { dateFrom?: string; dateTo?: string },
): Promise<number> {
  const [entries, usersSnap] = await Promise.all([
    listAllTimeEntries(projectId, { dateFrom: range?.dateFrom, dateTo: range?.dateTo }),
    getDocs(query(collection(db, 'users'), where('projectId', '==', projectId), where('approvalStatus', '==', 'APPROVED'))),
  ])

  const userAreaMap = new Map<string, string>()
  for (const d of usersSnap.docs) {
    const u = d.data() as UserProfile
    userAreaMap.set(u.uid, u.areaId ?? '')
  }

  const toUpdate = entries.filter((e) => {
    if (e.lockedByAdmin) return false
    if (lockedRanges.some((r) => e.workDate >= r.dateFrom && e.workDate <= r.dateTo)) return false
    const currentArea = userAreaMap.get(e.userId)
    return currentArea !== undefined && currentArea !== (e.areaId ?? '')
  })

  for (let i = 0; i < toUpdate.length; i += 400) {
    const batch = writeBatch(db)
    for (const entry of toUpdate.slice(i, i + 400)) {
      batch.update(doc(db, 'time_entries', entry.id), {
        areaId: userAreaMap.get(entry.userId) ?? '',
        updatedAt: serverTimestamp(),
      })
    }
    await batch.commit()
  }

  return toUpdate.length
}

// ── Templates de proyecto ──────────────────────────────────────────────────

export async function saveProjectTemplate(
  name: string,
  data: { areas: string[]; roles: ProjectRoleInput[]; config: Omit<ProjectConfig, 'projectId'> },
): Promise<string> {
  const ref = await addDoc(collection(db, 'project_templates'), {
    name,
    ...data,
    createdAt: serverTimestamp(),
  })
  return ref.id
}

export async function listProjectTemplates(): Promise<ProjectTemplate[]> {
  const q = query(collection(db, 'project_templates'), orderBy('name'))
  const snap = await getDocs(q)
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ProjectTemplate, 'id'>) }))
}

export async function applyProjectTemplate(projectId: string, template: ProjectTemplate): Promise<void> {
  for (const areaName of template.areas) {
    await createProjectArea(projectId, areaName)
  }
  for (const role of template.roles) {
    await createProjectRole(projectId, role)
  }
  await saveProjectConfig(projectId, template.config)
}

export async function previewSettlement(
  projectId: string,
  projectName: string,
  dateFrom: string,
  dateTo: string,
  createdBy: string,
): Promise<Settlement> {
  const [entries, config, projectUsers, projectRoles] = await Promise.all([
    listAllTimeEntries(projectId, { dateFrom, dateTo }),
    getProjectConfig(projectId),
    listProjectUsers(projectId),
    listProjectRoles(projectId),
  ])

  // Tarifa por hora:
  // 1) Si el rol tiene weeklyRate > 0 → Valor Jornada = weeklyRate / weeklyWorkDays
  // 2) Si no → Valor Jornada = dailyRate
  // Valor Hora = Valor Jornada / regularDailyHours
  const userRates = new Map<string, { hourlyRate: number; roleId?: string; roleName?: string }>()
  for (const user of projectUsers) {
    const role = user.roleId ? projectRoles.find((r) => r.id === user.roleId) : undefined
    const valorJornada = role
      ? (role.weeklyRate > 0
          ? Math.round((role.weeklyRate / (config.weeklyWorkDays || 5)) * 100) / 100
          : role.dailyRate)
      : 0
    const hourlyRate = role ? Math.round((valorJornada / config.regularDailyHours) * 100) / 100 : 0
    userRates.set(user.uid, { hourlyRate, roleId: role?.id, roleName: role?.name })
  }

  return calculateSettlement(entries, userRates, config, {
    projectId,
    projectName,
    dateFrom,
    dateTo,
    createdBy,
  })
}

export async function saveSettlement(settlement: Settlement): Promise<Settlement> {
  const { id: _id, ...data } = settlement
  if (!DATE_RE.test(settlement.dateFrom) || !DATE_RE.test(settlement.dateTo)) {
    throw new Error('Fechas de liquidación inválidas (formato esperado YYYY-MM-DD).')
  }
  if (settlement.dateFrom > settlement.dateTo) {
    throw new Error('La fecha desde no puede ser mayor que la fecha hasta.')
  }

  // Transacción: comprobamos que no exista otra liquidación para el mismo
  // proyecto y rango exacto antes de crear, para evitar duplicados por
  // doble click o envíos concurrentes.
  const settlementsCol = collection(db, 'settlements')
  const duplicateQuery = query(
    settlementsCol,
    where('projectId', '==', settlement.projectId),
    where('dateFrom', '==', settlement.dateFrom),
    where('dateTo', '==', settlement.dateTo),
  )

  const newRef = doc(settlementsCol)
  await runTransaction(db, async (tx) => {
    // getDocs no se puede usar dentro de la transacción; hacemos lectura previa.
    const existing = await getDocs(duplicateQuery)
    if (!existing.empty) {
      throw new Error('Ya existe una liquidación para este proyecto y rango de fechas.')
    }
    tx.set(newRef, {
      ...stripUndefined(data),
      createdAt: serverTimestamp(),
    })
  })
  return { ...settlement, id: newRef.id }
}

export async function deleteSettlement(settlementId: string): Promise<void> {
  await deleteDoc(doc(db, 'settlements', settlementId))
}

/**
 * Archiva permanentemente una liquidación:
 *  1) Sube el Excel (generado por el caller) a Storage en archives/{projectId}/{settlementId}.xlsx
 *  2) Marca todas las jornadas del rango como archived=true, en batches de 400.
 *  3) Actualiza el doc settlement con archivedAt, archivedBy, archiveFileUrl, archiveFilePath, archiveEntriesCount.
 * Una vez archivada, las reglas Firestore impiden editar/eliminar las jornadas y el settlement (excepto SUPERUSER).
 */
export async function archiveSettlement(
  settlementId: string,
  xlsxBlob: Blob,
  archivedBy: string,
): Promise<Settlement> {
  // 1) Cargar el settlement actual.
  const settlementRef = doc(db, 'settlements', settlementId)
  const snap = await getDoc(settlementRef)
  if (!snap.exists()) throw new Error('La liquidación ya no existe.')
  const settlement = { id: snap.id, ...(snap.data() as Omit<Settlement, 'id'>) }
  if (settlement.archivedAt) {
    throw new Error('Esta liquidación ya está archivada.')
  }

  // 2) Subir el Excel a Storage.
  const fileName = `${settlement.id}.xlsx`
  const filePath = `archives/${settlement.projectId}/${fileName}`
  const ref = storageRef(storage, filePath)
  await uploadBytes(ref, xlsxBlob, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    customMetadata: {
      projectId: settlement.projectId,
      settlementId: settlement.id ?? '',
      dateFrom: settlement.dateFrom,
      dateTo: settlement.dateTo,
    },
  })
  const archiveFileUrl = await getDownloadURL(ref)

  // 3) Marcar jornadas del rango como archivadas (batches de 400).
  const entries = await listAllTimeEntries(settlement.projectId, {
    dateFrom: settlement.dateFrom,
    dateTo: settlement.dateTo,
  })
  let archivedCount = 0
  for (let i = 0; i < entries.length; i += 400) {
    const chunk = entries.slice(i, i + 400)
    const batch = writeBatch(db)
    for (const e of chunk) {
      if (e.archived) continue
      batch.update(doc(db, 'time_entries', e.id), {
        archived: true,
        archivedSettlementId: settlement.id,
        updatedAt: serverTimestamp(),
      })
      archivedCount += 1
    }
    await batch.commit()
  }

  // 4) Actualizar el settlement con metadatos del archivo.
  const archiveMeta = {
    archivedAt: serverTimestamp(),
    archivedBy,
    archiveFilePath: filePath,
    archiveFileUrl,
    archiveEntriesCount: archivedCount,
  }
  await updateDoc(settlementRef, archiveMeta)

  return { ...settlement, ...archiveMeta, archivedAt: new Date() }
}

/**
 * Archiva una liquidación usando un link externo (Google Drive, OneDrive, etc.).
 * No sube ningún archivo a Firebase Storage — el caller ya descargó el Excel y lo subió manualmente a su Drive.
 * Marca jornadas como archivadas y guarda el link en el doc.
 */
export async function archiveSettlementWithDriveLink(
  settlementId: string,
  driveUrl: string,
  fileName: string,
  archivedBy: string,
): Promise<Settlement> {
  const settlementRef = doc(db, 'settlements', settlementId)
  const snap = await getDoc(settlementRef)
  if (!snap.exists()) throw new Error('La liquidación ya no existe.')
  const settlement = { id: snap.id, ...(snap.data() as Omit<Settlement, 'id'>) }
  if (settlement.archivedAt) {
    throw new Error('Esta liquidación ya está archivada.')
  }

  // Marcar jornadas del rango como archivadas (batches de 400).
  const entries = await listAllTimeEntries(settlement.projectId, {
    dateFrom: settlement.dateFrom,
    dateTo: settlement.dateTo,
  })
  let archivedCount = 0
  for (let i = 0; i < entries.length; i += 400) {
    const chunk = entries.slice(i, i + 400)
    const batch = writeBatch(db)
    for (const e of chunk) {
      if (e.archived) continue
      batch.update(doc(db, 'time_entries', e.id), {
        archived: true,
        archivedSettlementId: settlement.id,
        updatedAt: serverTimestamp(),
      })
      archivedCount += 1
    }
    await batch.commit()
  }

  const archiveMeta = {
    archivedAt: serverTimestamp(),
    archivedBy,
    archiveFilePath: `external:drive/${fileName}`,
    archiveFileUrl: driveUrl,
    archiveEntriesCount: archivedCount,
  }
  await updateDoc(settlementRef, archiveMeta)

  return { ...settlement, ...archiveMeta, archivedAt: new Date() }
}

export async function listSettlements(projectId: string): Promise<Settlement[]> {
  const q = query(
    collection(db, 'settlements'),
    where('projectId', '==', projectId),
    orderBy('createdAt', 'desc'),
  )
  const snapshot = await getDocs(q)
  return snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Settlement, 'id'>) }))
}

export async function listAllTimeEntries(
  projectId: string,
  filters: { dateFrom?: string; dateTo?: string; userId?: string; areaId?: string },
): Promise<TimeEntry[]> {
  const conditions = [where('projectId', '==', projectId), orderBy('workDate', 'desc')]

  if (filters.dateFrom) {
    conditions.splice(1, 0, where('workDate', '>=', filters.dateFrom))
  }
  if (filters.dateTo) {
    conditions.splice(filters.dateFrom ? 2 : 1, 0, where('workDate', '<=', filters.dateTo))
  }
  if (filters.userId) {
    conditions.splice(0, 0, where('userId', '==', filters.userId))
  }

  const q = query(collection(db, 'time_entries'), ...conditions)
  const snapshot = await getDocs(q)
  const entries = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<TimeEntry, 'id'>) }))

  // areaId filter is done client-side to avoid composite index requirements
  if (filters.areaId) {
    return entries.filter((e) => e.areaId === filters.areaId)
  }
  return entries
}

// ── Suscripciones en tiempo real ────────────────────────────────────────────

export function subscribeToProjects(callback: (projects: Project[]) => void): () => void {
  const q = query(collection(db, 'projects'), where('active', '==', true), orderBy('name'))
  return onSnapshot(
    q,
    (snap) => {
      callback(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Project, 'id'>) })))
    },
    (err) => {
      // Surface rule denials / index errors that otherwise quedan silenciosos.
      console.error('[subscribeToProjects] onSnapshot error:', err)
      callback([])
    },
  )
}

export async function listImportedPlaceholders(): Promise<UserProfile[]> {
  const q = query(collection(db, 'users'), where('isPlaceholder', '==', true))
  const snap = await getDocs(q)
  return snap.docs
    .map((d) => d.data() as UserProfile)
    .filter((u) => !u.mergedToUid && u.approvalStatus === 'PENDING')
    .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''))
}

// ─── Importación masiva de miembros (placeholders en users) ────────────────

/** Aprueba un placeholder importado: actualiza approvalStatus y asignaciones. */
export async function approveImportedPlaceholder(
  placeholderUid: string,
  role: AppRole,
  projectId?: string,
  areaId?: string,
  roleId?: string,
): Promise<void> {
  const userRef = doc(db, 'users', placeholderUid)
  // Plan C: verificar unicidad de email antes de aprobar el placeholder
  const snap = await getDoc(userRef)
  if (snap.exists()) {
    const data = snap.data() as UserProfile
    if (data.email) {
      const conflicts = await findActiveUsersByEmail(data.email, placeholderUid)
      if (conflicts.length > 0) throw new EmailConflictError(data.email, conflicts)
    }
  }
  await updateDoc(userRef, {
    role,
    approvalStatus: 'APPROVED',
    ...(projectId ? { projectId } : { projectId: deleteField() }),
    ...(areaId ? { areaId } : { areaId: deleteField() }),
    ...(roleId ? { roleId } : { roleId: deleteField() }),
    updatedAt: serverTimestamp(),
  })
}

/** Elimina un placeholder importado (solo si aún no fue reclamado por login). */
export async function deleteImportedPlaceholder(placeholderUid: string): Promise<void> {
  await deleteDoc(doc(db, 'users', placeholderUid))
}

/** Repara placeholders huérfanos: usuarios reales con `migratedFromUid` cuyo placeholder original
 *  no fue marcado como fusionado (por un bug histórico de reglas).
 *  Solo admins. Retorna la cantidad de placeholders reparados.
 */
export async function repairMergedPlaceholders(): Promise<{ repaired: number; orphans: number }> {
  const usersSnap = await getDocs(collection(db, 'users'))
  let repaired = 0
  let orphans = 0
  for (const d of usersSnap.docs) {
    const user = d.data() as UserProfile & { migratedFromUid?: string }
    if (!user.migratedFromUid) continue
    const placeholderRef = doc(db, 'users', user.migratedFromUid)
    const phSnap = await getDoc(placeholderRef)
    if (!phSnap.exists()) {
      orphans += 1
      continue
    }
    const ph = phSnap.data() as UserProfile
    if (ph.mergedToUid) continue
    try {
      await updateDoc(placeholderRef, {
        isPlaceholder: false,
        mergedToUid: user.uid,
        updatedAt: serverTimestamp(),
      })
      repaired += 1
    } catch (err) {
      if (import.meta.env.DEV) console.error('[repairMergedPlaceholders] failed for', user.migratedFromUid, err)
    }
  }
  return { repaired, orphans }
}

/**
 * Reconciliación COMPLETA de usuarios duplicados por email.
 * Solo admins. Para cada email con múltiples docs:
 *  1. Elige el "ganador" (doc canónico) según heurística:
 *     - Si hay un doc con `migratedFromUid` → ese es el ganador.
 *     - Si hay un solo doc sin `isPlaceholder` y otro con → el sin placeholder gana.
 *     - Si no se puede decidir → se reporta para revisión manual.
 *  2. Copia campos faltantes (projectId, areaId, roleId, role, approvalStatus, cycleMode)
 *     del perdedor al ganador (sin sobrescribir lo que ya tenga).
 *  3. Reasigna time_entries.userId del perdedor al ganador.
 *  4. Marca el perdedor con `mergedToUid` + `isPlaceholder:false`.
 *
 * NO borra docs; deja todo trazable.
 */
export async function reconcileDuplicateUsers(): Promise<{
  emailsScanned: number
  duplicatesFound: number
  reconciled: number
  entriesReassigned: number
  manualReview: string[]
}> {
  const usersSnap = await getDocs(collection(db, 'users'))
  const byEmail = new Map<string, Array<{ id: string; data: UserProfile }>>()
  for (const d of usersSnap.docs) {
    const data = d.data() as UserProfile
    if (!data.email) continue
    const key = data.email.toLowerCase().trim()
    if (!byEmail.has(key)) byEmail.set(key, [])
    byEmail.get(key)!.push({ id: d.id, data })
  }

  let duplicatesFound = 0
  let reconciled = 0
  let entriesReassigned = 0
  const manualReview: string[] = []

  for (const [email, docs] of byEmail.entries()) {
    if (docs.length < 2) continue
    duplicatesFound += 1

    // Excluir docs ya fusionados (mergedToUid presente Y apunta a otro doc del grupo)
    const active = docs.filter((d) => !d.data.mergedToUid)
    if (active.length < 2) {
      // Ya está fusionado o solo queda uno activo — nada que hacer
      continue
    }

    // Elegir ganador
    let winner: { id: string; data: UserProfile } | null = null

    // Caso A: uno tiene migratedFromUid → es el doc real creado en login. Gana.
    const withMigrated = active.filter((d) => d.data.migratedFromUid)
    if (withMigrated.length === 1) {
      winner = withMigrated[0]
    } else if (withMigrated.length > 1) {
      // Múltiples docs con migratedFromUid → estado raro, revisión manual
      manualReview.push(`${email} (múltiples docs con migratedFromUid)`)
      continue
    } else {
      // Caso B: ninguno tiene migratedFromUid. Preferir el que NO es placeholder.
      const nonPlaceholder = active.filter((d) => !d.data.isPlaceholder)
      if (nonPlaceholder.length === 1) {
        winner = nonPlaceholder[0]
      } else {
        // Todos son placeholders, o todos son no-placeholder → ambigüo
        manualReview.push(`${email} (no se puede elegir ganador automáticamente)`)
        continue
      }
    }

    const losers = active.filter((d) => d.id !== winner!.id)
    const winnerRef = doc(db, 'users', winner.id)

    // Construir patch del ganador con campos faltantes copiados de los perdedores
    const winnerPatch: Record<string, unknown> = {}
    for (const loser of losers) {
      const l = loser.data
      if (l.projectId && !winner.data.projectId && !winnerPatch.projectId) winnerPatch.projectId = l.projectId
      if (l.areaId && !winner.data.areaId && !winnerPatch.areaId) winnerPatch.areaId = l.areaId
      if (l.roleId && !winner.data.roleId && !winnerPatch.roleId) winnerPatch.roleId = l.roleId
      if (l.cycleMode && !winner.data.cycleMode && !winnerPatch.cycleMode) winnerPatch.cycleMode = l.cycleMode
      if (
        l.role && l.role !== 'MEMBER' &&
        winner.data.role === 'MEMBER' &&
        (!winnerPatch.role || winnerPatch.role === 'MEMBER')
      ) {
        winnerPatch.role = l.role
      }
      if (
        l.approvalStatus === 'APPROVED' &&
        winner.data.approvalStatus !== 'APPROVED' &&
        winnerPatch.approvalStatus !== 'APPROVED'
      ) {
        winnerPatch.approvalStatus = 'APPROVED'
      }
      if (!winner.data.migratedFromUid && !winnerPatch.migratedFromUid && loser.data.isPlaceholder) {
        winnerPatch.migratedFromUid = loser.id
      }
    }
    if (Object.keys(winnerPatch).length > 0) {
      winnerPatch.updatedAt = serverTimestamp()
      try {
        await updateDoc(winnerRef, winnerPatch)
      } catch (err) {
        if (import.meta.env.DEV) console.warn('[reconcile] update winner failed for', email, err)
      }
    }

    // Por cada perdedor: reasignar entries y marcar como fusionado
    for (const loser of losers) {
      // Reasignar time_entries.userId loser → winner
      let entriesSnap
      try {
        entriesSnap = await getDocs(
          query(collection(db, 'time_entries'), where('userId', '==', loser.id)),
        )
      } catch (err) {
        if (import.meta.env.DEV) console.warn('[reconcile] get entries failed for', loser.id, err)
        entriesSnap = null
      }
      if (entriesSnap) {
        const CHUNK = 440
        for (let i = 0; i < entriesSnap.docs.length; i += CHUNK) {
          const b = writeBatch(db)
          for (const e of entriesSnap.docs.slice(i, i + CHUNK)) {
            b.update(e.ref, { userId: winner.id })
          }
          try {
            await b.commit()
            entriesReassigned += Math.min(CHUNK, entriesSnap.docs.length - i)
          } catch (err) {
            if (import.meta.env.DEV) console.warn('[reconcile] reassign batch failed for', loser.id, err)
          }
        }
      }

      // Marcar perdedor como fusionado
      try {
        await updateDoc(doc(db, 'users', loser.id), {
          isPlaceholder: false,
          mergedToUid: winner.id,
          updatedAt: serverTimestamp(),
        })
      } catch (err) {
        if (import.meta.env.DEV) console.warn('[reconcile] mark loser fused failed for', loser.id, err)
      }
    }

    reconciled += 1
  }

  return {
    emailsScanned: byEmail.size,
    duplicatesFound,
    reconciled,
    entriesReassigned,
    manualReview,
  }
}

// ─── Buscar y reemplazar UID (manual, estilo Google Sheets) ────────────────

export interface OrphanEntryRow {
  userId: string
  /** Último `userName` visto en alguna entry de ese userId. */
  userName: string | null
  /** Último `userEmail` visto en alguna entry de ese userId (campo agregado recientemente). */
  userEmail: string | null
  entriesCount: number
  /** Último workDate de alguna entry de ese userId (para contexto). */
  lastWorkDate: string | null
  /** true si existe el doc `users/{userId}` (puede aparecer si está mergeado). */
  userExists: boolean
  /** Si el doc existe y está fusionado, hacia qué UID. */
  mergedToUid?: string | null
  approvalStatus?: string
}

/**
 * Audita `time_entries` de los últimos N días y reporta los `userId` cuyo
 * documento `users/{userId}`:
 *   - no existe, o
 *   - existe pero está marcado como fusionado (`mergedToUid` presente).
 *
 * Costo: 1 lectura por entry en el rango + 1 lectura por UID único.
 * Recomendado: empezar con 30 días.
 */
export async function auditOrphanEntries(opts?: { daysBack?: number }): Promise<OrphanEntryRow[]> {
  const days = Math.max(1, opts?.daysBack ?? 30)
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  const snap = await getDocs(
    query(collection(db, 'time_entries'), where('workDate', '>=', since)),
  )

  type Agg = { count: number; userName: string | null; userEmail: string | null; lastWorkDate: string | null }
  const byUid = new Map<string, Agg>()
  for (const d of snap.docs) {
    const data = d.data() as TimeEntry & { userEmail?: string | null }
    if (!data.userId) continue
    const cur = byUid.get(data.userId) ?? { count: 0, userName: null, userEmail: null, lastWorkDate: null }
    cur.count += 1
    if (!cur.userName && data.userName) cur.userName = data.userName
    if (!cur.userEmail && data.userEmail) cur.userEmail = data.userEmail
    if (!cur.lastWorkDate || (data.workDate && data.workDate > cur.lastWorkDate)) {
      cur.lastWorkDate = data.workDate ?? cur.lastWorkDate
    }
    byUid.set(data.userId, cur)
  }

  const uids = Array.from(byUid.keys())
  const userDocs = await Promise.all(uids.map((uid) => getDoc(doc(db, 'users', uid))))

  const rows: OrphanEntryRow[] = []
  uids.forEach((uid, i) => {
    const info = byUid.get(uid)!
    const ud = userDocs[i]
    if (!ud.exists()) {
      rows.push({
        userId: uid,
        userName: info.userName,
        userEmail: info.userEmail,
        entriesCount: info.count,
        lastWorkDate: info.lastWorkDate,
        userExists: false,
      })
    } else {
      const data = ud.data() as UserProfile
      if (data.mergedToUid) {
        rows.push({
          userId: uid,
          userName: info.userName ?? data.displayName ?? null,
          userEmail: info.userEmail ?? data.email ?? null,
          entriesCount: info.count,
          lastWorkDate: info.lastWorkDate,
          userExists: true,
          mergedToUid: data.mergedToUid,
          approvalStatus: data.approvalStatus,
        })
      }
    }
  })
  rows.sort((a, b) => b.entriesCount - a.entriesCount)
  return rows
}

/**
 * Crea un documento mínimo en `users/{uid}` con los datos provistos.
 * Pensado para "rescatar" usuarios huérfanos detectados por auditoría:
 * después de creado, el admin puede aprobarlo, asignarle proyecto/área,
 * o usar "Buscar y reemplazar UID" para fusionarlo a otro UID real.
 *
 * Falla si ya existe un doc en esa ruta (no se sobreescribe).
 */
export async function createMinimalUserDoc(
  uid: string,
  payload: { displayName?: string | null; email?: string | null },
): Promise<UserProfile> {
  if (!uid) throw new Error('UID es obligatorio.')
  const ref = doc(db, 'users', uid)
  const existing = await getDoc(ref)
  if (existing.exists()) throw new Error(`Ya existe un documento users/${uid}.`)
  const profile: UserProfile = {
    uid,
    email: payload.email ? payload.email.toLowerCase().trim() : null,
    displayName: payload.displayName?.trim() || null,
    role: 'MEMBER',
    approvalStatus: 'PENDING',
    isPlaceholder: false,
    mergedToUid: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  await setDoc(ref, profile)
  return profile
}

export interface UidReplacePreview {
  searchUid: string
  replaceUid: string
  searchProfile: UserProfile | null
  replaceProfile: UserProfile | null
  /** Cantidad de `time_entries` cuyo `userId == searchUid`. Lo que se va a reemplazar. */
  searchEntries: number
  /** Cantidad de `time_entries` cuyo `userId == replaceUid`. Solo informativo. */
  replaceEntries: number
  /** Cantidad de `system_logs` cuyo `userId == searchUid`. */
  searchLogs: number
}

/**
 * Previsualiza una operación de buscar-y-reemplazar de UID en `time_entries`,
 * `system_logs` y `users/{searchUid}`.
 * Costo: 2 getDoc + 3 getCountFromServer = 5 lecturas.
 */
export async function previewUidReplace(
  searchUid: string,
  replaceUid: string,
): Promise<UidReplacePreview> {
  const [searchDoc, replaceDoc, searchCnt, replaceCnt, logsCnt] = await Promise.all([
    getDoc(doc(db, 'users', searchUid)),
    getDoc(doc(db, 'users', replaceUid)),
    getCountFromServer(query(collection(db, 'time_entries'), where('userId', '==', searchUid))),
    getCountFromServer(query(collection(db, 'time_entries'), where('userId', '==', replaceUid))),
    getCountFromServer(query(collection(db, 'system_logs'), where('userId', '==', searchUid))),
  ])
  return {
    searchUid,
    replaceUid,
    searchProfile: searchDoc.exists() ? (searchDoc.data() as UserProfile) : null,
    replaceProfile: replaceDoc.exists() ? (replaceDoc.data() as UserProfile) : null,
    searchEntries: searchCnt.data().count,
    replaceEntries: replaceCnt.data().count,
    searchLogs: logsCnt.data().count,
  }
}

/**
 * Reemplaza el `userId` de `searchUid` por `replaceUid` en TODAS las
 * `time_entries` y `system_logs` que coincidan, marca `users/{searchUid}` como
 * fusionado a `replaceUid` (vía `mergedToUid`) y, si se proporciona
 * `replaceEmail`, propaga ese email a las entries (`userEmail`) y a los logs
 * (`email`). NO modifica el documento `users/{replaceUid}`.
 *
 * Devuelve la cantidad de documentos efectivamente actualizados.
 */
export async function executeUidReplace(
  searchUid: string,
  replaceUid: string,
  replaceEmail?: string | null,
): Promise<{ entriesUpdated: number; logsUpdated: number; userMerged: boolean }> {
  if (!searchUid || !replaceUid) throw new Error('Ambos UIDs son obligatorios.')
  if (searchUid === replaceUid) throw new Error('El UID a buscar y el de reemplazo no pueden ser iguales.')

  const trimmedEmail = replaceEmail?.trim()
  const emailToWrite = trimmedEmail ? trimmedEmail.toLowerCase() : null

  // Tomamos el displayName del UID de reemplazo (si existe) para mantener
  // consistencia visual en `userName` de las entries y logs reasignados.
  const [replaceSnap, searchSnap] = await Promise.all([
    getDoc(doc(db, 'users', replaceUid)),
    getDoc(doc(db, 'users', searchUid)),
  ])
  const replaceName = replaceSnap.exists()
    ? ((replaceSnap.data() as UserProfile).displayName ?? null)
    : null

  // 1) time_entries
  const entriesSnap = await getDocs(
    query(collection(db, 'time_entries'), where('userId', '==', searchUid)),
  )
  const CHUNK = 440
  let entriesTotal = 0
  for (let i = 0; i < entriesSnap.docs.length; i += CHUNK) {
    const slice = entriesSnap.docs.slice(i, i + CHUNK)
    const b = writeBatch(db)
    for (const e of slice) {
      const patch: Record<string, unknown> = { userId: replaceUid, updatedAt: serverTimestamp() }
      if (replaceName) patch.userName = replaceName
      if (emailToWrite !== null) patch.userEmail = emailToWrite
      b.update(e.ref, patch)
    }
    await b.commit()
    entriesTotal += slice.length
  }

  // 2) system_logs
  const logsSnap = await getDocs(
    query(collection(db, 'system_logs'), where('userId', '==', searchUid)),
  )
  let logsTotal = 0
  for (let i = 0; i < logsSnap.docs.length; i += CHUNK) {
    const slice = logsSnap.docs.slice(i, i + CHUNK)
    const b = writeBatch(db)
    for (const e of slice) {
      const patch: Record<string, unknown> = { userId: replaceUid }
      if (replaceName) patch.userName = replaceName
      if (emailToWrite !== null) patch.email = emailToWrite
      b.update(e.ref, patch)
    }
    await b.commit()
    logsTotal += slice.length
  }

  // 3) users/{searchUid} → marcar como fusionado al ganador.
  // Importante:
  //   - La regla de update para admin exige que el doc resultante tenga
  //     `role` ∈ ['SUPERUSER','PROJECT_ADMIN','MEMBER']. Si el doc original
  //     no tenía `role` (caso común en docs migrados o creados manualmente),
  //     la actualización falla con permission-denied. Lo defaulteamos a 'MEMBER'.
  //   - Si la actualización del user igualmente falla, no abortamos toda la
  //     operación: las entries/logs ya quedaron movidos. Reportamos
  //     `userMerged: false` para que el admin vea el detalle.
  let userMerged = false
  if (searchSnap.exists()) {
    const searchData = searchSnap.data() as UserProfile
    const roleNeedsBackfill = !['SUPERUSER', 'PROJECT_ADMIN', 'MEMBER'].includes(
      String(searchData.role ?? ''),
    )
    const userPatch: Record<string, unknown> = {
      mergedToUid: replaceUid,
      isPlaceholder: false,
      updatedAt: serverTimestamp(),
    }
    if (roleNeedsBackfill) userPatch.role = 'MEMBER'
    if (emailToWrite !== null && !searchData.email) userPatch.email = emailToWrite
    try {
      await updateDoc(searchSnap.ref, userPatch)
      userMerged = true
    } catch (e) {
      if (import.meta.env.DEV) {
        console.warn('[executeUidReplace] update users/{searchUid} skipped:', e)
      }
      // dejamos userMerged=false; el caller decide cómo informarlo
    }
  }

  return { entriesUpdated: entriesTotal, logsUpdated: logsTotal, userMerged }
}

export async function importMembers(
  rows: { email: string; displayName: string }[],
): Promise<{ imported: number; duplicates: string[] }> {
  const usersSnap = await getDocs(collection(db, 'users'))

  const existingEmails = new Set<string>()
  usersSnap.docs.forEach((d) => {
    const data = d.data() as UserProfile
    if (data.email && !data.mergedToUid) existingEmails.add(data.email.toLowerCase())
  })

  const duplicates: string[] = []
  const toImport: { email: string; displayName: string }[] = []

  for (const row of rows) {
    const emailLower = row.email.toLowerCase().trim()
    if (!emailLower || !emailLower.includes('@')) continue
    if (existingEmails.has(emailLower)) {
      duplicates.push(emailLower)
    } else {
      toImport.push({ email: emailLower, displayName: row.displayName.trim() })
      existingEmails.add(emailLower)
    }
  }

  const batch = writeBatch(db)
  for (const m of toImport) {
    const ref = doc(collection(db, 'users'))
    const placeholder: UserProfile = {
      uid: ref.id,
      email: m.email,
      displayName: m.displayName || null,
      role: 'MEMBER',
      approvalStatus: 'PENDING',
      isPlaceholder: true,
      mergedToUid: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }
    batch.set(ref, placeholder)
  }
  await batch.commit()

  return { imported: toImport.length, duplicates }
}

// ─── Modo Mantenimiento (solo SUPERUSER) ──────────────────────────────────

export interface MaintenanceState {
  enabled: boolean
  message?: string | null
  version: number
}

const MAINTENANCE_DOC = doc(db, 'app_config', 'maintenance')

export function subscribeToMaintenance(callback: (state: MaintenanceState) => void): () => void {
  return onSnapshot(
    MAINTENANCE_DOC,
    (snap) => {
      if (!snap.exists()) {
        callback({ enabled: false, message: null, version: 0 })
        return
      }
      const data = snap.data() as Partial<MaintenanceState>
      callback({
        enabled: data.enabled === true,
        message: data.message ?? null,
        version: typeof data.version === 'number' ? data.version : 0,
      })
    },
    (err) => {
      if (import.meta.env.DEV) console.warn('[subscribeToMaintenance] error:', err)
      callback({ enabled: false, message: null, version: 0 })
    },
  )
}

export async function setMaintenanceMode(enabled: boolean, message?: string | null): Promise<void> {
  const snap = await getDoc(MAINTENANCE_DOC)
  const prevVersion = snap.exists() ? ((snap.data() as { version?: number }).version ?? 0) : 0
  await setDoc(
    MAINTENANCE_DOC,
    {
      enabled,
      message: message ?? null,
      version: prevVersion + 1,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
}

// ─── Auditoría: usuarios sin informar + color de revisión ──────────────────

/** Asigna (o limpia con '') el color de revisión de un usuario en el reporte de "sin informar". */
export async function setUserAuditReviewColor(uid: string, color: string): Promise<void> {
  assertReviewColor(color)
  await updateDoc(doc(db, 'users', uid), {
    auditReviewColor: color,
    updatedAt: serverTimestamp(),
  })
}

export interface NoReportUserRow {
  user: UserProfile
  daysWithEntries: number
  totalDaysInRange: number
}

/** Devuelve los usuarios aprobados del proyecto que NO informaron horarios en el rango.
 *  Opcionalmente filtra por área.
 */
export async function listUsersWithoutEntries(
  projectId: string,
  dateFrom: string,
  dateTo: string,
  areaId?: string,
): Promise<NoReportUserRow[]> {
  if (!DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo)) {
    throw new Error('Fechas inválidas (formato esperado YYYY-MM-DD)')
  }
  if (dateFrom > dateTo) {
    throw new Error('La fecha desde no puede ser mayor que la fecha hasta.')
  }
  const [users, entries] = await Promise.all([
    listProjectUsers(projectId),
    listAllTimeEntries(projectId, { dateFrom, dateTo, areaId: areaId || undefined }),
  ])

  // Contar días distintos con entries por usuario
  const daysByUser = new Map<string, Set<string>>()
  for (const e of entries) {
    let set = daysByUser.get(e.userId)
    if (!set) {
      set = new Set<string>()
      daysByUser.set(e.userId, set)
    }
    set.add(e.workDate)
  }

  // Cálculo de días en rango (inclusivo)
  const start = new Date(dateFrom + 'T00:00:00')
  const end = new Date(dateTo + 'T00:00:00')
  const totalDaysInRange = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1)

  const filtered = areaId ? users.filter((u) => (u.areaId ?? '') === areaId) : users
  return filtered
    .map((u) => ({
      user: u,
      daysWithEntries: daysByUser.get(u.uid)?.size ?? 0,
      totalDaysInRange,
    }))
    .filter((row) => row.daysWithEntries === 0)
    .sort((a, b) => (a.user.displayName ?? '').localeCompare(b.user.displayName ?? ''))
}

// ─── Auditoría: bloqueo de ediciones (audit_locks/{projectId}) ─────────────

export async function getAuditLock(projectId: string): Promise<AuditLock | null> {
  const snap = await getDoc(doc(db, 'audit_locks', projectId))
  if (!snap.exists()) return null
  return { projectId, ...(snap.data() as Omit<AuditLock, 'projectId'>) }
}

/** Activa o desactiva el bloqueo de ediciones para el proyecto en un rango de fechas.
 *  Cuando se activa: marca lockedByAudit=true en todas las entradas existentes del rango.
 *  Cuando se desactiva: marca lockedByAudit=false en las entradas del rango previamente bloqueadas.
 *  Devuelve la cantidad de entradas afectadas.
 */
export async function setAuditLockEnabled(
  projectId: string,
  opts: { enabled: boolean; dateFrom: string; dateTo: string; updatedBy: string },
): Promise<number> {
  const { enabled, dateFrom, dateTo, updatedBy } = opts
  if (!DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo)) {
    throw new Error('Fechas inválidas (formato esperado YYYY-MM-DD)')
  }
  if (dateFrom > dateTo) {
    throw new Error('La fecha desde no puede ser mayor que la fecha hasta.')
  }

  // 1) Persistir el documento del lock
  await setDoc(
    doc(db, 'audit_locks', projectId),
    { projectId, enabled, dateFrom, dateTo, updatedBy, updatedAt: serverTimestamp() },
    { merge: true },
  )

  // 2) Actualizar entradas en rango
  const entries = await listAllTimeEntries(projectId, { dateFrom, dateTo })
  const toUpdate = entries.filter((e) => (e.lockedByAudit ?? false) !== enabled)

  for (let i = 0; i < toUpdate.length; i += 400) {
    const batch = writeBatch(db)
    for (const entry of toUpdate.slice(i, i + 400)) {
      batch.update(doc(db, 'time_entries', entry.id), {
        lockedByAudit: enabled,
        updatedAt: serverTimestamp(),
      })
    }
    await batch.commit()
  }
  return toUpdate.length
}


// ─── Ciclos laborales por usuario ──────────────────────────────────────────

/** Lista todos los ciclos (abiertos y cerrados) del usuario en el proyecto. */
export async function listUserWorkCycles(projectId: string, userId: string): Promise<WorkCycle[]> {
  const cached = workCyclesCacheByProject.get(projectId)
  if (cached && Date.now() - cached.ts < WORK_CYCLES_TTL_MS) {
    return cached.data
      .filter((c) => c.userId === userId)
      .sort((a, b) => a.anchorDate.localeCompare(b.anchorDate))
  }
  const q = query(
    collection(db, 'user_work_cycles'),
    where('projectId', '==', projectId),
  )
  const snap = await getDocs(q)
  const all = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<WorkCycle, 'id'>) }))
  workCyclesCacheByProject.set(projectId, { data: all, ts: Date.now() })
  return all
    .filter((c) => c.userId === userId)
    .sort((a, b) => a.anchorDate.localeCompare(b.anchorDate))
}

/** Devuelve el ciclo abierto del usuario (closedFromDate ausente) o null. */
export async function getUserActiveWorkCycle(
  projectId: string,
  userId: string,
): Promise<WorkCycle | null> {
  const cycles = await listUserWorkCycles(projectId, userId)
  for (const c of cycles) {
    if (!c.closedFromDate) return c
  }
  return null
}

/** Lista los ciclos de todos los usuarios del proyecto (uso ADMIN). */
export async function listProjectWorkCycles(projectId: string): Promise<WorkCycle[]> {
  const cached = workCyclesCacheByProject.get(projectId)
  if (cached && Date.now() - cached.ts < WORK_CYCLES_TTL_MS) {
    return cached.data
      .slice()
      .sort((a, b) => a.userId.localeCompare(b.userId) || a.anchorDate.localeCompare(b.anchorDate))
  }
  const q = query(collection(db, 'user_work_cycles'), where('projectId', '==', projectId))
  const snap = await getDocs(q)
  const all = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<WorkCycle, 'id'>) }))
  workCyclesCacheByProject.set(projectId, { data: all, ts: Date.now() })
  return all
    .slice()
    .sort((a, b) => a.userId.localeCompare(b.userId) || a.anchorDate.localeCompare(b.anchorDate))
}

/**
 * Crea un nuevo ciclo laboral para el usuario.
 * - Valida que no exista ya un ciclo abierto para el mismo (projectId, userId).
 * - Valida cycleMode === 'CYCLE' del usuario.
 * - Tras crear, dispara recalculateUserEntries para reprocesar entradas no liquidadas.
 */
export async function createUserWorkCycle(input: {
  projectId: string
  userId: string
  anchorDate: string
  createdBy: string
}): Promise<string> {
  if (!DATE_RE.test(input.anchorDate)) {
    throw new Error('Fecha de anchor inválida (formato YYYY-MM-DD)')
  }
  const profileSnap = await getDoc(doc(db, 'users', input.userId))
  if (!profileSnap.exists()) throw new Error('Usuario no encontrado')
  const profile = profileSnap.data() as UserProfile
  const mode: CycleMode = profile.cycleMode ?? 'CYCLE'
  if (mode === 'REINFORCEMENT') {
    throw new Error('El usuario está en modo refuerzo y no puede declarar ciclos.')
  }
  const existing = await getUserActiveWorkCycle(input.projectId, input.userId)
  if (existing) {
    throw new Error('El usuario ya tiene un ciclo laboral abierto.')
  }

  const ref = await addDoc(collection(db, 'user_work_cycles'), {
    projectId: input.projectId,
    userId: input.userId,
    anchorDate: input.anchorDate,
    createdBy: input.createdBy,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  invalidateWorkCyclesCache(input.projectId)

  // Recalcular para aplicar cycleScope/isJornadaAdicional a entradas existentes
  await recalculateUserEntries(input.projectId, input.userId)
  return ref.id
}

/**
 * Cierra un ciclo abierto a partir de una fecha (closedFromDate, exclusivo).
 * Tras cerrar, recalcula las entries del usuario.
 */
export async function closeUserWorkCycle(
  cycleId: string,
  closedFromDate: string,
  closedBy: string,
): Promise<void> {
  if (!DATE_RE.test(closedFromDate)) {
    throw new Error('Fecha de cierre inválida (formato YYYY-MM-DD)')
  }
  const ref = doc(db, 'user_work_cycles', cycleId)
  const snap = await getDoc(ref)
  if (!snap.exists()) throw new Error('Ciclo no encontrado')
  const cycle = snap.data() as Omit<WorkCycle, 'id'>
  if (cycle.closedFromDate) throw new Error('El ciclo ya está cerrado')
  if (closedFromDate <= cycle.anchorDate) {
    throw new Error('La fecha de cierre debe ser posterior al inicio del ciclo.')
  }
  await updateDoc(ref, {
    closedFromDate,
    closedAt: serverTimestamp(),
    closedBy,
    updatedAt: serverTimestamp(),
    updatedBy: closedBy,
  })
  invalidateWorkCyclesCache(cycle.projectId)
  await recalculateUserEntries(cycle.projectId, cycle.userId)
}

/** Reabre un ciclo cerrado (solo ADMIN). */
export async function reopenUserWorkCycle(cycleId: string, updatedBy: string): Promise<void> {
  const ref = doc(db, 'user_work_cycles', cycleId)
  const snap = await getDoc(ref)
  if (!snap.exists()) throw new Error('Ciclo no encontrado')
  const cycle = snap.data() as Omit<WorkCycle, 'id'>
  if (!cycle.closedFromDate) throw new Error('El ciclo no está cerrado')
  // Verificar que no haya otro ciclo abierto del mismo usuario
  const existingOpen = await getUserActiveWorkCycle(cycle.projectId, cycle.userId)
  if (existingOpen) {
    throw new Error('Ya existe otro ciclo abierto para este usuario; cierralo antes de reabrir éste.')
  }
  await updateDoc(ref, {
    closedFromDate: deleteField(),
    closedAt: deleteField(),
    closedBy: deleteField(),
    updatedAt: serverTimestamp(),
    updatedBy,
  })
  invalidateWorkCyclesCache(cycle.projectId)
  await recalculateUserEntries(cycle.projectId, cycle.userId)
}

/** Actualiza el anchorDate del ciclo (solo ADMIN). */
export async function updateUserWorkCycleAnchor(
  cycleId: string,
  newAnchorDate: string,
  updatedBy: string,
): Promise<void> {
  if (!DATE_RE.test(newAnchorDate)) {
    throw new Error('Fecha de anchor inválida (formato YYYY-MM-DD)')
  }
  const ref = doc(db, 'user_work_cycles', cycleId)
  const snap = await getDoc(ref)
  if (!snap.exists()) throw new Error('Ciclo no encontrado')
  const cycle = snap.data() as Omit<WorkCycle, 'id'>
  if (cycle.closedFromDate && newAnchorDate >= cycle.closedFromDate) {
    throw new Error('El nuevo anchor no puede ser posterior o igual a la fecha de cierre del ciclo.')
  }
  await updateDoc(ref, {
    anchorDate: newAnchorDate,
    updatedAt: serverTimestamp(),
    updatedBy,
  })
  invalidateWorkCyclesCache(cycle.projectId)
  await recalculateUserEntries(cycle.projectId, cycle.userId)
}

/** Elimina un ciclo (solo SUPERUSER vía rules). */
export async function deleteUserWorkCycle(cycleId: string): Promise<void> {
  const ref = doc(db, 'user_work_cycles', cycleId)
  const snap = await getDoc(ref)
  if (!snap.exists()) return
  const cycle = snap.data() as Omit<WorkCycle, 'id'>
  await deleteDoc(ref)
  invalidateWorkCyclesCache(cycle.projectId)
  await recalculateUserEntries(cycle.projectId, cycle.userId)
}

/** Cambia el modo de ciclo del usuario (CYCLE | REINFORCEMENT). */
export async function setUserCycleMode(userId: string, mode: CycleMode): Promise<void> {
  if (mode !== 'CYCLE' && mode !== 'REINFORCEMENT') {
    throw new Error(`Modo de ciclo inválido: "${mode}"`)
  }
  // Si pasa a REINFORCEMENT, cerrar ciclos abiertos automáticamente (no se permiten en REINFORCEMENT)
  const userRef = doc(db, 'users', userId)
  await updateDoc(userRef, { cycleMode: mode, updatedAt: serverTimestamp() })
}

// ─── Registros del sistema ────────────────────────────────────────────────────

/**
 * Escribe un registro de actividad en la colección system_logs.
 * Fire-and-forget: los errores se suprimen para no afectar la operación principal.
 */
export async function writeSystemLog(
  log: Omit<SystemLog, 'id' | 'timestamp' | 'logDate'>,
): Promise<void> {
  const now = new Date()
  const logDate = now.toISOString().slice(0, 10) // YYYY-MM-DD
  await addDoc(collection(db, 'system_logs'), {
    ...log,
    logDate,
    timestamp: serverTimestamp(),
  })
}

/**
 * Consulta registros del sistema en un rango de fechas.
 * Solo accesible para SUPERUSER (controlado en cliente por la UI).
 */
export async function querySystemLogs(
  dateFrom: string,
  dateTo: string,
): Promise<SystemLog[]> {
  const q = query(
    collection(db, 'system_logs'),
    where('logDate', '>=', dateFrom),
    where('logDate', '<=', dateTo),
    orderBy('logDate', 'desc'),
    orderBy('timestamp', 'desc'),
  )
  const snap = await getDocs(q)
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SystemLog, 'id'>) }))
}

// ─── Cédula/DNI: candado de unicidad y completar perfil ───────────────────

/** Normaliza un DNI: quita todo lo que no sea dígito. */
export function normalizeIdNumber(raw: string): string {
  return String(raw ?? '').replace(/\D/g, '')
}

/**
 * Valida formato del DNI: solo dígitos, 6-12 caracteres.
 */
export function isValidIdNumber(idNumber: string): boolean {
  const n = normalizeIdNumber(idNumber)
  return n.length >= 6 && n.length <= 12
}

/**
 * Error específico para DNI duplicado: el doc `id_numbers/{idNumber}` ya
 * existe (otro usuario ya reclamó ese número). El consumidor lo distingue
 * para mostrar el flujo de "No recuerdo el mail".
 */
export class DuplicateIdNumberError extends Error {
  idNumber: string
  constructor(idNumber: string) {
    super(`El Nro de Cédula/DNI ${idNumber} ya está en uso.`)
    this.name = 'DuplicateIdNumberError'
    this.idNumber = idNumber
  }
}

/**
 * Reclama el DNI para el usuario actual creando `id_numbers/{idNumber}`.
 * - Si ya existe → throw `DuplicateIdNumberError`.
 * - Si la regla rechaza por permission-denied (porque el doc ya está) → idem.
 */
async function claimIdNumber(uid: string, idNumber: string): Promise<void> {
  const ref = doc(db, 'id_numbers', idNumber)
  // Pre-check best-effort. Como `read` está restringido a admin, este getDoc
  // probablemente falle para usuarios regulares; ignoramos el error y dejamos
  // que el setDoc dispare permission-denied → lo traducimos a duplicate.
  try {
    const snap = await getDoc(ref)
    if (snap.exists()) {
      const data = snap.data() as { uid?: string }
      if (data.uid && data.uid === uid) return // ya estaba reclamado por nosotros
      throw new DuplicateIdNumberError(idNumber)
    }
  } catch (e) {
    if (e instanceof DuplicateIdNumberError) throw e
    // permission-denied al leer → seguimos al setDoc y manejamos allá.
  }
  try {
    await setDoc(ref, { uid, createdAt: serverTimestamp() })
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'permission-denied' || code === 'already-exists') {
      throw new DuplicateIdNumberError(idNumber)
    }
    throw e
  }
}

/**
 * Libera el candado de DNI (best-effort). Solo SUPERUSER puede borrarlo;
 * para otros usuarios este call probablemente falle silenciosamente.
 */
async function releaseIdNumber(idNumber: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'id_numbers', idNumber))
  } catch (e) {
    if (import.meta.env.DEV) console.warn('[releaseIdNumber] skipped:', e)
  }
}

/**
 * Completa el perfil del usuario actual: setea displayName e idNumber.
 * Pasos:
 *  1. Normaliza y valida el DNI.
 *  2. Reclama el candado en `id_numbers/{dni}` (atómico).
 *  3. Actualiza `users/{uid}` con `{ displayName, idNumber }`.
 *  4. Si el paso 3 falla, intenta liberar el candado (rollback best-effort).
 *
 * Errores:
 *  - `DuplicateIdNumberError` si el DNI ya está reclamado.
 *  - `Error` si el formato no cumple.
 */
export async function completeUserProfile(
  uid: string,
  payload: { displayName: string; idNumber: string },
): Promise<void> {
  const displayName = (payload.displayName ?? '').trim()
  const idNumber = normalizeIdNumber(payload.idNumber)
  if (!displayName) throw new Error('El nombre completo es obligatorio.')
  if (!isValidIdNumber(idNumber)) {
    throw new Error('El Nro de Cédula/DNI debe tener entre 6 y 12 dígitos.')
  }

  await claimIdNumber(uid, idNumber)

  try {
    await updateDoc(doc(db, 'users', uid), {
      displayName,
      idNumber,
      updatedAt: serverTimestamp(),
    })
  } catch (e) {
    if (import.meta.env.DEV) {
      console.warn('[completeUserProfile] update users failed, releasing claim:', e)
    }
    void releaseIdNumber(idNumber)
    throw e
  }
}

/**
 * Permite a un admin actualizar el DNI de otro usuario.
 * - Si el user ya tenía un DNI viejo, libera el candado viejo.
 * - Reclama el candado nuevo (a nombre del propio usuario destino).
 * - Actualiza users/{uid}.
 */
export async function adminUpdateUserIdNumber(
  targetUid: string,
  newIdNumber: string,
): Promise<void> {
  const idNumber = normalizeIdNumber(newIdNumber)
  if (!isValidIdNumber(idNumber)) {
    throw new Error('El Nro de Cédula/DNI debe tener entre 6 y 12 dígitos.')
  }
  const userRef = doc(db, 'users', targetUid)
  const userSnap = await getDoc(userRef)
  if (!userSnap.exists()) throw new Error(`Usuario ${targetUid} no existe.`)
  const userData = userSnap.data() as UserProfile
  const oldIdNumber = userData.idNumber ? normalizeIdNumber(userData.idNumber) : ''

  if (oldIdNumber === idNumber) return

  await claimIdNumber(targetUid, idNumber)

  try {
    await updateDoc(userRef, { idNumber, updatedAt: serverTimestamp() })
  } catch (e) {
    void releaseIdNumber(idNumber)
    throw e
  }

  if (oldIdNumber) {
    void releaseIdNumber(oldIdNumber)
  }
}

// ─── Solicitudes "No recuerdo el mail" ─────────────────────────────────────

/**
 * Crea una solicitud de recuperación de mail. Llamada por el usuario nuevo
 * que se topó con un DNI duplicado al intentar completar su perfil.
 */
export async function submitEmailRecoveryRequest(payload: {
  requestingUid: string
  requestingEmail: string | null
  requestingDisplayName: string | null
  idNumber: string
}): Promise<string> {
  const idNumber = normalizeIdNumber(payload.idNumber)
  if (!isValidIdNumber(idNumber)) {
    throw new Error('Nro de Cédula/DNI inválido.')
  }
  const ref = await addDoc(collection(db, 'email_recovery_requests'), {
    requestingUid: payload.requestingUid,
    requestingEmail: payload.requestingEmail ?? null,
    requestingDisplayName: payload.requestingDisplayName ?? null,
    idNumber,
    status: 'PENDING' as EmailRecoveryStatus,
    createdAt: serverTimestamp(),
  })
  return ref.id
}

/** Lista solicitudes de recuperación filtradas por estado. */
export async function listEmailRecoveryRequests(
  status?: EmailRecoveryStatus,
): Promise<EmailRecoveryRequest[]> {
  const constraints = status ? [where('status', '==', status)] : []
  const q = query(collection(db, 'email_recovery_requests'), ...constraints)
  const snap = await getDocs(q)
  const rows = snap.docs.map(
    (d) => ({ id: d.id, ...(d.data() as Omit<EmailRecoveryRequest, 'id'>) }),
  )
  rows.sort((a, b) => {
    const ta = (a.createdAt as { seconds?: number } | undefined)?.seconds ?? 0
    const tb = (b.createdAt as { seconds?: number } | undefined)?.seconds ?? 0
    return tb - ta
  })
  return rows
}

/** Marca una solicitud como RESOLVED (admin la atendió). */
export async function resolveEmailRecoveryRequest(
  requestId: string,
  adminUid: string,
  payload?: { existingUid?: string; notes?: string },
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: 'RESOLVED' as EmailRecoveryStatus,
    resolvedBy: adminUid,
    resolvedAt: serverTimestamp(),
  }
  if (payload?.existingUid) patch.existingUid = payload.existingUid
  if (payload?.notes) patch.notes = payload.notes
  await updateDoc(doc(db, 'email_recovery_requests', requestId), patch)
}

/** Marca una solicitud como DISMISSED (descartada por admin). */
export async function dismissEmailRecoveryRequest(
  requestId: string,
  adminUid: string,
  notes?: string,
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: 'DISMISSED' as EmailRecoveryStatus,
    resolvedBy: adminUid,
    resolvedAt: serverTimestamp(),
  }
  if (notes) patch.notes = notes
  await updateDoc(doc(db, 'email_recovery_requests', requestId), patch)
}
