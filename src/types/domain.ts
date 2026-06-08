export type AppRole = 'SUPERUSER' | 'PROJECT_ADMIN' | 'MEMBER'
export type ApprovalStatus = 'PENDING' | 'APPROVED'

// Modo del usuario respecto al ciclo laboral.
// CYCLE: trabaja por ciclos semanales declarados (con anchor + weeklyWorkDays).
// REINFORCEMENT: refuerzo por jornada puntual; solo enganche, sin reenganche ni jornada adicional.
export type CycleMode = 'CYCLE' | 'REINFORCEMENT'

export interface UserProfile {
  uid: string
  email: string | null
  displayName: string | null
  /**
   * Nro de Cédula/DNI normalizado (solo dígitos, 6-12 caracteres).
   * Obligatorio para operar; gate de login en CompleteProfilePage.
   * La unicidad se garantiza vía colección candado `id_numbers/{idNumber}`.
   */
  idNumber?: string
  role: AppRole
  approvalStatus: ApprovalStatus
  projectId?: string
  areaId?: string
  roleId?: string
  cycleMode?: CycleMode      // default 'CYCLE'
  isPlaceholder?: boolean    // true = creado por admin, aún no ha iniciado sesión
  mergedToUid?: string | null // UID real al que se migró este placeholder (null cuando aún no se reclamó)
  migratedFromUid?: string   // UID del placeholder del que proviene este perfil real
  auditReviewColor?: string  // color de revisión asignado por admin en reporte "sin informar"
  disabled?: boolean         // true = inhabilitado por admin; no puede iniciar sesión
  createdAt?: unknown
  updatedAt?: unknown
}

// ─── Solicitudes "No recuerdo el mail" ─────────────────────────────────────
// Cuando un usuario nuevo intenta completar su perfil con un DNI que ya está
// reclamado por otro UID, la pantalla CompleteProfilePage le muestra un botón
// "No recuerdo el mail" que crea una solicitud para que un admin lo asista.

export type EmailRecoveryStatus = 'PENDING' | 'RESOLVED' | 'DISMISSED'

export interface EmailRecoveryRequest {
  id: string
  requestingUid: string
  requestingEmail: string | null
  requestingDisplayName: string | null
  idNumber: string
  status: EmailRecoveryStatus
  /** UID del titular original del DNI (lo completa el admin al resolver). */
  existingUid?: string
  notes?: string
  resolvedBy?: string
  resolvedAt?: unknown
  createdAt?: unknown
}

// Ciclo laboral declarado por un usuario en un proyecto.
// - anchorDate: primer día laboral del ciclo (YYYY-MM-DD).
// - El ciclo dura desde anchorDate (incl.) hasta closedFromDate (excl.) si está cerrado;
//   si no, está abierto (sin límite superior).
// - Solo un ciclo abierto por (userId, projectId).
export interface WorkCycle {
  id: string
  userId: string
  projectId: string
  anchorDate: string                 // YYYY-MM-DD
  closedAt?: unknown
  closedBy?: string
  closedFromDate?: string            // YYYY-MM-DD; si presente, ciclo cerrado
  createdBy: string
  createdAt?: unknown
  updatedBy?: string
  updatedAt?: unknown
}

// Ámbito del cálculo de ciclo para una entry.
// IN_CYCLE: la entry cae dentro de un ciclo activo del usuario.
// OUT_OF_CYCLE: el usuario es CYCLE pero la entry está fuera de cualquier ciclo (sin ciclo declarado, anterior al anchor, o posterior a closedFromDate sin ciclo nuevo).
// REINFORCEMENT: el usuario es refuerzo por jornada.
export type CycleScope = 'IN_CYCLE' | 'OUT_OF_CYCLE' | 'REINFORCEMENT'

