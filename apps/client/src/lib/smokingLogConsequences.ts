import type { ClientCigaretteLog, ClientState } from '../types'
import { toLocalDate } from './model'

export interface CigaretteLogMutationConsequences {
  affectedCheckInCount: number
  linkedLapseCount: number
}

/** Describes records invalidated when a new cigarette is logged. */
export function cigaretteLogAdditionConsequences(
  state: ClientState,
  smokedAt: string,
): CigaretteLogMutationConsequences {
  const attemptId = state.plan?.id
  const affectedDate = toLocalDate(smokedAt)
  return {
    affectedCheckInCount: attemptId
      ? state.checkIns.filter((item) => item.attemptId === attemptId && item.date === affectedDate).length
      : 0,
    linkedLapseCount: 0,
  }
}

/** Describes the exact records that model.ts will invalidate or update. */
export function cigaretteLogMutationConsequences(
  state: ClientState,
  log: ClientCigaretteLog,
  nextSmokedAt?: string,
): CigaretteLogMutationConsequences {
  const attemptId = log.attemptId ?? state.plan?.id
  const affectedDates = new Set([toLocalDate(log.createdAt)])
  if (nextSmokedAt) affectedDates.add(toLocalDate(nextSmokedAt))
  return {
    affectedCheckInCount: attemptId
      ? state.checkIns.filter((item) => item.attemptId === attemptId && affectedDates.has(item.date)).length
      : 0,
    linkedLapseCount: state.lapses.filter((item) => item.cigaretteLogId === log.id).length,
  }
}
