import type { ClientQuitPlan, Trigger } from '../types'

export interface WithheldTodayContent {
  id: 'harmony-review-gated'
  title: '健康教育内容暂未开放'
  summary: 'HarmonyOS 首版仅提供本机记录与非医疗自助工具。'
  durationMinutes: 0
  sourceLabel: '首发范围'
  actionType?: undefined
}

const WITHHELD_TODAY_CONTENT: Readonly<WithheldTodayContent> = Object.freeze({
  id: 'harmony-review-gated',
  title: '健康教育内容暂未开放',
  summary: 'HarmonyOS 首版仅提供本机记录与非医疗自助工具。',
  durationMinutes: 0,
  sourceLabel: '首发范围',
})

/**
 * Harmony intentionally has no dependency on @wuyan/content or @wuyan/rules.
 * Keep the full signature so the shared Today page remains platform-neutral.
 */
export function getTodayContent(
  _plan: ClientQuitPlan,
  _at: Date,
  _recentCravingLevel?: number,
  _hasRecentLapse = false,
  _firstCigaretteMinutes = 60,
  _selectedTriggers: Trigger[] = [],
  _completedTaskIds: string[] = [],
): WithheldTodayContent {
  return WITHHELD_TODAY_CONTENT
}

export function getSharedPackageCapabilities() {
  return { ruleEngine: false, contentIndex: false }
}
