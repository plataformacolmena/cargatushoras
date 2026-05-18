import type { ProjectConfig, Settlement, SettlementLine, TimeEntry, TimeEntryCalculation } from '../types/domain'

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
 * - penalties / isJornadaAdicional vienen del form.
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

  const mult = opts?.isJornadaAdicional ? (config.jornadaAdicionalMultiplier || 1) : 1
  const rawMinutes = end - start

  const workedHours   = round2(rawMinutes * mult / 60)
  const regularHours  = round2(Math.min(workedHours, config.regularDailyHours * mult))
  const overtimeHours = round2(Math.max(0, workedHours - config.regularDailyHours * mult))

  // Horas nocturnas: todas las horas del turno que caen en la ventana nocturna
  const nightHours = round2(calcNightOverlapHours(start, end, config) * mult)

  // Nocturnidad doble: horas EXTRA que caen en la ventana nocturna
  const overtimeStart = start + config.regularDailyHours * 60
  const nightOvertimeHours = round2(calcNightOverlapHours(Math.max(start, overtimeStart), end, config) * mult)

  // Penalties
  const penaltyHours = round2((opts?.penalties ?? 0) * (config.penaltyHours || 0) * mult)

  // Enganche / reenganche (calculados externamente en lote)
  const engancheExtraHours   = round2(opts?.engancheExtraHours ?? 0)
  const reengancheExtraHours = round2(opts?.reengancheExtraHours ?? 0)

  const totalExtras = overtimeHours + penaltyHours + engancheExtraHours + reengancheExtraHours

  const extraPayUnits = round2(
    totalExtras * config.overtimeMultiplier +
    nightOvertimeHours * (config.nightAdditionalMultiplier - 1),
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

// ── Helpers para enganche/reenganche en lote ──────────────────────────────

const DAY_NAME_TO_NUM: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }

/** Devuelve la fecha de inicio de la semana laboral a la que pertenece dateStr. */
function getWorkWeekStart(dateStr: string, workWeekStartDay: string): string {
  const startNum = DAY_NAME_TO_NUM[workWeekStartDay] ?? 1
  // Usamos UTC para evitar problemas de zona horaria
  const date = new Date(dateStr + 'T12:00:00Z')
  const dow = date.getUTCDay()
  const daysBack = (dow - startNum + 7) % 7
  const weekStart = new Date(date)
  weekStart.setUTCDate(weekStart.getUTCDate() - daysBack)
  return weekStart.toISOString().slice(0, 10)
}

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
 * Retorna un Map<entryId, {enganche, reenganche}>.
 */
export function calcEngancheExtras(
  entries: Array<{ id: string; userId: string; workDate: string; timeIn: string; timeOut: string }>,
  config: ProjectConfig,
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

  for (const userEntries of byUser.values()) {
    // Ordenar por fecha+hora de inicio
    userEntries.sort((a, b) => {
      const tsA = shiftStartTs(a.workDate, a.timeIn)
      const tsB = shiftStartTs(b.workDate, b.timeIn)
      return tsA - tsB
    })

    for (let i = 1; i < userEntries.length; i++) {
      const prev = userEntries[i - 1]
      const curr = userEntries[i]

      const prevEnd  = shiftEndTs(prev.workDate, prev.timeIn, prev.timeOut)
      const currStart = shiftStartTs(curr.workDate, curr.timeIn)
      const gapHours = (currStart - prevEnd) / 3600000

      if (gapHours < 0) continue // solapamiento, ignorar

      const prevWeek = getWorkWeekStart(prev.workDate, config.workWeekStartDay)
      const currWeek = getWorkWeekStart(curr.workDate, config.workWeekStartDay)
      const sameWeek = prevWeek === currWeek

      if (sameWeek && config.engancheHours > 0) {
        const shortfall = round2(Math.max(0, config.engancheHours - gapHours))
        if (shortfall > 0) result.set(curr.id, { enganche: shortfall, reenganche: 0 })
      } else if (!sameWeek && config.reengancheHours > 0) {
        const reengancheMin = config.reengancheHours + config.engancheHours
        const shortfall = round2(Math.max(0, reengancheMin - gapHours))
        if (shortfall > 0) result.set(curr.id, { enganche: 0, reenganche: shortfall })
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
  }>()

  for (const e of entries) {
    const existing = byUser.get(e.userId) ?? {
      userName: e.userName,
      regular: 0, overtime: 0, night: 0,
      nightOvertime: 0, enganche: 0, reenganche: 0,
      jornadaAdicionalCount: 0, penalty: 0,
    }
    existing.regular       += e.calculation.regularHours   ?? 0
    existing.overtime       += e.calculation.overtimeHours  ?? 0
    existing.night          += e.calculation.nightHours     ?? 0
    existing.nightOvertime  += e.calculation.nightOvertimeHours  ?? 0
    existing.enganche       += e.calculation.engancheExtraHours  ?? 0
    existing.reenganche     += e.calculation.reengancheExtraHours ?? 0
    existing.penalty        += e.calculation.penaltyHours   ?? 0
    if (e.isJornadaAdicional) existing.jornadaAdicionalCount += 1
    byUser.set(e.userId, existing)
  }

  const lines: SettlementLine[] = Array.from(byUser.entries()).map(([userId, data]) => {
    const rateInfo  = userRates.get(userId)
    const hourlyRate = rateInfo?.hourlyRate ?? 0
    const regularPay  = round2(data.regular * hourlyRate)
    const overtimePay = round2(
      (data.overtime + data.penalty + data.enganche + data.reenganche) * hourlyRate * config.overtimeMultiplier,
    )
    const nightPay   = round2(data.night * hourlyRate * config.nightAdditionalMultiplier)
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

