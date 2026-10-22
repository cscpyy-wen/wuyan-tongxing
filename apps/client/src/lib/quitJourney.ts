import type { ClientQuitJourney, ClientState } from '../types'
import { toShanghaiDate } from './smokingLogs'
import { parseQuitJourney, quitJourneyTimestamp as timestamp, validQuitJourneyParameters as validParameters } from './quitJourneySchema'

export { parseQuitJourney } from './quitJourneySchema'

const DAY_MS = 86_400_000

export type QuitJourneyInput = Omit<ClientQuitJourney, 'confirmedAt'>

export interface QuitJourneySnapshot {
  startedAt: string
  continuousStartedAt: string
  /** Complete 24-hour periods, then the remaining hours and minutes. */
  days: number
  hours: number
  minutes: number
  elapsedDays: number
  cigarettesAvoided: number
  moneySaved: number
  recordedSinceStart: number
  clockSkew: boolean
  hasApproximateSmokingTime: boolean
  /** These estimates assume the user continues to record any later smoking. */
  selfReported: true
  assumesCompleteRecording: true
}

interface SmokingEvidence {
  time: number
  count: number
  approximate: boolean
}

interface DailyEvidence {
  events: SmokingEvidence[]
  totals: Array<{ count: number; time: number }>
}

/**
 * Physical smoking history spans attempts when a user backdates the quit anchor.
 * Daily totals remain scoped to their own attempt: one attempt's logs cannot
 * silently satisfy another attempt's reported total on the same calendar day.
 */
function smokingEvidence(state: ClientState, at: number): SmokingEvidence[] {
  const days = new Map<string, DailyEvidence>()
  const coveredTimes = new Set<number>()
  const scopedAttempt = (id: string | undefined) => id ?? state.plan?.id ?? ''
  const dayFor = (date: string, attemptId: string | undefined): DailyEvidence => {
    const key = JSON.stringify([scopedAttempt(attemptId), date])
    const existing = days.get(key)
    if (existing) return existing
    const created: DailyEvidence = { events: [], totals: [] }
    days.set(key, created)
    return created
  }
  const logs = state.cigarettes
  const checkIns = state.checkIns
  const lapses = state.lapses
  const logIds = new Set(logs.map((item) => item.id))
  const checkInById = new Map(checkIns.map((item) => [`daily-checkin-${item.id}`, item]))
  const signature = (time: string, count: number, attemptId: string | undefined) => JSON.stringify([scopedAttempt(attemptId), timestamp(time), count])
  const logSignatures = new Map<string, number>()
  const lapseSignatures = new Map<string, number>()
  logs.forEach((item) => {
    if (item.source === 'DAILY_CHECKIN') return
    const key = signature(item.createdAt, item.count, item.attemptId)
    logSignatures.set(key, (logSignatures.get(key) ?? 0) + 1)
  })
  lapses.forEach((item) => {
    const key = signature(item.createdAt, item.cigarettes, item.attemptId)
    lapseSignatures.set(key, (lapseSignatures.get(key) ?? 0) + 1)
  })
  const recordEvent = (time: number, count: number, attemptId: string | undefined) => {
    if (time > at) return
    coveredTimes.add(time)
    dayFor(toShanghaiDate(new Date(time)), attemptId).events.push({ time, count, approximate: false })
  }
  const recordTotal = (date: string, count: number, reportedAt: number, attemptId: string | undefined) => {
    if (reportedAt > at || date > toShanghaiDate(new Date(at))) return
    coveredTimes.add(reportedAt)
    const day = dayFor(date, attemptId)
    // A legacy daily count has no exact smoking instant. Its report time is an
    // upper bound on that day, capped at the day's end for later-entered totals.
    const end = new Date(`${date}T23:59:59.999+08:00`).getTime()
    const start = end - DAY_MS + 1
    const proxy = Math.min(at, end, Math.max(start, reportedAt))
    day.totals.push({ count, time: proxy })
  }
  logs.forEach((item) => {
    const time = timestamp(item.createdAt)
    if (time === undefined || item.count <= 0) return
    if (item.source === 'DAILY_CHECKIN') {
      const checkIn = checkInById.get(item.id)
      recordTotal(checkIn?.date ?? toShanghaiDate(item.createdAt), item.count, time, item.attemptId)
    } else recordEvent(time, item.count, item.attemptId)
  })
  lapses.forEach((item) => {
    const time = timestamp(item.createdAt)
    if (time === undefined || item.cigarettes <= 0) return
    // Linked lapses describe an existing visible record. Older unlinked pairs
    // may be matched only when both sides have one unambiguous exact signature.
    if (item.cigaretteLogId && logIds.has(item.cigaretteLogId)) return
    const key = signature(item.createdAt, item.cigarettes, item.attemptId)
    if (!item.cigaretteLogId && logSignatures.get(key) === 1 && lapseSignatures.get(key) === 1) return
    recordEvent(time, item.cigarettes, item.attemptId)
  })
  checkIns.forEach((item) => {
    const time = timestamp(item.createdAt)
    if (time !== undefined && item.cigarettesSmoked > 0) recordTotal(item.date, item.cigarettesSmoked, time, item.attemptId)
  })
  const result: SmokingEvidence[] = []
  days.forEach((day) => {
    day.events.sort((left, right) => left.time - right.time)
    day.totals.sort((left, right) => left.time - right.time)
    day.events.forEach((item) => result.push(item))
    let coveredCount = 0
    let index = 0
    day.totals.forEach((total) => {
      while (index < day.events.length && day.events[index]!.time <= total.time) {
        coveredCount += day.events[index++]!.count
      }
      const residual = total.count - coveredCount
      if (residual > 0) {
        result.push({ time: total.time, count: residual, approximate: true })
        coveredCount += residual
      }
    })
  })
  // Some old archives have only this timestamp. It proves at least one cigarette
  // but must not duplicate any covered event or daily report in any attempt.
  const cached = timestamp(state.lastCigaretteAt)
  if (cached !== undefined && cached <= at && !coveredTimes.has(cached)) {
    result.push({ time: cached, count: 1, approximate: true })
  }
  return result
}

