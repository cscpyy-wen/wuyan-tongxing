import { describe, expect, it } from 'vitest'
import type { ClientCigaretteLog } from '../types'
import {
  formatSmokingInterval,
  formatSmokingTime,
  shanghaiDateTimeToIso,
  SMOKING_TRIGGER_OPTIONS,
  summarizeSmokingLogs,
  toShanghaiDate,
  toShanghaiTime,
} from './smokingLogs'

function log(id: string, createdAt: string, trigger: NonNullable<ClientCigaretteLog['trigger']>, cravingIntensity: 1 | 2 | 3 | 4 | 5): ClientCigaretteLog {
  return { id, createdAt, count: 1, trigger, cravingIntensity, source: 'QUICK_LOG' }
}

describe('逐支吸烟统计', () => {
  it('将拉屎作为可记录和统计的独立原因', () => {
    expect(SMOKING_TRIGGER_OPTIONS).toContainEqual({ value: 'toilet', label: '拉屎', shortLabel: '拉屎' })
    const summary = summarizeSmokingLogs([
      log('toilet', '2026-08-24T09:30:00+08:00', 'toilet', 4),
    ], '2026-08-24')
    expect(summary.topReason).toMatchObject({ trigger: 'toilet', label: '拉屎', count: 1, percentage: 100 })
  })

  it('按时间排序后计算次数、频率、原因与烟瘾强度', () => {
    const summary = summarizeSmokingLogs([
      log('three', '2026-08-24T12:30:00+08:00', 'work', 5),
      log('one', '2026-08-24T10:00:00+08:00', 'meal', 2),
      log('two', '2026-08-24T12:00:00+08:00', 'work', 4),
    ], '2026-08-24')

    expect(summary.logs.map((item) => item.id)).toEqual(['one', 'two', 'three'])
    expect(summary.recordedCount).toBe(3)
    expect(summary.averageIntervalMinutes).toBe(75)
    expect(summary.latestIntervalMinutes).toBe(30)
    expect(summary.averageCravingIntensity).toBeCloseTo(11 / 3)
    expect(summary.peakCravingIntensity).toBe(5)
    expect(summary.topReason).toMatchObject({ trigger: 'work', count: 2, percentage: 67 })
    expect(formatSmokingInterval(summary.averageIntervalMinutes)).toBe('1 小时 15 分')
  })

  it('旧版合计记录保留支数但不伪造逐支间隔', () => {
    const summary = summarizeSmokingLogs([
      { id: 'legacy', createdAt: '2026-08-24T18:00:00+08:00', count: 4, source: 'DAILY_CHECKIN' },
      log('new', '2026-08-24T20:00:00+08:00', 'stress', 4),
    ], '2026-08-24')
    expect(summary.recordedCount).toBe(5)
    expect(summary.averageIntervalMinutes).toBeUndefined()
    expect(summary.reasons.find((item) => item.label === '原因未记录')?.count).toBe(4)
  })

  it('系统快捷记录计入支数和间隔，但不伪装成未填写的原因', () => {
    const summary = summarizeSmokingLogs([
      { id: 'tile', createdAt: '2026-08-24T10:00:00+08:00', count: 1, source: 'QUICK_LOG' },
      { id: 'widget', createdAt: '2026-08-24T10:05:00+08:00', count: 1, source: 'QUICK_LOG' },
    ], '2026-08-24')

    expect(summary.recordedCount).toBe(2)
    expect(summary.averageIntervalMinutes).toBe(5)
    expect(summary.reasons).toEqual([])
    expect(summary.topReason).toBeUndefined()
  })

  it('明确以中国标准时间跨日分桶', () => {
    expect(toShanghaiDate('2026-08-24T15:59:59.000Z')).toBe('2026-08-24')
    expect(toShanghaiDate('2026-08-24T16:00:00.000Z')).toBe('2026-08-25')
  })

  it('在设备处于其他时区时仍按北京时间显示和编辑记录', () => {
    const instant = '2026-08-27T21:53:00.000Z'
    expect(formatSmokingTime(instant)).toBe('05:53')
    expect(toShanghaiTime(instant)).toBe('05:53')
    expect(shanghaiDateTimeToIso('2026-08-28', '05:53')).toBe(instant)
  })

  it('同分钟间隔显示为小于一分钟，并如实呈现并列主要原因', () => {
    const summary = summarizeSmokingLogs([
      log('one', '2026-08-24T10:00:10+08:00', 'meal', 3),
      log('two', '2026-08-24T10:00:30+08:00', 'stress', 4),
    ], '2026-08-24')
    expect(formatSmokingInterval(summary.averageIntervalMinutes)).toBe('<1 分钟')
    expect(summary.topReason?.label).toBe('饭后、压力')
    expect(summary.topReason?.trigger).toBeUndefined()
  })

  it('三种以上并列原因使用完整的短摘要', () => {
    const summary = summarizeSmokingLogs([
      log('one', '2026-08-24T10:00:00+08:00', 'meal', 3),
      log('two', '2026-08-24T11:00:00+08:00', 'stress', 3),
      log('three', '2026-08-24T12:00:00+08:00', 'work', 3),
      log('four', '2026-08-24T13:00:00+08:00', 'social', 3),
    ], '2026-08-24')

    expect(summary.topReason?.label).toBe('4 种原因')
    expect(summary.topReason?.trigger).toBeUndefined()
  })
})
