export type AppRole = 'SUPERUSER' | 'PROJECT_ADMIN' | 'MEMBER'
export type ApprovalStatus = 'PENDING' | 'APPROVED'

export interface UserProfile {
  uid: string
  email: string | null
  displayName: string | null
  role: AppRole
  approvalStatus: ApprovalStatus
  projectId?: string
  areaId?: string
  roleId?: string
  isPlaceholder?: boolean    // true = creado por admin, aún no ha iniciado sesión
  mergedToUid?: string       // UID real al que se migró este placeholder
  migratedFromUid?: string   // UID del placeholder del que proviene este perfil real
  createdAt?: unknown
  updatedAt?: unknown
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
  reviewColorLabels?: Record<string, string> // leyenda de colores de revisión por proyecto
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
  areaId?: string
  calculation: TimeEntryCalculation
  calculationVersion: string
  calculationSource: 'client'
  lockedByAdmin: boolean
  reviewColor?: string               // color de revisión asignado por admin
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
  hourlyRate: number
  overtimeMultiplier: number
  nightMultiplier: number
  regularHours: number
  overtimeHours: number
  nightHours: number
  nightOvertimeHours: number
  engancheExtraHours: number
  reengancheExtraHours: number
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
}

// ─── Chat / Soporte ──────────────────────────────────────────────────────────

export type ChatScope = 'PRIVATE' | 'AREA' | 'PUBLIC'

export interface ChatThread {
  id: string
  projectId: string
  scope: ChatScope
  areaId?: string                // requerido si scope === 'AREA'
  title: string
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
