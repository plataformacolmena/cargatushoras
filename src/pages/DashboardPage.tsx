import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import * as XLSX from 'xlsx'
import { useAuth } from '../auth/useAuth'
import { SupportChatPanel } from '../components/SupportChatPanel'
import { Pagination, usePagedItems } from '../components/Pagination'
import { LoadingOverlay, Spinner } from '../components/Spinner'
import { OnlineStatusIndicator } from '../components/OnlineStatusIndicator'
import {
  applyProjectTemplate,
  approveUser,
  createProject,
  createProjectArea,
  createProjectRole,
  deleteProject,
  deleteProjectArea,
  deleteProjectRole,
  deleteTimeEntry,
  deleteSettlement,
  approveImportedPlaceholder,
  deleteImportedPlaceholder,
  getProjectConfig,
  importMembers,
  listAllProjects,
  listAllTimeEntries,
  listProjectAreas,
  listProjectRoles,
  listProjectTemplates,
  listSettlements,
  previewSettlement,
  recalculateProjectEntries,
  saveSettlement,
  saveProjectConfig,
  syncUserAreasToEntries,
  saveProjectTemplate,
  saveTimeEntry,
  saveTimeEntryForUser,
  setEntryReviewColor,
  setUserAuditReviewColor,
  setUserRole,
  listApprovedUsers,
  listPendingUsers,
  listImportedPlaceholders,
  repairMergedPlaceholders,
  subscribeToMyEntries,
  subscribeToProjectEntries,
  subscribeToAreaEntries,
  subscribeToProjectUsers,
  subscribeToProjects,
  listUsersWithoutEntries,
  type NoReportUserRow,
  updateProject,
  updateProjectArea,
  countUserTimeEntries,
  deleteUserProfile,
  setUserDisabled,
  updateProjectRole,
  updateTimeEntry,
  updateUserProfileAdmin,
  recalculateUserEntries,
} from '../services/firestore'
import type {
  AppRole,
  Project,
  ProjectArea,
  ProjectConfig,
  ProjectCreateInput,
  ProjectRole,
  ProjectRoleInput,
  ProjectTemplate,
  Settlement,
  TimeEntry,
  TimeEntryInput,
  UserProfile,
} from '../types/domain'

type MainTab = 'PROJECTS' | 'PROJECT_MANAGEMENT' | 'USERS' | 'HELP'
type ProjectTab =
  | 'PROJECT_CONFIG'
  | 'TIME_ENTRY_FORM'
  | 'TIME_ENTRY_TABLE'
  | 'TIME_ENTRY_AUDIT'
  | 'SETTLEMENTS'
type UserTab = 'PENDING' | 'APPROVED'

interface Toast {
  id: number
  message: string
  type: 'success' | 'error' | 'info'
}

function canSeeConfig(role: UserProfile['role']): boolean {
  return role === 'SUPERUSER' || role === 'PROJECT_ADMIN'
}

function canSeeProjectAdmin(role: UserProfile['role']): boolean {
  return role === 'SUPERUSER'
}

function canAudit(role: UserProfile['role']): boolean {
  return role === 'SUPERUSER' || role === 'PROJECT_ADMIN'
}

