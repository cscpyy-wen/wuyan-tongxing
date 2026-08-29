import { describe, expect, it } from 'vitest'
import type { DailyCheckIn, QuitPlan } from '@wuyan/contracts'
import {
  assessPointPrevalence,
  buildReductionSchedule,
  computeProgress,
  createQuitPlan,
  daysBetween,
  getProgramDay,
  getQuitPhase,
  restartAfterLapse,
} from './index'

const PLAN_ID = '11111111-1111-4111-8111-111111111111'
const ATTEMPT_ID = PLAN_ID

function abruptPlan(): QuitPlan {
  return createQuitPlan({
    id: PLAN_ID,
    strategy: 'ABRUPT',
    startDate: '2026-08-20',
    quitDate: '2026-08-23',
    baselineCigarettesPerDay: 20,
    pricePerPackCny: 40,
    now: new Date('2026-08-20T00:00:00.000Z'),
  })
}

function checkIn(date: string, cigarettesSmoked: number, idSuffix: string): DailyCheckIn {
  return {
    id: `22222222-2222-4222-8222-2222222222${idSuffix}`,
    attemptId: ATTEMPT_ID,
    date,
    cigarettesSmoked,
    cravingIntensity: 4,
    mood: 'NEUTRAL',
    triggers: [],
    taskCompleted: true,
    recordedAt: `${date}T12:00:00.000+08:00`,
  }
}

describe('date and plan logic', () => {
  it('handles leap-day boundaries without local timezone drift', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2)
    expect(() => daysBetween('2026-02-30', '2026-03-01')).toThrow('无效日期')
    expect(() => daysBetween('2026-13-01', '2027-01-01')).toThrow('无效日期')
  })

  it('builds three reduction stages and reaches zero on quit day', () => {
    const targets = buildReductionSchedule('2026-08-23', '2026-09-06', 20)
    expect(targets).toHaveLength(15)
    expect(targets[0]).toMatchObject({ maximumCigarettes: 15, ratio: 0.75 })
    expect(targets.at(-1)).toEqual({ date: '2026-09-06', maximumCigarettes: 0, ratio: 0 })
    expect(new Set(targets.map((item) => item.ratio))).toEqual(new Set([0.75, 0.5, 0.25, 0]))
  })

  it('uses quit day as program day one and day 28 as the last active day', () => {
    const plan = abruptPlan()
    expect(getQuitPhase(plan, '2026-08-22')).toBe('PREPARATION')
    expect(getQuitPhase(plan, '2026-08-23')).toBe('QUIT_DAY')
    expect(getProgramDay(plan, '2026-08-23')).toBe(1)
    expect(getProgramDay(plan, '2026-09-19')).toBe(28)
    expect(getQuitPhase(plan, '2026-09-20')).toBe('MAINTENANCE')
  })

  it('validates plan boundaries without loading the contracts Zod runtime', () => {
    expect(() => createQuitPlan({
      id: PLAN_ID,
      attemptNumber: 0,
      strategy: 'ABRUPT',
      startDate: '2026-08-20',
      quitDate: '2026-08-23',
      baselineCigarettesPerDay: 20,
    })).toThrow('尝试次数')
    expect(() => createQuitPlan({
      id: 'not-a-uuid',
      strategy: 'ABRUPT',
      startDate: '2026-08-20',
      quitDate: '2026-08-23',
      baselineCigarettesPerDay: 20,
    })).toThrow('UUID')
  })
})

describe('progress and outcomes', () => {
  it('keeps cumulative gains while restarting the current smoke-free clock after a lapse', () => {
    const plan = abruptPlan()
    const result = computeProgress({
      plan,
      checkIns: [checkIn('2026-08-23', 0, '01'), checkIn('2026-08-24', 1, '02')],
      cigaretteLogs: [{
        id: '33333333-3333-4333-8333-333333333333',
        attemptId: ATTEMPT_ID,
        smokedAt: '2026-08-24T10:00:00.000+08:00',
        trigger: 'STRESS',
        source: 'LAPSE_FLOW',
      }],
      tasks: [{ taskId: 'day-01', attemptId: ATTEMPT_ID, status: 'COMPLETED', completedAt: '2026-08-23T12:00:00.000+08:00' }],
      now: new Date('2026-08-25T02:00:00.000Z'),
    })
    expect(result.currentSmokeFreeMilliseconds).toBe(24 * 60 * 60 * 1000)
    expect(result.avoidedCigarettes).toBe(39)
    expect(result.estimatedSavingsCny).toBe(78)
    expect(result.completedTasks).toBe(1)
  })

  it('returns unknown when any day in the point-prevalence window is missing', () => {
    const sixKnownDays = Array.from({ length: 6 }, (_, index) =>
      checkIn(`2026-08-${String(18 + index).padStart(2, '0')}`, 0, String(10 + index)),
    )
    expect(assessPointPrevalence(sixKnownDays, '2026-08-23', 7)).toBeNull()
  })

  it('distinguishes abstinence from a known lapse', () => {
    const sevenDays = Array.from({ length: 7 }, (_, index) =>
      checkIn(`2026-08-${String(17 + index).padStart(2, '0')}`, index === 2 ? 1 : 0, String(20 + index)),
    )
    expect(assessPointPrevalence(sevenDays, '2026-08-23', 7)).toBe(false)
  })

  it('archives the previous attempt without deleting its history', () => {
    const restarted = restartAfterLapse({
      previousPlan: abruptPlan(),
      newPlanId: '44444444-4444-4444-8444-444444444444',
      strategy: 'ABRUPT',
      startDate: '2026-08-25',
      quitDate: '2026-08-25',
      now: new Date('2026-08-25T00:00:00.000Z'),
    })
    expect(restarted.archivedPlan.status).toBe('ARCHIVED')
    expect(restarted.newPlan.attemptNumber).toBe(2)
    expect(restarted.newPlan.status).toBe('ACTIVE')
  })
})
