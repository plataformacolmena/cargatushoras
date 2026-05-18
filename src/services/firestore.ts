import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
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
} from '../types/domain'

const CALCULATION_VERSION = 'v1-client'

export async function upsertUserProfile(payload: {
  uid: string
  email: string | null
  displayName: string | null
}): Promise<UserProfile> {
  const userRef = doc(db, 'users', payload.uid)

  let snapshot: Awaited<ReturnType<typeof getDoc>>
  try {
    snapshot = await getDoc(userRef)
    console.log('[upsert] A: getDoc(userRef) OK, exists=', snapshot.exists())
  } catch (e) {
    console.error('[upsert] A: getDoc(userRef) FAILED:', e)
    throw e
  }

  if (!snapshot.exists()) {
    // Verificar si el email coincide con un placeholder importado en users
    if (payload.email) {
      const emailLower = payload.email.toLowerCase().trim()
      console.log('[upsert] looking for placeholder with email=', emailLower)
      const placeholderQuery = query(
        collection(db, 'users'),
        where('email', '==', emailLower),
        where('isPlaceholder', '==', true),
      )

      let placeholderSnap: Awaited<ReturnType<typeof getDocs>>
      try {
        placeholderSnap = await getDocs(placeholderQuery)
        console.log('[upsert] B: getDocs(placeholder by email) OK, found=', placeholderSnap.size)
      } catch (e) {
        console.error('[upsert] B: getDocs(placeholder by email) FAILED:', e)
        throw e
      }

      // Tomar el primer placeholder no fusionado
      const placeholderDoc = placeholderSnap.docs.find((d) => {
        const data = d.data() as UserProfile
        return !data.mergedToUid
      })
      console.log('[upsert] placeholder selected?', !!placeholderDoc)

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
          console.log('[migration] step1 setDoc OK')
        } catch (e) {
          console.error('[migration] step1 setDoc FAILED:', e)
          throw e
        }

        // 2. Reasignar entradas de tiempo en lotes
        let entriesSnap
        try {
          entriesSnap = await getDocs(
            query(collection(db, 'time_entries'), where('userId', '==', placeholderUid)),
          )
          console.log('[migration] step2 getDocs OK, entries:', entriesSnap.docs.length)
        } catch (e) {
          console.error('[migration] step2 getDocs FAILED:', e)
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
            console.log('[migration] step2 batch commit OK (offset', i, ')')
          } catch (e) {
            console.error('[migration] step2 batch commit FAILED (offset', i, '):', e)
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
          console.log('[migration] step3 placeholder merge OK')
        } catch (e) {
          console.warn('[migration] step3 placeholder merge SKIPPED (non-critical):', e)
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
    console.log('[upsert] F: updateDoc(existing profile) OK')
  } catch (e) {
    console.error('[upsert] F: updateDoc(existing profile) FAILED:', e)
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
  // Recalcular enganche/reenganche para todo el historial del usuario
  await recalculateUserEntries(input.projectId, user.uid)
}

export async function saveTimeEntryForUser(
  input: TimeEntryInput,
  targetUser: Pick<UserProfile, 'uid' | 'displayName' | 'areaId'>,
): Promise<void> {
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
  await recalculateUserEntries(input.projectId, targetUser.uid)
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
  const userRef = doc(db, 'users', userId)
  await updateDoc(userRef, { role, updatedAt: serverTimestamp() })
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
 * Se llama automáticamente tras guardar, editar o eliminar una jornada.
 */
export async function recalculateUserEntries(projectId: string, userId: string): Promise<void> {
  const [entries, config] = await Promise.all([
    listMyTimeEntries(userId, projectId),
    getProjectConfig(projectId),
  ])
  const toUpdate = entries.filter((e) => !e.lockedByAdmin)
  const engancheMap = calcEngancheExtras(toUpdate, config)

  for (let i = 0; i < toUpdate.length; i += 400) {
    const batch = writeBatch(db)
    for (const entry of toUpdate.slice(i, i + 400)) {
      const extras = engancheMap.get(entry.id)
      const calculation = calculateEntry(entry.timeIn, entry.timeOut, config, {
        penalties: (entry as TimeEntry & { penalties?: number }).penalties ?? 0,
        isJornadaAdicional: (entry as TimeEntry & { isJornadaAdicional?: boolean }).isJornadaAdicional ?? false,
        engancheExtraHours: extras?.enganche ?? 0,
        reengancheExtraHours: extras?.reenganche ?? 0,
      })
      batch.update(doc(db, 'time_entries', entry.id), {
        calculation,
        updatedAt: serverTimestamp(),
      })
    }
    await batch.commit()
  }
}

export async function deleteTimeEntry(entryId: string, projectId: string, userId: string): Promise<void> {
  await deleteDoc(doc(db, 'time_entries', entryId))
  await recalculateUserEntries(projectId, userId)
}

export async function updateTimeEntry(
  entryId: string,
  input: Omit<TimeEntryInput, 'projectId'>,
  projectId: string,
  userId: string,
): Promise<void> {
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
  await recalculateUserEntries(projectId, userId)
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
  updates: Partial<Pick<UserProfile, 'displayName' | 'areaId' | 'roleId' | 'projectId' | 'role'>>,
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
): Promise<number> {
  const [entries, config] = await Promise.all([
    listAllTimeEntries(projectId, {}),
    getProjectConfig(projectId),
  ])

  const toUpdate = entries.filter(
    (e) =>
      !e.lockedByAdmin &&
      !lockedRanges.some((r) => e.workDate >= r.dateFrom && e.workDate <= r.dateTo),
  )

  // Calcular extras de enganche/reenganche para el lote completo
  const engancheMap = calcEngancheExtras(toUpdate, config)

  for (let i = 0; i < toUpdate.length; i += 400) {
    const batch = writeBatch(db)
    for (const entry of toUpdate.slice(i, i + 400)) {
      const extras = engancheMap.get(entry.id)
      const calculation = calculateEntry(entry.timeIn, entry.timeOut, config, {
        penalties: (entry as TimeEntry & { penalties?: number }).penalties ?? 0,
        isJornadaAdicional: (entry as TimeEntry & { isJornadaAdicional?: boolean }).isJornadaAdicional ?? false,
        engancheExtraHours: extras?.enganche ?? 0,
        reengancheExtraHours: extras?.reenganche ?? 0,
      })
      batch.update(doc(db, 'time_entries', entry.id), {
        calculation,
        updatedAt: serverTimestamp(),
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
): Promise<number> {
  const [entries, usersSnap] = await Promise.all([
    listAllTimeEntries(projectId, {}),
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
  const docRef = await addDoc(collection(db, 'settlements'), {
    ...data,
    createdAt: serverTimestamp(),
  })
  return { ...settlement, id: docRef.id }
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
): () => void {
  const q = query(
    collection(db, 'time_entries'),
    where('userId', '==', userId),
    where('projectId', '==', projectId),
    orderBy('workDate', 'desc'),
  )
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<TimeEntry, 'id'>) })))
  })
}

export function subscribeToProjectEntries(
  projectId: string,
  callback: (entries: TimeEntry[]) => void,
): () => void {
  const q = query(
    collection(db, 'time_entries'),
    where('projectId', '==', projectId),
    orderBy('workDate', 'desc'),
  )
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

/** Migra la colección legacy imported_members → users (placeholders).
 *  Se ejecuta una sola vez por admin si quedan registros antiguos.
 */
export async function migrateLegacyImportedMembers(): Promise<number> {
  const legacySnap = await getDocs(collection(db, 'imported_members'))
  if (legacySnap.empty) return 0

  // Email → uid del placeholder ya existente en users (si fue preApproved con placeholderUid)
  const usersSnap = await getDocs(query(collection(db, 'users'), where('isPlaceholder', '==', true)))
  const existingPlaceholderEmails = new Set<string>()
  usersSnap.docs.forEach((d) => {
    const data = d.data() as UserProfile
    if (data.email && !data.mergedToUid) existingPlaceholderEmails.add(data.email.toLowerCase())
  })

  let migrated = 0
  const batch = writeBatch(db)
  for (const d of legacySnap.docs) {
    const data = d.data() as Record<string, unknown>
    const email = (data.email as string) || d.id
    const displayName = (data.displayName as string) || ''
    const claimed = data.claimed === true
    const placeholderUid = data.placeholderUid as string | undefined
    const projectId = data.projectId as string | undefined

    // Si ya fue reclamado, simplemente borrar el legacy
    if (claimed) {
      batch.delete(d.ref)
      continue
    }

    // Si tiene placeholderUid → ese placeholder ya existe en users (admin lo preaprobó)
    if (placeholderUid) {
      batch.delete(d.ref)
      continue
    }

    // Si no hay placeholder y el email no existe en users → crear placeholder
    if (!existingPlaceholderEmails.has(email.toLowerCase())) {
      const ref = doc(collection(db, 'users'))
      const placeholder: UserProfile = {
        uid: ref.id,
        email: email.toLowerCase(),
        displayName: displayName || null,
        role: 'MEMBER',
        approvalStatus: 'PENDING',
        isPlaceholder: true,
        ...(projectId ? { projectId } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }
      batch.set(ref, placeholder)
      existingPlaceholderEmails.add(email.toLowerCase())
      migrated++
    }

    batch.delete(d.ref)
  }
  await batch.commit()
  return migrated
}
