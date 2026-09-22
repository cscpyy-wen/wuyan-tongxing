import type { ClientCigaretteLog, CravingLevel, Trigger } from '../types'

export const SMOKING_TIMEZONE_LABEL = '北京时间'

export const SMOKING_TRIGGER_OPTIONS: ReadonlyArray<{ value: Trigger; label: string; shortLabel: string }> = [
  { value: 'work', label: '工作疲惫', shortLabel: '工作' },
  { value: 'meal', label: '刚吃完饭', shortLabel: '饭后' },
  { value: 'toilet', label: '拉屎', shortLabel: '拉屎' },
  { value: 'stress', label: '压力或烦躁', shortLabel: '压力' },
  { value: 'social', label: '社交需要', shortLabel: '社交' },
  { value: 'alcohol', label: '饮酒后', shortLabel: '饮酒' },
  { value: 'exercise', label: '健身后', shortLabel: '运动' },
  { value: 'boredom', label: '无聊或独处', shortLabel: '无聊' },
  { value: 'morning', label: '早晨习惯', shortLabel: '早晨' },
  { value: 'coffee', label: '咖啡或茶', shortLabel: '咖啡' },
  { value: 'habit', label: '下意识习惯', shortLabel: '习惯' },
]

export function smokingTriggerLabel(value?: Trigger): string {
  return SMOKING_TRIGGER_OPTIONS.find((item) => item.value === value)?.label ?? '原因未记录'
}

export function smokingTriggerShortLabel(value?: Trigger): string {
  return SMOKING_TRIGGER_OPTIONS.find((item) => item.value === value)?.shortLabel ?? '未记录'
}

/** China has used UTC+8 without daylight-saving changes for the app's target period. */
export function toShanghaiDate(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value
  const shifted = new Date(date.getTime() + 8 * 3_600_000)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export interface SmokingReasonCount {
  trigger?: Trigger
  label: string
  count: number
  percentage: number
}

export interface SmokingDaySummary {
  date: string
  logs: ClientCigaretteLog[]
  recordedCount: number
  lastSmokedAt?: string
  averageIntervalMinutes?: number
  latestIntervalMinutes?: number
  averageCravingIntensity?: number
  peakCravingIntensity?: CravingLevel
  reasons: SmokingReasonCount[]
  topReason?: SmokingReasonCount
}

function validEventTime(value: string): number | undefined {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : undefined
}

export function summarizeSmokingLogs(
  logs: ClientCigaretteLog[],
  date: string,
): SmokingDaySummary {
  const dayLogs = logs
    .filter((item) => toShanghaiDate(item.createdAt) === date)
    .filter((item) => validEventTime(item.createdAt) !== undefined)
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
  const recordedCount = dayLogs.reduce((total, item) => total + item.count, 0)
  const preciseLogs = dayLogs.filter((item) => item.count === 1)
  const canCalculateIntervals = preciseLogs.length === dayLogs.length && preciseLogs.length >= 2
  const intervals = canCalculateIntervals
    ? preciseLogs.slice(1).map((item, index) => {
      const previous = preciseLogs[index]!
      return Math.max(0, Math.round((new Date(item.createdAt).getTime() - new Date(previous.createdAt).getTime()) / 60_000))
    })
    : []
  const intensityValues = dayLogs.flatMap((item) => item.cravingIntensity ? [item.cravingIntensity] : [])
  const reasonMap = new Map<Trigger | undefined, number>()
  dayLogs.forEach((item) => {
    const isSystemShortcut = item.count === 1
      && item.source === 'QUICK_LOG'
      && item.trigger === undefined
      && item.cravingIntensity === undefined
    if (isSystemShortcut) return
    reasonMap.set(item.trigger, (reasonMap.get(item.trigger) ?? 0) + item.count)
  })
  const reasons = [...reasonMap.entries()]
    .map(([trigger, count]) => ({
      ...(trigger ? { trigger } : {}),
      label: smokingTriggerLabel(trigger),
      count,
      percentage: recordedCount > 0 ? Math.round((count / recordedCount) * 100) : 0,
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'zh-CN'))
  const last = dayLogs.at(-1)
  const average = intervals.length > 0
    ? Math.round(intervals.reduce((total, value) => total + value, 0) / intervals.length)
    : undefined
  const averageCraving = intensityValues.length > 0
    ? intensityValues.reduce((total, value) => total + value, 0) / intensityValues.length
    : undefined

  return {
    date,
    logs: dayLogs,
    recordedCount,
    ...(last ? { lastSmokedAt: last.createdAt } : {}),
    ...(average !== undefined ? { averageIntervalMinutes: average } : {}),
    ...(intervals.length > 0 ? { latestIntervalMinutes: intervals.at(-1)! } : {}),
    ...(averageCraving !== undefined ? { averageCravingIntensity: averageCraving } : {}),
    ...(intensityValues.length > 0 ? { peakCravingIntensity: Math.max(...intensityValues) as CravingLevel } : {}),
    reasons,
    ...(reasons[0] ? {
      topReason: reasons.filter((item) => item.count === reasons[0]!.count).length === 1
        ? reasons[0]
        : {
            label: reasons.filter((item) => item.count === reasons[0]!.count).length <= 2
              ? reasons.filter((item) => item.count === reasons[0]!.count).map((item) => smokingTriggerShortLabel(item.trigger)).join('、')
              : `${reasons.filter((item) => item.count === reasons[0]!.count).length} 种原因`,
            count: reasons[0].count,
            percentage: reasons[0].percentage,
          },
    } : {}),
  }
}

export function formatSmokingInterval(minutes?: number): string {
  if (minutes === undefined) return '—'
  if (minutes < 1) return '<1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder > 0 ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`
}

export function formatSmokingTime(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai',
  })
}

export function toShanghaiTime(value: Date | string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai',
  }).format(typeof value === 'string' ? new Date(value) : value)
}

export function shanghaiDateTimeToIso(date: string, time: string): string | undefined {
  const timestamp = new Date(`${date}T${time}:00+08:00`)
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined
}
