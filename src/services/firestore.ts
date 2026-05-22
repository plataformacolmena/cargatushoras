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
import { db } from '../firebase'
import { calcEngancheExtras, calculateEntry, calculateSettlement, getDefaultProjectConfig } from '../lib/calc'
import type {
  AppRole,
  CycleMode,
  Project,
  ProjectArea,
  ProjectConfig,
  ProjectCreateInput,
  ProjectRole,
  ProjectRoleInput,
  ProjectTemplate,
  ProjectUpdateInput,
  Settlement,
  TimeEntry,
  TimeEntryInput,
  UserProfile,
  WorkCycle,
} from '../types/domain'

const CALCULATION_VERSION = 'v1-client'

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

  if (!snapshot.exists()) {
    // Verificar si el email coincide con un placeholder importado en users
    if (payload.email) {
      const emailLower = payload.email.toLowerCase().trim()
      const placeholderQuery = query(
        collection(db, 'users'),
        where('email', '==', emailLower),
        where('isPlaceholder', '==', true),
      )

      let placeholderSnap: Awaited<ReturnType<typeof getDocs>>
      try {
        placeholderSnap = await getDocs(placeholderQuery)
      } catch (e) {
        if (import.meta.env.DEV) console.error('[upsert] placeholder query failed:', e)
        throw e
      }

      // Tomar el primer placeholder no fusionado
      const placeholderDoc = placeholderSnap.docs.find((d) => {
        const data = d.data() as UserProfile
        return !data.mergedToUid
      })

      if (placeholderDoc) {
        const placeholderData = placeholderDoc.data() as UserProfile
        const placeholderUid = placeholderDoc.id

        const newProfile: UserProfile = {
          uid: payload.uid,
          email: payload.email,
          displayName: payload.displayName ?? placeholderData.displayName ?? null,
          role: placeholderData.role ?? 'MEMBER',
          approvalStatus: placeholderData.approvalStatus ?? 'PENDING',
          ...(placeholderData.projectId ? { projectId: placeholderData.projectId } : {}),
          ...(placeholderData.areaId ? { areaId: placeholderData.areaId } : {}),
          ...(placeholderData.roleId ? { roleId: placeholderData.roleId } : {}),
          migratedFromUid: placeholderUid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }

        // 1. Crear perfil real
        try {
          await setDoc(userRef, newProfile)
        } catch (e) {
          if (import.meta.env.DEV) console.error('[migration] step1 setDoc failed:', e)
          throw e
        }

        // 2. Reasignar entradas de tiempo en lotes
        let entriesSnap
        try {
          entriesSnap = await getDocs(
            query(collection(db, 'time_entries'), where('userId', '==', placeholderUid)),
          )
        } catch (e) {
          if (import.meta.env.DEV) console.error('[migration] step2 getDocs failed:', e)
          throw e
        }
        const CHUNK = 440
        for (let i = 0; i < entriesSnap.docs.length; i += CHUNK) {
          const b = writeBatch(db)
          for (const e of entriesSnap.docs.slice(i, i + CHUNK)) {
            b.update(e.ref, { userId: payload.uid })
          }
          try {
            await b.commit()
          } catch (e) {
            if (import.meta.env.DEV) console.error('[migration] step2 batch failed:', e)
            throw e
          }
        }

        // 3. Marcar placeholder como fusionado
        try {
          await updateDoc(placeholderDoc.ref, {
            isPlaceholder: false,
            mergedToUid: payload.uid,
            updatedAt: serverTimestamp(),
          })
        } catch (e) {
          if (import.meta.env.DEV) console.warn('[migration] step3 placeholder merge skipped:', e)
        }

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

  const data = snapshot.data() as UserProfile
  const updateData: Record<string, unknown> = { email: payload.email, updatedAt: serverTimestamp() }
  if (payload.displayName != null) updateData.displayName = payload.displayName
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
  user: Pick<UserProfile, 'uid' | 'displayName' | 'areaId'>,
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
    areaId: user.areaId ?? null,
    calculation,
    calculationSource: 'client',
    calculationVersion: CALCULATION_VERSION,
    lockedByAdmin: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  // Recalcular enganche/reenganche (debounced para agrupar ediciones consecutivas)
  scheduleRecalculateUserEntries(input.projectId, user.uid)
}

export async function saveTimeEntryForUser(
  input: TimeEntryInput,
  targetUser: Pick<UserProfile, 'uid' | 'displayName' | 'areaId'>,
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
    areaId: targetUser.areaId ?? null,
    calculation,
    calculationSource: 'client',
    calculationVersion: CALCULATION_VERSION,
    lockedByAdmin: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  scheduleRecalculateUserEntries(input.projectId, targetUser.uid)
}

export async function listMyTimeEntries(userId: string, projectId: string): Promise<TimeEntry[]> {
  const q = query(
    collection(db, 'time_entries'),
    where('userId', '==', userId),
    where('projectId', '==', projectId),
    orderBy('workDate', 'desc'),
  )

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

export async function approveUser(
  userId: string,
  role: AppRole = 'MEMBER',
  projectId?: string,
  areaId?: string,
  roleId?: string,
): Promise<void> {
  const userRef = doc(db, 'users', userId)
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
  const [entries, config, userSnap] = await Promise.all([
    listMyTimeEntries(userId, projectId),
    getProjectConfig(projectId),
    getDoc(doc(db, 'users', userId)),
  ])
  const userCycleMode = (userSnap.data() as UserProfile | undefined)?.cycleMode ?? 'CYCLE'
  const userCycleModes = new Map<string, 'CYCLE' | 'REINFORCEMENT'>([[userId, userCycleMode]])

  const toUpdate = entries.filter((e) => !e.lockedByAdmin)

  const entriesForExtras = toUpdate.map((e) => ({
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

export async function deleteTimeEntry(entryId: string, projectId: string, userId: string): Promise<void> {
  await deleteDoc(doc(db, 'time_entries', entryId))
  scheduleRecalculateUserEntries(projectId, userId)
}

export async function updateTimeEntry(
  entryId: string,
  input: Omit<TimeEntryInput, 'projectId'>,
  projectId: string,
  userId: string,
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
  for (const d of usersSnap.docs) {
    const u = d.data() as UserProfile
    userCycleModes.set(u.uid, u.cycleMode ?? 'CYCLE')
  }

  const toUpdate = entries.filter(
    (e) =>
      !e.lockedByAdmin &&
      !lockedRanges.some((r) => e.workDate >= r.dateFrom && e.workDate <= r.dateTo),
  )

  const entriesForExtras = toUpdate.map((e) => ({
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

  // Tarifa por hora = dailyRate del rol del usuario / regularDailyHours
  const userRates = new Map<string, { hourlyRate: number; roleId?: string; roleName?: string }>()
  for (const user of projectUsers) {
    const role = user.roleId ? projectRoles.find((r) => r.id === user.roleId) : undefined
    const hourlyRate = role ? Math.round((role.dailyRate / config.regularDailyHours) * 100) / 100 : 0
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
      ...data,
      createdAt: serverTimestamp(),
    })
  })
  return { ...settlement, id: newRef.id }
}

export async function deleteSettlement(settlementId: string): Promise<void> {
  await deleteDoc(doc(db, 'settlements', settlementId))
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
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Project, 'id'>) })))
  })
}

