import { describe, expect, it } from 'vitest'
import type { ClientQuitPlan } from '../types'
import { getTodayContent, toShanghaiRuleTimeBucket } from './shared'

const plan = (quitDate: string): ClientQuitPlan => ({
  id: '11111111-1111-4111-8111-111111111111',
  path: 'abrupt',
  createdAt: '2026-08-01T08:00:00+08:00',
  quitDate,
  baselineCigarettesPerDay: 10,
  baselinePricePerPack: 25,
  attemptNumber: 1,
})

describe('日期课程', () => {
  it('按日期提供准备期7模块、28天课程和第5至8周巩固模块', () => {
    const quitDate = '2026-08-08'
    const cases = [
      ['2026-08-01T12:00:00+08:00', 'prep-01'],
      ['2026-08-07T12:00:00+08:00', 'prep-07'],
      ['2026-08-08T12:00:00+08:00', 'day-01'],
      ['2026-09-04T12:00:00+08:00', 'day-28'],
      ['2026-09-05T12:00:00+08:00', 'maintenance-week-05'],
      ['2026-09-12T12:00:00+08:00', 'maintenance-week-06'],
      ['2026-09-19T12:00:00+08:00', 'maintenance-week-07'],
      ['2026-09-26T12:00:00+08:00', 'maintenance-week-08'],
    ] as const

    for (const [at, expected] of cases) {
      expect(getTodayContent(plan(quitDate), new Date(at)).id).toBe(expected)
    }
  })

  it('压力与社交 SUPPORT_CARD 不覆盖第1天和第28天主课程', () => {
    const quitDate = '2026-08-08'
    expect(getTodayContent(
      plan(quitDate),
      new Date('2026-08-08T12:00:00+08:00'),
      undefined,
      false,
      60,
      ['stress'],
    ).id).toBe('day-01')
    expect(getTodayContent(
      plan(quitDate),
      new Date('2026-09-04T12:00:00+08:00'),
      undefined,
      false,
      60,
      ['social'],
    ).id).toBe('day-28')
  })
})

describe('规则时段采用北京时间', () => {
  it.each([
    ['2026-08-28T02:59:00Z', 'MORNING'],
    ['2026-08-28T03:00:00Z', 'MIDDAY'],
    ['2026-08-28T06:00:00Z', 'EVENING'],
    ['2026-08-28T11:00:00Z', 'NIGHT'],
  ] as const)('%s -> %s', (timestamp, expected) => {
    expect(toShanghaiRuleTimeBucket(new Date(timestamp))).toBe(expected)
  })

  it('拒绝无效时间', () => {
    expect(() => toShanghaiRuleTimeBucket(new Date(Number.NaN))).toThrow('规则时间无效')
  })
})
