import {
  getTodayContentSummary,
  TODAY_CONTENT_SUMMARIES,
  type TodayContentSummary,
} from '@wuyan/content/today'
import { defaultRules, evaluateRules, type RuleInput } from '@wuyan/rules'
import type { QuitPhase, Trigger as SharedTrigger } from '@wuyan/contracts'
import type { ClientQuitPlan, QuitPath, Trigger } from '../types'
import { daysBetween, getJourneyPhase } from './model'

interface DisplayContent extends TodayContentSummary {
  actionType?: string
}

interface RecommendationInput {
  path: QuitPath
  phase: string
  relativeDay: number
  recentCravingLevel?: number
  hasRecentLapse: boolean
  firstCigaretteMinutes: number
  selectedTriggers: Trigger[]
  completedTaskIds: string[]
  at: Date
}

const TRIGGER_MAP: Record<Trigger, SharedTrigger> = {
  work: 'WORK_BREAK',
  meal: 'AFTER_MEAL',
  stress: 'STRESS',
  social: 'SOCIAL_OFFER',
  alcohol: 'ALCOHOL',
  exercise: 'OTHER_STRUCTURED',
  boredom: 'BOREDOM',
  morning: 'OTHER_STRUCTURED',
  coffee: 'COFFEE_TEA',
  habit: 'OTHER_STRUCTURED',
}

function toSharedPhase(phase: string): QuitPhase {
  if (phase === 'prepare') return 'PREPARATION'
  if (phase === 'reduce') return 'REDUCTION'
  if (phase === 'quit-day') return 'QUIT_DAY'
  if (phase === 'active') return 'ACTIVE_28'
  return 'MAINTENANCE'
}

export function toShanghaiRuleTimeBucket(at: Date): RuleInput['localTimeBucket'] {
  if (!Number.isFinite(at.getTime())) throw new Error('规则时间无效')
  const hourPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at).find((part) => part.type === 'hour')?.value
  const hour = Number(hourPart)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('规则时间无效')
  if (hour < 11) return 'MORNING'
  if (hour < 14) return 'MIDDAY'
  if (hour < 19) return 'EVENING'
  return 'NIGHT'
}

function recommendedByRules(input: RecommendationInput): { contentId: string; actionType: string } {
  const decision = evaluateRules({
    strategy: input.path === 'abrupt' ? 'ABRUPT' : 'REDUCE_THEN_QUIT',
    phase: toSharedPhase(input.phase),
    relativeDay: input.relativeDay,
    dependenceBand: input.firstCigaretteMinutes <= 30 ? 'HIGHER' : 'LOWER',
    recentCraving: input.recentCravingLevel ? input.recentCravingLevel * 2 : null,
    recentLapse: input.hasRecentLapse,
    selectedTriggers: input.selectedTriggers.map((trigger) => TRIGGER_MAP[trigger]),
    completedTaskIds: input.completedTaskIds,
    localTimeBucket: toShanghaiRuleTimeBucket(input.at),
  }, defaultRules)
  return { contentId: decision.contentId, actionType: decision.actionType }
}

export function getTodayContent(
  plan: ClientQuitPlan,
  at: Date,
  recentCravingLevel?: number,
  hasRecentLapse = false,
  firstCigaretteMinutes = 60,
  selectedTriggers: Trigger[] = [],
  completedTaskIds: string[] = [],
): DisplayContent {
  const phase = getJourneyPhase(plan, at)
  const relativeDay = daysBetween(plan.quitDate, at)
  const ruleDecision = recommendedByRules({
    path: plan.path,
    phase,
    relativeDay,
    ...(recentCravingLevel ? { recentCravingLevel } : {}),
    hasRecentLapse,
    firstCigaretteMinutes,
    selectedTriggers,
    completedTaskIds,
    at,
  })
  const scheduledId = relativeDay < 0
    ? `prep-${String(Math.min(7, Math.max(1, 8 + relativeDay))).padStart(2, '0')}`
    : relativeDay <= 27
      ? `day-${String(Math.max(1, relativeDay + 1)).padStart(2, '0')}`
      : relativeDay <= 55
        ? `maintenance-week-${String(Math.min(8, Math.max(5, 5 + Math.floor((relativeDay - 28) / 7)))).padStart(2, '0')}`
        : 'day-28'
  const scheduledContent = getTodayContentSummary(scheduledId) ?? TODAY_CONTENT_SUMMARIES[0]!

  // Contextual recommendations are supplemental. The dated course is the
  // stable primary task so a craving or lapse never makes unfinished work
  // disappear without explanation.
  if (ruleDecision.contentId === scheduledContent.id) {
    return { ...scheduledContent, actionType: ruleDecision.actionType }
  }
  return scheduledContent
}

/** Visible in diagnostics; keeps package integration explicit without assuming unstable runtime signatures. */
export function getSharedPackageCapabilities() {
  return {
    ruleEngine: typeof evaluateRules === 'function',
    contentIndex: TODAY_CONTENT_SUMMARIES.length > 0,
  }
}
