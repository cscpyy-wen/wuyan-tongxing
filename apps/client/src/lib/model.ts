import type {
  ClientBaseline,
  ClientCheckIn,
  ClientCigaretteLog,
  ClientCravingEvent,
  ClientLapseEvent,
  ClientOutcomeAssessment,
  ClientQuitPlan,
  ClientSettings,
  ClientState,
  CompletedTask,
  OnboardingPayload,
  ProgressSnapshot,
  CravingLevel,
  QuitPath,
  Trigger,
} from '../types'
import {
  buildReductionSchedule as buildSharedReductionSchedule,
  createQuitPlan as createSharedQuitPlan,
  dateToDayIndex,
  dayIndexToDate,
  daysBetween as sharedDaysBetween,
  shanghaiMidnight,
} from '@wuyan/domain'
import { summarizeSmokingLogs, toShanghaiDate } from './smokingLogs'

export const STORAGE_KEY = 'wuyan-tongxing/client-state/v1'
export const DAY_MS = 86_400_000
export const MAX_PREVIOUS_ATTEMPTS = 100
export const MAX_STORED_ITEMS_PER_COLLECTION = 50_000

export const createInitialState = (): ClientState => ({
  version: 1,
  onboarded: false,
  archivedPlans: [],
  checkIns: [],
  cravings: [],
  cigarettes: [],
  deletedCigaretteIds: [],
  lapses: [],
  outcomes: [],
  completedTasks: [],
  settings: {
    sensitiveHealthData: false,
    inAppReminder: false,
    reminderHour: 20,
    subscriptionEnabled: false,
    cloudSync: false,
    outcomeAnalytics: false,
  },
})

let localFallbackSequence = 0

