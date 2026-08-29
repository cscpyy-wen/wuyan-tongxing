import type {
  CigaretteLog,
  DailyCheckIn,
  QuitPhase,
  QuitPlan,
  QuitStrategy,
  ReductionTarget,
  TaskProgress,
} from '@wuyan/contracts'

const DAY_MS = 86_400_000
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface CreateQuitPlanInput {
  id?: string
  attemptNumber?: number
  strategy: QuitStrategy
  startDate: string
  quitDate: string
  baselineCigarettesPerDay: number
  pricePerPackCny?: number | null
  cigarettesPerPack?: number
  now?: Date
}

export interface QuitProgress {
  currentSmokeFreeMilliseconds: number
  currentSmokeFreeDays: number
  knownTrackingDays: number
  avoidedCigarettes: number
  estimatedSavingsCny: number
  completedTasks: number
  currentAverageCigarettes: number | null
  averageReductionFromBaseline: number | null
  selfReported: true
}

function assertIntegerInRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label}必须是 ${minimum}–${maximum} 的整数`)
  }
}

function assertCreateQuitPlanInput(input: CreateQuitPlanInput, id: string): void {
  if (!UUID_PATTERN.test(id)) throw new Error('戒烟计划 ID 必须是 UUID')
  if (input.strategy !== 'ABRUPT' && input.strategy !== 'REDUCE_THEN_QUIT') {
    throw new Error('未知的戒烟路径')
  }
  assertIntegerInRange(input.attemptNumber ?? 1, 1, Number.MAX_SAFE_INTEGER, '尝试次数')
  assertIntegerInRange(input.baselineCigarettesPerDay, 1, 100, '基线日吸烟量')
  assertIntegerInRange(input.cigarettesPerPack ?? 20, 1, 100, '每包支数')
  const price = input.pricePerPackCny ?? null
  if (price !== null && (!Number.isFinite(price) || price < 0 || price > 10_000)) {
    throw new Error('每包价格必须是 0–10000 的有限数值')
  }
}

function dateParts(value: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error(`无效日期：${value}`)
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const [year, month, day] = parts
  const roundTrip = new Date(Date.UTC(year, month - 1, day))
  if (
    year < 1000
    || roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() !== month - 1
    || roundTrip.getUTCDate() !== day
  ) {
    throw new Error(`无效日期：${value}`)
  }
  return parts
}

export function dateToDayIndex(value: string): number {
  const [year, month, day] = dateParts(value)
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS)
}

export function dayIndexToDate(index: number): string {
  const date = new Date(index * DAY_MS)
  return date.toISOString().slice(0, 10)
}

export function daysBetween(from: string, to: string): number {
  return dateToDayIndex(to) - dateToDayIndex(from)
}

export function shanghaiDateFromInstant(instant: Date): string {
  return new Date(instant.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

export function shanghaiMidnight(date: string): Date {
  const [year, month, day] = dateParts(date)
  return new Date(Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS)
}

export function buildReductionSchedule(
  startDate: string,
  quitDate: string,
  baselineCigarettesPerDay: number,
): ReductionTarget[] {
  const duration = daysBetween(startDate, quitDate)
  if (duration < 7 || duration > 28) {
    throw new Error('限期减量路径的戒烟日必须在开始后 7–28 天')
  }
  if (!Number.isInteger(baselineCigarettesPerDay) || baselineCigarettesPerDay < 1 || baselineCigarettesPerDay > 100) {
    throw new Error('基线日吸烟量必须是 1–100 的整数')
  }

  const targets: ReductionTarget[] = []
  for (let offset = 0; offset < duration; offset += 1) {
    const progress = offset / duration
    const ratio = progress < 1 / 3 ? 0.75 : progress < 2 / 3 ? 0.5 : 0.25
    targets.push({
      date: dayIndexToDate(dateToDayIndex(startDate) + offset),
      maximumCigarettes: Math.max(1, Math.floor(baselineCigarettesPerDay * ratio)),
      ratio,
    })
  }
  targets.push({ date: quitDate, maximumCigarettes: 0, ratio: 0 })
  return targets
}

export function createQuitPlan(input: CreateQuitPlanInput): QuitPlan {
  const id = input.id ?? crypto.randomUUID()
  assertCreateQuitPlanInput(input, id)
  const daysUntilQuit = daysBetween(input.startDate, input.quitDate)
  if (input.strategy === 'ABRUPT' && (daysUntilQuit < 0 || daysUntilQuit > 14)) {
    throw new Error('直接戒断路径的戒烟日必须是今天至 14 天后')
  }
  if (input.strategy === 'REDUCE_THEN_QUIT' && (daysUntilQuit < 7 || daysUntilQuit > 28)) {
    throw new Error('限期减量路径的戒烟日必须在 7–28 天后')
  }

  const now = input.now ?? new Date()
  const timestamp = now.toISOString()
  const plan: QuitPlan = {
    id,
    attemptNumber: input.attemptNumber ?? 1,
    strategy: input.strategy,
    startDate: input.startDate,
    quitDate: input.quitDate,
    timezone: 'Asia/Shanghai',
    baselineCigarettesPerDay: input.baselineCigarettesPerDay,
    pricePerPackCny: input.pricePerPackCny ?? null,
    cigarettesPerPack: input.cigarettesPerPack ?? 20,
    reductionTargets: input.strategy === 'REDUCE_THEN_QUIT'
      ? buildReductionSchedule(input.startDate, input.quitDate, input.baselineCigarettesPerDay)
      : [],
    status: 'ACTIVE',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  return plan
}

export function getQuitPhase(plan: QuitPlan, today: string): QuitPhase {
  const relativeDay = daysBetween(plan.quitDate, today)
  if (relativeDay < 0) return plan.strategy === 'REDUCE_THEN_QUIT' ? 'REDUCTION' : 'PREPARATION'
  if (relativeDay === 0) return 'QUIT_DAY'
  if (relativeDay <= 27) return 'ACTIVE_28'
  return 'MAINTENANCE'
}

export function getProgramDay(plan: QuitPlan, today: string): number | null {
  const relativeDay = daysBetween(plan.quitDate, today)
  return relativeDay >= 0 && relativeDay <= 27 ? relativeDay + 1 : null
}

function latestCheckInPerDate(checkIns: DailyCheckIn[]): DailyCheckIn[] {
  const byDate = new Map<string, DailyCheckIn>()
  for (const checkIn of checkIns) {
    const current = byDate.get(checkIn.date)
    if (!current || current.recordedAt < checkIn.recordedAt) byDate.set(checkIn.date, checkIn)
  }
  return [...byDate.values()]
}

export function computeProgress(input: {
  plan: QuitPlan
  checkIns: DailyCheckIn[]
  cigaretteLogs: CigaretteLog[]
  tasks: TaskProgress[]
  now?: Date
}): QuitProgress {
  const now = input.now ?? new Date()
  const quitInstant = shanghaiMidnight(input.plan.quitDate)
  const postQuitLogs = input.cigaretteLogs
    .map((entry) => new Date(entry.smokedAt))
    .filter((instant) => instant >= quitInstant && instant <= now)
    .sort((a, b) => b.getTime() - a.getTime())
  const smokeFreeStart = postQuitLogs[0] ?? quitInstant
  const currentSmokeFreeMilliseconds = now > smokeFreeStart ? now.getTime() - smokeFreeStart.getTime() : 0

  const known = latestCheckInPerDate(input.checkIns)
  const avoidedCigarettes = known.reduce(
    (sum, item) => sum + Math.max(0, input.plan.baselineCigarettesPerDay - item.cigarettesSmoked),
    0,
  )
  const average = known.length === 0
    ? null
    : known.reduce((sum, item) => sum + item.cigarettesSmoked, 0) / known.length
  const pricePerCigarette = input.plan.pricePerPackCny === null
    ? 0
    : input.plan.pricePerPackCny / input.plan.cigarettesPerPack

  return {
    currentSmokeFreeMilliseconds,
    currentSmokeFreeDays: Math.floor(currentSmokeFreeMilliseconds / DAY_MS),
    knownTrackingDays: known.length,
    avoidedCigarettes,
    estimatedSavingsCny: Math.max(0, Number((avoidedCigarettes * pricePerCigarette).toFixed(2))),
    completedTasks: input.tasks.filter((task) => task.status === 'COMPLETED').length,
    currentAverageCigarettes: average === null ? null : Number(average.toFixed(2)),
    averageReductionFromBaseline: average === null
      ? null
      : Number(Math.max(0, input.plan.baselineCigarettesPerDay - average).toFixed(2)),
    selfReported: true,
  }
}

export function assessPointPrevalence(
  checkIns: DailyCheckIn[],
  assessmentDate: string,
  windowDays: 7 | 30,
): boolean | null {
  const latest = latestCheckInPerDate(checkIns)
  const byDate = new Map(latest.map((item) => [item.date, item]))
  const assessmentIndex = dateToDayIndex(assessmentDate)
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const date = dayIndexToDate(assessmentIndex - offset)
    const entry = byDate.get(date)
    if (!entry) return null
    if (entry.cigarettesSmoked > 0) return false
  }
  return true
}

export function restartAfterLapse(input: {
  previousPlan: QuitPlan
  newPlanId?: string
  strategy: QuitStrategy
  startDate: string
  quitDate: string
  now?: Date
}): { archivedPlan: QuitPlan; newPlan: QuitPlan } {
  const now = input.now ?? new Date()
  const archivedPlan: QuitPlan = {
    ...input.previousPlan,
    status: 'ARCHIVED',
    updatedAt: now.toISOString(),
  }
  const newPlan = createQuitPlan({
    ...(input.newPlanId ? { id: input.newPlanId } : {}),
    attemptNumber: input.previousPlan.attemptNumber + 1,
    strategy: input.strategy,
    startDate: input.startDate,
    quitDate: input.quitDate,
    baselineCigarettesPerDay: input.previousPlan.baselineCigarettesPerDay,
    pricePerPackCny: input.previousPlan.pricePerPackCny,
    cigarettesPerPack: input.previousPlan.cigarettesPerPack,
    now,
  })
  return { archivedPlan, newPlan }
}