/** Devuelve YYYY-MM-DD máximo permitido según la política, o null si no hay restricción. */
function getMaxWorkDate(policy: 'ALLOW' | 'TODAY' | 'TODAY_PLUS_ONE' | undefined): string | null {
  if (!policy || policy === 'ALLOW') return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (policy === 'TODAY_PLUS_ONE') today.setDate(today.getDate() + 1)
  const y = today.getFullYear()
  const m = String(today.getMonth() + 1).padStart(2, '0')
  const d = String(today.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Formatea YYYY-MM-DD → DD-MM-AA para mostrar en pantalla. */
function formatDate(dateStr: string): string {
  if (!dateStr || dateStr.length < 10) return dateStr
  const [y, m, d] = dateStr.split('-')
  return `${d}-${m}-${y.slice(2)}`
}

function downloadEntriesCSV(entries: TimeEntry[], downloader: UserProfile, areas: ProjectArea[]) {
  const areaName = areas.find((a) => a.id === downloader.areaId)?.name ?? 'Todas las áreas'
  const downloadedAt = new Date().toLocaleString('es-UY', { timeZone: 'America/Montevideo' })
  const userName = downloader.displayName ?? downloader.email ?? downloader.uid

  const header = [
    `# CargaTusHoras — Descarga de horarios`,
    `# Fecha de descarga: ${downloadedAt}`,
    `# Área: ${areaName}`,
    `# Descargado por: ${userName}`,
    ``,
    `Fecha,Jornada,Usuario,Entrada,Salida,Hs. Trabajadas,Hs. Extras,Hs. Nocturnas,Notas`,
  ]

  const rows = entries.map((e) => {
    const notes = (e.notes ?? '').replace(/"/g, '""')
    return [
      e.workDate,
      `"${e.shiftLabel}"`,
      `"${e.userName ?? ''}"`,
      e.timeIn,
      e.timeOut,
      e.calculation.workedHours,
      e.calculation.overtimeHours,
      e.calculation.nightHours,
      `"${notes}"`,
    ].join(',')
  })

  const csv = [...header, ...rows].join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `horarios_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

const REVIEW_COLORS = [
  { value: 'green',  defaultLabel: 'Revisado',      bg: '#22c55e', tint: 'rgba(34,197,94,0.13)'  },
  { value: 'yellow', defaultLabel: 'En revisión',   bg: '#eab308', tint: 'rgba(234,179,8,0.15)'  },
  { value: 'red',    defaultLabel: 'Con problemas', bg: '#ef4444', tint: 'rgba(239,68,68,0.13)'  },
  { value: 'orange', defaultLabel: 'Pendiente',     bg: '#f97316', tint: 'rgba(249,115,22,0.13)' },
  { value: 'blue',   defaultLabel: 'Consulta',      bg: '#3b82f6', tint: 'rgba(59,130,246,0.13)' },
] as const

// ─── Persistencia de navegación ───────────────────────────────────────────
const LS_PREFIX = 'cargatushoras:nav:'
function readLS<T extends string>(key: string, fallback: T, allowed?: readonly T[]): T {
  try {
    const v = localStorage.getItem(LS_PREFIX + key)
    if (!v) return fallback
    if (allowed && !allowed.includes(v as T)) return fallback
    return v as T
  } catch {
    return fallback
  }
}
function writeLS(key: string, value: string) {
  try { localStorage.setItem(LS_PREFIX + key, value) } catch { /* noop */ }
}
const MAIN_TABS = ['PROJECTS', 'PROJECT_MANAGEMENT', 'USERS', 'HELP'] as const
const PROJECT_TABS = ['PROJECT_CONFIG', 'TIME_ENTRY_FORM', 'TIME_ENTRY_TABLE', 'TIME_ENTRY_AUDIT', 'SETTLEMENTS'] as const
const USER_TABS = ['PENDING', 'APPROVED'] as const

export function DashboardPage() {
  const { profile, signOutUser, user } = useAuth()
  const toastIdRef = useRef(0)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [mainTab, setMainTab] = useState<MainTab>(() => readLS<MainTab>('mainTab', 'PROJECTS', MAIN_TABS))
  const [projectTab, setProjectTab] = useState<ProjectTab>(() => readLS<ProjectTab>('projectTab', 'TIME_ENTRY_FORM', PROJECT_TABS))
  const [userTab, setUserTab] = useState<UserTab>(() => readLS<UserTab>('userTab', 'PENDING', USER_TABS))

  // Persistir tabs
  useEffect(() => { writeLS('mainTab', mainTab) }, [mainTab])
  useEffect(() => { writeLS('projectTab', projectTab) }, [projectTab])
  useEffect(() => { writeLS('userTab', userTab) }, [userTab])

  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState('')
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [pendingUsers, setPendingUsers] = useState<UserProfile[]>([])
  const [approvedUsers, setApprovedUsers] = useState<UserProfile[]>([])
  const [importedMembers, setImportedMembers] = useState<UserProfile[]>([])
  const [importPreview, setImportPreview] = useState<{ toImport: { email: string; displayName: string }[]; duplicates: string[] } | null>(null)
  const [importLoading, setImportLoading] = useState(false)
  const [userSearch, setUserSearch] = useState('')
  const [areas, setAreas] = useState<ProjectArea[]>([])
  const [newAreaName, setNewAreaName] = useState('')
  const [allProjects, setAllProjects] = useState<Project[]>([])
  const [projectFormMode, setProjectFormMode] = useState<'create' | 'edit' | null>(null)
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  const [projectFormData, setProjectFormData] = useState<ProjectCreateInput>({
    name: '',
    code: '',
    description: '',
  })
  const [projectInitialAdminId, setProjectInitialAdminId] = useState('')
  const [approvedUsersList, setApprovedUsersList] = useState<UserProfile[]>([])
  const [projectConfig, setProjectConfig] = useState<ProjectConfig | null>(null)
  const [configStatus, setConfigStatus] = useState('')

  // Editar/eliminar propias entradas
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null)
  const [editEntryForm, setEditEntryForm] = useState<Omit<TimeEntryInput, 'projectId'>>({
    workDate: '',
    shiftLabel: '',
    timeIn: '',
    timeOut: '',
    notes: '',
    penalties: 0,
    isJornadaAdicional: false,
  })

  // Auditoría
  const [auditEntries, setAuditEntries] = useState<TimeEntry[]>([])
  const [auditFilters, setAuditFilters] = useState({ dateFrom: '', dateTo: '', userId: '', areaId: '' })
  const [auditLoading, setAuditLoading] = useState(false)
  const [editingAuditEntry, setEditingAuditEntry] = useState<TimeEntry | null>(null)
  const [editAuditForm, setEditAuditForm] = useState<Omit<TimeEntryInput, 'projectId'>>({
    workDate: '',
    shiftLabel: '',
    timeIn: '',
    timeOut: '',
    notes: '',
    penalties: 0,
    isJornadaAdicional: false,
  })

  // Liquidaciones
  const [settlementForm, setSettlementForm] = useState({ dateFrom: '', dateTo: '' })
  const [currentSettlement, setCurrentSettlement] = useState<Settlement | null>(null)
  const [editableLines, setEditableLines] = useState<Settlement['lines']>([])
  const [isSettlementSaved, setIsSettlementSaved] = useState(false)
  const [pastSettlements, setPastSettlements] = useState<Settlement[]>([])
  const [settlementLoading, setSettlementLoading] = useState(false)

  // Modal de aprobación de usuario
  const [approvingUser, setApprovingUser] = useState<UserProfile | null>(null)
  const [approveForm, setApproveForm] = useState<{ role: AppRole; projectId: string; areaId: string; roleId: string }>({
    role: 'MEMBER',
    projectId: '',
    areaId: '',
    roleId: '',
  })
  const [approveAreas, setApproveAreas] = useState<ProjectArea[]>([])
  const [approveRoles, setApproveRoles] = useState<ProjectRole[]>([])

  // Admin: cargar jornadas para otros usuarios
  const [projectUsers, setProjectUsers] = useState<UserProfile[]>([])
  const [adminEntryUserId, setAdminEntryUserId] = useState('')
  const [adminEntryForm, setAdminEntryForm] = useState<Omit<TimeEntryInput, 'projectId'>>({ workDate: '', shiftLabel: '', timeIn: '', timeOut: '', notes: '', penalties: 0, isJornadaAdicional: false })

  // Roles del proyecto activo
  const [projectRoles, setProjectRoles] = useState<ProjectRole[]>([])
  const [newRoleForm, setNewRoleForm] = useState<ProjectRoleInput>({ name: '', dailyRate: 0, weeklyRate: 0, monthlyRate: 0 })
  const [editingRole, setEditingRole] = useState<ProjectRole | null>(null)
  const [editRoleForm, setEditRoleForm] = useState<ProjectRoleInput>({ name: '', dailyRate: 0, weeklyRate: 0, monthlyRate: 0 })

  // Edición inline de área
  const [editingAreaId, setEditingAreaId] = useState<string | null>(null)
  const [editAreaName, setEditAreaName] = useState('')

  // Edición de usuarios aprobados
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null)
  const [editUserForm, setEditUserForm] = useState({ displayName: '', areaId: '', roleId: '', projectId: '', cycleMode: 'CYCLE' as 'CYCLE' | 'REINFORCEMENT' })
  const [editUserAreas, setEditUserAreas] = useState<ProjectArea[]>([])
  const [editUserRoles, setEditUserRoles] = useState<ProjectRole[]>([])
  // Estados de guardado/edición/eliminación de jornadas (para spinners en UI)
  const [savingEntry, setSavingEntry] = useState(false)
  const [savingEditEntry, setSavingEditEntry] = useState(false)
  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null)

  // Templates de proyecto
  const [templates, setTemplates] = useState<ProjectTemplate[]>([])
  const [newTemplateName, setNewTemplateName] = useState('')
  const [templateLoading, setTemplateLoading] = useState(false)

  // Rangos bloqueados por liquidaciones
  const [lockedRanges, setLockedRanges] = useState<Array<{ dateFrom: string; dateTo: string }>>([])

  // Modal de recálculo/sync de áreas por rango
  const [rangeOpModal, setRangeOpModal] = useState<{ op: 'RECALC' | 'SYNC_AREAS'; dateFrom: string; dateTo: string } | null>(null)
  const [rangeOpBusy, setRangeOpBusy] = useState(false)

  // Auditoría: usuarios sin informar
  const [noReportFilters, setNoReportFilters] = useState<{ dateFrom: string; dateTo: string; areaId: string }>({ dateFrom: '', dateTo: '', areaId: '' })
  const [noReportRows, setNoReportRows] = useState<NoReportUserRow[]>([])
  const [noReportLoading, setNoReportLoading] = useState(false)

  const [form, setForm] = useState<TimeEntryInput>({
    projectId: '',
    workDate: new Date().toISOString().slice(0, 10),
    shiftLabel: 'Jornada principal',
    timeIn: '09:00',
    timeOut: '18:00',
    notes: '',
    penalties: 0,
    isJornadaAdicional: false,
  })

  function showToast(message: string, type: Toast['type'] = 'success') {
    const id = toastIdRef.current++
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000)
  }

  useEffect(() => {
    return subscribeToProjects((loadedProjects) => {
      setProjects(loadedProjects)
      setActiveProjectId((prev) => {
        if (prev) return prev
        // Restaurar último proyecto activo si existe y sigue disponible
        const remembered = (() => {
          try { return localStorage.getItem(LS_PREFIX + 'activeProjectId') ?? '' } catch { return '' }
        })()
        if (remembered && loadedProjects.some((p) => p.id === remembered)) return remembered
        return loadedProjects[0]?.id ?? ''
      })
    })
  }, [])

  // Persistir proyecto activo
  useEffect(() => {
    if (activeProjectId) writeLS('activeProjectId', activeProjectId)
  }, [activeProjectId])

  useEffect(() => {
    const currentProfile = profile
    if (!currentProfile || !activeProjectId) return
    // Solo montar el listener cuando el usuario está en la pestaña de proyectos.
    // En USERS / HELP / PROJECT_MANAGEMENT no se necesita.
    if (mainTab !== 'PROJECTS') return
    // Ventana de jornadas en tiempo real: últimos ~90 días para limitar
    // lecturas de Firestore. Reportes y liquidaciones (que requieran fechas
    // más antiguas) usan listAllTimeEntries con rango específico.
    const since = (() => {
      const d = new Date()
      d.setDate(d.getDate() - 90)
      return d.toISOString().slice(0, 10)
    })()
    if (canAudit(currentProfile.role)) {
      return subscribeToProjectEntries(activeProjectId, setEntries, { since })
    } else if (currentProfile.areaId) {
      return subscribeToAreaEntries(activeProjectId, currentProfile.areaId, setEntries, { since })
    } else {
      return subscribeToMyEntries(currentProfile.uid, activeProjectId, setEntries, { since })
    }
  }, [activeProjectId, profile, mainTab])

  // Suscripción en tiempo real a usuarios del proyecto (formulario admin en auditoría)
  useEffect(() => {
    const currentProfile = profile
    if (!currentProfile || !canAudit(currentProfile.role) || !activeProjectId) return
    return subscribeToProjectUsers(activeProjectId, setProjectUsers)
  }, [activeProjectId, profile])

  useEffect(() => {
    if (!activeProjectId) return
    async function loadAreas() {
      const loaded = await listProjectAreas(activeProjectId)
      setAreas(loaded)
    }
    async function loadConfig() {
      const config = await getProjectConfig(activeProjectId)
      setProjectConfig(config)
    }
    async function loadRoles() {
      const loaded = await listProjectRoles(activeProjectId)
      setProjectRoles(loaded)
    }
    async function loadLocked() {
      const settlements = await listSettlements(activeProjectId)
      setLockedRanges(settlements.map((s) => ({ dateFrom: s.dateFrom, dateTo: s.dateTo })))
    }
    void loadAreas()
    void loadConfig()
    void loadRoles()
    void loadLocked()
  }, [activeProjectId])

  useEffect(() => {
    if (!activeProjectId || projectTab !== 'SETTLEMENTS') return
    void listSettlements(activeProjectId).then(setPastSettlements)
  }, [activeProjectId, projectTab])

  useEffect(() => {
    const currentProfile = profile
    if (!currentProfile || !canSeeProjectAdmin(currentProfile.role)) return
    void listAllProjects().then(setAllProjects)
  }, [profile])

  // Carga one-shot de usuarios aprobados/pendientes/placeholders (con botón Refrescar)
  const loadUsersPanels = useCallback(async () => {
    const currentProfile = profile
    if (!currentProfile || !canAudit(currentProfile.role)) return
    try {
      const [approved, pending, placeholders] = await Promise.all([
        listApprovedUsers(),
        listPendingUsers(),
        listImportedPlaceholders(),
      ])
      setApprovedUsers(approved)
      setApprovedUsersList(approved)
      setPendingUsers(pending)
      setImportedMembers(placeholders)
    } catch (err) {
      console.error('[loadUsersPanels] error:', err)
    }
  }, [profile])

  useEffect(() => {
    void loadUsersPanels()
  }, [loadUsersPanels])

  const [repairBusy, setRepairBusy] = useState(false)
  const handleRepairMerged = useCallback(async () => {
    if (repairBusy) return
    if (!window.confirm('Reparar placeholders huérfanos: marcará como fusionados los placeholders cuyo usuario real ya existe. ¿Continuar?')) return
    setRepairBusy(true)
    try {
      const { repaired, orphans } = await repairMergedPlaceholders()
      window.alert(`Reparados: ${repaired}\nHuérfanos sin placeholder original: ${orphans}`)
      await loadUsersPanels()
    } catch (err) {
      console.error('[repairMergedPlaceholders] error:', err)
      window.alert('Error al reparar. Revisar consola.')
    } finally {
      setRepairBusy(false)
    }
  }, [repairBusy, loadUsersPanels])

  // Carga áreas al seleccionar proyecto en modal de aprobación
  useEffect(() => {
    if (!approveForm.projectId) {
      setApproveAreas([])
      setApproveRoles([])
      return
    }
    void listProjectAreas(approveForm.projectId).then(setApproveAreas)
    void listProjectRoles(approveForm.projectId).then(setApproveRoles)
  }, [approveForm.projectId])

  // Carga áreas y roles al abrir edición de usuario
  useEffect(() => {
    if (!editingUser?.projectId) {
      setEditUserAreas([])
      setEditUserRoles([])
      return
    }
    void listProjectAreas(editingUser.projectId).then(setEditUserAreas)
    void listProjectRoles(editingUser.projectId).then(setEditUserRoles)
  }, [editingUser?.projectId])

  // Carga templates al montar
  useEffect(() => {
    const currentProfile = profile
    if (!currentProfile || !canSeeConfig(currentProfile.role)) return
    void listProjectTemplates().then(setTemplates)
  }, [profile])

  const activeProjectName = useMemo(() => {
    return projects.find((p) => p.id === activeProjectId)?.name || 'Sin proyecto'
  }, [activeProjectId, projects])

  const activeAreaName = useMemo(() => {
    if (!profile?.areaId) return ''
    return areas.find((a) => a.id === profile.areaId)?.name ?? ''
  }, [profile?.areaId, areas])

  const filteredApprovedUsers = useMemo(() => {
    if (!userSearch.trim()) return approvedUsers
    const s = userSearch.toLowerCase()
    return approvedUsers.filter(
      (u) =>
        (u.displayName ?? '').toLowerCase().includes(s) ||
        (u.email ?? '').toLowerCase().includes(s),
    )
  }, [approvedUsers, userSearch])

  // ─── Paginación ─────────────────────────────────────────────────────────
  const entriesPagination = usePagedItems(entries, 25)
  const auditPagination = usePagedItems(auditEntries, 50)
  const settlementsPagination = usePagedItems(pastSettlements, 10)

  // Loading global (cualquier proceso en curso) → overlay con spinner
  const anyLoading = auditLoading || settlementLoading || importLoading

  if (!profile) return null

  const currentProfile = profile

  async function loadAuditEntries() {
    if (!activeProjectId) return
    setAuditLoading(true)
    try {
      const loaded = await listAllTimeEntries(activeProjectId, {
        dateFrom: auditFilters.dateFrom || undefined,
        dateTo: auditFilters.dateTo || undefined,
        userId: auditFilters.userId || undefined,
        areaId: auditFilters.areaId || undefined,
      })
      setAuditEntries(loaded)
    } finally {
      setAuditLoading(false)
    }
  }

  function exportAuditExcel() {
    if (auditEntries.length === 0) return
    const rows = auditEntries.map((e) => ({
      Fecha: e.workDate,
      Jornada: e.shiftLabel,
      Usuario: e.userName,
      'Hora Entrada': e.timeIn,
      'Hora Salida': e.timeOut,
      'Horas Trabajadas': e.calculation.workedHours,
      'Horas Regulares': e.calculation.regularHours,
      'Horas Extra': e.calculation.overtimeHours,
      'Horas Nocturnas': e.calculation.nightHours,
      'Unidades Extra Pay': e.calculation.extraPayUnits,
      Observaciones: e.notes || '',
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Auditoría')
    const projectName = projects.find((p) => p.id === activeProjectId)?.name ?? 'proyecto'
    XLSX.writeFile(wb, `auditoria_${projectName}_${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  async function handleSetReviewColor(entryId: string, color: string) {
    setAuditEntries((prev) => prev.map((e) => e.id === entryId ? { ...e, reviewColor: color } : e))
    try {
      await setEntryReviewColor(entryId, color)
    } catch (err) {
      showToast('Error al guardar el color.', 'error')
      void loadAuditEntries()
      console.error(err)
    }
  }

  function getColorLabel(colorValue: string): string {
    const rc = REVIEW_COLORS.find((c) => c.value === colorValue)
    if (!rc) return ''
    return projectConfig?.reviewColorLabels?.[colorValue] ?? rc.defaultLabel
  }

  async function calculateSettlementPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeProjectId || !settlementForm.dateFrom || !settlementForm.dateTo) {
      showToast('Completá las fechas.', 'error')
      return
    }
    setSettlementLoading(true)
    setCurrentSettlement(null)
    setIsSettlementSaved(false)
    try {
      const proj = projects.find((p) => p.id === activeProjectId)
      const result = await previewSettlement(
        activeProjectId,
        proj?.name ?? 'Proyecto',
        settlementForm.dateFrom,
        settlementForm.dateTo,
        currentProfile.uid,
      )
      setCurrentSettlement(result)
      setEditableLines(result.lines)
    } catch (err) {
      showToast('Error al calcular la liquidación.', 'error')
      console.error(err)
    } finally {
      setSettlementLoading(false)
    }
  }

  async function handleSaveSettlement() {
    if (!currentSettlement || isSettlementSaved) return
    setSettlementLoading(true)
    try {
      const totalPay = Math.round(editableLines.reduce((s, l) => s + l.totalPay, 0) * 100) / 100
      await saveSettlement({ ...currentSettlement, lines: editableLines, totalPay })
      setIsSettlementSaved(true)
      const loaded = await listSettlements(activeProjectId)
      setPastSettlements(loaded)
      setLockedRanges(loaded.map((s) => ({ dateFrom: s.dateFrom, dateTo: s.dateTo })))
      showToast('Liquidaci\u00f3n guardada. Fechas bloqueadas.')
    } catch (err) {
      const e = err as { code?: string; message?: string }
      const msg = String(e?.message ?? '').toLowerCase()
      const code = String(e?.code ?? '').toLowerCase()
      const isBlocked =
        code === 'unavailable' ||
        msg.includes('blocked_by_client') ||
        msg.includes('err_blocked') ||
        msg.includes('network error') ||
        msg.includes('webchannel') ||
        msg.includes('failed to fetch')
      if (isBlocked) {
        showToast(
          'No se pudo guardar la liquidación. Es posible que una extensión del navegador (bloqueador de anuncios o privacidad) esté bloqueando Firestore. Probá desactivarla para este sitio o usar una ventana de incógnito.',
          'error',
        )
      } else if (e?.message) {
        showToast(`Error al guardar la liquidación: ${e.message}`, 'error')
      } else {
        showToast('Error al guardar la liquidación.', 'error')
      }
      console.error(err)
    } finally {
      setSettlementLoading(false)
    }
  }

  async function handleDeleteSettlement(settlementId: string) {
    if (!window.confirm('\u00bfLiberar las fechas de esta liquidaci\u00f3n? Las jornadas del per\u00edodo podr\u00e1n volver a modificarse.')) return
    try {
      await deleteSettlement(settlementId)
      const loaded = await listSettlements(activeProjectId)
      setPastSettlements(loaded)
      setLockedRanges(loaded.map((s) => ({ dateFrom: s.dateFrom, dateTo: s.dateTo })))
      showToast('Fechas liberadas.')
    } catch (err) {
      showToast('Error al liberar fechas.', 'error')
      console.error(err)
    }
  }

  function exportSettlementExcel(s: Settlement) {
    const rows = s.lines.map((l) => ({
      Colaborador: l.userName,
      'Hs. Normales': l.regularHours,
      'Hs. Extras': l.overtimeHours,
      'Hs. Nocturnas': l.nightHours,
      'Total Hs.': l.totalHours,
      'Pago Normal ($)': l.regularPay,
      'Pago Extra ($)': l.overtimePay,
      'Pago Nocturno ($)': l.nightPay,
      'Total ($)': l.totalPay,
    }))
    rows.push({
      Colaborador: 'TOTAL',
      'Hs. Normales': s.lines.reduce((a, l) => a + l.regularHours, 0),
      'Hs. Extras': s.lines.reduce((a, l) => a + l.overtimeHours, 0),
      'Hs. Nocturnas': s.lines.reduce((a, l) => a + l.nightHours, 0),
      'Total Hs.': s.lines.reduce((a, l) => a + l.totalHours, 0),
      'Pago Normal ($)': s.lines.reduce((a, l) => a + l.regularPay, 0),
      'Pago Extra ($)': s.lines.reduce((a, l) => a + l.overtimePay, 0),
      'Pago Nocturno ($)': s.lines.reduce((a, l) => a + l.nightPay, 0),
      'Total ($)': s.totalPay,
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Liquidación')
    XLSX.writeFile(wb, `liquidacion_${s.projectName}_${s.dateFrom}_${s.dateTo}.xlsx`)
  }

  async function submitConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeProjectId || !projectConfig) return
    setConfigStatus('Guardando...')
    try {
      await saveProjectConfig(activeProjectId, {
        regularDailyHours: projectConfig.regularDailyHours,
        overtimeMultiplier: projectConfig.overtimeMultiplier,
        nightWindowStart: projectConfig.nightWindowStart,
        nightWindowEnd: projectConfig.nightWindowEnd,
        nightAdditionalMultiplier: projectConfig.nightAdditionalMultiplier,
        weeklyWorkDays: projectConfig.weeklyWorkDays,
        workWeekPattern: projectConfig.workWeekPattern,
        workWeekStartDay: projectConfig.workWeekStartDay,
        rodajeStart: projectConfig.rodajeStart,
        rodajeEnd: projectConfig.rodajeEnd,
        engancheHours: projectConfig.engancheHours,
        reengancheHours: projectConfig.reengancheHours,
        penaltyHours: projectConfig.penaltyHours,
        jornadaAdicionalMultiplier: projectConfig.jornadaAdicionalMultiplier,
        futureDatePolicy: projectConfig.futureDatePolicy ?? 'ALLOW',
      })
      setConfigStatus('')
      showToast('Configuración guardada correctamente.')
    } catch (error) {
      setConfigStatus('Error al guardar')
      showToast(`Error: ${error instanceof Error ? error.message : 'Desconocido'}`, 'error')
    }
  }

  async function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      if (projectFormMode === 'create') {
        await createProject(projectFormData)
        if (projectInitialAdminId) {
          await setUserRole(projectInitialAdminId, 'PROJECT_ADMIN')
        }
        showToast('Proyecto creado exitosamente.')
      } else if (projectFormMode === 'edit' && editingProjectId) {
        await updateProject(editingProjectId, projectFormData)
        if (projectInitialAdminId) {
          await setUserRole(projectInitialAdminId, 'PROJECT_ADMIN')
        }
        showToast('Proyecto actualizado exitosamente.')
      }
      setProjectFormMode(null)
      setProjectFormData({ name: '', code: '', description: '' })
      setProjectInitialAdminId('')
      setEditingProjectId(null)
      const loaded = await listAllProjects()
      setAllProjects(loaded)
    } catch (error) {
      showToast(`Error: ${error instanceof Error ? error.message : 'Desconocido'}`, 'error')
    }
  }

  function startCreateProject() {
    setProjectFormMode('create')
    setProjectFormData({ name: '', code: '', description: '' })
    setProjectInitialAdminId('')
    setEditingProjectId(null)
  }

  function startEditProject(project: Project) {
    setProjectFormMode('edit')
    setProjectFormData({ name: project.name, code: project.code, description: project.description })
    setProjectInitialAdminId('')
    setEditingProjectId(project.id)
  }

  async function handleDeleteProject(projectId: string) {
    if (!window.confirm('¿Desactivar este proyecto?')) return
    try {
      await deleteProject(projectId)
      showToast('Proyecto desactivado.')
      const loaded = await listAllProjects()
      setAllProjects(loaded)
    } catch (error) {
      showToast(`Error: ${error instanceof Error ? error.message : 'Desconocido'}`, 'error')
    }
  }

  async function submitEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isDateLocked(form.workDate)) {
      showToast(`La fecha ${form.workDate} pertenece a un período liquidado y no se puede modificar.`, 'error')
      return
    }
    // Bloqueo por política de fechas futuras (admins exentos).
    if (!canAudit(currentProfile.role) && projectConfig) {
      const maxDate = getMaxWorkDate(projectConfig.futureDatePolicy)
      if (maxDate && form.workDate > maxDate) {
        const msg = projectConfig.futureDatePolicy === 'TODAY'
          ? 'No se permiten fechas posteriores a hoy.'
          : 'No se permiten fechas posteriores a mañana.'
        showToast(msg, 'error')
        return
      }
    }
    const fechaDuplicada = entries.some((e) => e.workDate === form.workDate && e.userId === currentProfile.uid)
    if (fechaDuplicada) {
      showToast(`Ya existe un registro para el ${form.workDate} en este proyecto.`, 'error')
      return
    }

    // ── Validaciones de 6to día (no aplican a usuarios marcados como Refuerzo) ──
    const myEntriesForUser = entries.filter((e) => e.userId === currentProfile.uid)
    const refDate = new Date(form.workDate + 'T00:00:00')
    const isReinforcement = currentProfile.cycleMode === 'REINFORCEMENT'

    // 1) BLOQUEO: no permitir un 3er 6to día dentro de los últimos 7 días.
    if (!isReinforcement && form.isJornadaAdicional) {
      const windowStart = new Date(refDate)
      windowStart.setDate(refDate.getDate() - 6)
      const windowStartStr = windowStart.toISOString().slice(0, 10)
      const flagsInWindow = myEntriesForUser.filter(
        (e) =>
          (e as TimeEntry & { isJornadaAdicional?: boolean }).isJornadaAdicional === true &&
          e.workDate >= windowStartStr &&
          e.workDate < form.workDate,
      ).length
      if (flagsInWindow >= 2) {
        showToast('No podés marcar un 3er 6to día en menos de 7 días.', 'error')
        return
      }
    }

    // 2) AVISO: si hay 5+ jornadas consecutivas previas sin 6to día, ofrecer marcarlo.
    if (!isReinforcement && !form.isJornadaAdicional) {
      const sorted = myEntriesForUser
        .slice()
        .sort((a, b) => b.workDate.localeCompare(a.workDate))
      let consecutive = 0
      const cursor = new Date(refDate)
      for (const e of sorted) {
        if (e.workDate >= form.workDate) continue
        cursor.setDate(cursor.getDate() - 1)
        const expectedStr = cursor.toISOString().slice(0, 10)
        if (e.workDate !== expectedStr) break
        if ((e as TimeEntry & { isJornadaAdicional?: boolean }).isJornadaAdicional === true) break
        consecutive++
        if (consecutive >= 5) break
      }
      if (consecutive >= 5) {
        const wantsMark = window.confirm(
          'Atención: hoy sería tu 6to día laboral consecutivo.\n\n' +
            'Aceptar: marcar esta jornada como 6to día y guardar.\n' +
            'Cancelar: guardar como jornada normal.',
        )
        if (wantsMark) {
          // Re-verifico el bloqueo de 3er 6to día también en este caso.
          const windowStart = new Date(refDate)
          windowStart.setDate(refDate.getDate() - 6)
          const windowStartStr = windowStart.toISOString().slice(0, 10)
          const flagsInWindow = myEntriesForUser.filter(
            (e) =>
              (e as TimeEntry & { isJornadaAdicional?: boolean }).isJornadaAdicional === true &&
              e.workDate >= windowStartStr &&
              e.workDate < form.workDate,
          ).length
          if (flagsInWindow >= 2) {
            showToast('No podés marcar un 3er 6to día en menos de 7 días.', 'error')
            return
          }
          form.isJornadaAdicional = true
          setForm((prev) => ({ ...prev, isJornadaAdicional: true }))
        }
      }
    }

    try {
      setSavingEntry(true)
      await saveTimeEntry(
        { ...form, projectId: activeProjectId },
        { uid: currentProfile.uid, displayName: currentProfile.displayName, areaId: currentProfile.areaId },
      )
      showToast('Horario guardado correctamente.')
      setForm((prev) => ({ ...prev, notes: '' }))
    } catch (err) {
      showToast('Error al guardar el horario.', 'error')
      console.error(err)
    } finally {
      setSavingEntry(false)
    }
  }

  function startEditEntry(entry: TimeEntry) {
    setEditingEntry(entry)
    setEditEntryForm({
      workDate: entry.workDate,
      shiftLabel: entry.shiftLabel,
      timeIn: entry.timeIn,
      timeOut: entry.timeOut,
      notes: entry.notes,
      penalties: (entry as TimeEntry & { penalties?: number }).penalties ?? 0,
      isJornadaAdicional: (entry as TimeEntry & { isJornadaAdicional?: boolean }).isJornadaAdicional ?? false,
    })
  }

  async function submitEditEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingEntry) return
    if (!canAudit(currentProfile.role) && isDateLocked(editEntryForm.workDate)) {
      showToast('Esta jornada está bloqueada y no se puede editar.', 'error')
      return
    }
    // Bloqueo por política de fechas futuras (admins exentos).
    if (!canAudit(currentProfile.role) && projectConfig) {
      const maxDate = getMaxWorkDate(projectConfig.futureDatePolicy)
      if (maxDate && editEntryForm.workDate > maxDate) {
        const msg = projectConfig.futureDatePolicy === 'TODAY'
          ? 'No se permiten fechas posteriores a hoy.'
          : 'No se permiten fechas posteriores a mañana.'
        showToast(msg, 'error')
        return
      }
    }
    try {
      setSavingEditEntry(true)
      await updateTimeEntry(editingEntry.id, editEntryForm, activeProjectId, editingEntry.userId)
      setEditingEntry(null)
      showToast('Jornada actualizada.')
    } catch (err) {
      showToast('Error al actualizar.', 'error')
      console.error(err)
    } finally {
      setSavingEditEntry(false)
    }
  }

  async function handleDeleteEntry(entryId: string, userId: string) {
    const target = entries.find((e) => e.id === entryId)
    if (!canAudit(currentProfile.role) && target && isDateLocked(target.workDate)) {
      showToast('Esta jornada está bloqueada y no se puede eliminar.', 'error')
      return
    }
    if (!window.confirm('¿Eliminar esta jornada?')) return
    try {
      setDeletingEntryId(entryId)
      await deleteTimeEntry(entryId, activeProjectId, userId)
      showToast('Jornada eliminada.')
    } catch (err) {
      showToast('Error al eliminar.', 'error')
      console.error(err)
    } finally {
      setDeletingEntryId(null)
    }
  }

  function startEditAuditEntry(entry: TimeEntry) {
    setEditingAuditEntry(entry)
    setEditAuditForm({
      workDate: entry.workDate,
      shiftLabel: entry.shiftLabel,
      timeIn: entry.timeIn,
      timeOut: entry.timeOut,
      notes: entry.notes,
      penalties: (entry as TimeEntry & { penalties?: number }).penalties ?? 0,
      isJornadaAdicional: (entry as TimeEntry & { isJornadaAdicional?: boolean }).isJornadaAdicional ?? false,
    })
  }

  async function submitEditAuditEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingAuditEntry) return
    try {
      await updateTimeEntry(editingAuditEntry.id, editAuditForm, activeProjectId, editingAuditEntry.userId)
      await loadAuditEntries()
      setEditingAuditEntry(null)
      showToast('Jornada actualizada.')
    } catch (err) {
      showToast('Error al actualizar.', 'error')
      console.error(err)
    }
  }

  async function handleDeleteAuditEntry(entryId: string, userId: string) {
    if (!window.confirm('¿Eliminar esta jornada?')) return
    try {
      await deleteTimeEntry(entryId, activeProjectId, userId)
      await loadAuditEntries()
      showToast('Jornada eliminada.')
    } catch (err) {
      showToast('Error al eliminar.', 'error')
      console.error(err)
    }
  }

  async function submitAdminEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isDateLocked(adminEntryForm.workDate)) {
      showToast(`La fecha ${adminEntryForm.workDate} pertenece a un período liquidado.`, 'error')
      return
    }
    const targetUser = projectUsers.find((u) => u.uid === adminEntryUserId)
    if (!targetUser) return
    try {
      await saveTimeEntryForUser(
        { ...adminEntryForm, projectId: activeProjectId },
        targetUser,
      )
      showToast(`Jornada cargada para ${targetUser.displayName ?? 'usuario'}.`)
      setAdminEntryForm({ workDate: '', shiftLabel: '', timeIn: '', timeOut: '', notes: '', penalties: 0, isJornadaAdicional: false })
      setAdminEntryUserId('')
    } catch (err) {
      showToast('Error al cargar jornada.', 'error')
      console.error(err)
    }
  }

  function openApproveModal(u: UserProfile) {
    setApprovingUser(u)
    setApproveForm({ role: 'MEMBER', projectId: activeProjectId || '', areaId: '', roleId: '' })
    setApproveAreas([])
    setApproveRoles([])
  }

  function openApproveImportedModal(m: UserProfile) {
    // Marcamos el flujo importado con un prefijo en uid para distinguirlo en submitApproval.
    // Guardamos el uid real del placeholder como suffix.
    const fakeProfile: UserProfile = {
      uid: `__imported__:${m.uid}`,
      email: m.email,
      displayName: m.displayName || null,
      role: 'MEMBER',
      approvalStatus: 'PENDING',
    }
    setApprovingUser(fakeProfile)
    setApproveForm({ role: 'MEMBER', projectId: activeProjectId || '', areaId: '', roleId: '' })
    setApproveAreas([])
    setApproveRoles([])
  }

  function handleImportExcel(file: File) {
    const reader = new FileReader()
    reader.onload = (e) => {
      const data = e.target?.result
      if (!data) return
      const wb = XLSX.read(data, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rawRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][]
      const entries: { email: string; displayName: string }[] = []
      for (const row of rawRows) {
        const email = String(row[0] ?? '').trim()
        const displayName = String(row[1] ?? '').trim()
        if (email && email.includes('@')) {
          entries.push({ email: email.toLowerCase(), displayName })
        }
      }
      if (entries.length === 0) {
        showToast('El archivo no contiene filas válidas (email en col. A, nombre en col. B).')
        return
      }
      const existingEmails = new Set(importedMembers.map((m) => (m.email ?? '').toLowerCase()).filter(Boolean))
      const toImport: { email: string; displayName: string }[] = []
      const duplicates: string[] = []
      const seen = new Set<string>()
      for (const entry of entries) {
        if (existingEmails.has(entry.email) || seen.has(entry.email)) {
          duplicates.push(entry.email)
        } else {
          toImport.push(entry)
          seen.add(entry.email)
        }
      }
      setImportPreview({ toImport, duplicates })
    }
    reader.readAsArrayBuffer(file)
  }

  async function handleConfirmImport() {
    if (!importPreview) return
    setImportLoading(true)
    try {
      const result = await importMembers(importPreview.toImport)
      setImportPreview(null)
      const dupMsg = result.duplicates.length > 0 ? ` (${result.duplicates.length} duplicado(s) ignorado(s))` : ''
      showToast(`${result.imported} miembro(s) importado(s) correctamente.${dupMsg}`)
    } catch (err) {
      showToast('Error al importar miembros.')
      console.error(err)
    } finally {
      setImportLoading(false)
    }
  }

  function closeApproveModal() {
    setApprovingUser(null)
    setApproveForm({ role: 'MEMBER', projectId: '', areaId: '', roleId: '' })
    setApproveAreas([])
    setApproveRoles([])
  }

  async function submitApproval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!approvingUser) return
    try {
      if (approvingUser.uid.startsWith('__imported__:')) {
        const placeholderUid = approvingUser.uid.slice('__imported__:'.length)
        await approveImportedPlaceholder(
          placeholderUid,
          approveForm.role,
          approveForm.projectId || undefined,
          approveForm.areaId || undefined,
          approveForm.roleId || undefined,
        )
      } else {
        await approveUser(
          approvingUser.uid,
          approveForm.role,
          approveForm.projectId || undefined,
          approveForm.areaId || undefined,
          approveForm.roleId || undefined,
        )
      }
      showToast(`${approvingUser.displayName ?? 'Usuario'} aprobado correctamente.`)
      closeApproveModal()
    } catch (err) {
      showToast('Error al aprobar usuario.', 'error')
      console.error(err)
    }
  }

  async function addArea(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeProjectId || !newAreaName.trim()) return
    await createProjectArea(activeProjectId, newAreaName.trim())
    setNewAreaName('')
    const loaded = await listProjectAreas(activeProjectId)
    setAreas(loaded)
    showToast('Área creada.')
  }

  async function handleSaveAreaRename(areaId: string) {
    if (!editAreaName.trim()) return
    await updateProjectArea(areaId, editAreaName.trim())
    setEditingAreaId(null)
    setEditAreaName('')
    const loaded = await listProjectAreas(activeProjectId)
    setAreas(loaded)
    showToast('Área renombrada.')
  }

  async function removeArea(areaId: string) {
    if (!window.confirm('¿Eliminar esta área?')) return
    await deleteProjectArea(areaId)
    const loaded = await listProjectAreas(activeProjectId)
    setAreas(loaded)
    showToast('Área eliminada.')
  }

  async function handleAddRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeProjectId || !newRoleForm.name.trim()) return
    await createProjectRole(activeProjectId, newRoleForm)
    setNewRoleForm({ name: '', dailyRate: 0, weeklyRate: 0, monthlyRate: 0 })
    const loaded = await listProjectRoles(activeProjectId)
    setProjectRoles(loaded)
    showToast('Rol creado.')
  }

  async function handleSaveRoleEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingRole) return
    await updateProjectRole(editingRole.id, editRoleForm)
    setEditingRole(null)
    const loaded = await listProjectRoles(activeProjectId)
    setProjectRoles(loaded)
    showToast('Rol actualizado.')
  }

  async function handleDeleteRole(roleId: string) {
    if (!window.confirm('¿Eliminar este rol?')) return
    await deleteProjectRole(roleId)
    const loaded = await listProjectRoles(activeProjectId)
    setProjectRoles(loaded)
    showToast('Rol eliminado.')
  }

  async function handleSaveTemplate() {
    if (!newTemplateName.trim() || !projectConfig) {
      showToast('Ingresá un nombre para el template.', 'error')
      return
    }
    setTemplateLoading(true)
    try {
      await saveProjectTemplate(newTemplateName.trim(), {
        areas: areas.map((a) => a.name),
        roles: projectRoles.map(({ name, dailyRate, weeklyRate, monthlyRate }) => ({ name, dailyRate, weeklyRate, monthlyRate })),
        config: {
          regularDailyHours: projectConfig.regularDailyHours,
          overtimeMultiplier: projectConfig.overtimeMultiplier,
          nightWindowStart: projectConfig.nightWindowStart,
          nightWindowEnd: projectConfig.nightWindowEnd,
          nightAdditionalMultiplier: projectConfig.nightAdditionalMultiplier,
          weeklyWorkDays: projectConfig.weeklyWorkDays,
          workWeekPattern: projectConfig.workWeekPattern,
          workWeekStartDay: projectConfig.workWeekStartDay,
          rodajeStart: projectConfig.rodajeStart,
          rodajeEnd: projectConfig.rodajeEnd,
          engancheHours: projectConfig.engancheHours,
          reengancheHours: projectConfig.reengancheHours,
          penaltyHours: projectConfig.penaltyHours,
          jornadaAdicionalMultiplier: projectConfig.jornadaAdicionalMultiplier,
        },
      })
      setNewTemplateName('')
      const loaded = await listProjectTemplates()
      setTemplates(loaded)
      showToast('Template guardado.')
    } catch (err) {
      showToast('Error al guardar template.', 'error')
      console.error(err)
    } finally {
      setTemplateLoading(false)
    }
  }

  async function handleApplyTemplate(template: ProjectTemplate) {
    if (!window.confirm(`¿Aplicar template "${template.name}" al proyecto activo? Se crearán áreas, roles y se aplicará la configuración de cálculo.`)) return
    setTemplateLoading(true)
    try {
      await applyProjectTemplate(activeProjectId, template)
      const [loadedAreas, loadedRoles, loadedConfig] = await Promise.all([
        listProjectAreas(activeProjectId),
        listProjectRoles(activeProjectId),
        getProjectConfig(activeProjectId),
      ])
      setAreas(loadedAreas)
      setProjectRoles(loadedRoles)
      setProjectConfig(loadedConfig)
      showToast(`Template "${template.name}" aplicado exitosamente.`)
    } catch (err) {
      showToast('Error al aplicar template.', 'error')
      console.error(err)
    } finally {
      setTemplateLoading(false)
    }
  }

  function openRecalcModal() {
    setRangeOpModal({ op: 'RECALC', dateFrom: '', dateTo: '' })
  }

  function openSyncAreasModal() {
    setRangeOpModal({ op: 'SYNC_AREAS', dateFrom: '', dateTo: '' })
  }

  async function runRangeOp() {
    if (!rangeOpModal) return
    const { op, dateFrom, dateTo } = rangeOpModal
    if (!dateFrom || !dateTo) {
      showToast('Indicá un rango de fechas.', 'error')
      return
    }
    if (dateFrom > dateTo) {
      showToast('La fecha desde no puede ser mayor que la fecha hasta.', 'error')
      return
    }
    setRangeOpBusy(true)
    try {
      if (op === 'RECALC') {
        const count = await recalculateProjectEntries(activeProjectId, lockedRanges, { dateFrom, dateTo })
        showToast(`${count} registro${count !== 1 ? 's' : ''} recalculado${count !== 1 ? 's' : ''}.`)
      } else {
        const count = await syncUserAreasToEntries(activeProjectId, lockedRanges, { dateFrom, dateTo })
        showToast(count > 0 ? `${count} registro${count !== 1 ? 's' : ''} actualizado${count !== 1 ? 's' : ''} con el área actual.` : 'No hay registros que actualizar.')
      }
      setRangeOpModal(null)
    } catch (err) {
      showToast(op === 'RECALC' ? 'Error al recalcular.' : 'Error al sincronizar áreas.', 'error')
      console.error(err)
    } finally {
      setRangeOpBusy(false)
    }
  }

  function openEditUser(u: UserProfile) {
    setEditingUser(u)
    setEditUserForm({
      displayName: u.displayName ?? '',
      areaId: u.areaId ?? '',
      roleId: u.roleId ?? '',
      projectId: u.projectId ?? '',
      cycleMode: u.cycleMode ?? 'CYCLE',
    })
  }

  async function handleSaveUserEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingUser) return
    try {
      const previousCycleMode = editingUser.cycleMode ?? 'CYCLE'
      const newCycleMode = editUserForm.cycleMode
      const targetProjectId = editUserForm.projectId || editingUser.projectId
      await updateUserProfileAdmin(editingUser.uid, {
        displayName: editUserForm.displayName || undefined,
        areaId: editUserForm.areaId || undefined,
        roleId: editUserForm.roleId || undefined,
        projectId: editUserForm.projectId || undefined,
        cycleMode: newCycleMode,
      })
      // Si cambió el modo de ciclo, recalcular las jornadas previas del usuario
      // para que reflejen el nuevo cálculo de enganche/reenganche.
      if (previousCycleMode !== newCycleMode && targetProjectId) {
        try {
          await recalculateUserEntries(targetProjectId, editingUser.uid)
        } catch (recalcErr) {
          console.warn('[handleSaveUserEdit] recalc on cycleMode change failed:', recalcErr)
        }
      }
      showToast('Usuario actualizado.')
      setEditingUser(null)
    } catch (err) {
      showToast('Error al actualizar usuario.', 'error')
      console.error(err)
    }
  }

  async function handleDeleteApprovedUser(u: UserProfile) {
    if (u.uid === profile?.uid) {
      showToast('No podés eliminar tu propia cuenta.', 'error')
      return
    }
    if (u.role === 'SUPERUSER') {
      showToast('No se puede eliminar un Superusuario desde la aplicación.', 'error')
      return
    }
    try {
      const count = await countUserTimeEntries(u.uid)
      if (count > 0) {
        const offerDisable = window.confirm(
          `No se puede eliminar a ${u.displayName ?? u.email}: tiene ${count} jornada(s) cargada(s).\n\n¿Querés inhabilitarlo en su lugar? El usuario no podrá acceder hasta ser rehabilitado.`,
        )
        if (offerDisable) {
          await setUserDisabled(u.uid, true)
          showToast('Usuario inhabilitado.')
        }
        return
      }
      const confirmDelete = window.confirm(
        `¿Eliminar permanentemente a ${u.displayName ?? u.email}?\n\nEsta acción no se puede deshacer.`,
      )
      if (!confirmDelete) return
      await deleteUserProfile(u.uid)
      showToast('Usuario eliminado.')
    } catch (err) {
      console.error(err)
      showToast('Error al eliminar el usuario.', 'error')
    }
  }

  async function handleToggleUserDisabled(u: UserProfile) {
    if (u.uid === profile?.uid) {
      showToast('No podés inhabilitar tu propia cuenta.', 'error')
      return
    }
    const next = !u.disabled
    const verb = next ? 'inhabilitar' : 'rehabilitar'
    if (!window.confirm(`¿Seguro que querés ${verb} a ${u.displayName ?? u.email}?`)) return
    try {
      await setUserDisabled(u.uid, next)
      showToast(next ? 'Usuario inhabilitado.' : 'Usuario rehabilitado.')
    } catch (err) {
      console.error(err)
      showToast(`Error al ${verb} el usuario.`, 'error')
    }
  }

  function isDateLocked(workDate: string): boolean {
    return lockedRanges.some((r) => workDate >= r.dateFrom && workDate <= r.dateTo)
  }

  async function loadNoReportUsers() {
    if (!activeProjectId) return
    if (!noReportFilters.dateFrom || !noReportFilters.dateTo) {
      showToast('Indicá rango de fechas para el reporte.', 'error')
      return
    }
    setNoReportLoading(true)
    try {
      const rows = await listUsersWithoutEntries(
        activeProjectId,
        noReportFilters.dateFrom,
        noReportFilters.dateTo,
        noReportFilters.areaId || undefined,
      )
      setNoReportRows(rows)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Error al consultar.', 'error')
      console.error(err)
    } finally {
      setNoReportLoading(false)
    }
  }

  async function handleSetUserAuditColor(uid: string, color: string) {
    setNoReportRows((prev) =>
      prev.map((r) => (r.user.uid === uid ? { ...r, user: { ...r.user, auditReviewColor: color } } : r)),
    )
    try {
      await setUserAuditReviewColor(uid, color)
    } catch (err) {
      showToast('Error al guardar el color.', 'error')
      console.error(err)
      void loadNoReportUsers()
    }
  }

  const projectTabs: Array<{ key: ProjectTab; label: string; visible: boolean }> = [
    { key: 'PROJECT_CONFIG', label: 'Configuración', visible: canSeeConfig(currentProfile.role) },
    { key: 'TIME_ENTRY_FORM', label: 'Cargar horario', visible: true },
    { key: 'TIME_ENTRY_TABLE', label: canAudit(currentProfile.role) ? 'Horarios del proyecto' : currentProfile.areaId ? 'Horarios del área' : 'Mis horarios', visible: true },
    { key: 'TIME_ENTRY_AUDIT', label: 'Auditoría', visible: canAudit(currentProfile.role) },
    { key: 'SETTLEMENTS', label: 'Liquidaciones', visible: canAudit(currentProfile.role) },
  ]

  return (
    <div className="screen dashboard-screen">
      <header className="topbar">
        <div>
          <p className="chip">{currentProfile.role}</p>
          <h1>Gestor de jornadas</h1>
          <p className="muted">
            Proyecto activo: {activeProjectName}
            {activeAreaName && <span className="topbar-area-chip">Área: {activeAreaName}</span>}
            <OnlineStatusIndicator />
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {user?.photoURL && (
            <img
              src={user.photoURL}
              alt={currentProfile.displayName ?? 'Usuario'}
              referrerPolicy="no-referrer"
              style={{ width: '38px', height: '38px', borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--line)' }}
            />
          )}
          <div style={{ textAlign: 'right' }}>
            {currentProfile.displayName && (
              <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: '0.9rem' }}>{currentProfile.displayName}</p>
            )}
            <button className="btn btn-outline" onClick={signOutUser}>
              Cerrar sesión
            </button>
          </div>
        </div>
      </header>

      <section className="project-switcher card">
        <label>
          Proyecto
          <select
            value={activeProjectId}
            onChange={(event) => {
              setActiveProjectId(event.target.value)
              setForm((prev) => ({ ...prev, projectId: event.target.value }))
            }}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      <nav className="tab-row">
        {canSeeProjectAdmin(currentProfile.role) && (
          <button
            className={`tab ${mainTab === 'PROJECT_MANAGEMENT' ? 'active' : ''}`}
            onClick={() => setMainTab('PROJECT_MANAGEMENT')}
          >
            Gestión de proyectos
          </button>
        )}
        <button
          className={`tab ${mainTab === 'PROJECTS' ? 'active' : ''}`}
          onClick={() => setMainTab('PROJECTS')}
        >
          Horarios
        </button>
        {canAudit(currentProfile.role) && (
          <button
            className={`tab ${mainTab === 'USERS' ? 'active' : ''}`}
            onClick={() => setMainTab('USERS')}
          >
            Usuarios{pendingUsers.length > 0 ? ` (${pendingUsers.length})` : ''}
          </button>
        )}
        <button
          className={`tab ${mainTab === 'HELP' ? 'active' : ''}`}
          onClick={() => setMainTab('HELP')}
        >
          Ayuda
        </button>
      </nav>

      {mainTab === 'PROJECT_MANAGEMENT' && canSeeProjectAdmin(currentProfile.role) && (
        <section className="card">
          <h2>Gestión de proyectos</h2>

          {projectFormMode && (
            <form className="stack" onSubmit={(e) => { void submitProject(e) }}>
              <p className="chip">{projectFormMode === 'create' ? 'Nuevo Proyecto' : 'Editar Proyecto'}</p>

              <label>
                Nombre
                <input
                  type="text"
                  value={projectFormData.name}
                  onChange={(e) => setProjectFormData((prev) => ({ ...prev, name: e.target.value }))}
                  required
                  placeholder="Ej: Construcción Centro"
                />
              </label>

              <label>
                Código
                <input
                  type="text"
                  value={projectFormData.code}
                  onChange={(e) => setProjectFormData((prev) => ({ ...prev, code: e.target.value }))}
                  required
                  placeholder="Ej: CONST-001"
                />
              </label>

              <label>
                Descripción
                <textarea
                  value={projectFormData.description}
                  onChange={(e) => setProjectFormData((prev) => ({ ...prev, description: e.target.value }))}
                  rows={2}
                  placeholder="Detalles del proyecto..."
                />
              </label>

              <label>
                Administrador{projectFormMode === 'create' ? ' inicial (requerido)' : ' (cambiar)'}
                <select
                  value={projectInitialAdminId}
                  onChange={(e) => setProjectInitialAdminId(e.target.value)}
                  required={projectFormMode === 'create'}
                >
                  <option value="">— Seleccionar usuario —</option>
                  {approvedUsersList
                    .filter((u) => u.role !== 'SUPERUSER')
                    .map((u) => (
                      <option key={u.uid} value={u.uid}>
                        {u.displayName ?? u.email}
                      </option>
                    ))}
                </select>
              </label>

              <div className="row">
                <button className="btn" type="submit">
                  {projectFormMode === 'create' ? 'Crear' : 'Actualizar'}
                </button>
                <button
                  className="btn btn-outline"
                  type="button"
                  onClick={() => {
                    setProjectFormMode(null)
                    setProjectFormData({ name: '', code: '', description: '' })
                    setProjectInitialAdminId('')
                    setEditingProjectId(null)
                  }}
                >
                  Cancelar
                </button>
              </div>
            </form>
          )}

          {!projectFormMode && (
            <button className="btn" onClick={startCreateProject}>
              + Nuevo proyecto
            </button>
          )}

          <h3>Proyectos registrados</h3>
          {allProjects.length === 0 ? (
            <p className="muted">No hay proyectos registrados.</p>
          ) : (
            <div className="stack">
              {allProjects.map((proj) => (
                <div className="row" key={proj.id} style={{ alignItems: 'flex-start' }}>
                  <div>
                    <strong>{proj.name}</strong>
                    <p className="muted" style={{ margin: '2px 0' }}>{proj.code} — {proj.description}</p>
                    <span className="chip">{proj.active ? 'Activo' : 'Inactivo'}</span>
                  </div>
                  {proj.active && !projectFormMode && (
                    <div className="row">
                      <button className="btn btn-outline" onClick={() => startEditProject(proj)}>Editar</button>
                      <button className="btn btn-outline" onClick={() => { void handleDeleteProject(proj.id) }}>Desactivar</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <hr />

          <h3>Templates de configuración</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>Guarda la configuración actual (áreas, roles y parámetros de cálculo) como template reutilizable.</p>
          <div className="row" style={{ marginBottom: '0.75rem' }}>
            <input type="text" placeholder="Nombre del template..." value={newTemplateName} onChange={(e) => setNewTemplateName(e.target.value)} />
            <button className="btn" onClick={() => { void handleSaveTemplate() }} disabled={templateLoading}>
              {templateLoading ? 'Guardando...' : 'Guardar como template'}
            </button>
          </div>
          {templates.length > 0 && (
            <div className="stack">
              <p style={{ fontWeight: 600, margin: '0 0 4px' }}>Templates disponibles:</p>
              {templates.map((t) => (
                <div key={t.id} className="row entry-item" style={{ alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <strong>{t.name}</strong>
                    <p className="muted" style={{ margin: '2px 0', fontSize: '0.82rem' }}>
                      {t.areas.length} área{t.areas.length !== 1 ? 's' : ''} · {t.roles.length} rol{t.roles.length !== 1 ? 'es' : ''}
                    </p>
                  </div>
                  <button className="btn-sm btn-outline" onClick={() => { void handleApplyTemplate(t) }} disabled={templateLoading}>
                    Aplicar
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {mainTab === 'PROJECTS' && (
        <>
          <nav className="subtab-row">
            {projectTabs
              .filter((t) => t.visible)
              .map((tab) => (
                <button
                  key={tab.key}
                  className={`subtab ${projectTab === tab.key ? 'active' : ''}`}
                  onClick={() => setProjectTab(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
          </nav>

          {projectTab === 'PROJECT_CONFIG' && canSeeConfig(currentProfile.role) && (
            <>
            <section className="card">
              <h2>Configuración del proyecto</h2>
              {!projectConfig ? (
                <p className="muted">Cargando configuración...</p>
              ) : (
                <form className="stack" onSubmit={submitConfig}>
                  <label>
                    Horas jornada regular (diarias)
                    <input
                      type="number"
                      min={1}
                      max={24}
                      step={0.5}
                      value={projectConfig.regularDailyHours}
                      onChange={(e) =>
                        setProjectConfig((prev) =>
                          prev ? { ...prev, regularDailyHours: Number(e.target.value) } : prev,
                        )
                      }
                      required
                    />
                  </label>

                  <label>
                    Multiplicador horas extra
                    <input
                      type="number"
                      min={1}
                      max={5}
                      step={0.1}
                      value={projectConfig.overtimeMultiplier}
                      onChange={(e) =>
                        setProjectConfig((prev) =>
                          prev ? { ...prev, overtimeMultiplier: Number(e.target.value) } : prev,
                        )
                      }
                      required
                    />
                  </label>

                  <div className="time-grid">
                    <label>
                      Inicio horario nocturno
                      <input
                        type="time"
                        value={projectConfig.nightWindowStart}
                        onChange={(e) =>
                          setProjectConfig((prev) =>
                            prev ? { ...prev, nightWindowStart: e.target.value } : prev,
                          )
                        }
                        required
                      />
                    </label>
                    <label>
                      Fin horario nocturno
                      <input
                        type="time"
                        value={projectConfig.nightWindowEnd}
                        onChange={(e) =>
                          setProjectConfig((prev) =>
                            prev ? { ...prev, nightWindowEnd: e.target.value } : prev,
                          )
                        }
                        required
                      />
                    </label>
                  </div>

                  <label>
                    Multiplicador recargo nocturno
                    <input
                      type="number"
                      min={1}
                      max={5}
                      step={0.1}
                      value={projectConfig.nightAdditionalMultiplier}
                      onChange={(e) =>
                        setProjectConfig((prev) =>
                          prev
                            ? { ...prev, nightAdditionalMultiplier: Number(e.target.value) }
                            : prev,
                        )
                      }
                      required
                    />
                  </label>

                  <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '0.5rem 0' }} />
                  <p style={{ margin: 0, fontWeight: 600, fontSize: '0.9rem' }}>Semana laboral</p>

                  <label>
                    Cantidad de jornadas por semana
                    <input
                      type="number"
                      min={1}
                      max={7}
                      step={1}
                      value={projectConfig.weeklyWorkDays}
                      onChange={(e) =>
                        setProjectConfig((prev) =>
                          prev ? { ...prev, weeklyWorkDays: Number(e.target.value) } : prev,
                        )
                      }
                    />
                  </label>

                  <label>
                    Día de inicio de semana laboral
                    <select
                      value={projectConfig.workWeekStartDay}
                      onChange={(e) =>
                        setProjectConfig((prev) =>
                          prev ? { ...prev, workWeekStartDay: e.target.value } : prev,
                        )
                      }
                    >
                      {[['MON','Lunes'],['TUE','Martes'],['WED','Miércoles'],['THU','Jueves'],['FRI','Viernes'],['SAT','Sábado'],['SUN','Domingo']].map(([v,l]) => (
                        <option key={v} value={v}>{l}</option>
                      ))}
                    </select>
                  </label>

                  <div className="time-grid">
                    <label>
                      Inicio del rodaje
                      <input
                        type="date"
                        value={projectConfig.rodajeStart}
                        onChange={(e) =>
                          setProjectConfig((prev) =>
                            prev ? { ...prev, rodajeStart: e.target.value } : prev,
                          )
                        }
                      />
                    </label>
                    <label>
                      Fin del rodaje
                      <input
                        type="date"
                        value={projectConfig.rodajeEnd}
                        onChange={(e) =>
                          setProjectConfig((prev) =>
                            prev ? { ...prev, rodajeEnd: e.target.value } : prev,
                          )
                        }
                      />
                    </label>
                  </div>

                  <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '0.5rem 0' }} />
                  <p style={{ margin: 0, fontWeight: 600, fontSize: '0.9rem' }}>Reglas especiales</p>

                  <div className="time-grid">
                    <label>
                      Enganche (horas mín. entre jornadas)
                      <input
                        type="number" min={0} max={48} step={0.5}
                        value={projectConfig.engancheHours}
                        onChange={(e) =>
                          setProjectConfig((prev) =>
                            prev ? { ...prev, engancheHours: Number(e.target.value) } : prev,
                          )
                        }
                      />
                    </label>
                    <label>
                      Reenganche (horas mín. entre semanas)
                      <input
                        type="number" min={0} max={96} step={0.5}
                        value={projectConfig.reengancheHours}
                        onChange={(e) =>
                          setProjectConfig((prev) =>
                            prev ? { ...prev, reengancheHours: Number(e.target.value) } : prev,
                          )
                        }
                      />
                    </label>
                  </div>

                  <div className="time-grid">
                    <label>
                      Penalty (horas por penalty)
                      <input
                        type="number" min={0} max={24} step={0.5}
                        value={projectConfig.penaltyHours}
                        onChange={(e) =>
                          setProjectConfig((prev) =>
                            prev ? { ...prev, penaltyHours: Number(e.target.value) } : prev,
                          )
                        }
                      />
                    </label>
                    <label>
                      6to día (multiplicador)
                      <input
                        type="number" min={1} max={10} step={0.5}
                        value={projectConfig.jornadaAdicionalMultiplier}
                        onChange={(e) =>
                          setProjectConfig((prev) =>
                            prev ? { ...prev, jornadaAdicionalMultiplier: Number(e.target.value) } : prev,
                          )
                        }
                      />
                    </label>
                  </div>

                  <div className="time-grid">
                    <label>
                      Fechas futuras
                      <select
                        value={projectConfig.futureDatePolicy ?? 'ALLOW'}
                        onChange={(e) =>
                          setProjectConfig((prev) =>
                            prev ? { ...prev, futureDatePolicy: e.target.value as 'ALLOW' | 'TODAY' | 'TODAY_PLUS_ONE' } : prev,
                          )
                        }
                      >
                        <option value="ALLOW">Permitir cualquier fecha</option>
                        <option value="TODAY">Impedir posteriores a hoy</option>
                        <option value="TODAY_PLUS_ONE">Impedir posteriores a hoy + 1</option>
                      </select>
                    </label>
                  </div>

                  <button className="btn" type="submit">
                    Guardar configuración
                  </button>
                  {configStatus && <p className="status">{configStatus}</p>}
                </form>
              )}
            </section>

            <section className="card">
              <h3 style={{ marginTop: 0 }}>Áreas del proyecto activo</h3>
              <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>Área <strong>TODAS</strong>: los administradores y superusuarios ven todos los registros sin importar el área asignada.</p>
              <form onSubmit={(e) => { void addArea(e) }} className="row">
                <input
                  type="text"
                  placeholder="Nueva área"
                  value={newAreaName}
                  onChange={(event) => setNewAreaName(event.target.value)}
                />
                <button className="btn" type="submit">Agregar</button>
              </form>
              <div className="stack" style={{ marginTop: '0.5rem' }}>
                {areas.map((area) => (
                  <div className="row" key={area.id} style={{ alignItems: 'center' }}>
                    {editingAreaId === area.id ? (
                      <>
                        <input
                          type="text"
                          value={editAreaName}
                          onChange={(e) => setEditAreaName(e.target.value)}
                          style={{ flex: 1 }}
                          autoFocus
                        />
                        <button className="btn-sm" onClick={() => { void handleSaveAreaRename(area.id) }}>Guardar</button>
                        <button className="btn-sm btn-outline" onClick={() => setEditingAreaId(null)}>Cancelar</button>
                      </>
                    ) : (
                      <>
                        <span style={{ flex: 1 }}>{area.name}</span>
                        <button className="btn-sm btn-outline" onClick={() => { setEditingAreaId(area.id); setEditAreaName(area.name) }}>Renombrar</button>
                        <button className="btn-sm danger" onClick={() => { void removeArea(area.id) }}>Eliminar</button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="card">
              <h3 style={{ marginTop: 0 }}>Roles del proyecto activo</h3>
              <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>Define los roles con sus tarifas (diaria, semanal, mensual) para usar en liquidaciones.</p>
              <details style={{ marginBottom: '1rem' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 600, userSelect: 'none' }}>+ Agregar rol</summary>
                <form className="stack" style={{ marginTop: '0.75rem' }} onSubmit={(e) => { void handleAddRole(e) }}>
                  <label>Nombre del rol
                    <input type="text" value={newRoleForm.name} onChange={(e) => setNewRoleForm((f) => ({ ...f, name: e.target.value }))} required placeholder="Ej: Oficial, Ayudante..." />
                  </label>
                  <div className="time-grid">
                    <label>Tarifa diaria ($)<input type="number" min={0} step={0.01} value={newRoleForm.dailyRate || ''} onChange={(e) => setNewRoleForm((f) => ({ ...f, dailyRate: parseFloat(e.target.value) || 0 }))} /></label>
                    <label>Tarifa semanal ($)<input type="number" min={0} step={0.01} value={newRoleForm.weeklyRate || ''} onChange={(e) => setNewRoleForm((f) => ({ ...f, weeklyRate: parseFloat(e.target.value) || 0 }))} /></label>
                  </div>
                  <label>Tarifa mensual ($)<input type="number" min={0} step={0.01} value={newRoleForm.monthlyRate || ''} onChange={(e) => setNewRoleForm((f) => ({ ...f, monthlyRate: parseFloat(e.target.value) || 0 }))} /></label>
                  <button className="btn" type="submit">Crear rol</button>
                </form>
              </details>
              <div className="stack">
                {projectRoles.length === 0 && <p className="muted">No hay roles definidos para este proyecto.</p>}
                {projectRoles.map((r) => (
                  <div key={r.id} className="entry-item">
                    {editingRole?.id === r.id ? (
                      <form className="stack" onSubmit={(e) => { void handleSaveRoleEdit(e) }}>
                        <label>Nombre<input type="text" value={editRoleForm.name} onChange={(e) => setEditRoleForm((f) => ({ ...f, name: e.target.value }))} required /></label>
                        <div className="time-grid">
                          <label>Diaria ($)<input type="number" min={0} step={0.01} value={editRoleForm.dailyRate || ''} onChange={(e) => setEditRoleForm((f) => ({ ...f, dailyRate: parseFloat(e.target.value) || 0 }))} /></label>
                          <label>Semanal ($)<input type="number" min={0} step={0.01} value={editRoleForm.weeklyRate || ''} onChange={(e) => setEditRoleForm((f) => ({ ...f, weeklyRate: parseFloat(e.target.value) || 0 }))} /></label>
                        </div>
                        <label>Mensual ($)<input type="number" min={0} step={0.01} value={editRoleForm.monthlyRate || ''} onChange={(e) => setEditRoleForm((f) => ({ ...f, monthlyRate: parseFloat(e.target.value) || 0 }))} /></label>
                        <div className="row">
                          <button className="btn" type="submit">Guardar</button>
                          <button className="btn btn-outline" type="button" onClick={() => setEditingRole(null)}>Cancelar</button>
                        </div>
                      </form>
                    ) : (
                      <div className="row" style={{ alignItems: 'flex-start' }}>
                        <div style={{ flex: 1 }}>
                          <strong>{r.name}</strong>
                          <p className="muted" style={{ margin: '2px 0', fontSize: '0.82rem' }}>
                            Diario: ${r.dailyRate.toFixed(2)} | Semanal: ${r.weeklyRate.toFixed(2)} | Mensual: ${r.monthlyRate.toFixed(2)}
                          </p>
                        </div>
                        <div className="row" style={{ gap: '6px' }}>
                          <button className="btn-sm btn-outline" onClick={() => { setEditingRole(r); setEditRoleForm({ name: r.name, dailyRate: r.dailyRate, weeklyRate: r.weeklyRate, monthlyRate: r.monthlyRate }) }}>Editar</button>
                          <button className="btn-sm danger" onClick={() => { void handleDeleteRole(r.id) }}>Eliminar</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
            </>
          )}

          {projectTab === 'TIME_ENTRY_FORM' && (
            <section className="card">
              <h2>Cargar horario</h2>

              {/* Cards de ciclo laboral / modo refuerzo eliminadas: el 6to día es manual y el reenganche se decide por ese flag. */}

              <form className="stack" onSubmit={submitEntry}>
                <label>
                  Fecha / jornada
                  <input
                    type="date"
                    value={form.workDate}
                    max={!canAudit(currentProfile.role) ? (getMaxWorkDate(projectConfig?.futureDatePolicy) ?? undefined) : undefined}
                    onChange={(event) => setForm((prev) => ({ ...prev, workDate: event.target.value }))}
                    required
                  />
                </label>
                <label>
                  Etiqueta de jornada
                  <input
                    type="text"
                    value={form.shiftLabel}
                    onChange={(event) => setForm((prev) => ({ ...prev, shiftLabel: event.target.value }))}
                    placeholder="Ej: Turno manana"
                  />
                </label>
                <div className="time-grid">
                  <label>
                    Hora in
                    <input
                      type="time"
                      value={form.timeIn}
                      onChange={(event) => setForm((prev) => ({ ...prev, timeIn: event.target.value }))}
                      required
                    />
                  </label>
                  <label>
                    Hora out
                    <input
                      type="time"
                      value={form.timeOut}
                      onChange={(event) => setForm((prev) => ({ ...prev, timeOut: event.target.value }))}
                      required
                    />
                  </label>
                </div>
                <label>
                  Observaciones
                  <textarea
                    value={form.notes}
                    onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
                    rows={3}
                  />
                </label>

                <div className="time-grid">
                  <label>
                    Penalties
                    <select
                      value={form.penalties}
                      onChange={(e) => setForm((prev) => ({ ...prev, penalties: Number(e.target.value) }))}
                    >
                      <option value={0}>0 — Sin penalty</option>
                      <option value={1}>1 penalty</option>
                    </select>
                  </label>
                  {/* 6to día: lo marca manualmente el usuario al cargar la jornada. */}
                  <label style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                    <span style={{ marginBottom: '4px' }}>6to día</span>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 'normal' }}>
                      <input
                        type="checkbox"
                        checked={form.isJornadaAdicional}
                        onChange={(e) => setForm((prev) => ({ ...prev, isJornadaAdicional: e.target.checked }))}
                      />
                      {form.isJornadaAdicional ? 'Sí — 6to día' : 'No'}
                    </label>
                  </label>
                </div>

                <button className="btn" type="submit" disabled={savingEntry}>
                  {savingEntry ? <><Spinner size={14} inline /> Guardando…</> : 'Guardar horario'}
                </button>
              </form>
            </section>
          )}

          {projectTab === 'TIME_ENTRY_TABLE' && (
            <section className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                <h2 style={{ margin: 0 }}>
                  {canAudit(currentProfile.role)
                    ? 'Horarios del proyecto'
                    : currentProfile.areaId
                    ? 'Horarios del área'
                    : 'Mis horarios'}
                </h2>
                {entries.length > 0 && (
                  <button
                    className="btn btn-outline"
                    onClick={() => downloadEntriesCSV(entries, currentProfile, areas)}
                    title="Descargar registros como CSV"
                  >
                    Descargar CSV ({entries.length})
                  </button>
                )}
              </div>
              {entries.length === 0 ? (
                <p className="muted">No hay registros para este proyecto.</p>
              ) : (
                <>
                <div className="mobile-table">
                  {entriesPagination.paged.map((entry) => (
                    <article className="entry-item" key={entry.id}>
                      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <strong>{formatDate(entry.workDate)}</strong> — {entry.shiftLabel}
                          {entry.userId !== currentProfile.uid && (
                            <span className="chip" style={{ marginLeft: '6px', fontSize: '0.75rem' }}>{entry.userName}</span>
                          )}
                          {/* Chips de ciclo (IN_CYCLE / OUT_OF_CYCLE / REINFORCEMENT) eliminados: el 6to día es manual y se muestra más abajo como info. */}
                          <p style={{ margin: '2px 0' }}>{entry.timeIn} → {entry.timeOut}</p>
                          <p style={{ margin: '2px 0' }}>
                            Hs: <strong>{entry.calculation.workedHours}</strong>
                            {' | '}Extras: <strong>{entry.calculation.overtimeHours}</strong>
                            {' | '}Noct: {entry.calculation.nightHours}
                            {entry.calculation.nightOvertimeHours > 0 && (
                              <> {' | '}Noct.Extra: {entry.calculation.nightOvertimeHours}</>
                            )}
                            {entry.calculation.penaltyHours > 0 && (
                              <> {' | '}Penalty: {entry.calculation.penaltyHours}</>
                            )}
                            {entry.calculation.engancheExtraHours > 0 && (
                              <> {' | '}Enganche: {entry.calculation.engancheExtraHours}</>
                            )}
                            {entry.calculation.reengancheExtraHours > 0 && (
                              <> {' | '}Reenganche: {entry.calculation.reengancheExtraHours}</>
                            )}
                            {' | '}6to día: <strong>{entry.isJornadaAdicional ? 'Sí' : 'No'}</strong>
                          </p>
                          {entry.notes && <p className="muted" style={{ margin: '2px 0' }}>{entry.notes}</p>}
                        </div>
                        {(canAudit(currentProfile.role) || entry.userId === currentProfile.uid) && (
                          <div className="row" style={{ gap: '6px' }}>
                            {isDateLocked(entry.workDate) && !canAudit(currentProfile.role) ? (
                              <span className="chip" title="Esta jornada está dentro de un período liquidado" style={{ fontSize: '0.75rem' }}>
                                🔒 Bloqueada
                              </span>
                            ) : (
                              <>
                                <button className="btn-sm" onClick={() => startEditEntry(entry)}>Editar</button>
                                <button className="btn-sm danger" disabled={deletingEntryId === entry.id} onClick={() => { void handleDeleteEntry(entry.id, entry.userId) }}>{deletingEntryId === entry.id ? <><Spinner size={12} inline /> Eliminando…</> : 'Eliminar'}</button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
                <Pagination
                  totalItems={entriesPagination.totalItems}
                  pageSize={entriesPagination.pageSize}
                  page={entriesPagination.page}
                  onPageChange={entriesPagination.setPage}
                  onPageSizeChange={entriesPagination.setPageSize}
                />
                </>
              )}
            </section>
          )}

          {projectTab === 'TIME_ENTRY_AUDIT' && canAudit(currentProfile.role) && (
            <section className="card">
              <h2>Auditoría de horarios</h2>

              {/* ── Usuarios sin informar ──────────────────────────────────── */}
              <details style={{ marginBottom: '1rem', borderBottom: '1px solid var(--line)', paddingBottom: '1rem' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 600, userSelect: 'none' }}>
                  📋 Usuarios sin informar horarios
                </summary>
                <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
                  Reporta los miembros aprobados del proyecto que no cargaron ninguna jornada en el rango indicado.
                </p>
                <div className="time-grid" style={{ marginTop: '0.5rem' }}>
                  <label>
                    Desde
                    <input
                      type="date"
                      value={noReportFilters.dateFrom}
                      onChange={(e) => setNoReportFilters((p) => ({ ...p, dateFrom: e.target.value }))}
                    />
                  </label>
                  <label>
                    Hasta
                    <input
                      type="date"
                      value={noReportFilters.dateTo}
                      onChange={(e) => setNoReportFilters((p) => ({ ...p, dateTo: e.target.value }))}
                    />
                  </label>
                </div>
                <div className="time-grid">
                  <label>
                    Área
                    <select
                      value={noReportFilters.areaId}
                      onChange={(e) => setNoReportFilters((p) => ({ ...p, areaId: e.target.value }))}
                    >
                      <option value="">— Todas las áreas —</option>
                      {areas.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="row" style={{ flexWrap: 'wrap', gap: '8px', marginTop: '0.5rem' }}>
                  <button
                    className="btn"
                    onClick={() => { void loadNoReportUsers() }}
                    disabled={noReportLoading}
                  >
                    {noReportLoading ? <><Spinner size={14} inline /> Consultando…</> : 'Buscar'}
                  </button>
                </div>

                {noReportRows.length > 0 && (
                  <div style={{ overflowX: 'auto', marginTop: '0.75rem' }}>
                    <table className="audit-table">
                      <thead>
                        <tr>
                          <th title="Color de revisión"></th>
                          <th>Usuario</th>
                          <th>Email</th>
                          <th>Área</th>
                          <th>Días sin informar</th>
                        </tr>
                      </thead>
                      <tbody>
                        {noReportRows.map((row) => {
                          const areaName = areas.find((a) => a.id === row.user.areaId)?.name ?? '—'
                          const rowBg = REVIEW_COLORS.find((c) => c.value === row.user.auditReviewColor)?.tint
                          return (
                            <tr key={row.user.uid} style={{ backgroundColor: rowBg }}>
                              <td style={{ padding: '4px 6px' }}>
                                <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
                                  {REVIEW_COLORS.map((rc) => (
                                    <button
                                      key={rc.value}
                                      title={projectConfig?.reviewColorLabels?.[rc.value] ?? rc.defaultLabel}
                                      onClick={() => { void handleSetUserAuditColor(row.user.uid, row.user.auditReviewColor === rc.value ? '' : rc.value) }}
                                      style={{ width: 13, height: 13, borderRadius: '50%', background: rc.bg, border: `2px solid ${row.user.auditReviewColor === rc.value ? '#333' : 'transparent'}`, cursor: 'pointer', padding: 0, flexShrink: 0 }}
                                    />
                                  ))}
                                </div>
                              </td>
                              <td>{row.user.displayName ?? '—'}</td>
                              <td>{row.user.email ?? '—'}</td>
                              <td>{areaName}</td>
                              <td><strong>{row.totalDaysInRange}</strong></td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {!noReportLoading && noReportRows.length === 0 && noReportFilters.dateFrom && noReportFilters.dateTo && (
                  <p className="muted" style={{ marginTop: '0.5rem' }}>Sin resultados (todos los miembros informaron al menos un día en el rango).</p>
                )}
              </details>

              {/* Form admin: cargar jornada para otro usuario */}
              <details style={{ marginBottom: '1rem', borderBottom: '1px solid var(--line)', paddingBottom: '1rem' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 600, userSelect: 'none' }}>
                  + Cargar jornada para un usuario
                </summary>
                <form className="stack" style={{ marginTop: '0.75rem' }} onSubmit={(e) => { void submitAdminEntry(e) }}>
                  <label>
                    Usuario
                    <select value={adminEntryUserId} onChange={(e) => setAdminEntryUserId(e.target.value)} required>
                      <option value="">— Seleccionar usuario —</option>
                      {projectUsers.map((u) => (
                        <option key={u.uid} value={u.uid}>{u.displayName ?? u.email}</option>
                      ))}
                    </select>
                  </label>
                  <div className="time-grid">
                    <label>Fecha
                      <input type="date" value={adminEntryForm.workDate} onChange={(e) => setAdminEntryForm((f) => ({ ...f, workDate: e.target.value }))} required />
                    </label>
                    <label>Etiqueta
                      <input type="text" value={adminEntryForm.shiftLabel} onChange={(e) => setAdminEntryForm((f) => ({ ...f, shiftLabel: e.target.value }))} placeholder="Ej: Turno mañana" />
                    </label>
                  </div>
                  <div className="time-grid">
                    <label>Entrada<input type="time" value={adminEntryForm.timeIn} onChange={(e) => setAdminEntryForm((f) => ({ ...f, timeIn: e.target.value }))} required /></label>
                    <label>Salida<input type="time" value={adminEntryForm.timeOut} onChange={(e) => setAdminEntryForm((f) => ({ ...f, timeOut: e.target.value }))} required /></label>
                  </div>
                  <label>Observaciones
                    <input type="text" value={adminEntryForm.notes} onChange={(e) => setAdminEntryForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Opcional" />
                  </label>
                  <div className="time-grid">
                    <label>Penalties
                      <select value={adminEntryForm.penalties} onChange={(e) => setAdminEntryForm((f) => ({ ...f, penalties: Number(e.target.value) }))}>
                        <option value={0}>0 — Sin penalty</option>
                        <option value={1}>1 penalty</option>
                      </select>
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                      <span style={{ marginBottom: '4px' }}>6to día</span>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 'normal' }}>
                        <input type="checkbox" checked={adminEntryForm.isJornadaAdicional} onChange={(e) => setAdminEntryForm((f) => ({ ...f, isJornadaAdicional: e.target.checked }))} />
                        {adminEntryForm.isJornadaAdicional ? 'Sí' : 'No'}
                      </label>
                    </label>
                  </div>
                  <button className="btn" type="submit">Guardar jornada</button>
                </form>
              </details>

              <div className="stack">
                <div className="time-grid">
                  <label>
                    Desde
                    <input
                      type="date"
                      value={auditFilters.dateFrom}
                      onChange={(e) => setAuditFilters((prev) => ({ ...prev, dateFrom: e.target.value }))}
                    />
                  </label>
                  <label>
                    Hasta
                    <input
                      type="date"
                      value={auditFilters.dateTo}
                      onChange={(e) => setAuditFilters((prev) => ({ ...prev, dateTo: e.target.value }))}
                    />
                  </label>
                </div>
                <div className="time-grid">
                  <label>
                    Usuario
                    <select value={auditFilters.userId} onChange={(e) => setAuditFilters((prev) => ({ ...prev, userId: e.target.value }))}>
                      <option value="">— Todos los usuarios —</option>
                      {projectUsers.map((u) => (
                        <option key={u.uid} value={u.uid}>{u.displayName ?? u.email}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Área
                    <select value={auditFilters.areaId} onChange={(e) => setAuditFilters((prev) => ({ ...prev, areaId: e.target.value }))}>
                      <option value="">— Todas las áreas —</option>
                      {areas.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="row" style={{ flexWrap: 'wrap', gap: '8px' }}>
                  <button className="btn" onClick={() => { void loadAuditEntries() }} disabled={auditLoading}>
                    {auditLoading ? <><Spinner size={14} inline /> Cargando…</> : 'Buscar'}
                  </button>
                  {auditEntries.length > 0 && (
                    <button className="btn btn-outline" onClick={exportAuditExcel}>
                      Exportar Excel ({auditEntries.length})
                    </button>
                  )}
                  <button
                    className="btn btn-outline"
                    onClick={openRecalcModal}
                    title="Recalcula registros no liquidados en el rango de fechas elegido"
                  >
                    Recalcular…
                  </button>
                  <button
                    className="btn btn-outline"
                    onClick={openSyncAreasModal}
                    title="Actualiza el área en los registros no liquidados del rango de fechas elegido"
                  >
                    Sincronizar áreas…
                  </button>
                </div>
              </div>

              {editingAuditEntry && (
                <div style={{ background: 'var(--bg-accent)', padding: '1rem', borderRadius: 'var(--radius)', marginTop: '0.75rem' }}>
                  <strong>Editando: {editingAuditEntry.userName} — {formatDate(editingAuditEntry.workDate)}</strong>
                  <form className="stack" style={{ marginTop: '0.5rem' }} onSubmit={(e) => { void submitEditAuditEntry(e) }}>
                    <div className="time-grid">
                      <label>Fecha<input type="date" value={editAuditForm.workDate} onChange={(e) => setEditAuditForm((f) => ({ ...f, workDate: e.target.value }))} required /></label>
                      <label>Etiqueta<input type="text" value={editAuditForm.shiftLabel} onChange={(e) => setEditAuditForm((f) => ({ ...f, shiftLabel: e.target.value }))} /></label>
                    </div>
                    <div className="time-grid">
                      <label>Entrada<input type="time" value={editAuditForm.timeIn} onChange={(e) => setEditAuditForm((f) => ({ ...f, timeIn: e.target.value }))} required /></label>
                      <label>Salida<input type="time" value={editAuditForm.timeOut} onChange={(e) => setEditAuditForm((f) => ({ ...f, timeOut: e.target.value }))} required /></label>
                    </div>
                    <label>Observaciones<input type="text" value={editAuditForm.notes} onChange={(e) => setEditAuditForm((f) => ({ ...f, notes: e.target.value }))} /></label>
                    <div className="time-grid">
                      <label>Penalties
                        <select value={editAuditForm.penalties} onChange={(e) => setEditAuditForm((f) => ({ ...f, penalties: Number(e.target.value) }))}>
                          <option value={0}>0</option>
                          <option value={1}>1</option>
                        </select>
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                        <span style={{ marginBottom: '4px' }}>6to día</span>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 'normal' }}>
                          <input type="checkbox" checked={editAuditForm.isJornadaAdicional} onChange={(e) => setEditAuditForm((f) => ({ ...f, isJornadaAdicional: e.target.checked }))} />
                          {editAuditForm.isJornadaAdicional ? 'Sí' : 'No'}
                        </label>
                      </label>
                    </div>
                    <div className="row">
                      <button className="btn" type="submit">Guardar</button>
                      <button className="btn btn-outline" type="button" onClick={() => setEditingAuditEntry(null)}>Cancelar</button>
                    </div>
                  </form>
                </div>
              )}

              {auditEntries.length > 0 ? (
                <div style={{ overflowX: 'auto', marginTop: '0.75rem' }}>
                  {/* Leyenda de colores */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', marginBottom: '8px' }}>
                    <span className="muted" style={{ fontSize: '0.78rem', marginRight: '2px' }}>Leyenda:</span>
                    {REVIEW_COLORS.map((rc) => (
                      <div key={rc.value} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ width: 11, height: 11, borderRadius: '50%', background: rc.bg, display: 'inline-block', flexShrink: 0 }} />
                        <input
                          type="text"
                          defaultValue={projectConfig?.reviewColorLabels?.[rc.value] ?? rc.defaultLabel}
                          readOnly={!canAudit(currentProfile.role)}
                          onBlur={(e) => {
                            if (!activeProjectId || !projectConfig) return
                            const updated = { ...projectConfig, reviewColorLabels: { ...(projectConfig.reviewColorLabels ?? {}), [rc.value]: e.target.value.trim() || rc.defaultLabel } }
                            setProjectConfig(updated)
                            void saveProjectConfig(activeProjectId, updated)
                          }}
                          style={{ border: 'none', borderBottom: canAudit(currentProfile.role) ? '1px dashed var(--line)' : 'none', background: 'transparent', fontSize: '0.78rem', width: '90px', padding: '0 2px', outline: 'none' }}
                        />
                      </div>
                    ))}
                    <span className="muted" style={{ fontSize: '0.75rem' }}>(clic en punto = asignar color; doble clic = quitar)</span>
                  </div>
                  <table className="audit-table">
                    <thead>
                      <tr>
                        <th title="Color de revisión"></th>
                        <th>Fecha</th>
                        <th>Usuario</th>
                        <th>Jornada</th>
                        <th>Entrada</th>
                        <th>Salida</th>
                        <th>Hs. Trab.</th>
                        <th>Extras</th>
                        <th>Noct.</th>
                        <th>N.Ext.</th>
                        <th>Enganche</th>
                        <th>Reenganche</th>
                        <th>Pen.</th>
                        <th title="Extras + Enganche + Reenganche + Penalties">Tot. Ext.</th>
                        <th>6to día</th>
                        <th>Obs.</th>
                        <th>Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditPagination.paged.map((entry) => {
                        const totalExtras = (entry.calculation.overtimeHours ?? 0)
                          + (entry.calculation.engancheExtraHours ?? 0)
                          + (entry.calculation.reengancheExtraHours ?? 0)
                          + (entry.calculation.penaltyHours ?? 0)
                        const rowBg = REVIEW_COLORS.find((c) => c.value === entry.reviewColor)?.tint
                        return (
                          <tr key={entry.id} style={{ opacity: editingAuditEntry?.id === entry.id ? 0.4 : 1, backgroundColor: rowBg }}>
                            <td style={{ padding: '4px 6px' }}>
                              <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
                                {REVIEW_COLORS.map((rc) => (
                                  <button
                                    key={rc.value}
                                    title={getColorLabel(rc.value)}
                                    onClick={() => { void handleSetReviewColor(entry.id, entry.reviewColor === rc.value ? '' : rc.value) }}
                                    style={{ width: 13, height: 13, borderRadius: '50%', background: rc.bg, border: `2px solid ${entry.reviewColor === rc.value ? '#333' : 'transparent'}`, cursor: 'pointer', padding: 0, flexShrink: 0 }}
                                  />
                                ))}
                              </div>
                            </td>
                            <td>{formatDate(entry.workDate)}</td>
                            <td>{entry.userName}</td>
                            <td>{entry.shiftLabel}</td>
                            <td>{entry.timeIn}</td>
                            <td>{entry.timeOut}</td>
                            <td><strong>{entry.calculation.workedHours}</strong></td>
                            <td>{entry.calculation.overtimeHours}</td>
                            <td>{entry.calculation.nightHours}</td>
                            <td>{(entry.calculation.nightOvertimeHours ?? 0) > 0 ? entry.calculation.nightOvertimeHours : '—'}</td>
                            <td>{(entry.calculation.engancheExtraHours ?? 0) > 0 ? entry.calculation.engancheExtraHours : '—'}</td>
                            <td>{(entry.calculation.reengancheExtraHours ?? 0) > 0 ? entry.calculation.reengancheExtraHours : '—'}</td>
                            <td>{(entry.calculation.penaltyHours ?? 0) > 0 ? entry.calculation.penaltyHours : '—'}</td>
                            <td><strong>{totalExtras > 0 ? totalExtras.toFixed(2) : '—'}</strong></td>
                            <td style={{ textAlign: 'center' }}>{entry.isJornadaAdicional ? '✓' : '—'}</td>
                            <td>{entry.notes || '—'}</td>
                            <td>
                              <div style={{ display: 'flex', gap: '4px' }}>
                                <button className="btn-sm" onClick={() => startEditAuditEntry(entry)}>Editar</button>
                                <button className="btn-sm danger" onClick={() => { void handleDeleteAuditEntry(entry.id, entry.userId) }}>Eliminar</button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  <Pagination
                    totalItems={auditPagination.totalItems}
                    pageSize={auditPagination.pageSize}
                    page={auditPagination.page}
                    onPageChange={auditPagination.setPage}
                    onPageSizeChange={auditPagination.setPageSize}
                    pageSizeOptions={[25, 50, 100, 200]}
                  />
                </div>
              ) : (
                !auditLoading && <p className="muted">Aplicá filtros y presioná Buscar para ver registros.</p>
              )}
            </section>
          )}

          {projectTab === 'SETTLEMENTS' && (
            <section className="card">
              <h2>Nueva Liquidación</h2>
              <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
                Las tarifas se calculan automáticamente según el rol asignado a cada colaborador.
              </p>
              <form onSubmit={(e) => { void calculateSettlementPreview(e) }} className="stack">
                <div className="row">
                  <div className="stack" style={{ flex: 1 }}>
                    <label>Desde
                      <input type="date" required value={settlementForm.dateFrom} onChange={(e) => setSettlementForm((f) => ({ ...f, dateFrom: e.target.value }))} />
                    </label>
                  </div>
                  <div className="stack" style={{ flex: 1 }}>
                    <label>Hasta
                      <input type="date" required value={settlementForm.dateTo} onChange={(e) => setSettlementForm((f) => ({ ...f, dateTo: e.target.value }))} />
                    </label>
                  </div>
                </div>
                <button type="submit" className="btn" disabled={settlementLoading}>
                  {settlementLoading ? <><Spinner size={14} inline /> Calculando…</> : 'Calcular'}
                </button>
              </form>

              {currentSettlement && (
                <>
                  <hr />
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <h3 style={{ margin: 0 }}>
                      Vista previa: {formatDate(currentSettlement.dateFrom)} → {formatDate(currentSettlement.dateTo)}
                      {isSettlementSaved && <span className="chip" style={{ marginLeft: '8px', background: 'var(--green, #22c55e)', color: '#fff' }}>Guardada</span>}
                    </h3>
                    <div className="row" style={{ gap: '8px' }}>
                      {!isSettlementSaved && (
                        <button
                          className="btn"
                          onClick={() => { void handleSaveSettlement() }}
                          disabled={settlementLoading || editableLines.length === 0}
                        >
                          {settlementLoading ? <><Spinner size={14} inline /> Guardando…</> : 'Guardar Liquidación'}
                        </button>
                      )}
                      <button className="btn btn-outline" onClick={() => exportSettlementExcel({ ...currentSettlement, lines: editableLines })}>
                        Exportar Excel
                      </button>
                    </div>
                  </div>
                  {!isSettlementSaved && editableLines.length > 0 && (
                    <p className="muted" style={{ fontSize: '0.82rem', marginTop: '4px' }}>
                      Podés ajustar los montos manualmente antes de confirmar.
                    </p>
                  )}
                  {editableLines.length === 0 ? (
                    <p className="muted">No hay jornadas registradas en ese período.</p>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      {/* Leyenda de colores */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', marginBottom: '8px' }}>
                        <span className="muted" style={{ fontSize: '0.78rem', marginRight: '2px' }}>Leyenda:</span>
                        {REVIEW_COLORS.map((rc) => (
                          <div key={rc.value} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ width: 11, height: 11, borderRadius: '50%', background: rc.bg, display: 'inline-block', flexShrink: 0 }} />
                            <input
                              type="text"
                              defaultValue={projectConfig?.reviewColorLabels?.[rc.value] ?? rc.defaultLabel}
                              readOnly={!canAudit(currentProfile.role)}
                              onBlur={(e) => {
                                if (!activeProjectId || !projectConfig) return
                                const updated = { ...projectConfig, reviewColorLabels: { ...(projectConfig.reviewColorLabels ?? {}), [rc.value]: e.target.value.trim() || rc.defaultLabel } }
                                setProjectConfig(updated)
                                void saveProjectConfig(activeProjectId, updated)
                              }}
                              style={{ border: 'none', borderBottom: canAudit(currentProfile.role) ? '1px dashed var(--line)' : 'none', background: 'transparent', fontSize: '0.78rem', width: '90px', padding: '0 2px', outline: 'none' }}
                            />
                          </div>
                        ))}
                      </div>
                      <table className="audit-table">
                        <thead>
                          <tr>
                            <th title="Color de revisión"></th>
                            <th>Colaborador</th><th>Rol</th><th>$/h</th>
                            <th>Hs. Norm.</th><th>Hs. Ext.</th><th>Hs. Noct.</th>
                            <th title="Horas extra que caen en ventana nocturna">Noct. Ext.</th>
                            <th>Enganches</th><th>Reenganches</th>
                            <th title="Cantidad de 6tos días">6to día</th>
                            <th>Pen.</th>
                            <th title="Extras + Enganche + Reenganche + Penalties">Tot. Ext.</th>
                            <th>Total Hs.</th><th>Total $</th>
                          </tr>
                        </thead>
                        <tbody>
                          {editableLines.map((l, i) => {
                            type EditableHourField =
                              | 'regularHours' | 'overtimeHours' | 'nightHours'
                              | 'nightOvertimeHours' | 'engancheExtraHours'
                              | 'reengancheExtraHours' | 'penaltyHours'
                            function updateHours(field: EditableHourField, val: number) {
                              setEditableLines((prev) => prev.map((line, idx) => {
                                if (idx !== i) return line
                                const updated = { ...line, [field]: val }
                                const rp = Math.round(updated.regularHours * updated.hourlyRate * 100) / 100
                                const op = Math.round(
                                  (updated.overtimeHours + updated.penaltyHours + updated.engancheExtraHours + updated.reengancheExtraHours)
                                  * updated.hourlyRate * updated.overtimeMultiplier * 100,
                                ) / 100
                                const np = Math.round(updated.nightHours * updated.hourlyRate * updated.nightMultiplier * 100) / 100
                                const totalHours = Math.round((updated.regularHours + updated.overtimeHours) * 100) / 100
                                return { ...updated, totalHours, regularPay: rp, overtimePay: op, nightPay: np, totalPay: Math.round((rp + op + np) * 100) / 100 }
                              }))
                            }
                            const safe = (v: number | undefined) => v ?? 0
                            function editableNum(field: EditableHourField, val: number) {
                              const safeVal = safe(val)
                              if (isSettlementSaved) return <span>{safeVal.toFixed(2)}</span>
                              return (
                                <input type="number" min={0} step={0.01} value={safeVal} style={{ width: '66px' }}
                                  onChange={(e) => updateHours(field, parseFloat(e.target.value) || 0)} />
                              )
                            }
                            function editableCount(val: number | undefined) {
                              const safeVal = safe(val)
                              if (isSettlementSaved) return <span style={{ textAlign: 'center' }}>{safeVal}</span>
                              return (
                                <input type="number" min={0} step={1} value={safeVal} style={{ width: '52px', textAlign: 'center' }}
                                  onChange={(e) => setEditableLines((prev) => prev.map((line, idx) =>
                                    idx !== i ? line : { ...line, jornadaAdicionalCount: parseInt(e.target.value) || 0 }
                                  ))} />
                              )
                            }
                            return (
                              <tr key={l.userId} style={{ backgroundColor: REVIEW_COLORS.find((c) => c.value === l.reviewColor)?.tint }}>
                                <td style={{ padding: '4px 6px' }}>
                                  <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
                                    {REVIEW_COLORS.map((rc) => (
                                      <button
                                        key={rc.value}
                                        title={getColorLabel(rc.value)}
                                        onClick={() => setEditableLines((prev) => prev.map((line, idx) =>
                                          idx === i ? { ...line, reviewColor: line.reviewColor === rc.value ? '' : rc.value } : line
                                        ))}
                                        style={{ width: 13, height: 13, borderRadius: '50%', background: rc.bg, border: `2px solid ${l.reviewColor === rc.value ? '#333' : 'transparent'}`, cursor: 'pointer', padding: 0, flexShrink: 0 }}
                                      />
                                    ))}
                                  </div>
                                </td>
                                <td>{l.userName}</td>
                                <td>{l.roleName ?? <span className="muted">—</span>}</td>
                                <td>{l.hourlyRate > 0 ? l.hourlyRate.toFixed(2) : <span className="muted">—</span>}</td>
                                <td>{editableNum('regularHours', l.regularHours)}</td>
                                <td>{editableNum('overtimeHours', l.overtimeHours)}</td>
                                <td>{editableNum('nightHours', l.nightHours)}</td>
                                <td>{editableNum('nightOvertimeHours', l.nightOvertimeHours)}</td>
                                <td>{editableNum('engancheExtraHours', l.engancheExtraHours)}</td>
                                <td>{editableNum('reengancheExtraHours', l.reengancheExtraHours)}</td>
                                <td style={{ textAlign: 'center' }}>{editableCount(l.jornadaAdicionalCount)}</td>
                                <td>{editableNum('penaltyHours', l.penaltyHours)}</td>
                                <td><strong>{((safe(l.overtimeHours) + safe(l.engancheExtraHours) + safe(l.reengancheExtraHours) + safe(l.penaltyHours))).toFixed(2)}</strong></td>
                                <td>{safe(l.totalHours).toFixed(2)}</td>
                                <td><strong>${safe(l.totalPay).toFixed(2)}</strong></td>
                              </tr>
                            )
                          })}
                          <tr style={{ fontWeight: 600, borderTop: '2px solid var(--line)' }}>
                            <td></td>
                            <td colSpan={3}>TOTAL</td>
                            <td>{editableLines.reduce((a, l) => a + (l.regularHours ?? 0), 0).toFixed(2)}</td>
                            <td>{editableLines.reduce((a, l) => a + (l.overtimeHours ?? 0), 0).toFixed(2)}</td>
                            <td>{editableLines.reduce((a, l) => a + (l.nightHours ?? 0), 0).toFixed(2)}</td>
                            <td>{editableLines.reduce((a, l) => a + (l.nightOvertimeHours ?? 0), 0).toFixed(2)}</td>
                            <td>{editableLines.reduce((a, l) => a + (l.engancheExtraHours ?? 0), 0).toFixed(2)}</td>
                            <td>{editableLines.reduce((a, l) => a + (l.reengancheExtraHours ?? 0), 0).toFixed(2)}</td>
                            <td style={{ textAlign: 'center' }}>{editableLines.reduce((a, l) => a + (l.jornadaAdicionalCount ?? 0), 0)}</td>
                            <td>{editableLines.reduce((a, l) => a + (l.penaltyHours ?? 0), 0).toFixed(2)}</td>
                            <td>{editableLines.reduce((a, l) => a + (l.overtimeHours ?? 0) + (l.engancheExtraHours ?? 0) + (l.reengancheExtraHours ?? 0) + (l.penaltyHours ?? 0), 0).toFixed(2)}</td>
                            <td>{editableLines.reduce((a, l) => a + (l.totalHours ?? 0), 0).toFixed(2)}</td>
                            <td>${editableLines.reduce((a, l) => a + (l.totalPay ?? 0), 0).toFixed(2)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              {pastSettlements.length > 0 && (
                <>
                  <hr />
                  <h3>Historial de Liquidaciones</h3>
                  <div className="stack">
                    {settlementsPagination.paged.map((s) => (
                      <div key={s.id} className="entry-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <strong>{formatDate(s.dateFrom)} → {formatDate(s.dateTo)}</strong>
                          <br />
                          <span className="muted">
                            {s.lines.length} colaborador{s.lines.length !== 1 ? 'es' : ''} — Total ${s.totalPay.toFixed(2)}
                          </span>
                        </div>
                        <div className="row" style={{ gap: '6px' }}>
                          <button className="btn-sm" onClick={() => exportSettlementExcel(s)}>Excel</button>
                          <button
                            className="btn-sm danger"
                            onClick={() => { void handleDeleteSettlement(s.id!) }}
                            title="Liberar fechas: permite modificar jornadas de este período"
                          >
                            Liberar
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <Pagination
                    totalItems={settlementsPagination.totalItems}
                    pageSize={settlementsPagination.pageSize}
                    page={settlementsPagination.page}
                    onPageChange={settlementsPagination.setPage}
                    onPageSizeChange={settlementsPagination.setPageSize}
                    pageSizeOptions={[5, 10, 25, 50]}
                  />
                </>
              )}
            </section>
          )}
        </>
      )}

      {/* === USUARIOS === */}
      {mainTab === 'USERS' && canAudit(currentProfile.role) && (
        <>
          <nav className="subtab-row" style={{ alignItems: 'center' }}>
            <button
              className={`subtab ${userTab === 'PENDING' ? 'active' : ''}`}
              onClick={() => setUserTab('PENDING')}
            >
              Pendientes{pendingUsers.length > 0 ? ` (${pendingUsers.length})` : ''}
            </button>
            <button
              className={`subtab ${userTab === 'APPROVED' ? 'active' : ''}`}
              onClick={() => setUserTab('APPROVED')}
            >
              Aprobados
            </button>
            <button
              className="btn-sm btn-outline"
              style={{ marginLeft: 'auto' }}
              onClick={() => { void loadUsersPanels() }}
              title="Recargar listados de usuarios"
            >
              Refrescar
            </button>
            <button
              className="btn-sm btn-outline"
              disabled={repairBusy}
              onClick={() => { void handleRepairMerged() }}
              title="Marca como fusionados los placeholders cuyo usuario real ya existe (limpia duplicados por mail)"
            >
              {repairBusy ? 'Reparando…' : 'Reparar duplicados'}
            </button>
          </nav>

          {userTab === 'PENDING' && (
            <>
              {/* Importación masiva */}
              <section className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <h2 style={{ margin: 0 }}>Miembros pre-registrados</h2>
                  <label className="btn" style={{ cursor: 'pointer', margin: 0 }}>
                    Importar desde Excel
                    <input
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) handleImportExcel(file)
                        e.target.value = ''
                      }}
                    />
                  </label>
                </div>
                <p className="muted" style={{ fontSize: '0.82rem', marginTop: 0, marginBottom: '0.75rem' }}>
                  Planilla Excel: columna A = email, columna B = nombre. Se importan como MIEMBROS y se aprueban automáticamente al iniciar sesión por primera vez.
                </p>

                {/* Vista previa de importación */}
                {importPreview && (
                  <div style={{ border: '1px solid var(--line)', borderRadius: '6px', padding: '12px', marginBottom: '0.75rem', background: 'var(--bg-subtle, #f8f8f8)' }}>
                    <p style={{ margin: '0 0 6px', fontWeight: 600 }}>
                      Vista previa: {importPreview.toImport.length} miembro(s) a importar
                    </p>
                    {importPreview.duplicates.length > 0 && (
                      <p className="muted" style={{ margin: '0 0 6px', fontSize: '0.82rem' }}>
                        {importPreview.duplicates.length} correo(s) ya existen y serán ignorados:{' '}
                        {importPreview.duplicates.join(', ')}
                      </p>
                    )}
                    {importPreview.toImport.length === 0 ? (
                      <p className="muted" style={{ margin: '0 0 8px', fontSize: '0.82rem' }}>Todos los correos ya existen.</p>
                    ) : (
                      <div style={{ maxHeight: '140px', overflowY: 'auto', marginBottom: '8px', fontSize: '0.82rem' }}>
                        {importPreview.toImport.map((m) => (
                          <div key={m.email} style={{ padding: '2px 0' }}>
                            <strong>{m.displayName || '—'}</strong> &lt;{m.email}&gt;
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        className="btn"
                        disabled={importLoading || importPreview.toImport.length === 0}
                        onClick={() => { void handleConfirmImport() }}
                      >
                        {importLoading ? 'Importando…' : `Confirmar (${importPreview.toImport.length})`}
                      </button>
                      <button className="btn-outline" onClick={() => setImportPreview(null)}>Cancelar</button>
                    </div>
                  </div>
                )}

                {/* Lista de miembros pre-registrados */}
                {importedMembers.length === 0 ? (
                  <p className="muted">No hay miembros pre-registrados pendientes de primer acceso.</p>
                ) : (
                  <div className="stack">
                    {importedMembers.map((m) => (
                      <div key={m.uid} style={{ justifyContent: 'space-between' }}>
                        <div>
                          <strong>{m.displayName || '—'}</strong>
                          <p className="muted" style={{ margin: 0 }}>{m.email}</p>
                        </div>
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            className="btn-sm"
                            title="Aprobar y asignar proyecto / área / rol"
                            onClick={() => openApproveImportedModal(m)}
                          >
                            Aprobar
                          </button>
                          <button
                            className="btn-sm btn-outline"
                            title="Eliminar pre-registro"
                            onClick={() => { void deleteImportedPlaceholder(m.uid).catch(() => showToast('Error al eliminar.')) }}
                          >
                            Eliminar
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Usuarios pendientes de aprobación manual */}
              <section className="card">
                <h2>Usuarios pendientes de aprobación</h2>
                {pendingUsers.length === 0 ? (
                  <p className="muted">No hay usuarios pendientes.</p>
                ) : (
                  <div className="stack">
                    {pendingUsers.map((pendingUser) => (
                      <div className="row" key={pendingUser.uid} style={{ justifyContent: 'space-between' }}>
                        <div>
                          <strong>{pendingUser.displayName ?? 'Sin nombre'}</strong>
                          <p className="muted" style={{ margin: 0 }}>{pendingUser.email}</p>
                        </div>
                        <button className="btn" onClick={() => openApproveModal(pendingUser)}>
                          Aprobar...
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}

          {userTab === 'APPROVED' && (
            <section className="card">
              <h2>Usuarios aprobados</h2>
              <input
                type="search"
                placeholder="Buscar por nombre o email..."
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                style={{ marginBottom: '0.75rem' }}
              />
              {filteredApprovedUsers.length === 0 ? (
                <p className="muted">Sin resultados.</p>
              ) : (
                <div className="stack">
                  {filteredApprovedUsers.map((u) => (
                    <div className="entry-item" key={u.uid} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <strong>{u.displayName ?? '—'}</strong>
                        <p className="muted" style={{ margin: '2px 0' }}>{u.email}</p>
                        <div className="row" style={{ gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                          {u.isPlaceholder && (
                            <span className="chip" style={{ background: '#f97316', color: '#fff', fontSize: '0.72rem' }}>Sin primer acceso</span>
                          )}
                          {u.disabled && (
                            <span className="chip" style={{ background: '#ef4444', color: '#fff', fontSize: '0.72rem' }}>Inhabilitado</span>
                          )}
                          {u.cycleMode === 'REINFORCEMENT' && (
                            <span className="chip" style={{ background: '#8b5cf6', color: '#fff', fontSize: '0.72rem' }}>Refuerzo</span>
                          )}
                          <span className="chip">{u.role}</span>
                          {u.projectId && (
                            <span className="chip">
                              {projects.find((p) => p.id === u.projectId)?.name ?? u.projectId}
                            </span>
                          )}
                          {u.areaId && (
                            <span className="chip">
                              Área: {areas.find((a) => a.id === u.areaId)?.name ?? u.areaId}
                            </span>
                          )}
                          {u.roleId && (
                            <span className="chip" style={{ background: 'var(--bg-accent)' }}>
                              Rol: {projectRoles.find((r) => r.id === u.roleId)?.name ?? u.roleId}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="row" style={{ gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <button className="btn-sm btn-outline" onClick={() => openEditUser(u)}>Editar</button>
                        <button
                          className="btn-sm btn-outline"
                          onClick={() => handleToggleUserDisabled(u)}
                          disabled={u.uid === profile?.uid}
                          title={u.uid === profile?.uid ? 'No podés inhabilitar tu propia cuenta' : ''}
                        >
                          {u.disabled ? 'Rehabilitar' : 'Inhabilitar'}
                        </button>
                        <button
                          className="btn-sm danger"
                          onClick={() => handleDeleteApprovedUser(u)}
                          disabled={u.uid === profile?.uid || u.role === 'SUPERUSER'}
                          title={
                            u.uid === profile?.uid
                              ? 'No podés eliminar tu propia cuenta'
                              : u.role === 'SUPERUSER'
                              ? 'No se puede eliminar un Superusuario'
                              : ''
                          }
                        >
                          Eliminar
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {/* === AYUDA (incluye Soporte) === */}
      {mainTab === 'HELP' && (
        <>
          <section className="card">
            <h2>Soporte</h2>
            {activeProjectId ? (
              <SupportChatPanel
                viewer={currentProfile}
                projectId={activeProjectId}
                projectName={activeProjectName}
                areas={areas}
                showToast={showToast}
              />
            ) : (
              <p className="muted">Seleccioná un proyecto para usar el chat de soporte.</p>
            )}
          </section>

        <section className="card">
          <h2>Ayuda y guía de uso</h2>

          <h3>¿Qué es Cargá tus horas?</h3>
          <p>Sistema de registro y liquidación de jornadas laborales por proyecto. Cada colaborador carga sus horarios de entrada y salida, el sistema calcula horas regulares, extras y nocturnas según la configuración del proyecto, y los administradores pueden auditar, editar y generar liquidaciones.</p>

          <hr />

          <h3>Tipos de usuario</h3>
          <div className="stack">
            <div className="entry-item">
              <strong><span className="chip">SUPERUSER</span> Superusuario</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>Acceso total al sistema: crea y edita proyectos, gestiona usuarios de toda la organización, audita y borra cualquier registro, y modera todas las conversaciones de soporte.</p>
            </div>
            <div className="entry-item">
              <strong><span className="chip">PROJECT_ADMIN</span> Administrador de proyecto</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>Gestiona el proyecto al que fue asignado: configura horas/multiplicadores, áreas y roles, audita jornadas, edita o elimina cualquier registro del proyecto, genera liquidaciones y participa en todas las conversaciones de soporte de su proyecto.</p>
            </div>
            <div className="entry-item">
              <strong><span className="chip">MEMBER</span> Miembro</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>Carga sus propias jornadas, consulta su historial y edita o elimina sus registros mientras no estén bloqueados por un administrador. Puede iniciar conversaciones de soporte.</p>
            </div>
          </div>

          <hr />

          <h3>Flujo de acceso</h3>
          <ol style={{ paddingLeft: '1.25rem', lineHeight: '1.8' }}>
            <li>El usuario se registra con Google o con email/contraseña.</li>
            <li>La cuenta queda en estado <em>pendiente</em> hasta que un administrador la aprueba.</li>
            <li>Al aprobar, el administrador asigna rol, proyecto y área.</li>
            <li>Una vez aprobado, el usuario ingresa al panel.</li>
          </ol>

          <p className="muted" style={{ fontSize: '0.9rem' }}><strong>Atajo para nuevos equipos:</strong> los administradores pueden <em>importar miembros</em> desde la solapa <strong>Usuarios</strong> cargando un Excel/CSV con mail y nombre. Cuando ese usuario se loguea por primera vez, su registro pre-creado se fusiona automáticamente y conserva el rol, proyecto y área que ya tenía asignados.</p>

          <hr />

          <h3>Carga de jornadas (solapa Horarios)</h3>
          <ul style={{ paddingLeft: '1.25rem', lineHeight: '1.8' }}>
            <li>Seleccioná el proyecto activo en el menú superior.</li>
            <li><strong>Cargar horario:</strong> fecha, etiqueta de turno, hora de entrada, hora de salida, notas, penalties y "6to día" si aplica.</li>
            <li><strong>Mis horarios / Horarios del área / Horarios del proyecto</strong> (según rol): listado para revisar, editar o eliminar registros que no estén bloqueados.</li>
            <li>Las horas extras, nocturnas y multiplicadores se calculan automáticamente según la <em>Configuración</em> del proyecto.</li>
          </ul>

          <hr />

          <h3>Auditoría (admins)</h3>
          <ul style={{ paddingLeft: '1.25rem', lineHeight: '1.8' }}>
            <li>Filtrá por rango de fechas y/o usuario.</li>
            <li>Editá o eliminá cualquier jornada del proyecto directamente desde la tabla.</li>
            <li>Asigná <strong>colores de revisión</strong> (verde, amarillo, rojo, etc.) para marcar el estado de cada jornada. Las etiquetas de cada color se configuran en <em>Configuración del proyecto</em>.</li>
            <li>Bloqueá rangos de fechas para evitar modificaciones por parte de los miembros una vez liquidados.</li>
            <li>Exportá a CSV/Excel para análisis externos.</li>
          </ul>

          <hr />

          <h3>Liquidaciones (admins)</h3>
          <ul style={{ paddingLeft: '1.25rem', lineHeight: '1.8' }}>
            <li>Definí el período y los miembros incluidos.</li>
            <li>El sistema calcula el total por colaborador considerando horas regulares, extras, nocturnas, penalties, enganche/reenganche y jornadas adicionales.</li>
            <li>Cada liquidación queda guardada en el historial y se puede exportar.</li>
          </ul>

          <hr />

          <h3>Soporte y chat (solapa Soporte)</h3>
          <p>Espacio para que los miembros se comuniquen con administradores y entre sí. Al crear una conversación se elige su <strong>nivel de privacidad</strong>:</p>
          <div className="stack">
            <div className="entry-item">
              <strong><span className="chat-scope-badge scope-private">Privada</span></strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>Solo el creador de la conversación, los <em>administradores del proyecto</em> y el <em>superusuario</em> pueden ver y participar. Ideal para consultas personales (un problema con tu carga, dudas sobre tu liquidación, etc.).</p>
            </div>
            <div className="entry-item">
              <strong><span className="chat-scope-badge scope-area">Área</span></strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>Visible para todos los miembros de un <em>área</em> dentro del proyecto, más los administradores. Útil para coordinar entre compañeros del mismo equipo.</p>
            </div>
            <div className="entry-item">
              <strong><span className="chat-scope-badge scope-public">Pública</span></strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>Visible para <em>todos los usuarios aprobados</em> del proyecto. Para anuncios generales o discusiones abiertas.</p>
            </div>
          </div>
          <p className="muted" style={{ fontSize: '0.9rem' }}><strong>Tip:</strong> en el composer, <kbd>Enter</kbd> envía el mensaje y <kbd>Shift+Enter</kbd> agrega una línea nueva. El creador de una conversación, los administradores del proyecto y el superusuario pueden eliminarla (borra también todos los mensajes).</p>

          <hr />

          <h3>Configuración del proyecto (admins)</h3>
          <ul style={{ paddingLeft: '1.25rem', lineHeight: '1.8' }}>
            <li><strong>Horas regulares, extras y nocturnas:</strong> definí la jornada estándar, multiplicadores y ventana nocturna.</li>
            <li><strong>Semana laboral:</strong> días de trabajo, día de inicio de semana y reglas de enganche/reenganche.</li>
            <li><strong>Áreas y roles:</strong> crear los equipos (áreas) y los puestos (roles con tarifas) usados al asignar miembros.</li>
            <li><strong>Plantillas de proyecto:</strong> guardá una configuración completa (áreas, roles, parámetros) como plantilla reutilizable al crear nuevos proyectos.</li>
            <li><strong>Colores de revisión:</strong> personalizá las etiquetas de cada color de auditoría.</li>
          </ul>
        </section>
        </>
      )}

      {/* === MODAL: Recalcular / Sincronizar áreas por rango === */}
      {rangeOpModal && (
        <div className="modal-overlay" onClick={() => { if (!rangeOpBusy) setRangeOpModal(null) }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{rangeOpModal.op === 'RECALC' ? 'Recalcular registros' : 'Sincronizar áreas'}</h3>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              {rangeOpModal.op === 'RECALC'
                ? 'Recalcula las horas de los registros NO liquidados dentro del rango usando la configuración actual del proyecto.'
                : 'Actualiza el área en los registros NO liquidados dentro del rango según el área actual de cada usuario.'}
            </p>
            <div className="time-grid">
              <label>Desde
                <input
                  type="date"
                  value={rangeOpModal.dateFrom}
                  onChange={(e) => setRangeOpModal((p) => p ? { ...p, dateFrom: e.target.value } : p)}
                  disabled={rangeOpBusy}
                />
              </label>
              <label>Hasta
                <input
                  type="date"
                  value={rangeOpModal.dateTo}
                  onChange={(e) => setRangeOpModal((p) => p ? { ...p, dateTo: e.target.value } : p)}
                  disabled={rangeOpBusy}
                />
              </label>
            </div>
            <div className="row" style={{ gap: '8px', justifyContent: 'flex-end' }}>
              <button className="btn btn-outline" onClick={() => setRangeOpModal(null)} disabled={rangeOpBusy}>Cancelar</button>
              <button className="btn" onClick={() => { void runRangeOp() }} disabled={rangeOpBusy}>
                {rangeOpBusy ? <><Spinner size={14} inline /> Procesando…</> : (rangeOpModal.op === 'RECALC' ? 'Recalcular' : 'Sincronizar')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* === MODAL: Editar propia jornada === */}
      {editingEntry && (
        <div className="modal-overlay" onClick={() => setEditingEntry(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Editar jornada</h3>
            <form className="stack" onSubmit={(e) => { void submitEditEntry(e) }}>
              <label>Fecha
                <input type="date" value={editEntryForm.workDate} max={!canAudit(currentProfile.role) ? (getMaxWorkDate(projectConfig?.futureDatePolicy) ?? undefined) : undefined} onChange={(e) => setEditEntryForm((f) => ({ ...f, workDate: e.target.value }))} required />
              </label>
              <label>Etiqueta
                <input type="text" value={editEntryForm.shiftLabel} onChange={(e) => setEditEntryForm((f) => ({ ...f, shiftLabel: e.target.value }))} />
              </label>
              <div className="time-grid">
                <label>Entrada<input type="time" value={editEntryForm.timeIn} onChange={(e) => setEditEntryForm((f) => ({ ...f, timeIn: e.target.value }))} required /></label>
                <label>Salida<input type="time" value={editEntryForm.timeOut} onChange={(e) => setEditEntryForm((f) => ({ ...f, timeOut: e.target.value }))} required /></label>
              </div>
              <label>Observaciones
                <textarea value={editEntryForm.notes} onChange={(e) => setEditEntryForm((f) => ({ ...f, notes: e.target.value }))} rows={2} />
              </label>
              <div className="time-grid">
                <label>Penalties
                  <select value={editEntryForm.penalties} onChange={(e) => setEditEntryForm((f) => ({ ...f, penalties: Number(e.target.value) }))}>
                    <option value={0}>0 — Sin penalty</option>
                    <option value={1}>1 penalty</option>
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                  <span style={{ marginBottom: '4px' }}>6to día</span>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 'normal' }}>
                    <input type="checkbox" checked={editEntryForm.isJornadaAdicional} onChange={(e) => setEditEntryForm((f) => ({ ...f, isJornadaAdicional: e.target.checked }))} />
                    {editEntryForm.isJornadaAdicional ? 'Sí' : 'No'}
                  </label>
                </label>
              </div>
              <div className="row">
                <button className="btn" type="submit" disabled={savingEditEntry}>
                  {savingEditEntry ? <><Spinner size={14} inline /> Guardando…</> : 'Guardar'}
                </button>
                <button className="btn btn-outline" type="button" disabled={savingEditEntry} onClick={() => setEditingEntry(null)}>Cancelar</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* === MODAL: Aprobar usuario === */}
      {approvingUser && (
        <div className="modal-overlay" onClick={closeApproveModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Aprobar usuario</h3>
            <p className="muted" style={{ marginTop: 0 }}>{approvingUser.displayName ?? approvingUser.email}</p>
            <form className="stack" onSubmit={(e) => { void submitApproval(e) }}>
              <label>
                Rol
                <select
                  value={approveForm.role}
                  onChange={(e) => setApproveForm((f) => ({ ...f, role: e.target.value as AppRole }))}
                >
                  <option value="MEMBER">Miembro</option>
                  <option value="PROJECT_ADMIN">Administrador de proyecto</option>
                </select>
              </label>
              <label>
                Proyecto asignado
                <select
                  value={approveForm.projectId}
                  onChange={(e) => setApproveForm((f) => ({ ...f, projectId: e.target.value, areaId: '' }))}
                >
                  <option value="">— Sin proyecto —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              {approveForm.projectId && (
                <>
                  <label>
                    Área asignada
                    <select
                      value={approveForm.areaId}
                      onChange={(e) => setApproveForm((f) => ({ ...f, areaId: e.target.value }))}
                    >
                      <option value="">— TODAS (sin filtro de área) —</option>
                      {approveAreas.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  </label>
                  {approveRoles.length > 0 && (
                    <label>
                      Rol en el proyecto
                      <select
                        value={approveForm.roleId}
                        onChange={(e) => setApproveForm((f) => ({ ...f, roleId: e.target.value }))}
                      >
                        <option value="">— Sin rol específico —</option>
                        {approveRoles.map((r) => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
              <div className="row">
                <button className="btn" type="submit">Confirmar aprobación</button>
                <button className="btn btn-outline" type="button" onClick={closeApproveModal}>Cancelar</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* === MODAL: Editar usuario aprobado === */}
      {editingUser && (
        <div className="modal-overlay" onClick={() => setEditingUser(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Editar usuario</h3>
            <p className="muted" style={{ marginTop: 0 }}>{editingUser.email}</p>
            <form className="stack" onSubmit={(e) => { void handleSaveUserEdit(e) }}>
              <label>
                Nombre y apellido
                <input
                  type="text"
                  value={editUserForm.displayName}
                  onChange={(e) => setEditUserForm((f) => ({ ...f, displayName: e.target.value }))}
                  placeholder="Nombre completo"
                />
              </label>
              <label>
                Área
                <select value={editUserForm.areaId} onChange={(e) => setEditUserForm((f) => ({ ...f, areaId: e.target.value }))}>
                  <option value="">— TODAS (sin filtro de área) —</option>
                  {editUserAreas.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </label>
              {editUserRoles.length > 0 && (
                <label>
                  Rol en el proyecto
                  <select value={editUserForm.roleId} onChange={(e) => setEditUserForm((f) => ({ ...f, roleId: e.target.value }))}>
                    <option value="">— Sin rol específico —</option>
                    {editUserRoles.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Desvincular de proyecto
                <select value={editUserForm.projectId} onChange={(e) => setEditUserForm((f) => ({ ...f, projectId: e.target.value, areaId: '', roleId: '' }))}>
                  <option value="">— Sin proyecto —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Tipo de ciclo
                <select
                  value={editUserForm.cycleMode}
                  onChange={(e) => setEditUserForm((f) => ({ ...f, cycleMode: e.target.value as 'CYCLE' | 'REINFORCEMENT' }))}
                >
                  <option value="CYCLE">Ciclo normal (con reenganche)</option>
                  <option value="REINFORCEMENT">Refuerzo (sin reenganche)</option>
                </select>
                <span className="muted" style={{ fontSize: '0.78rem' }}>
                  Refuerzo: el usuario no recibe avisos de 6to día ni se le calcula reenganche. El enganche se sigue calculando normalmente.
                </span>
              </label>
              <p className="muted" style={{ fontSize: '0.8rem', margin: '0' }}>
                Nota: el nombre se actualiza en el sistema pero se sincronizará nuevamente desde Google en el próximo inicio de sesión.
              </p>
              <div className="row">
                <button className="btn" type="submit">Guardar cambios</button>
                <button className="btn btn-outline" type="button" onClick={() => setEditingUser(null)}>Cancelar</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* === TOASTS === */}
      <div className="toast-container">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>{t.message}</div>
        ))}
      </div>

      {/* === LOADING OVERLAY === */}
      <LoadingOverlay
        show={anyLoading}
        label={
          auditLoading ? 'Buscando registros…'
          : settlementLoading ? 'Procesando liquidación…'
          : importLoading ? 'Importando miembros…'
          : 'Procesando…'
        }
      />
    </div>
  )
}