// Bloqueo de ediciones a nivel de proyecto.
// Cuando enabled=true, las entradas con workDate entre dateFrom y dateTo
// quedan marcadas con lockedByAudit=true y los miembros no pueden
// editarlas/eliminarlas ni crear nuevas en ese rango (los admins sí).
export interface AuditLock {
  projectId: string
  enabled: boolean
  dateFrom: string  // YYYY-MM-DD
  dateTo: string    // YYYY-MM-DD
  updatedAt?: unknown
  updatedBy?: string
}

export interface Project {
  id: string
  name: string
  code: string
  description: string
  active: boolean
  createdAt?: unknown
  updatedAt?: unknown
}

export interface ProjectCreateInput {
  name: string
  code: string
  description: string
}

export interface ProjectUpdateInput {
  name?: string
  code?: string
  description?: string
  active?: boolean
}

export interface ProjectConfig {
  projectId: string
  regularDailyHours: number
  overtimeMultiplier: number
  nightWindowStart: string
  nightWindowEnd: string
  nightAdditionalMultiplier: number
  // Semana laboral
  weeklyWorkDays: number            // número de jornadas por semana, default 5
  workWeekPattern: string[]         // días laborales ordenados, ej ['WED','THU','FRI','SAT','SUN']
  workWeekStartDay: string          // día que inicia la semana laboral, ej 'MON'
  // Rodaje
  rodajeStart: string               // YYYY-MM-DD o ''
  rodajeEnd: string                 // YYYY-MM-DD o ''
  // Reglas especiales
  engancheHours: number             // mín. horas entre jornadas consecutivas (0=desactivado)
  reengancheHours: number           // mín. horas entre última/primera jornada de semanas adyacentes (0=desactivado)
  penaltyHours: number              // horas que suma cada penalty marcado (0=desactivado)
  jornadaAdicionalMultiplier: number // multiplicador jornada adicional (default 1)
  // Política de fechas futuras al cargar jornadas (admins quedan exentos).
  //  - 'ALLOW': sin restricción (default por compatibilidad)
  //  - 'TODAY': la fecha máxima permitida es hoy
  //  - 'TODAY_PLUS_ONE': la fecha máxima permitida es hoy + 1 día
  futureDatePolicy?: 'ALLOW' | 'TODAY' | 'TODAY_PLUS_ONE'
  reviewColorLabels?: Record<string, string> // leyenda de colores de revisión por proyecto
  // Resaltado por exceso de enganche/reenganche en registros y auditoría
  engancheAlertEnabled?: boolean    // si true, destaca jornadas con enganche/reenganche altos
  engancheAlertThreshold?: number   // umbral en horas (default 12)
}

export interface TimeEntryInput {
  projectId: string
  workDate: string
  shiftLabel: string
  timeIn: string
  timeOut: string
  notes: string
  penalties: number          // 0, 1 o 2
  isJornadaAdicional: boolean
}

export interface TimeEntryCalculation {
  workedHours: number
  regularHours: number
  overtimeHours: number
  nightHours: number
  nightOvertimeHours: number   // horas extra que caen en ventana nocturna
  penaltyHours: number
  engancheExtraHours: number
  reengancheExtraHours: number
  extraPayUnits: number
}

export interface TimeEntry extends TimeEntryInput {
  id: string
  userId: string
  userName: string
  userEmail?: string | null
  areaId?: string
  calculation: TimeEntryCalculation
  calculationVersion: string
  calculationSource: 'client'
  lockedByAdmin: boolean
  lockedByAudit?: boolean            // bloqueado por auditoría (impide edición a miembros)
  archived?: boolean                 // jornada archivada (liquidación cerrada): bloqueada para todos los roles
  archivedSettlementId?: string      // id de la liquidación que la archivó
  reviewColor?: string               // color de revisión asignado por admin
  // Campos derivados del ciclo laboral del usuario (calculados al guardar/recalcular):
  cycleScope?: CycleScope            // IN_CYCLE | OUT_OF_CYCLE | REINFORCEMENT
  cycleDayInWeek?: number            // 0..6 (solo si IN_CYCLE)
  cycleWeekIndex?: number            // semana cronológica relativa al anchor (solo si IN_CYCLE)
  createdAt?: unknown
  updatedAt?: unknown
}