export function subscribeToMyEntries(
  userId: string,
  projectId: string,
  callback: (entries: TimeEntry[]) => void,
  opts?: { since?: string },
): () => void {
  const conditions = [
    where('userId', '==', userId),
    where('projectId', '==', projectId),
  ]
  if (opts?.since) {
    conditions.push(where('workDate', '>=', opts.since))
  }
  const q = query(collection(db, 'time_entries'), ...conditions, orderBy('workDate', 'desc'))
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<TimeEntry, 'id'>) })))
  })
}

export function subscribeToProjectEntries(
  projectId: string,
  callback: (entries: TimeEntry[]) => void,
  opts?: { since?: string },
): () => void {
  const conditions = [where('projectId', '==', projectId)]
  if (opts?.since) {
    conditions.push(where('workDate', '>=', opts.since))
  }
  const q = query(collection(db, 'time_entries'), ...conditions, orderBy('workDate', 'desc'))
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<TimeEntry, 'id'>) })))
  })
}

/** Suscripción filtrada por área (server-side). Requiere índice (projectId, areaId, workDate desc). */
export function subscribeToAreaEntries(
  projectId: string,
  areaId: string,
  callback: (entries: TimeEntry[]) => void,
  opts?: { since?: string },
): () => void {
  const conditions = [where('projectId', '==', projectId), where('areaId', '==', areaId)]
  if (opts?.since) {
    conditions.push(where('workDate', '>=', opts.since))
  }
  const q = query(collection(db, 'time_entries'), ...conditions, orderBy('workDate', 'desc'))
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<TimeEntry, 'id'>) })))
  })
}

