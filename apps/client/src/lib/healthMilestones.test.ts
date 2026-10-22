import { describe, expect, it } from 'vitest'
import { HEALTH_MILESTONES, healthMilestonePhase } from './healthMilestones'

describe('健康参考时间线', () => {
  it('几分钟与数天只提供一般信息，不制造个人恢复达成状态', () => {
    for (const id of ['heart-rate', 'carbon-monoxide']) {
      const item = HEALTH_MILESTONES.find((candidate) => candidate.id === id)!
      expect(item.startDays).toBeUndefined()
      expect(item.endDays).toBeUndefined()
      for (const day of [0, 1, 30, 10_000]) {
        expect(healthMilestonePhase(item, day)).toBe('general')
      }
    }
  })

  it.each([
    ['breathing', 30.4375, 365.25],
    ['heart-attack', 365.25, 730.5],
    ['coronary-excess-risk', 1095.75, 2191.5],
    ['stroke-risk', 1826.25, 3652.5],
    ['oral-pharyngeal-laryngeal-cancer', 1826.25, 3652.5],
    ['lung-cancer', 3652.5, 5478.75],
  ] as const)('%s 保留范围，并正确区分两端的前后时间', (id, start, end) => {
    const item = HEALTH_MILESTONES.find((candidate) => candidate.id === id)!
    expect(item.startDays).toBe(start)
    expect(item.endDays).toBe(end)
    expect(healthMilestonePhase(item, start - 0.001)).toBe('ahead')
    expect(healthMilestonePhase(item, start)).toBe('within')
    expect(healthMilestonePhase(item, (start + end) / 2)).toBe('within')
    expect(healthMilestonePhase(item, end)).toBe('within')
    expect(healthMilestonePhase(item, end + 0.001)).toBe('elapsed')
  })

  it('15 年节点仅判断参考时点是否经过', () => {
    const item = HEALTH_MILESTONES.find((candidate) => candidate.id === 'coronary-long-term')!
    expect(item.startDays).toBe(5478.75)
    expect(item.endDays).toBeUndefined()
    expect(healthMilestonePhase(item, 5478.749)).toBe('ahead')
    expect(healthMilestonePhase(item, 5478.75)).toBe('elapsed')
    expect(healthMilestonePhase(item, 10_000)).toBe('elapsed')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    '无效经过时间 %s 不会被判为已经过',
    (day) => {
      expect(healthMilestonePhase({ startDays: 10, endDays: 20 }, day)).toBe('general')
    },
  )

  it.each([
    {},
    { endDays: 10 },
    { startDays: Number.NaN },
    { startDays: Number.POSITIVE_INFINITY },
    { startDays: -1 },
    { startDays: 20, endDays: 10 },
    { startDays: 10, endDays: Number.NaN },
    { startDays: 10, endDays: Number.POSITIVE_INFINITY },
  ])('无效或未定义窗口仅提供一般信息：%j', (item) => {
    expect(healthMilestonePhase(item, 30)).toBe('general')
  })

  it('固定输入结果确定，窗口内部不产生健康评分或插值百分比', () => {
    const item = Object.freeze({ startDays: 10, endDays: 20 })
    expect([11, 15, 19].map((day) => healthMilestonePhase(item, day)))
      .toEqual(['within', 'within', 'within'])
    expect(healthMilestonePhase(item, 15)).toBe(healthMilestonePhase(item, 15))
    expect(item).toEqual({ startDays: 10, endDays: 20 })
  })

  it('每条群体信息都有唯一标识及已核对的 CDC 来源日期', () => {
    expect(new Set(HEALTH_MILESTONES.map((item) => item.id)).size).toBe(HEALTH_MILESTONES.length)
    for (const item of HEALTH_MILESTONES) {
      expect(new URL(item.sourceUrl).hostname).toBe('www.cdc.gov')
      expect(item.sourcePublishedAt).toMatch(/^2024-(05-15|09-17)$/)
      expect(item.sourceCheckedAt).toBe('2026-10-13')
      expect(item.label).not.toMatch(/已恢复|已达成|恢复进度|\d+%/)
    }
  })
})
