export interface HealthMilestone {
  readonly id: string
  readonly label: string
  readonly timeLabel: string
  readonly detail: string
  readonly sourceUrl: string
  readonly sourceName: string
  /** Date displayed by the source; not the date of the underlying studies. */
  readonly sourcePublishedAt: string
  readonly sourceCheckedAt: string
  readonly startDays?: number
  readonly endDays?: number
}

export type HealthMilestonePhase = 'ahead' | 'within' | 'elapsed' | 'general'

// Approximate units locate reference windows only; they do not model recovery.
const REFERENCE_YEAR_DAYS = 365.25
const REFERENCE_MONTH_DAYS = REFERENCE_YEAR_DAYS / 12
const SOURCE_CHECKED_AT = '2026-10-13'

const BENEFITS_SOURCE = {
  sourceUrl: 'https://www.cdc.gov/tobacco/about/benefits-of-quitting.html',
  sourceName: 'CDC · 戒烟益处',
  sourcePublishedAt: '2024-05-15',
  sourceCheckedAt: SOURCE_CHECKED_AT,
} as const

const CARDIOVASCULAR_SOURCE = {
  sourceUrl: 'https://www.cdc.gov/tobacco/about/cigarettes-and-cardiovascular-disease.html',
  sourceName: 'CDC · 吸烟与心血管疾病',
  sourcePublishedAt: '2024-09-17',
  sourceCheckedAt: SOURCE_CHECKED_AT,
} as const

const CANCER_SOURCE = {
  sourceUrl: 'https://www.cdc.gov/tobacco/about/cigarettes-and-cancer.html',
  sourceName: 'CDC · 吸烟与癌症',
  sourcePublishedAt: '2024-09-17',
  sourceCheckedAt: SOURCE_CHECKED_AT,
} as const

/** Population-level education, never a personal risk or recovery assessment. */
export const HEALTH_MILESTONES: ReadonlyArray<HealthMilestone> = [
  {
    id: 'heart-rate',
    label: '心率变化',
    timeLabel: '几分钟',
    detail: '戒烟后心率开始下降；个人变化不能仅凭经过时间判断。',
    ...BENEFITS_SOURCE,
  },
  {
    id: 'carbon-monoxide',
    label: '一氧化碳水平',
    timeLabel: '数天',
    detail: '资料显示，血液中一氧化碳可降至不吸烟者水平；这不是个人检测结果。',
    ...BENEFITS_SOURCE,
  },
  {
    id: 'breathing',
    label: '咳嗽与气短',
    timeLabel: '1–12 个月',
    detail: '这一时间段内，咳嗽和气短通常逐渐减轻；每个人的变化不同。',
    startDays: REFERENCE_MONTH_DAYS,
    endDays: REFERENCE_YEAR_DAYS,
    ...BENEFITS_SOURCE,
  },
  {
    id: 'heart-attack',
    label: '心肌梗死风险',
    timeLabel: '1–2 年',
    detail: '群体资料显示，相比继续吸烟，戒烟后这一时期心肌梗死风险明显下降。',
    startDays: REFERENCE_YEAR_DAYS,
    endDays: 2 * REFERENCE_YEAR_DAYS,
    ...CARDIOVASCULAR_SOURCE,
  },
  {
    id: 'coronary-excess-risk',
    label: '冠心病额外风险',
    timeLabel: '3–6 年',
    detail: '群体资料显示，吸烟带来的额外冠心病风险约减半；不是个人总风险减半。',
    startDays: 3 * REFERENCE_YEAR_DAYS,
    endDays: 6 * REFERENCE_YEAR_DAYS,
    ...CARDIOVASCULAR_SOURCE,
  },
  {
    id: 'stroke-risk',
    label: '卒中风险',
    timeLabel: '5–10 年',
    detail: '群体资料显示，相比继续吸烟，戒烟后这一时期卒中风险下降。',
    startDays: 5 * REFERENCE_YEAR_DAYS,
    endDays: 10 * REFERENCE_YEAR_DAYS,
    ...CARDIOVASCULAR_SOURCE,
  },
  {
    id: 'oral-pharyngeal-laryngeal-cancer',
    label: '口腔、咽与喉癌额外风险',
    timeLabel: '5–10 年',
    detail: '群体资料显示，吸烟带来的这些癌症额外风险约减半；不代表所有癌症风险。',
    startDays: 5 * REFERENCE_YEAR_DAYS,
    endDays: 10 * REFERENCE_YEAR_DAYS,
    ...CANCER_SOURCE,
  },
  {
    id: 'lung-cancer',
    label: '肺癌额外风险',
    timeLabel: '10–15 年',
    detail: '群体资料显示，吸烟带来的额外肺癌风险约减半；不是个人患癌概率或死亡率。',
    startDays: 10 * REFERENCE_YEAR_DAYS,
    endDays: 15 * REFERENCE_YEAR_DAYS,
    ...CANCER_SOURCE,
  },
  {
    id: 'coronary-long-term',
    label: '长期冠心病风险',
    timeLabel: '15 年',
    detail: '群体资料显示，冠心病风险接近不吸烟者；不表示个人心血管健康已完全恢复。',
    startDays: 15 * REFERENCE_YEAR_DAYS,
    ...CARDIOVASCULAR_SOURCE,
  },
]

/**
 * Classifies elapsed time only, without measuring health or interpolating risk.
 * Bounded windows include both endpoints. A single reference time is elapsed
 * at or after its start. Unspecified bounds or invalid inputs remain general.
 * UI labels must describe reference time, never a physiological achievement.
 */
export function healthMilestonePhase(
  item: Pick<HealthMilestone, 'startDays' | 'endDays'>,
  elapsedDays: number,
): HealthMilestonePhase {
  const { startDays, endDays } = item
  if (
    !Number.isFinite(elapsedDays)
    || elapsedDays < 0
    || startDays === undefined
    || !Number.isFinite(startDays)
    || startDays < 0
    || (endDays !== undefined && (!Number.isFinite(endDays) || endDays < startDays))
  ) return 'general'

  if (elapsedDays < startDays) return 'ahead'
  if (endDays !== undefined && elapsedDays <= endDays) return 'within'
  return 'elapsed'
}
