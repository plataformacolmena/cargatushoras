import type { CycleScope, ProjectConfig, Settlement, SettlementLine, TimeEntry, TimeEntryCalculation, WorkCycle } from '../types/domain'

const DEFAULT_CONFIG: ProjectConfig = {
  projectId: 'default',
  regularDailyHours: 8,
  overtimeMultiplier: 1.5,
  nightWindowStart: '22:00',
  nightWindowEnd: '06:00',
  nightAdditionalMultiplier: 1.2,
  weeklyWorkDays: 5,
  workWeekPattern: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
  workWeekStartDay: 'MON',
  rodajeStart: '',
  rodajeEnd: '',
  engancheHours: 0,
  reengancheHours: 0,
  penaltyHours: 0,
  jornadaAdicionalMultiplier: 1,
  futureDatePolicy: 'ALLOW',
  engancheAlertEnabled: false,
  engancheAlertThreshold: 12,
}

function toMinutes(timeHHMM: string): number {
  const [h, m] = timeHHMM.split(':').map(Number)
  return h * 60 + m
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Calcula el overlap en horas entre el intervalo [segStart, segEnd) y la ventana nocturna. */
function calcNightOverlapHours(segStart: number, segEnd: number, cfg: ProjectConfig): number {
  if (segStart >= segEnd) return 0
  const ns = toMinutes(cfg.nightWindowStart)
  const ne = toMinutes(cfg.nightWindowEnd)
  // La ventana nocturna cruza medianoche (caso estándar, ej. 22:00-06:00)
  const ranges = ns > ne
    ? [{ s: 0, e: ne }, { s: ns, e: 24 * 60 }, { s: 24 * 60, e: 24 * 60 + ne }, { s: 24 * 60 + ns, e: 48 * 60 }, { s: 48 * 60, e: 48 * 60 + ne }]
    : [{ s: ns, e: ne }, { s: 24 * 60 + ns, e: 24 * 60 + ne }]

  let total = 0
  for (const r of ranges) {
    total += Math.max(0, Math.min(segEnd, r.e) - Math.max(segStart, r.s))
  }
  return round2(total / 60)
}

export function getDefaultProjectConfig(projectId: string): ProjectConfig {
  return { ...DEFAULT_CONFIG, projectId }
}

/**
 * Calcula las métricas de una entrada individual.
 * - penalties / isJornadaAdicional vienen del form o se derivan del ciclo (cycleInfo).
 * - engancheExtraHours / reengancheExtraHours se calculan en el lote (recalculate) y llegan via opts.
 */
export function calculateEntry(
  timeIn: string,
  timeOut: string,
  config: ProjectConfig,
  opts?: {
    penalties?: number
    isJornadaAdicional?: boolean
    engancheExtraHours?: number
    reengancheExtraHours?: number
  },
): TimeEntryCalculation {
  const start = toMinutes(timeIn)
  let end = toMinutes(timeOut)
  if (end <= start) end += 24 * 60

  const adicMult = opts?.isJornadaAdicional ? (config.jornadaAdicionalMultiplier || 1) : 1
  const rawMinutes = end - start

  // Horas REALES (sin multiplicador de jornada adicional). El efecto del multiplicador
  // se refleja únicamente en el pago (extraPayUnits y en la liquidación).
  const workedHours   = round2(rawMinutes / 60)
  const regularHours  = round2(Math.min(workedHours, config.regularDailyHours))
  const overtimeHours = round2(Math.max(0, workedHours - config.regularDailyHours))

  // Nocturnidad doble: horas EXTRA que caen en la ventana nocturna
  const overtimeStart = start + config.regularDailyHours * 60
  const nightOvertimeHours = round2(calcNightOverlapHours(Math.max(start, overtimeStart), end, config))

  // Horas nocturnas: TODA la porción nocturna del turno (incluye las que además
  // son extras). `nightOvertimeHours` es un subconjunto informativo de
  // `nightHours` (las nocturnas que también son extras). El pago se calcula
  // sobre `nightHours` para no duplicar; el subset solo se usa para mostrar
  // y aplicar el recargo adicional en `extraPayUnits` si la política lo pide.
  const nightHours = round2(calcNightOverlapHours(start, end, config))

  // Penalties
  const penaltyHours = round2((opts?.penalties ?? 0) * (config.penaltyHours || 0))

  // Enganche / reenganche (calculados externamente en lote)
  const engancheExtraHours   = round2(opts?.engancheExtraHours ?? 0)
  const reengancheExtraHours = round2(opts?.reengancheExtraHours ?? 0)

  // Para "unidades a cobrar" sí aplicamos el multiplicador de jornada adicional
  // (al overtime/penalty/nocturnidad extra). Enganche/reenganche no se afectan.
  const totalExtrasForPay =
    overtimeHours * adicMult +
    penaltyHours * adicMult +
    engancheExtraHours +
    reengancheExtraHours

  const extraPayUnits = round2(
    totalExtrasForPay * config.overtimeMultiplier +
    (nightOvertimeHours * adicMult) * (config.nightAdditionalMultiplier - 1),
  )

  return {
    workedHours,
    regularHours,
    overtimeHours,
    nightHours,
    nightOvertimeHours,
    penaltyHours,
    engancheExtraHours,
    reengancheExtraHours,
    extraPayUnits,
  }
}

// ── Helpers de ciclo laboral ────────────────────────────────────────────────

/** Diferencia en días (UTC) entre dos fechas YYYY-MM-DD (b - a). */
function daysBetween(a: string, b: string): number {
  const ta = new Date(a + 'T00:00:00Z').getTime()
  const tb = new Date(b + 'T00:00:00Z').getTime()
  return Math.round((tb - ta) / 86400000)
}

export interface CycleInfo {
  scope: CycleScope                  // IN_CYCLE | OUT_OF_CYCLE | REINFORCEMENT
  dayInWeek?: number                 // 0..6 (solo IN_CYCLE)
  weekIndex?: number                 // 0..N (solo IN_CYCLE)
  isJornadaAdicional: boolean        // derivado
}

/**
 * Devuelve el ciclo activo del usuario para una fecha (workDate) dada.
 * Un ciclo aplica si anchorDate <= workDate AND (no cerrado OR workDate < closedFromDate).
 * Si hay varios candidatos (no debería), toma el de anchorDate más reciente.
 */
export function findCycleForDate(cycles: WorkCycle[], workDate: string): WorkCycle | null {
  let best: WorkCycle | null = null
  for (const c of cycles) {
    if (c.anchorDate > workDate) continue
    if (c.closedFromDate && workDate >= c.closedFromDate) continue
    if (!best || c.anchorDate > best.anchorDate) best = c
  }
  return best
}

/**
 * Calcula la cycleInfo de una entry según el modo del usuario y sus ciclos.
 * - REINFORCEMENT: no aplica ciclo (solo enganche, no reenganche, no jornada adicional).
 * - CYCLE con ciclo cubriendo workDate: IN_CYCLE; dayInWeek = (workDate - anchor) % 7;
 *   semana cronológica = floor((workDate - anchor) / 7); isJornadaAdicional = dayInWeek >= weeklyWorkDays.
 * - CYCLE sin ciclo cubriendo (sin anchor, antes del anchor, o tras closedFromDate): OUT_OF_CYCLE.
 */
export function getCycleInfo(
  workDate: string,
  cycleMode: 'CYCLE' | 'REINFORCEMENT',
  cycles: WorkCycle[],
  config: ProjectConfig,
): CycleInfo {
  if (cycleMode === 'REINFORCEMENT') {
    return { scope: 'REINFORCEMENT', isJornadaAdicional: false }
  }
  const cycle = findCycleForDate(cycles, workDate)
  if (!cycle) {
    return { scope: 'OUT_OF_CYCLE', isJornadaAdicional: false }
  }
  const days = daysBetween(cycle.anchorDate, workDate)
  if (days < 0) {
    return { scope: 'OUT_OF_CYCLE', isJornadaAdicional: false }
  }
  const dayInWeek = days % 7
  const weekIndex = Math.floor(days / 7)
  const wd = Math.max(0, Math.min(7, config.weeklyWorkDays || 0))
  const isAdicional = dayInWeek >= wd
  return { scope: 'IN_CYCLE', dayInWeek, weekIndex, isJornadaAdicional: isAdicional }
}

// ── Helpers para enganche/reenganche en lote ──────────────────────────────

/** Timestamp UTC del inicio del turno. */
function shiftStartTs(workDate: string, timeIn: string): number {
  return new Date(workDate + 'T' + timeIn + ':00Z').getTime()
}

/** Timestamp UTC del fin del turno (ajusta para turnos nocturnos que cruzan medianoche). */
function shiftEndTs(workDate: string, timeIn: string, timeOut: string): number {
  const base = new Date(workDate + 'T' + timeOut + ':00Z').getTime()
  const start = shiftStartTs(workDate, timeIn)
  return base <= start ? base + 24 * 3600 * 1000 : base
}

/**
 * Calcula extras por enganche/reenganche para cada entrada (por userId, ordenadas).
 *
 * Regla simple: si la jornada `prev` está marcada como 6to día (isJornadaAdicional=true),
 * la siguiente jornada (`curr`) inicia una NUEVA semana laboral → se evalúa REENGANCHE.
 * En caso contrario → ENGANCHE normal.
 *
 * El monto se calcula siempre como shortfall respecto al umbral correspondiente
 * (engancheHours o engancheHours + reengancheHours).
 *
 * Retorna un Map<entryId, {enganche, reenganche}>.
 */
export function calcEngancheExtras(
  entries: Array<{
    id: string
    userId: string
    workDate: string
    timeIn: string
    timeOut: string
    isJornadaAdicional?: boolean
  }>,
  config: ProjectConfig,
  /**
   * Modo de ciclo por usuario. Si un usuario es 'REINFORCEMENT' se calcula el
   * enganche normal entre sus jornadas, pero NUNCA se evalúa reenganche
   * (un refuerzo no tiene ciclo semanal, así que la marca de 6to día de la
   * jornada previa se ignora a estos efectos).
   * Usuarios no presentes en el mapa se asumen 'CYCLE'.
   */
  userCycleModes?: Map<string, 'CYCLE' | 'REINFORCEMENT'>,
): Map<string, { enganche: number; reenganche: number }> {
  const result = new Map<string, { enganche: number; reenganche: number }>()
  if (config.engancheHours === 0 && config.reengancheHours === 0) return result

  // Agrupar por usuario
  const byUser = new Map<string, typeof entries>()
  for (const e of entries) {
    const arr = byUser.get(e.userId) ?? []
    arr.push(e)
    byUser.set(e.userId, arr)
  }

  for (const [userId, userEntries] of byUser.entries()) {
    const isReinforcement = userCycleModes?.get(userId) === 'REINFORCEMENT'
    userEntries.sort((a, b) => {
      const tsA = shiftStartTs(a.workDate, a.timeIn)
      const tsB = shiftStartTs(b.workDate, b.timeIn)
      return tsA - tsB
    })

    for (let i = 1; i < userEntries.length; i++) {
      const prev = userEntries[i - 1]
      const curr = userEntries[i]

      const prevEnd   = shiftEndTs(prev.workDate, prev.timeIn, prev.timeOut)
      const currStart = shiftStartTs(curr.workDate, curr.timeIn)
      const gapHours = (currStart - prevEnd) / 3600000

      if (gapHours < 0) continue // solapamiento, ignorar

      // Refuerzo: nunca aplica reenganche aunque la previa esté marcada como 6to día.
      const reengancheApplies = !isReinforcement && prev.isJornadaAdicional === true

      if (reengancheApplies && config.reengancheHours > 0) {
        const reengancheMin = config.reengancheHours + config.engancheHours
        const shortfall = round2(Math.max(0, reengancheMin - gapHours))
        if (shortfall > 0) result.set(curr.id, { enganche: 0, reenganche: shortfall })
      } else if (config.engancheHours > 0) {
        const shortfall = round2(Math.max(0, config.engancheHours - gapHours))
        if (shortfall > 0) result.set(curr.id, { enganche: shortfall, reenganche: 0 })
      }
    }
  }

  return result
}

export function calculateSettlement(
  entries: TimeEntry[],
  userRates: Map<string, { hourlyRate: number; roleId?: string; roleName?: string }>,
  config: ProjectConfig,
  meta: { projectId: string; projectName: string; dateFrom: string; dateTo: string; createdBy: string },
): Settlement {
  const byUser = new Map<string, {
    userName: string
    regular: number; overtime: number; night: number
    nightOvertime: number; enganche: number; reenganche: number
    jornadaAdicionalCount: number; penalty: number
    // Horas "ponderadas" por jornada adicional, usadas solo para el cálculo de pago.
    regularPaid: number; overtimePaid: number; nightPaid: number; penaltyPaid: number
  }>()

  const adicMult = config.jornadaAdicionalMultiplier || 1

  for (const e of entries) {
    const existing = byUser.get(e.userId) ?? {
      userName: e.userName,
      regular: 0, overtime: 0, night: 0,
      nightOvertime: 0, enganche: 0, reenganche: 0,
      jornadaAdicionalCount: 0, penalty: 0,
      regularPaid: 0, overtimePaid: 0, nightPaid: 0, penaltyPaid: 0,
    }
    const m = e.isJornadaAdicional ? adicMult : 1
    const reg = e.calculation.regularHours ?? 0
    const ot  = e.calculation.overtimeHours ?? 0
    const nh  = e.calculation.nightHours ?? 0
    const noh = e.calculation.nightOvertimeHours ?? 0
    const pen = e.calculation.penaltyHours ?? 0
    existing.regular       += reg
    existing.overtime      += ot
    existing.night         += nh
    existing.nightOvertime += noh
    existing.enganche      += e.calculation.engancheExtraHours  ?? 0
    existing.reenganche    += e.calculation.reengancheExtraHours ?? 0
    existing.penalty       += pen
    // Acumulado para pago, aplicando multiplicador de jornada adicional cuando corresponda.
    existing.regularPaid   += reg * m
    existing.overtimePaid  += ot * m
    // `nightPaid` paga TODAS las horas nocturnas (que ya incluyen las extras
    // nocturnas) con `nightAdditionalMultiplier`. NO se suma `noh` porque
    // estaría dentro de `nh`.
    existing.nightPaid     += nh * m
    existing.penaltyPaid   += pen * m
    if (e.isJornadaAdicional) existing.jornadaAdicionalCount += 1
    byUser.set(e.userId, existing)
  }

  const lines: SettlementLine[] = Array.from(byUser.entries()).map(([userId, data]) => {
    const rateInfo  = userRates.get(userId)
    const hourlyRate = rateInfo?.hourlyRate ?? 0
    const regularPay  = round2(data.regularPaid * hourlyRate)
    const overtimePay = round2(
      (data.overtimePaid + data.penaltyPaid + data.enganche + data.reenganche) * hourlyRate * config.overtimeMultiplier,
    )
    const nightPay   = round2(data.nightPaid * hourlyRate * config.nightAdditionalMultiplier)
    const totalHours  = round2(data.regular + data.overtime)
    return {
      userId,
      userName: data.userName,
      roleId: rateInfo?.roleId,
      roleName: rateInfo?.roleName,
      hourlyRate,
      overtimeMultiplier: config.overtimeMultiplier,
      nightMultiplier: config.nightAdditionalMultiplier,
      regularHours:         round2(data.regular),
      overtimeHours:        round2(data.overtime),
      nightHours:           round2(data.night),
      nightOvertimeHours:   round2(data.nightOvertime),
      engancheExtraHours:   round2(data.enganche),
      reengancheExtraHours: round2(data.reenganche),
      jornadaAdicionalCount: data.jornadaAdicionalCount,
      penaltyHours:         round2(data.penalty),
      totalHours,
      regularPay,
      overtimePay,
      nightPay,
      totalPay: round2(regularPay + overtimePay + nightPay),
    }
  })

  const totalPay = round2(lines.reduce((sum, l) => sum + l.totalPay, 0))

  return { ...meta, lines, totalPay }
}

