import type { ClientQuitJourney } from '../types'
import { validTimestamp } from './timestampValidation'

/** Shared by strict persistence parsing and the independently loaded calculator. */
export function quitJourneyTimestamp(value: unknown): number | undefined {
  return validTimestamp(value) ? new Date(value).getTime() : undefined
}

export function validQuitJourneyParameters(input: Record<string, unknown>): boolean {
  const day = input.cigarettesPerDay as number
  const pack = input.cigarettesPerPack as number
  return typeof input.attemptId === 'string' && input.attemptId.length > 0 && input.attemptId.length <= 128
    && Number.isInteger(day) && day >= 1 && day <= 100
    && typeof input.pricePerPack === 'number' && Number.isFinite(input.pricePerPack) && input.pricePerPack >= 0 && input.pricePerPack <= 10_000
    && Number.isInteger(pack) && pack >= 1 && pack <= 100
}

/**
 * Absent data is a v33-compatible unconfigured journey. Dates are checked against
 * the saved confirmation, not the device clock: clock rollback must not destroy
 * an otherwise valid local archive. New submissions also check the current time.
 */
export function parseQuitJourney(value: unknown, knownAttemptIds: ReadonlySet<string>): ClientQuitJourney | undefined {
  if (value === undefined) return undefined
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const start = quitJourneyTimestamp(input.startedAt)
  const confirmed = quitJourneyTimestamp(input.confirmedAt)
  if (!validQuitJourneyParameters(input) || start === undefined || confirmed === undefined || start > confirmed
    || !knownAttemptIds.has(input.attemptId as string)) throw new Error('无烟数据无效')
  return {
    attemptId: input.attemptId as string,
    startedAt: new Date(start).toISOString(),
    cigarettesPerDay: input.cigarettesPerDay as number,
    pricePerPack: input.pricePerPack as number,
    cigarettesPerPack: input.cigarettesPerPack as number,
    confirmedAt: new Date(confirmed).toISOString(),
  }
}