export function subscribeToPendingUsers(callback: (users: UserProfile[]) => void): () => void {
  const q = query(collection(db, 'users'), where('approvalStatus', '==', 'PENDING'))
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => d.data() as UserProfile))
  })
}

export async function listImportedPlaceholders(): Promise<UserProfile[]> {
  const q = query(collection(db, 'users'), where('isPlaceholder', '==', true))
  const snap = await getDocs(q)
  return snap.docs
    .map((d) => d.data() as UserProfile)
    .filter((u) => !u.mergedToUid && u.approvalStatus === 'PENDING')
    .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''))
}

export function subscribeToApprovedUsers(
  callback: (users: UserProfile[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(collection(db, 'users'), where('approvalStatus', '==', 'APPROVED'))
  return onSnapshot(
    q,
    (snap) => {
      const users = snap.docs
        .map((d) => d.data() as UserProfile)
        .filter((u) => !u.mergedToUid)
        .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''))
      callback(users)
    },
    onError,
  )
}

export function subscribeToProjectUsers(
  projectId: string,
  callback: (users: UserProfile[]) => void,
): () => void {
  const q = query(
    collection(db, 'users'),
    where('approvalStatus', '==', 'APPROVED'),
    where('projectId', '==', projectId),
  )
  return onSnapshot(q, (snap) => {
    const users = snap.docs
      .map((d) => d.data() as UserProfile)
      .filter((u) => !u.mergedToUid)
      .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''))
    callback(users)
  })
}

// ─── Importación masiva de miembros (placeholders en users) ────────────────

/** Suscribe a los placeholders pendientes (miembros importados que aún no han iniciado sesión). */
export function subscribeToImportedPlaceholders(
  callback: (users: UserProfile[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(collection(db, 'users'), where('isPlaceholder', '==', true))
  return onSnapshot(
    q,
    (snap) => {
      const users = snap.docs
        .map((d) => d.data() as UserProfile)
        .filter((u) => !u.mergedToUid && u.approvalStatus === 'PENDING')
        .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''))
      callback(users)
    },
    onError,
  )
}

/** Aprueba un placeholder importado: actualiza approvalStatus y asignaciones. */
export async function approveImportedPlaceholder(
  placeholderUid: string,
  role: AppRole,
  projectId?: string,
  areaId?: string,
  roleId?: string,
): Promise<void> {
  const userRef = doc(db, 'users', placeholderUid)
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
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }
    batch.set(ref, placeholder)
  }
  await batch.commit()

  return { imported: toImport.length, duplicates }
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

/** Suscripción en tiempo real a los ciclos del usuario en el proyecto. */
export function subscribeToUserWorkCycles(
  projectId: string,
  userId: string,
  callback: (cycles: WorkCycle[]) => void,
  onError?: (err: unknown) => void,
): () => void {
  const q = query(
    collection(db, 'user_work_cycles'),
    where('projectId', '==', projectId),
    where('userId', '==', userId),
  )
  return onSnapshot(
    q,
    (snap) => {
      const cycles = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<WorkCycle, 'id'>) }))
        .sort((a, b) => a.anchorDate.localeCompare(b.anchorDate))
      callback(cycles)
    },
    (err) => {
      onError?.(err)
    },
  )
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