export interface ProjectArea {
  id: string
  projectId: string
  name: string
  active: boolean
  createdAt?: unknown
}

export interface ProjectRole {
  id: string
  projectId: string
  name: string
  dailyRate: number
  weeklyRate: number
  monthlyRate: number
  active: boolean
  createdAt?: unknown
}

export interface ProjectRoleInput {
  name: string
  dailyRate: number
  weeklyRate: number
  monthlyRate: number
}

export interface ProjectTemplate {
  id?: string
  name: string
  areas: string[]
  roles: ProjectRoleInput[]
  config: Omit<ProjectConfig, 'projectId'>
  createdAt?: unknown
}



export interface SettlementLine {
  userId: string
  userName: string
  roleId?: string
  roleName?: string
  /**
   * Área del usuario al momento de generar la liquidación. Se persiste para
   * que el panel "Histórico" pueda agrupar/filtrar por área sin necesidad de
   * cruzar con `users` (que pueden cambiar de área después).
   */
  areaId?: string
  areaName?: string
  hourlyRate: number
  overtimeMultiplier: number
  nightMultiplier: number
  regularHours: number
  overtimeHours: number
  nightHours: number
  nightOvertimeHours: number
  engancheExtraHours: number
  reengancheExtraHours: number
  /**
   * Cantidad de jornadas distintas (días distintos con al menos una entry)
   * dentro del rango de la liquidación.
   */
  daysWorked: number
  jornadaAdicionalCount: number
  penaltyHours: number
  totalHours: number
  regularPay: number
  overtimePay: number
  nightPay: number
  totalPay: number
  reviewColor?: string
}

export interface Settlement {
  id?: string
  projectId: string
  projectName: string
  dateFrom: string
  dateTo: string
  hourlyRate?: number
  lines: SettlementLine[]
  totalPay: number
  createdAt?: unknown
  createdBy: string
  archivedAt?: unknown               // si está archivada, fecha del cierre permanente
  archivedBy?: string                // uid del admin que archivó
  archiveFilePath?: string           // path en Firebase Storage (archives/{projectId}/{id}.xlsx)
  archiveFileUrl?: string            // download URL del Excel archivado
  archiveEntriesCount?: number       // cantidad de jornadas marcadas como archivadas
}

// ─── Chat / Soporte ──────────────────────────────────────────────────────────

export type ChatScope = 'PRIVATE' | 'AREA' | 'PUBLIC'
export type ChatThreadStatus = 'OPEN' | 'CLOSED'

export interface ChatThread {
  id: string
  projectId: string
  scope: ChatScope
  areaId?: string                // requerido si scope === 'AREA'
  title: string
  status?: ChatThreadStatus      // 'OPEN' (default) | 'CLOSED' (respondida/cerrada)
  closedAt?: unknown
  closedBy?: string              // uid
  closedByName?: string
  createdBy: string              // uid
  createdByName: string
  createdByRole: AppRole
  lastMessageAt?: unknown
  lastMessageText?: string
  lastMessageBy?: string
  createdAt?: unknown
  updatedAt?: unknown
}

export interface ChatMessage {
  id: string
  threadId: string
  text: string
  senderUid: string
  senderName: string
  senderRole: AppRole
  createdAt?: unknown
}

export interface ChatThreadCreateInput {
  projectId: string
  scope: ChatScope
  areaId?: string
  title: string
}

// ─── Registros del sistema ────────────────────────────────────────────────────

export type SystemLogType = 'entry_create' | 'entry_edit' | 'entry_delete' | 'user_login'

export interface SystemLog {
  id: string
  type: SystemLogType
  userId: string
  userName: string
  email?: string | null
  projectId?: string
  projectName?: string
  entryId?: string
  workDate?: string       // fecha de la jornada afectada (YYYY-MM-DD)
  logDate: string         // YYYY-MM-DD del momento de la acción (para filtrar por rango)
  details?: string        // descripción adicional del cambio
  timestamp: unknown      // Firestore Timestamp
}