function uuidFromRandomBytes(bytes: Uint8Array): string {
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function createId(_prefix: string): string {
  const cryptoApi = globalThis.crypto
  const nativeUuid = cryptoApi?.randomUUID?.()
  if (nativeUuid) return nativeUuid
  if (cryptoApi?.getRandomValues) {
    return uuidFromRandomBytes(cryptoApi.getRandomValues(new Uint8Array(16)))
  }

  // Last-resort compatibility for older WeChat JSCore. These IDs are local
  // object keys, never credentials or authorization tokens. Timestamp and a
  // monotonic sequence prevent same-runtime collisions; Math.random adds
  // cross-runtime entropy when the platform exposes no cryptographic source.
  localFallbackSequence = (localFallbackSequence + 1) >>> 0
  const bytes = new Uint8Array(16)
  const timestamp = Date.now()
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Math.floor(timestamp / (2 ** (8 * (5 - index)))) & 0xff
  }
  for (let index = 6; index < 10; index += 1) {
    bytes[index] = (localFallbackSequence >>> (8 * (9 - index))) & 0xff
  }
  for (let index = 10; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  return uuidFromRandomBytes(bytes)
}

export interface PlanEligibility {
  adultConfirmed: boolean
  currentPaperCigaretteUser: boolean
  medicalBoundaryAccepted: boolean
  sensitiveHealthDataAccepted: boolean
}

export function canBeginPersonalPlan(input: PlanEligibility): boolean {
  return input.adultConfirmed
    && input.currentPaperCigaretteUser
    && input.medicalBoundaryAccepted
    && input.sensitiveHealthDataAccepted
}

export function toLocalDate(value: Date | string): string {
  return toShanghaiDate(value)
}

export function addDays(date: Date | string, days: number): string {
  return dayIndexToDate(dateToDayIndex(toLocalDate(date)) + days)
}

export function addMonths(date: Date | string, months: number): string {
  const [year, month, day] = toLocalDate(date).split('-').map(Number) as [number, number, number]
  const targetMonthIndex = year * 12 + (month - 1) + months
  const targetYear = Math.floor(targetMonthIndex / 12)
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`
}

export function daysBetween(from: Date | string, to: Date | string): number {
  return sharedDaysBetween(toLocalDate(from), toLocalDate(to))
}

export function validateQuitDate(path: QuitPath, today: string, quitDate: string): boolean {
  const days = daysBetween(today, quitDate)
  return path === 'abrupt' ? days >= 0 && days <= 14 : days >= 7 && days <= 28
}

export function createClientPlan(
  payload: OnboardingPayload,
  now = new Date(),
  attemptNumber = payload.baseline.previousAttempts + 1,
): ClientQuitPlan {
  if (
    !Number.isInteger(payload.baseline.previousAttempts)
    || payload.baseline.previousAttempts < 0
    || payload.baseline.previousAttempts > MAX_PREVIOUS_ATTEMPTS
  ) {
    throw new Error(`既往戒烟尝试次数必须是 0–${MAX_PREVIOUS_ATTEMPTS} 的整数`)
  }
  if (!validateQuitDate(payload.path, toLocalDate(now), payload.quitDate)) {
    throw new Error('戒烟日期超出所选路径允许范围')
  }
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error('当前戒烟尝试次数无效')
  }
  const sharedPlan = createSharedQuitPlan({
    id: createId('plan'),
    attemptNumber,
    strategy: payload.path === 'abrupt' ? 'ABRUPT' : 'REDUCE_THEN_QUIT',
    startDate: toLocalDate(now),
    quitDate: payload.quitDate,
    baselineCigarettesPerDay: payload.baseline.cigarettesPerDay,
    pricePerPackCny: payload.baseline.pricePerPack,
    now,
  })
  return {
    id: sharedPlan.id,
    path: sharedPlan.strategy === 'ABRUPT' ? 'abrupt' : 'reduction',
    createdAt: sharedPlan.createdAt,
    quitDate: sharedPlan.quitDate,
    baselineCigarettesPerDay: sharedPlan.baselineCigarettesPerDay,
    baselinePricePerPack: payload.baseline.pricePerPack,
    attemptNumber: sharedPlan.attemptNumber,
    ...(payload.path === 'reduction' ? {
      reductionLimits: defaultReductionLimits(sharedPlan.baselineCigarettesPerDay),
    } : {}),
  }
}

function defaultReductionLimits(baseline: number): NonNullable<ClientQuitPlan['reductionLimits']> {
  return {
    stage75: Math.max(1, Math.floor(baseline * 0.75)),
    stage50: Math.max(1, Math.floor(baseline * 0.5)),
    stage25: Math.max(1, Math.floor(baseline * 0.25)),
  }
}

export function adjustClientReductionLimit(
  plan: ClientQuitPlan,
  ratio: 0.75 | 0.5 | 0.25,
  delta: -1 | 1,
): ClientQuitPlan {
  if (plan.path !== 'reduction') return plan
  const current = plan.reductionLimits ?? defaultReductionLimits(plan.baselineCigarettesPerDay)
  const next = { ...current }
  if (ratio === 0.75) {
    next.stage75 = Math.max(next.stage50, Math.min(plan.baselineCigarettesPerDay, next.stage75 + delta))
  } else if (ratio === 0.5) {
    next.stage50 = Math.max(next.stage25, Math.min(next.stage75, next.stage50 + delta))
  } else {
    next.stage25 = Math.max(1, Math.min(next.stage50, next.stage25 + delta))
  }
  return { ...plan, reductionLimits: next }
}

export function startNextClientAttempt(
  state: ClientState,
  path: QuitPath,
  quitDate: string,
  now = new Date(),
  baselineUpdate?: Pick<ClientBaseline, 'cigarettesPerDay' | 'pricePerPack'>,
): ClientState {
  if (!state.plan || !state.baseline || !state.onboarded) {
    throw new Error('没有可延续的当前戒烟计划')
  }
  const baseline = baselineUpdate ? { ...state.baseline, ...baselineUpdate } : state.baseline
  const plan = createClientPlan(
    { baseline, path, quitDate },
    now,
    state.plan.attemptNumber + 1,
  )
  return {
    ...state,
    baseline,
    plan,
    archivedPlans: [state.plan, ...state.archivedPlans.filter((item) => item.id !== state.plan!.id)],
  }
}

export interface ReductionStage {
  label: string
  from: string
  to: string
  dailyLimit: number
  ratio: number
}

export function buildClientReductionSchedule(plan: ClientQuitPlan): ReductionStage[] {
  if (plan.path !== 'reduction') return []
  const targets = buildSharedReductionSchedule(
    toLocalDate(plan.createdAt),
    plan.quitDate,
    plan.baselineCigarettesPerDay,
  ).filter((item) => item.ratio !== 0)
  const labels = new Map<number, string>([
    [0.75, '先减到约四分之三'],
    [0.5, '再减到约一半'],
    [0.25, '最后减到约四分之一'],
  ])
  const limits = plan.reductionLimits ?? defaultReductionLimits(plan.baselineCigarettesPerDay)
  const limitByRatio = new Map<number, number>([
    [0.75, limits.stage75],
    [0.5, limits.stage50],
    [0.25, limits.stage25],
  ])
  return [0.75, 0.5, 0.25].flatMap((ratio) => {
    const group = targets.filter((item) => item.ratio === ratio)
    const first = group[0]
    const last = group[group.length - 1]
    if (!first || !last) return []
    return [{
      label: labels.get(ratio) ?? '阶段减量',
      from: first.date,
      to: last.date,
      dailyLimit: limitByRatio.get(ratio) ?? first.maximumCigarettes,
      ratio,
    }]
  })
}

export function getCurrentReductionLimit(plan: ClientQuitPlan, at = new Date()): number {
  if (plan.path !== 'reduction') return 0
  const current = toLocalDate(at)
  if (daysBetween(current, plan.quitDate) <= 0) return 0
  const stage = buildClientReductionSchedule(plan).find(
    (item) => daysBetween(item.from, current) >= 0 && daysBetween(current, item.to) >= 0,
  )
  return stage?.dailyLimit ?? plan.baselineCigarettesPerDay
}

export type JourneyPhase = 'prepare' | 'reduce' | 'quit-day' | 'active' | 'consolidate' | 'follow-up'

export function getJourneyPhase(plan: ClientQuitPlan, at = new Date()): JourneyPhase {
  const relativeDay = daysBetween(plan.quitDate, at)
  if (relativeDay < 0) return plan.path === 'reduction' ? 'reduce' : 'prepare'
  if (relativeDay === 0) return 'quit-day'
  // 戒烟日是第 1 天，因此相对日 0..27 对应完整的 28 天干预。
  if (relativeDay <= 27) return 'active'
  // 第 5..8 周覆盖相对日 28..55。
  if (relativeDay <= 55) return 'consolidate'
  return 'follow-up'
}

function parseEventTime(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined
  const timestamp = new Date(value)
  return Number.isFinite(timestamp.getTime()) ? timestamp : undefined
}

function latestSmokingTime(state: ClientState, at: Date, attemptId?: string): Date | undefined {
  const candidates: Date[] = []
  let cachedCandidate: Date | undefined
  let cachedMatchesCoveredCheckIn = false
  const addCandidate = (value: unknown) => {
    const timestamp = parseEventTime(value)
    // Ignore clock-skewed future events when calculating a snapshot in the past.
    if (timestamp && timestamp <= at) candidates.push(timestamp)
  }

  if (!attemptId) {
    cachedCandidate = parseEventTime(state.lastCigaretteAt)
  } else if (attemptId === state.plan?.id) {
    const cached = parseEventTime(state.lastCigaretteAt)
    const attemptStarted = parseEventTime(state.plan.createdAt)
    if (cached && cached <= at && attemptStarted && cached >= attemptStarted) cachedCandidate = cached
  }
  const loggedCountByDate = new Map<string, number>()
  state.cigarettes.forEach((event) => {
    if (event.count <= 0 || (attemptId && event.attemptId && event.attemptId !== attemptId)) return
    const timestamp = parseEventTime(event.createdAt)
    if (!timestamp || timestamp > at) return
    candidates.push(timestamp)
    const date = toLocalDate(timestamp)
    loggedCountByDate.set(date, (loggedCountByDate.get(date) ?? 0) + event.count)
  })
  state.lapses.forEach((event) => {
    if (event.cigarettes > 0 && (!attemptId || event.attemptId === attemptId)) addCandidate(event.createdAt)
  })
  // Older local data may contain only a daily smoking check-in. Its save time is
  // the safest available proxy when its total is not already covered by logs.
  state.checkIns.forEach((checkIn) => {
    if (checkIn.cigarettesSmoked <= 0 || (attemptId && checkIn.attemptId !== attemptId)) return
    if ((loggedCountByDate.get(checkIn.date) ?? 0) < checkIn.cigarettesSmoked) {
      addCandidate(checkIn.createdAt)
      return
    }
    const checkInTime = parseEventTime(checkIn.createdAt)
    if (cachedCandidate && checkInTime?.getTime() === cachedCandidate.getTime()) cachedMatchesCoveredCheckIn = true
  })

  // `lastCigaretteAt` is also the only exact timestamp in some older states.
  // Ignore it only when it exactly matches a fully covered check-in save time.
  if (cachedCandidate && !cachedMatchesCoveredCheckIn) candidates.push(cachedCandidate)

  return candidates.sort((left, right) => right.getTime() - left.getTime())[0]
}

export function computeClientProgress(state: ClientState, at = new Date()): ProgressSnapshot {
  if (!state.plan || !state.baseline) {
    return {
      currentStreakHours: 0,
      smokeFreeDays: 0,
      knownTrackingDays: 0,
      streakConfirmed: false,
      cigarettesAvoided: 0,
      moneySaved: 0,
      completedTasks: state.completedTasks.length,
      attemptNumber: 0,
    }
  }

  const currentDate = toLocalDate(at)
  const beforeQuitDate = daysBetween(currentDate, state.plan.quitDate) > 0
  const quitStart = shanghaiMidnight(state.plan.quitDate)
  const planStart = new Date(state.plan.createdAt)
  const smokingTime = latestSmokingTime(state, at, state.plan.id)
  // A same-day new attempt must not inherit the hours before it existed.
  const trackingStart = planStart > quitStart ? planStart : quitStart
  const streakStart = smokingTime && smokingTime > trackingStart ? smokingTime : trackingStart
  const elapsed = beforeQuitDate ? 0 : Math.max(0, at.getTime() - streakStart.getTime())

  const attemptCheckIns = state.checkIns.filter((item) => item.attemptId === state.plan!.id && item.date <= currentDate)
  const checkInByDate = new Map(attemptCheckIns.map((item) => [item.date, item]))
  let smokeFreeDays = 0
  for (let date = addDays(currentDate, -1); date >= state.plan.quitDate; date = addDays(date, -1)) {
    const checkIn = checkInByDate.get(date)
    if (!checkIn?.smokeFree) break
    smokeFreeDays += 1
  }
  const todayCheckIn = checkInByDate.get(currentDate)
  const streakConfirmed = !beforeQuitDate && Boolean(todayCheckIn?.smokeFree)
  // Confirming today cannot retroactively certify an earlier unanswered day.
  // Keep elapsed-since-last-record semantics when unconfirmed, but constrain
  // an explicitly labelled smoke-free streak to the contiguous confirmed window.
  const confirmedWindowStart = shanghaiMidnight(addDays(currentDate, -smokeFreeDays))
  const confirmedStart = confirmedWindowStart > streakStart ? confirmedWindowStart : streakStart
  const currentStreakHours = Math.floor((streakConfirmed
    ? Math.max(0, at.getTime() - confirmedStart.getTime())
    : elapsed) / 3_600_000)
  const completedCheckIns = attemptCheckIns.filter((item) => item.date < currentDate)
  const cigarettesAvoided = completedCheckIns.reduce(
    (total, item) => total + Math.max(0, state.plan!.baselineCigarettesPerDay - item.cigarettesSmoked),
    0,
  )
  const moneySaved = (cigarettesAvoided / 20) * state.plan.baselinePricePerPack
  const completedTasks = state.completedTasks.filter((item) => item.attemptId === state.plan!.id).length

  return {
    currentStreakHours,
    smokeFreeDays,
    knownTrackingDays: attemptCheckIns.length,
    streakConfirmed,
    ...(smokingTime ? { lastRecordedCigaretteAt: smokingTime.toISOString() } : {}),
    cigarettesAvoided,
    moneySaved,
    completedTasks,
    attemptNumber: state.plan.attemptNumber,
  }
}

export function mergeCheckIn(checkIns: ClientCheckIn[], next: ClientCheckIn): ClientCheckIn[] {
  const withoutSameDate = checkIns.filter((item) => item.date !== next.date || item.attemptId !== next.attemptId)
  return [...withoutSameDate, next].sort((a, b) => b.date.localeCompare(a.date))
}

export interface DailyCheckInConfirmation {
  attemptId: string
  date: string
  cigarettesSmoked: number
  cravingPeak: CravingLevel
  recordsSignature: string
}

/** Captures exactly the plan, Beijing day and records the confirmation describes. */
export function createDailyCheckInConfirmation(
  state: ClientState,
  at = new Date(),
): DailyCheckInConfirmation | undefined {
  if (!state.onboarded || !state.plan || !state.settings.sensitiveHealthData) return undefined
  const date = toLocalDate(at)
  const logs = state.cigarettes.filter((item) => (
    item.attemptId === state.plan!.id && toLocalDate(item.createdAt) === date
  ))
  const summary = summarizeSmokingLogs(logs, date)
  return {
    attemptId: state.plan.id,
    date,
    cigarettesSmoked: summary.recordedCount,
    cravingPeak: summary.peakCravingIntensity ?? 1,
    recordsSignature: JSON.stringify([...logs].sort((left, right) => left.id.localeCompare(right.id))),
  }
}

export function isDailyCheckInConfirmationCurrent(
  state: ClientState,
  confirmation: DailyCheckInConfirmation,
  at = new Date(),
): boolean {
  const current = createDailyCheckInConfirmation(state, at)
  return Boolean(current
    && current.attemptId === confirmation.attemptId
    && current.date === confirmation.date
    && current.cigarettesSmoked === confirmation.cigarettesSmoked
    && current.cravingPeak === confirmation.cravingPeak
    && current.recordsSignature === confirmation.recordsSignature)
}

export function applyDailyCheckIn(state: ClientState, next: ClientCheckIn): ClientState {
  const checkInTime = parseEventTime(next.createdAt)
  const exactSmokingTime = checkInTime ? latestSmokingTime(state, checkInTime, next.attemptId) : undefined
  const loggedCount = state.cigarettes
    .filter((event) => (!event.attemptId || event.attemptId === next.attemptId) && toLocalDate(event.createdAt) === next.date)
    .reduce((total, event) => total + event.count, 0)
  if (next.cigarettesSmoked < loggedCount) return state
  const legacyProxyTime = next.cigarettesSmoked > loggedCount ? checkInTime : undefined
  const latest = [exactSmokingTime, legacyProxyTime]
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => right.getTime() - left.getTime())[0]

  return {
    ...state,
    checkIns: mergeCheckIn(state.checkIns, next),
    ...(latest ? { lastCigaretteAt: latest.toISOString() } : {}),
  }
}

export function removeDailyCheckIn(state: ClientState, attemptId: string, date: string): ClientState {
  const checkIns = state.checkIns.filter((item) => item.attemptId !== attemptId || item.date !== date)
  if (checkIns.length === state.checkIns.length) return state

  const { lastCigaretteAt: _removed, ...withoutCachedLast } = state
  const candidate: ClientState = { ...withoutCachedLast, checkIns }
  const latest = latestSmokingTime(candidate, new Date(8_640_000_000_000_000))
  return latest ? { ...candidate, lastCigaretteAt: latest.toISOString() } : candidate
}

export function applyCigaretteLog(state: ClientState, event: ClientCigaretteLog): ClientState {
  const eventTime = parseEventTime(event.createdAt)
  if (!eventTime || event.count !== 1) return state
  if ((event.trigger === undefined) !== (event.cravingIntensity === undefined)) return state
  if (state.cigarettes.some((item) => item.id === event.id)) return state
  const previousTime = parseEventTime(state.lastCigaretteAt)
  const latest = [previousTime, eventTime]
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => right.getTime() - left.getTime())[0]
  return {
    ...state,
    ...(latest ? { lastCigaretteAt: latest.toISOString() } : {}),
    cigarettes: [event, ...state.cigarettes],
    checkIns: state.checkIns.filter((item) => item.date !== toLocalDate(event.createdAt) || item.attemptId !== event.attemptId),
  }
}

export interface CigaretteLogUpdate {
  smokedAt: string
  trigger?: Trigger | undefined
  cravingIntensity?: CravingLevel | undefined
  updatedAt?: string
}

export function updateCigaretteLog(
  state: ClientState,
  id: string,
  input: CigaretteLogUpdate,
): ClientState {
  const existing = state.cigarettes.find((item) => item.id === id)
  const eventTime = parseEventTime(input.smokedAt)
  if (!existing || existing.count !== 1 || !eventTime) return state
  if ((input.trigger === undefined) !== (input.cravingIntensity === undefined)) return state
  if (input.trigger !== undefined && (!parseTrigger(input.trigger) || !integerInRange(input.cravingIntensity, 1, 5))) return state
  if (input.trigger === undefined && (existing.trigger !== undefined || existing.cravingIntensity !== undefined)) return state
  const updated: ClientCigaretteLog = {
    ...existing,
    createdAt: eventTime.toISOString(),
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(input.cravingIntensity ? { cravingIntensity: input.cravingIntensity } : {}),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  }
  const attemptId = existing.attemptId ?? state.plan?.id
  const affectedDates = new Set([toLocalDate(existing.createdAt), toLocalDate(updated.createdAt)])
  const { lastCigaretteAt: _removed, ...withoutCachedLast } = state
  const candidate: ClientState = {
    ...withoutCachedLast,
    cigarettes: state.cigarettes
      .map((item) => item.id === id ? updated : item)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    checkIns: state.checkIns.filter((item) => !affectedDates.has(item.date) || item.attemptId !== attemptId),
    lapses: state.lapses.map((item) => item.cigaretteLogId === id
      ? {
          ...item,
          createdAt: updated.createdAt,
          ...(updated.trigger ? { trigger: updated.trigger } : {}),
          ...(updated.cravingIntensity ? { cravingIntensity: updated.cravingIntensity } : {}),
        }
      : item),
  }
  const latest = latestSmokingTime(candidate, new Date(8_640_000_000_000_000))
  return latest ? { ...candidate, lastCigaretteAt: latest.toISOString() } : candidate
}

export function removeCigaretteLog(state: ClientState, id: string): ClientState {
  const removed = state.cigarettes.find((item) => item.id === id)
  const cigarettes = state.cigarettes.filter((item) => item.id !== id)
  if (cigarettes.length === state.cigarettes.length) return state
  const { lastCigaretteAt: _removed, ...withoutCachedLast } = state
  const candidate: ClientState = {
    ...withoutCachedLast,
    cigarettes,
    deletedCigaretteIds: state.deletedCigaretteIds.includes(id)
      ? state.deletedCigaretteIds
      : [...state.deletedCigaretteIds, id],
    checkIns: removed
      ? state.checkIns.filter((item) => item.date !== toLocalDate(removed.createdAt) || item.attemptId !== (removed.attemptId ?? state.plan?.id))
      : state.checkIns,
    lapses: state.lapses.filter((item) => item.cigaretteLogId !== id),
  }
  const latest = latestSmokingTime(candidate, new Date(8_640_000_000_000_000))
  return latest ? { ...candidate, lastCigaretteAt: latest.toISOString() } : candidate
}

export function updateCravingEventLevel(
  cravings: ClientCravingEvent[],
  id: string,
  level: CravingLevel,
): ClientCravingEvent[] {
  return cravings.map((item) => item.id === id ? { ...item, level } : item)
}

export function resolveCravingEvent(
  cravings: ClientCravingEvent[],
  id: string,
  technique: string,
  level: CravingLevel,
): ClientCravingEvent[] {
  return cravings.map((item) => item.id === id
    ? { ...item, level, technique, resolved: true }
    : item)
}

export function applyLapseEvent(state: ClientState, event: ClientLapseEvent): ClientState {
  if (!Number.isInteger(event.cigarettes) || event.cigarettes < 1 || event.cigarettes > 60 || !parseEventTime(event.createdAt)) {
    return state
  }
  // The lapse ID is the caller-supplied operation ID. Checking it before
  // generating a cigarette makes retries idempotent across UI and state-layer
  // re-entry, while still committing the pair in one repository write.
  if (state.lapses.some((item) => item.id === event.id)) return state
  const referenced = event.cigaretteLogId
    ? state.cigarettes.find((item) => item.id === event.cigaretteLogId)
    : undefined
  if (event.cigaretteLogId && !referenced) return state
  if (referenced && (referenced.attemptId !== event.attemptId || referenced.count !== event.cigarettes)) return state
  if (event.cigaretteLogId && state.lapses.some((item) => item.cigaretteLogId === event.cigaretteLogId)) return state

  const createdCigarette: ClientCigaretteLog | undefined = referenced ? undefined : {
    id: createId('cigarette'),
    createdAt: event.createdAt,
    count: event.cigarettes,
    ...(event.trigger ? { trigger: event.trigger } : {}),
    ...(event.cravingIntensity ? { cravingIntensity: event.cravingIntensity } : {}),
    attemptId: event.attemptId,
    source: 'LAPSE_FLOW',
  }
  const linkedEvent: ClientLapseEvent = event.cigaretteLogId
    ? event
    : { ...event, cigaretteLogId: createdCigarette!.id }
  const cigaretteTime = referenced?.createdAt ?? event.createdAt
  const previousTime = parseEventTime(state.lastCigaretteAt)
  const nextTime = parseEventTime(cigaretteTime)
  const latest = [previousTime, nextTime]
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => right.getTime() - left.getTime())[0]
  return {
    ...state,
    ...(latest ? { lastCigaretteAt: latest.toISOString() } : {}),
    cigarettes: createdCigarette ? [createdCigarette, ...state.cigarettes] : state.cigarettes,
    checkIns: state.checkIns.filter((item) => item.date !== toLocalDate(cigaretteTime) || item.attemptId !== event.attemptId),
    lapses: [linkedEvent, ...state.lapses],
  }
}

export function updateLapseRecoveryAction(
  state: ClientState,
  id: string,
  recoveryAction: string,
): ClientState {
  const normalized = recoveryAction.trim()
  if (!normalized || normalized.length > 256) return state
  const existing = state.lapses.find((item) => item.id === id)
  if (!existing || existing.recoveryAction === normalized) return state
  return {
    ...state,
    lapses: state.lapses.map((item) => item.id === id
      ? { ...item, recoveryAction: normalized }
      : item),
  }
}

export function upsertOutcomeAssessment(
  outcomes: ClientOutcomeAssessment[],
  next: ClientOutcomeAssessment,
): ClientOutcomeAssessment[] {
  return [
    next,
    ...outcomes.filter((item) => !(item.planId === next.planId && item.dueMonth === next.dueMonth)),
  ].sort((left, right) => right.assessedAt.localeCompare(left.assessedAt))
}

export type SelfReportedOutcome = 'yes' | 'no' | 'unknown'

export function assessSelfReportedWindow(
  state: ClientState,
  days: 7 | 30,
  at = new Date(),
): SelfReportedOutcome {
  const dates = Array.from({ length: days }, (_, index) => addDays(at, -(days - index - 1)))
  const windowStart = dates[0]
  if (!windowStart) return 'unknown'
  const smokingEvent = [...state.cigarettes, ...state.lapses].some((item) => {
    const date = toLocalDate(item.createdAt)
    return date >= windowStart && date <= toLocalDate(at)
  })
  if (smokingEvent) return 'no'
  const checkInByDate = new Map(state.checkIns.map((item) => [item.date, item]))
  const answers = dates.map((date) => checkInByDate.get(date))
  if (answers.some((item) => item && !item.smokeFree)) return 'no'
  if (answers.every((item) => item?.smokeFree)) return 'yes'
  return 'unknown'
}

export class StoredStateCorruptionError extends Error {
  constructor(message = '本机数据无法安全读取') {
    super(message)
    this.name = 'StoredStateCorruptionError'
  }
}

function legacyLapseMatchKey(event: {
  attemptId?: string
  createdAt: string
  count: number
  trigger?: Trigger
}): string {
  return JSON.stringify([event.attemptId, event.createdAt, event.count, event.trigger ?? null])
}

/**
 * personal.20 and earlier could persist a LAPSE_FLOW cigarette beside an
 * unreferenced lapse. Link only a unique exact one-to-one match. Guessing when
 * either side is ambiguous could make an unrelated cigarette delete history,
 * so unmatched legacy lapses deliberately retain their original v1 semantics.
 */
function linkUnambiguousLegacyLapses(
  lapses: ClientLapseEvent[],
  cigarettes: ClientCigaretteLog[],
): ClientLapseEvent[] {
  const alreadyReferenced = new Set(
    lapses.flatMap((lapse) => lapse.cigaretteLogId ? [lapse.cigaretteLogId] : []),
  )
  const cigarettesByKey = new Map<string, ClientCigaretteLog[]>()
  cigarettes.forEach((cigarette) => {
    if (cigarette.source !== 'LAPSE_FLOW' || alreadyReferenced.has(cigarette.id)) return
    const key = legacyLapseMatchKey(cigarette)
    const bucket = cigarettesByKey.get(key)
    if (bucket) bucket.push(cigarette)
    else cigarettesByKey.set(key, [cigarette])
  })

  const lapsesByKey = new Map<string, ClientLapseEvent[]>()
  lapses.forEach((lapse) => {
    if (lapse.cigaretteLogId) return
    const key = legacyLapseMatchKey({
      attemptId: lapse.attemptId,
      createdAt: lapse.createdAt,
      count: lapse.cigarettes,
      ...(lapse.trigger ? { trigger: lapse.trigger } : {}),
    })
    const bucket = lapsesByKey.get(key)
    if (bucket) bucket.push(lapse)
    else lapsesByKey.set(key, [lapse])
  })

  const cigaretteIdByLapseId = new Map<string, string>()
  lapsesByKey.forEach((matchingLapses, key) => {
    const matchingCigarettes = cigarettesByKey.get(key) ?? []
    if (matchingLapses.length === 1 && matchingCigarettes.length === 1) {
      cigaretteIdByLapseId.set(matchingLapses[0]!.id, matchingCigarettes[0]!.id)
    }
  })
  return lapses.map((lapse) => {
    const cigaretteLogId = cigaretteIdByLapseId.get(lapse.id)
    return cigaretteLogId ? { ...lapse, cigaretteLogId } : lapse
  })
}

function parseStoredStateInternal(value: unknown, rejectInvalidCollectionItems: boolean): ClientState {
  if (value === undefined || value === null || value === '') return createInitialState()
  if (typeof value !== 'object') throw new StoredStateCorruptionError()
  const candidate = value as Partial<ClientState>
  if (candidate.version !== 1) throw new StoredStateCorruptionError('本机数据版本无法识别')
  const settings = parseSettings(candidate.settings)
  const baseline = parseBaseline(candidate.baseline)
  const plan = parsePlan(candidate.plan, baseline?.pricePerPack)

  const hasResidualHealthData = Boolean(candidate.lastCigaretteAt)
    || [
      candidate.checkIns,
      candidate.cravings,
      candidate.cigarettes,
      candidate.deletedCigaretteIds,
      candidate.lapses,
      candidate.outcomes,
      candidate.completedTasks,
    ]
      .some((items) => Array.isArray(items) && items.length > 0)
  if (candidate.onboarded === false && !baseline && !plan && !settings.sensitiveHealthData && !hasResidualHealthData) {
    return createInitialState()
  }

  // Never reinterpret partially written health data as a new user. The caller
  // must keep the original bytes untouched and offer recovery instead.
  if (candidate.onboarded !== true || !settings.sensitiveHealthData || !baseline || !plan) {
    throw new StoredStateCorruptionError()
  }

  if (
    rejectInvalidCollectionItems
    && candidate.lastCigaretteAt !== undefined
    && !validTimestamp(candidate.lastCigaretteAt)
  ) {
    throw new StoredStateCorruptionError('本机记录包含无法识别的项目')
  }
  const lastCigaretteAt = validTimestamp(candidate.lastCigaretteAt)
    ? candidate.lastCigaretteAt
    : undefined
  const archivedPlans = parseArray(
    candidate.archivedPlans,
    (item) => parsePlan(item, baseline.pricePerPack),
    rejectInvalidCollectionItems,
  )
  const checkIns = parseArray(candidate.checkIns, (item) => parseCheckIn(item, plan.id), rejectInvalidCollectionItems)
  const cigarettes = parseArray(
    candidate.cigarettes,
    (item) => parseCigarette(item, plan.id),
    rejectInvalidCollectionItems,
  )
  const deletedCigaretteIds = parseArray(
    candidate.deletedCigaretteIds,
    (item) => boundedString(item, 128) ? item : undefined,
    rejectInvalidCollectionItems,
  )
  const cravings = parseArray(candidate.cravings, (item) => parseCraving(item, plan.id), rejectInvalidCollectionItems)
  const outcomes = parseArray(candidate.outcomes, parseOutcome, rejectInvalidCollectionItems)
  const completedTasks = parseArray(
    candidate.completedTasks,
    (item) => parseCompletedTask(item, plan.id),
    rejectInvalidCollectionItems,
  )
  // Older versions allowed a positive daily total without any corresponding
  // per-cigarette event. Preserve it as one legacy aggregate instead of
  // dropping the count or inventing several identical event times.
  const cigaretteDays = new Set(cigarettes.map((item) => JSON.stringify([
    item.attemptId,
    toLocalDate(item.createdAt),
  ])))
  checkIns.forEach((checkIn) => {
    if (checkIn.cigarettesSmoked <= 0) return
    const dayKey = JSON.stringify([checkIn.attemptId, checkIn.date])
    if (cigaretteDays.has(dayKey)) return
    cigarettes.push({
      id: `daily-checkin-${checkIn.id}`,
      createdAt: checkIn.createdAt,
      count: checkIn.cigarettesSmoked,
      attemptId: checkIn.attemptId,
      source: 'DAILY_CHECKIN',
    })
    cigaretteDays.add(dayKey)
  })
  const parsedLapses = parseArray(candidate.lapses, (item) => parseLapse(item, plan.id), rejectInvalidCollectionItems)
  const migratedLapses = linkUnambiguousLegacyLapses(parsedLapses, cigarettes)
  const cigaretteById = new Map(cigarettes.map((item) => [item.id, item]))
  const lapses = migratedLapses.filter((lapse) => {
    if (!lapse.cigaretteLogId) return true
    const referenced = cigaretteById.get(lapse.cigaretteLogId)
    const valid = Boolean(
      referenced
      && referenced.attemptId === lapse.attemptId
      && referenced.count === lapse.cigarettes,
    )
    if (!valid && rejectInvalidCollectionItems) {
      throw new StoredStateCorruptionError('本机记录包含无法识别的项目')
    }
    return valid
  })

  // Duplicate identities are corruption, not a merge strategy. Accepting them
  // would make one edit/delete mutate several events and would double-count
  // smoking, tasks, check-ins or outcomes after a hand-edited backup import.
  // Run these checks after legacy migration so generated IDs are covered too.
  assertUniqueKeys([plan, ...archivedPlans], (item) => item.id)
  assertUniqueKeys([plan, ...archivedPlans], (item) => item.attemptNumber)
  assertUniqueKeys(checkIns, (item) => item.id)
  assertUniqueKeys(checkIns, (item) => [item.attemptId, item.date])
  assertUniqueKeys(cravings, (item) => item.id)
  assertUniqueKeys(cigarettes, (item) => item.id)
  assertUniqueKeys(deletedCigaretteIds, (item) => item)
  assertUniqueKeys(lapses, (item) => item.id)
  assertUniqueKeys(
    lapses.filter((item): item is ClientLapseEvent & { cigaretteLogId: string } => Boolean(item.cigaretteLogId)),
    (item) => item.cigaretteLogId,
  )
  assertUniqueKeys(outcomes, (item) => item.id)
  assertUniqueKeys(outcomes, (item) => [item.planId, item.dueMonth])
  assertUniqueKeys(completedTasks, (item) => [item.attemptId, item.contentId])

  // Missing attempt IDs are migrated by the individual parsers to the current
  // plan. An explicit, well-formed but unknown ID is different: accepting it
  // would leave history that no plan-scoped view can display or update.
  const knownPlanIds = new Set([plan, ...archivedPlans].map((item) => item.id))
  const hasUnknownPlanReference = [
    ...checkIns.map((item) => item.attemptId),
    ...cravings.map((item) => item.attemptId),
    ...cigarettes.map((item) => item.attemptId),
    ...lapses.map((item) => item.attemptId),
    ...completedTasks.map((item) => item.attemptId),
    ...outcomes.map((item) => item.planId),
  ].some((id) => !id || !knownPlanIds.has(id))
  if (hasUnknownPlanReference) {
    throw new StoredStateCorruptionError('本机记录包含无法识别的项目')
  }

  return {
    version: 1,
    onboarded: true,
    baseline,
    plan,
    archivedPlans,
    ...(lastCigaretteAt ? { lastCigaretteAt } : {}),
    checkIns,
    cravings,
    cigarettes: cigarettes.some((item, index) => (
      index > 0 && cigarettes[index - 1]!.createdAt.localeCompare(item.createdAt) < 0
    ))
      ? cigarettes.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      : cigarettes,
    deletedCigaretteIds,
    lapses,
    outcomes,
    completedTasks,
    settings,
  }
}

function assertUniqueKeys<T>(items: readonly T[], keyOf: (item: T) => unknown): void {
  const seen = new Set<string>()
  items.forEach((item) => {
    const key = JSON.stringify(keyOf(item))
    if (seen.has(key)) {
      throw new StoredStateCorruptionError('本机记录包含重复项目')
    }
    seen.add(key)
  })
}

/** Persistence parser: one malformed collection item makes the stored copy invalid. */
export function parseStoredStateStrict(value: unknown): ClientState {
  return parseStoredStateInternal(value, true)
}

/** Compatibility parser for non-persistence callers that intentionally want a safe blank fallback. */
export function parseStoredState(value: unknown): ClientState {
  try {
    return parseStoredStateInternal(value, false)
  } catch {
    return createInitialState()
  }
}

const TRIGGER_VALUES: readonly Trigger[] = [
  'work', 'meal', 'toilet', 'stress', 'social', 'alcohol', 'exercise', 'boredom', 'morning', 'coffee', 'habit',
]

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function boundedString(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum
}

function finiteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/

function daysInGregorianMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    return leapYear ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

export function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const match = RFC3339_TIMESTAMP.exec(value)
  if (!match) return false

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (
    year < 1
    || month < 1 || month > 12
    || day < 1 || day > daysInGregorianMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
  ) return false

  if (offsetText !== 'Z') {
    const offsetHour = Number(offsetText!.slice(1, 3))
    const offsetMinute = Number(offsetText!.slice(4, 6))
    if (offsetHour > 23 || offsetMinute > 59) return false
  }
  return Number.isFinite(new Date(value).getTime())
}

function validLocalDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return sharedDaysBetween(value, value) === 0
  } catch {
    return false
  }
}

function parseArray<T>(
  value: unknown,
  parser: (item: unknown) => T | undefined,
  rejectInvalidItems = false,
): T[] {
  // Missing collection fields are accepted for legacy version-1 snapshots,
  // but an explicitly stored non-array value means the container itself is
  // damaged. Strict persistence/import parsing must not silently reinterpret
  // that damage as an empty health-history collection.
  if (!Array.isArray(value)) {
    if (rejectInvalidItems && value !== undefined) {
      throw new StoredStateCorruptionError('本机记录集合格式无法识别')
    }
    return []
  }
  if (value.length > MAX_STORED_ITEMS_PER_COLLECTION) {
    throw new StoredStateCorruptionError('本机记录数量超出安全读取上限')
  }
  return value.flatMap((item) => {
    const parsed = parser(item)
    if (!parsed && rejectInvalidItems) {
      throw new StoredStateCorruptionError('本机记录包含无法识别的项目')
    }
    return parsed ? [parsed] : []
  })
}

function parseTrigger(value: unknown): Trigger | undefined {
  return TRIGGER_VALUES.includes(value as Trigger) ? value as Trigger : undefined
}

function parseScopedAttemptId(value: unknown, fallbackAttemptId: string): string | undefined {
  if (value === undefined) return fallbackAttemptId
  return boundedString(value, 128) ? value : undefined
}

function parseBaseline(value: unknown): ClientBaseline | undefined {
  const input = recordValue(value)
  if (
    !input
    || !integerInRange(input.cigarettesPerDay, 1, 100)
    || !integerInRange(input.firstCigaretteMinutes, 0, 1_440)
    || !integerInRange(input.previousAttempts, 0, MAX_PREVIOUS_ATTEMPTS)
    || !finiteInRange(input.pricePerPack, 0, 10_000)
  ) return undefined
  const reasons = Array.isArray(input.reasons)
    ? input.reasons.filter((item): item is string => boundedString(item, 80)).slice(0, 3)
    : []
  const triggers = Array.isArray(input.triggers)
    ? input.triggers.flatMap((item) => {
      const trigger = parseTrigger(item)
      return trigger ? [trigger] : []
    }).slice(0, 3)
    : []
  if (reasons.length === 0 || triggers.length === 0) return undefined
  return {
    cigarettesPerDay: input.cigarettesPerDay,
    firstCigaretteMinutes: input.firstCigaretteMinutes,
    previousAttempts: input.previousAttempts,
    reasons: [...new Set(reasons)],
    triggers: [...new Set(triggers)],
    pricePerPack: input.pricePerPack,
  }
}

function parsePlan(value: unknown, fallbackPricePerPack = 0): ClientQuitPlan | undefined {
  const input = recordValue(value)
  if (
    !input
    || !boundedString(input.id, 128)
    || (input.path !== 'abrupt' && input.path !== 'reduction')
    || !validTimestamp(input.createdAt)
    || !validLocalDate(input.quitDate)
    || !integerInRange(input.baselineCigarettesPerDay, 1, 100)
    || !integerInRange(input.attemptNumber, 1, Number.MAX_SAFE_INTEGER)
  ) return undefined
  // Validate the relationship as well as each field: the schedule renderer
  // requires these bounds, including when the plan came from an older backup.
  if (!validateQuitDate(input.path, toLocalDate(input.createdAt), input.quitDate)) return undefined
  const reductionLimits = input.path === 'reduction'
    ? parseReductionLimits(input.reductionLimits, input.baselineCigarettesPerDay)
    : undefined
  return {
    id: input.id,
    path: input.path,
    createdAt: input.createdAt,
    quitDate: input.quitDate,
    baselineCigarettesPerDay: input.baselineCigarettesPerDay,
    baselinePricePerPack: finiteInRange(input.baselinePricePerPack, 0, 10_000)
      ? input.baselinePricePerPack
      : fallbackPricePerPack,
    attemptNumber: input.attemptNumber,
    ...(reductionLimits ? { reductionLimits } : {}),
  }
}

function parseReductionLimits(
  value: unknown,
  baseline: number,
): NonNullable<ClientQuitPlan['reductionLimits']> {
  const defaults = defaultReductionLimits(baseline)
  const input = recordValue(value)
  if (
    !input
    || !integerInRange(input.stage75, 1, baseline)
    || !integerInRange(input.stage50, 1, baseline)
    || !integerInRange(input.stage25, 1, baseline)
    || input.stage75 < input.stage50
    || input.stage50 < input.stage25
  ) return defaults
  return { stage75: input.stage75, stage50: input.stage50, stage25: input.stage25 }
}

function parseSettings(value: unknown): ClientSettings {
  const defaults = createInitialState().settings
  const input = recordValue(value)
  if (!input) return defaults
  const requestedCloudSync = input.cloudSync === true
  const requestedOutcomeAnalytics = input.outcomeAnalytics === true
  const subscriptionEnabled = input.subscriptionEnabled === true
  const subscriptionStatus = input.subscriptionStatus === 'simulated'
    || input.subscriptionStatus === 'denied'
    || input.subscriptionStatus === 'not-requested'
    ? input.subscriptionStatus
    : undefined
  const syncConsentAt = requestedCloudSync && validTimestamp(input.syncConsentAt) ? input.syncConsentAt : undefined
  const analyticsConsentAt = requestedOutcomeAnalytics && validTimestamp(input.analyticsConsentAt)
    ? input.analyticsConsentAt
    : undefined
  // Optional processing can only survive a reload when its separate consent
  // receipt timestamp is intact. A manually flipped/corrupted boolean is not
  // treated as authorization for future adapters.
  const cloudSync = Boolean(syncConsentAt)
  const outcomeAnalytics = Boolean(analyticsConsentAt)
  return {
    sensitiveHealthData: input.sensitiveHealthData === true,
    inAppReminder: input.inAppReminder === true,
    reminderHour: integerInRange(input.reminderHour, 0, 23) ? input.reminderHour : defaults.reminderHour,
    subscriptionEnabled,
    ...(subscriptionStatus ? { subscriptionStatus } : {}),
    cloudSync,
    outcomeAnalytics,
    ...(syncConsentAt ? { syncConsentAt } : {}),
    ...(analyticsConsentAt ? { analyticsConsentAt } : {}),
  }
}

function parseCheckIn(value: unknown, fallbackAttemptId: string): ClientCheckIn | undefined {
  const input = recordValue(value)
  const attemptId = parseScopedAttemptId(input?.attemptId, fallbackAttemptId)
  if (
    !input || !boundedString(input.id, 128) || !validLocalDate(input.date)
    || !integerInRange(input.cigarettesSmoked, 0, 100)
    || !integerInRange(input.cravingPeak, 1, 5) || !validTimestamp(input.createdAt) || !attemptId
  ) return undefined
  return {
    id: input.id,
    date: input.date,
    cigarettesSmoked: input.cigarettesSmoked,
    cravingPeak: input.cravingPeak as CravingLevel,
    smokeFree: input.cigarettesSmoked === 0,
    createdAt: input.createdAt,
    attemptId,
  }
}

function parseCraving(value: unknown, fallbackAttemptId: string): ClientCravingEvent | undefined {
  const input = recordValue(value)
  const attemptId = parseScopedAttemptId(input?.attemptId, fallbackAttemptId)
  if (!input || !boundedString(input.id, 128) || !validTimestamp(input.createdAt) || !integerInRange(input.level, 1, 5) || !attemptId) return undefined
  const trigger = parseTrigger(input.trigger)
  const technique = boundedString(input.technique, 128) ? input.technique : undefined
  return {
    id: input.id,
    createdAt: input.createdAt,
    level: input.level as CravingLevel,
    ...(trigger ? { trigger } : {}),
    ...(technique ? { technique } : {}),
    ...(input.resolved === true ? { resolved: true } : {}),
    attemptId,
  }
}

function parseCigarette(value: unknown, fallbackAttemptId: string): ClientCigaretteLog | undefined {
  const input = recordValue(value)
  const attemptId = parseScopedAttemptId(input?.attemptId, fallbackAttemptId)
  if (
    !input || !boundedString(input.id, 128) || !validTimestamp(input.createdAt)
    || !integerInRange(input.count, 1, 100) || !attemptId
    || (input.loggedAt !== undefined && !validTimestamp(input.loggedAt))
    || (input.updatedAt !== undefined && !validTimestamp(input.updatedAt))
  ) return undefined
  const trigger = parseTrigger(input.trigger)
  const cravingIntensity = integerInRange(input.cravingIntensity, 1, 5)
    ? input.cravingIntensity as CravingLevel
    : undefined
  const loggedAt = validTimestamp(input.loggedAt) ? input.loggedAt : undefined
  const updatedAt = validTimestamp(input.updatedAt) ? input.updatedAt : undefined
  const source = input.source === 'QUICK_LOG' || input.source === 'DAILY_CHECKIN' || input.source === 'LAPSE_FLOW'
    ? input.source
    : undefined
  return {
    id: input.id,
    createdAt: input.createdAt,
    count: input.count,
    ...(trigger ? { trigger } : {}),
    ...(cravingIntensity ? { cravingIntensity } : {}),
    attemptId,
    ...(loggedAt ? { loggedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(source ? { source } : {}),
  }
}

function parseLapse(value: unknown, fallbackAttemptId: string): ClientLapseEvent | undefined {
  const input = recordValue(value)
  const attemptId = parseScopedAttemptId(input?.attemptId, fallbackAttemptId)
  if (
    !input || !boundedString(input.id, 128) || !validTimestamp(input.createdAt)
    || !integerInRange(input.cigarettes, 1, 60) || !boundedString(input.recoveryAction, 256) || !attemptId
  ) return undefined
  const trigger = parseTrigger(input.trigger)
  const cravingIntensity = integerInRange(input.cravingIntensity, 1, 5)
    ? input.cravingIntensity as CravingLevel
    : undefined
  const cigaretteLogId = boundedString(input.cigaretteLogId, 128) ? input.cigaretteLogId : undefined
  return {
    id: input.id,
    createdAt: input.createdAt,
    cigarettes: input.cigarettes,
    recoveryAction: input.recoveryAction,
    ...(trigger ? { trigger } : {}),
    ...(cravingIntensity ? { cravingIntensity } : {}),
    ...(cigaretteLogId ? { cigaretteLogId } : {}),
    attemptId,
  }
}

function nullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean'
}

function nullableInteger(value: unknown, minimum: number, maximum: number): value is number | null {
  return value === null || integerInRange(value, minimum, maximum)
}

function parseOutcome(value: unknown): ClientOutcomeAssessment | undefined {
  const input = recordValue(value)
  if (
    !input || !boundedString(input.id, 128) || !boundedString(input.planId, 128)
    || (input.dueMonth !== 3 && input.dueMonth !== 6 && input.dueMonth !== 12)
    || !validTimestamp(input.assessedAt)
    || !nullableBoolean(input.sevenDayAbstinent)
    || !nullableBoolean(input.thirtyDayAbstinent)
    || !nullableBoolean(input.continuouslyAbstinent)
    || !nullableInteger(input.currentCigarettesPerDay, 0, 100)
    || !nullableInteger(input.additionalQuitAttempts, 0, 100)
    || !nullableInteger(input.confidence, 0, 10)
    || !nullableBoolean(input.usedProfessionalSupport)
  ) return undefined
  return {
    id: input.id,
    planId: input.planId,
    dueMonth: input.dueMonth,
    assessedAt: input.assessedAt,
    sevenDayAbstinent: input.sevenDayAbstinent,
    thirtyDayAbstinent: input.thirtyDayAbstinent,
    continuouslyAbstinent: input.continuouslyAbstinent,
    currentCigarettesPerDay: input.currentCigarettesPerDay,
    additionalQuitAttempts: input.additionalQuitAttempts,
    confidence: input.confidence,
    usedProfessionalSupport: input.usedProfessionalSupport,
    selfReported: true,
    biochemicallyVerified: false,
  }
}

function parseCompletedTask(value: unknown, fallbackAttemptId: string): CompletedTask | undefined {
  const input = recordValue(value)
  const attemptId = parseScopedAttemptId(input?.attemptId, fallbackAttemptId)
  if (!input || !boundedString(input.contentId, 128) || !validTimestamp(input.completedAt) || !attemptId) return undefined
  return {
    contentId: input.contentId,
    completedAt: input.completedAt,
    attemptId,
  }
}