/** Saved smoking cannot be in the future; do not silently hide it after clock rollback. */
function hasFutureSmokingEvidence(state: ClientState, at: number): boolean {
  const future = (value: string | undefined) => (timestamp(value) ?? Number.NEGATIVE_INFINITY) > at
  return future(state.lastCigaretteAt)
    || state.cigarettes.some((item) => item.count > 0 && future(item.createdAt))
    || state.lapses.some((item) => item.cigarettes > 0 && future(item.createdAt))
    || state.checkIns.some((item) => item.cigarettesSmoked > 0 && future(item.createdAt))
}

export function validateQuitJourneyInput(state: ClientState, input: QuitJourneyInput, now = new Date()): string | undefined {
  if (!state.onboarded || !state.settings.sensitiveHealthData || !state.plan || input.attemptId !== state.plan.id) {
    return '计划已变化，请重新打开无烟起点设置'
  }
  if (!validParameters(input as unknown as Record<string, unknown>)) return '请检查日均支数、每包价格和每包支数'
  const start = timestamp(input.startedAt)
  if (start === undefined) return '请选择有效的最后一支时间'
  const at = now.getTime()
  if (!Number.isFinite(at) || start > at) return '最后一支时间不能晚于现在'
  const existing = state.quitJourney
  const sameStart = existing?.attemptId === input.attemptId && timestamp(existing.startedAt) === start
  if (!sameStart && hasFutureSmokingEvidence(state, at)) return '已存吸烟记录晚于当前时间，请检查设备时间后再设置'
  if (!sameStart && smokingEvidence(state, at).some((item) => item.time > start)) {
    return '所选时间之后还有吸烟记录，请将最后一支时间改到最近一次吸烟之后'
  }
  return undefined
}

/** Always call with the latest committed state; never backfill daily check-ins. */
export function setQuitJourney(state: ClientState, input: QuitJourneyInput, now = new Date()): ClientState {
  const error = validateQuitJourneyInput(state, input, now)
  if (error) throw new Error(error)
  const sameStart = state.quitJourney?.attemptId === input.attemptId
    && timestamp(state.quitJourney.startedAt) === timestamp(input.startedAt)
  const quitJourney = parseQuitJourney({
    ...input,
    confirmedAt: sameStart ? state.quitJourney!.confirmedAt : now.toISOString(),
  }, new Set([state.plan!.id]))!
  return { ...state, quitJourney }
}

export function computeQuitJourney(state: ClientState, now = new Date()): QuitJourneySnapshot | undefined {
  const journey = state.quitJourney
  if (!journey || journey.attemptId !== state.plan?.id || !state.onboarded || !state.settings.sensitiveHealthData) return undefined
  const start = timestamp(journey.startedAt)
  const confirmed = timestamp(journey.confirmedAt)
  const at = now.getTime()
  if (start === undefined || confirmed === undefined || !Number.isFinite(at)) return undefined
  const evidence = smokingEvidence(state, at).filter((item) => item.time > start)
  const continuousStart = evidence.reduce((latest, item) => Math.max(latest, item.time), start)
  const totalMinutes = Math.floor(Math.max(0, at - continuousStart) / 60_000)
  const elapsedDays = Math.max(0, at - start) / DAY_MS
  const recordedSinceStart = evidence.reduce((total, item) => total + item.count, 0)
  const cigarettesAvoided = Math.max(0, Math.floor(elapsedDays * journey.cigarettesPerDay) - recordedSinceStart)
  return {
    startedAt: journey.startedAt,
    continuousStartedAt: new Date(continuousStart).toISOString(),
    days: Math.floor(totalMinutes / (24 * 60)),
    hours: Math.floor(totalMinutes / 60) % 24,
    minutes: totalMinutes % 60,
    elapsedDays,
    cigarettesAvoided,
    moneySaved: cigarettesAvoided * journey.pricePerPack / journey.cigarettesPerPack,
    recordedSinceStart,
    clockSkew: at < start || at < confirmed || hasFutureSmokingEvidence(state, at),
    hasApproximateSmokingTime: evidence.some((item) => item.approximate),
    selfReported: true,
    assumesCompleteRecording: true,
  }
}
