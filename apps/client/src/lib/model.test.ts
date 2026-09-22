import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientLapseEvent, ClientOutcomeAssessment, ClientState, OnboardingPayload } from '../types'
import {
  addDays,
  addMonths,
  adjustClientReductionLimit,
  applyCigaretteLog,
  applyDailyCheckIn,
  applyLapseEvent,
  assessSelfReportedWindow,
  buildClientReductionSchedule,
  canBeginPersonalPlan,
  computeClientProgress,
  createClientPlan,
  createDailyCheckInConfirmation,
  isDailyCheckInConfirmationCurrent,
  createId,
  createInitialState,
  MAX_PREVIOUS_ATTEMPTS,
  resolveCravingEvent,
  parseStoredState,
  parseStoredStateStrict,
  removeDailyCheckIn,
  removeCigaretteLog,
  startNextClientAttempt,
  updateCigaretteLog,
  updateCravingEventLevel,
  updateLapseRecoveryAction,
  validateQuitDate,
  upsertOutcomeAssessment,
} from './model'

afterEach(() => vi.unstubAllGlobals())

const baseline: OnboardingPayload['baseline'] = {
  cigarettesPerDay: 11,
  firstCigaretteMinutes: 30,
  previousAttempts: 2,
  reasons: ['为了健康'],
  triggers: ['stress'],
  pricePerPack: 25,
}

function plannedState(path: OnboardingPayload['path'] = 'abrupt'): ClientState {
  const now = new Date('2026-08-01T08:00:00+08:00')
  const plan = createClientPlan({
    baseline,
    path,
    quitDate: path === 'abrupt' ? '2026-08-08' : '2026-08-15',
  }, now)
  return {
    ...createInitialState(),
    onboarded: true,
    baseline,
    plan,
    settings: { ...createInitialState().settings, sensitiveHealthData: true },
    completedTasks: [{ contentId: 'prep-01', completedAt: '2026-08-02T08:00:00+08:00', attemptId: plan.id }],
    cravings: [{ id: 'craving-1', createdAt: '2026-08-02T08:00:00+08:00', level: 4, attemptId: plan.id }],
  }
}

describe('双路径与日期边界', () => {
  it('同日重开计划不会把此前已吸烟的时段计为新计划无烟时间', () => {
    const base = plannedState()
    const smoked = applyCigaretteLog(base, {
      id: 'before-restart', createdAt: '2026-08-12T19:00:00+08:00', count: 1,
      attemptId: base.plan!.id, source: 'QUICK_LOG',
    })
    const restarted = startNextClientAttempt(smoked, 'abrupt', '2026-08-12', new Date('2026-08-12T20:00:00+08:00'))
    const confirmed = applyDailyCheckIn(restarted, {
      id: 'after-restart', date: '2026-08-12', cigarettesSmoked: 0, cravingPeak: 1,
      smokeFree: true, createdAt: '2026-08-12T20:01:00+08:00', attemptId: restarted.plan!.id,
    })
    const progress = computeClientProgress(confirmed, new Date('2026-08-12T20:01:00+08:00'))
    expect(progress.streakConfirmed).toBe(true)
    expect(progress.currentStreakHours).toBe(0)
  })

  it.each([
    ['abrupt', '2026-07-31'], ['abrupt', '2026-08-16'],
    ['reduction', '2026-08-07'], ['reduction', '2026-08-30'],
  ] as const)('严格恢复拒绝无法安全渲染的%s日期%s', (path, quitDate) => {
    const base = plannedState()
    expect(() => parseStoredStateStrict({ ...base, plan: { ...base.plan, path, quitDate } })).toThrow()
  })

  it.each([
    ['abrupt', '2026-08-01'], ['abrupt', '2026-08-15'],
    ['reduction', '2026-08-08'], ['reduction', '2026-08-29'],
  ] as const)('兼容历史有效%s计划的日期边界%s', (path, quitDate) => {
    const base = plannedState()
    const restored = parseStoredStateStrict({ ...base, plan: { ...base.plan, path, quitDate } })
    expect(() => buildClientReductionSchedule(restored.plan!)).not.toThrow()
  })

  it('日终确认绑定具体记录而非仅绑定支数', () => {
    const base = plannedState()
    const at = new Date('2026-08-12T20:00:00+08:00')
    const state = applyCigaretteLog(base, {
      id: 'one', createdAt: '2026-08-12T19:00:00+08:00', count: 1,
      attemptId: base.plan!.id, source: 'QUICK_LOG',
    })
    const confirmation = createDailyCheckInConfirmation(state, at)!
    expect(isDailyCheckInConfirmationCurrent(state, confirmation, at)).toBe(true)
    const edited = updateCigaretteLog(state, 'one', { smokedAt: '2026-08-12T18:00:00+08:00' })
    expect(isDailyCheckInConfirmationCurrent(edited, confirmation, at)).toBe(false)
    expect(isDailyCheckInConfirmationCurrent(state, confirmation, new Date('2026-08-13T00:00:00+08:00'))).toBe(false)
  })

  it('有逐支记录时不接受更低的过期日终总数', () => {
    const base = plannedState()
    const state = applyCigaretteLog(base, {
      id: 'after-prompt', createdAt: '2026-08-12T19:00:00+08:00', count: 1,
      attemptId: base.plan!.id, source: 'QUICK_LOG',
    })
    expect(applyDailyCheckIn(state, {
      id: 'stale', date: '2026-08-12', cigarettesSmoked: 0, cravingPeak: 1,
      smokeFree: true, createdAt: '2026-08-12T20:00:00+08:00', attemptId: base.plan!.id,
    })).toBe(state)
  })

  it('系统快捷记录允许仅修正时间并保留关联复盘的已有原因和强度', () => {
    const base = plannedState()
    const logged = applyCigaretteLog(base, {
      id: 'system', createdAt: '2026-08-12T19:00:00+08:00', count: 1,
      attemptId: base.plan!.id, source: 'QUICK_LOG',
    })
    const linked = applyLapseEvent(logged, {
      id: 'review', createdAt: '2026-08-12T19:00:00+08:00', cigarettes: 1,
      cigaretteLogId: 'system', attemptId: base.plan!.id, trigger: 'stress', cravingIntensity: 4,
      recoveryAction: '散步',
    })
    const edited = updateCigaretteLog(linked, 'system', { smokedAt: '2026-08-12T18:00:00+08:00' })
    expect(edited.cigarettes[0]).toMatchObject({ createdAt: '2026-08-12T10:00:00.000Z' })
    expect(edited.cigarettes[0]?.trigger).toBeUndefined()
    expect(edited.cigarettes[0]?.cravingIntensity).toBeUndefined()
    expect(edited.lapses[0]).toMatchObject({ trigger: 'stress', cravingIntensity: 4, createdAt: '2026-08-12T10:00:00.000Z' })
    expect(parseStoredStateStrict(edited).cigarettes[0]?.trigger).toBeUndefined()
  })

  it('原因和强度只接受成对补齐且已填写记录不可被清空', () => {
    const base = plannedState()
    const state = applyCigaretteLog(base, {
      id: 'system', createdAt: '2026-08-12T19:00:00+08:00', count: 1,
      attemptId: base.plan!.id, source: 'QUICK_LOG',
    })
    const smokedAt = '2026-08-12T18:00:00+08:00'
    expect(updateCigaretteLog(state, 'system', { smokedAt, trigger: 'stress' })).toBe(state)
    expect(updateCigaretteLog(state, 'system', { smokedAt, cravingIntensity: 3 })).toBe(state)
    const completed = updateCigaretteLog(state, 'system', { smokedAt, trigger: 'stress', cravingIntensity: 3 })
    expect(completed.cigarettes[0]).toMatchObject({ trigger: 'stress', cravingIntensity: 3 })
    expect(updateCigaretteLog(completed, 'system', { smokedAt })).toBe(completed)
  })

  it('直接戒断允许今天至14天，限期减量允许7至28天', () => {
    expect(validateQuitDate('abrupt', '2026-08-01', '2026-08-01')).toBe(true)
    expect(validateQuitDate('abrupt', '2026-08-01', '2026-08-15')).toBe(true)
    expect(validateQuitDate('abrupt', '2026-08-01', '2026-08-16')).toBe(false)
    expect(validateQuitDate('reduction', '2026-08-01', '2026-08-07')).toBe(false)
    expect(validateQuitDate('reduction', '2026-08-01', '2026-08-08')).toBe(true)
    expect(validateQuitDate('reduction', '2026-08-01', '2026-08-29')).toBe(true)
    expect(validateQuitDate('reduction', '2026-08-01', '2026-08-30')).toBe(false)
  })

  it('使用共享领域包生成三阶段75/50/25减量上限', () => {
    const state = plannedState('reduction')
    const stages = buildClientReductionSchedule(state.plan!)
    expect(stages.map((item) => item.ratio)).toEqual([0.75, 0.5, 0.25])
    expect(stages.map((item) => item.dailyLimit)).toEqual([8, 5, 2])
    expect(stages[2]?.to).toBe(addDays(state.plan!.quitDate, -1))
  })

  it('允许用户调整减量上限，同时保持75%阶段不低于50%阶段、50%不低于25%', () => {
    const plan = plannedState('reduction').plan!
    const lowered = adjustClientReductionLimit(plan, 0.75, -1)
    expect(buildClientReductionSchedule(lowered).map((item) => item.dailyLimit)).toEqual([7, 5, 2])

    let bounded = lowered
    for (let index = 0; index < 20; index += 1) bounded = adjustClientReductionLimit(bounded, 0.75, -1)
    expect(bounded.reductionLimits?.stage75).toBe(bounded.reductionLimits?.stage50)
    for (let index = 0; index < 20; index += 1) bounded = adjustClientReductionLimit(bounded, 0.25, 1)
    expect(bounded.reductionLimits?.stage25).toBe(bounded.reductionLimits?.stage50)
  })

  it('当前尝试次数等于既往尝试加一，并覆盖允许边界', () => {
    const now = new Date('2026-08-01T08:00:00+08:00')
    const makePlan = (previousAttempts: number) => createClientPlan({
      baseline: { ...baseline, previousAttempts },
      path: 'abrupt',
      quitDate: '2026-08-08',
    }, now)

    expect(makePlan(0).attemptNumber).toBe(1)
    expect(makePlan(MAX_PREVIOUS_ATTEMPTS).attemptNumber).toBe(MAX_PREVIOUS_ATTEMPTS + 1)
    expect(() => makePlan(-1)).toThrow('既往戒烟尝试次数')
    expect(() => makePlan(MAX_PREVIOUS_ATTEMPTS + 1)).toThrow('既往戒烟尝试次数')
    expect(() => makePlan(1.5)).toThrow('既往戒烟尝试次数')
  })

  it('在 randomUUID 不可用时优先使用平台加密随机源生成标准 UUID', () => {
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        bytes.forEach((_, index) => { bytes[index] = index })
        return bytes
      },
    })
    expect(createId('local')).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
  })
})

describe('资格与滑倒恢复', () => {
  it('未成年人或非当前纸烟用户不能进入个人计划', () => {
    expect(canBeginPersonalPlan({
      adultConfirmed: false,
      currentPaperCigaretteUser: true,
      medicalBoundaryAccepted: true,
      sensitiveHealthDataAccepted: true,
    })).toBe(false)
    expect(canBeginPersonalPlan({
      adultConfirmed: true,
      currentPaperCigaretteUser: false,
      medicalBoundaryAccepted: true,
      sensitiveHealthDataAccepted: true,
    })).toBe(false)
  })

  it('一次滑倒只重算连续计时，不清空累计进展或增加尝试次数', () => {
    const before = plannedState()
    const event: ClientLapseEvent = {
      id: 'lapse-1',
      createdAt: '2026-08-12T12:00:00+08:00',
      cigarettes: 1,
      trigger: 'stress',
      cravingIntensity: 5,
      recoveryAction: '马上做一次烟瘾急救',
      attemptId: before.plan!.id,
    }
    const after = applyLapseEvent(before, event)
    expect(after.plan?.attemptNumber).toBe(before.plan?.attemptNumber)
    expect(after.completedTasks).toEqual(before.completedTasks)
    expect(after.cravings).toEqual(before.cravings)
    expect(after.lapses).toHaveLength(1)
    expect(after.cigarettes[0]?.count).toBe(1)
    expect(after.cigarettes[0]?.cravingIntensity).toBe(5)
    expect(after.lapses[0]?.cigaretteLogId).toBe(after.cigarettes[0]?.id)
    expect(applyLapseEvent(after, event)).toBe(after)
    const snapshot = computeClientProgress(after, new Date('2026-08-13T12:00:00+08:00'))
    expect(snapshot.currentStreakHours).toBe(24)
  })

  it('只修改关联复盘动作，不改写烟支、日终确认或累计进展', () => {
    const before = plannedState()
    const withCheckIn: ClientState = {
      ...before,
      checkIns: [{
        id: 'check-in-before-lapse-edit',
        date: '2026-08-12',
        cigarettesSmoked: 1,
        cravingPeak: 4,
        smokeFree: false,
        createdAt: '2026-08-12T13:00:00+08:00',
        attemptId: before.plan!.id,
      }],
    }
    const withLapse = applyLapseEvent(withCheckIn, {
      id: 'editable-lapse',
      createdAt: '2026-08-12T12:00:00+08:00',
      cigarettes: 1,
      trigger: 'stress',
      cravingIntensity: 4,
      recoveryAction: '马上做一次烟瘾急救',
      attemptId: before.plan!.id,
    })
    const restoredCheckIn = { ...withCheckIn.checkIns[0]! }
    const prepared: ClientState = { ...withLapse, checkIns: [restoredCheckIn] }
    const updated = updateLapseRecoveryAction(prepared, 'editable-lapse', '联系可信赖的支持者')

    expect(updated.lapses[0]?.recoveryAction).toBe('联系可信赖的支持者')
    expect(updated.cigarettes).toEqual(prepared.cigarettes)
    expect(updated.checkIns).toEqual([restoredCheckIn])
    expect(updated.completedTasks).toEqual(prepared.completedTasks)
    expect(updateLapseRecoveryAction(updated, 'editable-lapse', '联系可信赖的支持者')).toBe(updated)
  })

  it('一次逐支确认只新增一个完整事件，重复事件 ID 幂等', () => {
    const before = plannedState()
    const event = {
      id: 'cigarette-one',
      createdAt: '2026-08-12T10:00:00+08:00',
      count: 1,
      trigger: 'work' as const,
      cravingIntensity: 4 as const,
      attemptId: before.plan!.id,
      source: 'QUICK_LOG' as const,
    }
    const once = applyCigaretteLog(before, event)
    const twice = applyCigaretteLog(once, event)
    expect(once.cigarettes).toEqual([event])
    expect(twice.cigarettes).toHaveLength(1)
    expect(once.lastCigaretteAt).toBe('2026-08-12T02:00:00.000Z')
  })

  it('系统一键入口可只记录一支烟和时间，不伪造原因或烟瘾强度', () => {
    const before = plannedState()
    const after = applyCigaretteLog(before, {
      id: 'system-shortcut-cigarette',
      createdAt: '2026-08-12T10:30:00+08:00',
      loggedAt: '2026-08-12T10:30:01+08:00',
      count: 1,
      attemptId: before.plan!.id,
      source: 'QUICK_LOG',
    })

    expect(after.cigarettes).toEqual([expect.objectContaining({
      id: 'system-shortcut-cigarette',
      count: 1,
      attemptId: before.plan!.id,
    })])
    expect(after.cigarettes[0]?.trigger).toBeUndefined()
    expect(after.cigarettes[0]?.cravingIntensity).toBeUndefined()
    expect(after.lastCigaretteAt).toBe('2026-08-12T02:30:00.000Z')
  })

  it('拒绝只有原因或只有烟瘾强度的半完整新记录', () => {
    const before = plannedState()
    const common = {
      createdAt: '2026-08-12T10:31:00+08:00',
      count: 1,
      attemptId: before.plan!.id,
      source: 'QUICK_LOG' as const,
    }
    expect(applyCigaretteLog(before, {
      ...common,
      id: 'half-trigger-only',
      trigger: 'work',
    })).toBe(before)
    expect(applyCigaretteLog(before, {
      ...common,
      id: 'half-intensity-only',
      cravingIntensity: 4,
    })).toBe(before)
  })

  it('已记录的一支烟进入恢复流程时不会重复计数', () => {
    const before = plannedState()
    const logged = applyCigaretteLog(before, {
      id: 'cigarette-for-recovery',
      createdAt: '2026-08-12T10:00:00+08:00',
      count: 1,
      trigger: 'stress',
      cravingIntensity: 5,
      attemptId: before.plan!.id,
      source: 'QUICK_LOG',
    })
    const recovered = applyLapseEvent(logged, {
      id: 'recovery-one',
      createdAt: '2026-08-12T10:00:00+08:00',
      cigarettes: 1,
      trigger: 'stress',
      recoveryAction: '马上做一次烟瘾急救',
      cigaretteLogId: 'cigarette-for-recovery',
      attemptId: before.plan!.id,
    })
    expect(recovered.cigarettes).toHaveLength(1)
    expect(recovered.lapses[0]?.cigaretteLogId).toBe('cigarette-for-recovery')
  })

  it('撤销原子创建的吸烟记录会级联删除滑倒并恢复连续计时，重载仍有效', () => {
    const before = plannedState()
    const withOlderCigarette = applyCigaretteLog(before, {
      id: 'older-before-lapse',
      createdAt: '2026-08-10T10:00:00+08:00',
      count: 1,
      trigger: 'meal',
      cravingIntensity: 3,
      attemptId: before.plan!.id,
      source: 'QUICK_LOG',
    })
    const progressAt = new Date('2026-08-13T12:00:00+08:00')
    const progressBefore = computeClientProgress(withOlderCigarette, progressAt)
    const withLapse = applyLapseEvent(withOlderCigarette, {
      id: 'atomic-lapse-operation',
      createdAt: '2026-08-12T12:00:00+08:00',
      cigarettes: 1,
      trigger: 'stress',
      recoveryAction: '马上做一次烟瘾急救',
      attemptId: before.plan!.id,
    })
    const linkedCigaretteId = withLapse.lapses[0]?.cigaretteLogId

    expect(linkedCigaretteId).toBeTruthy()
    expect(withLapse.cigarettes.map((item) => item.id)).toContain(linkedCigaretteId)
    expect(computeClientProgress(withLapse, progressAt).currentStreakHours).toBe(24)

    const removed = removeCigaretteLog(withLapse, linkedCigaretteId!)
    expect(removed.cigarettes.map((item) => item.id)).toEqual(['older-before-lapse'])
    expect(removed.lapses).toEqual([])
    expect(removed.lastCigaretteAt).toBe('2026-08-10T02:00:00.000Z')
    expect(computeClientProgress(removed, progressAt)).toEqual(progressBefore)

    const reloaded = parseStoredStateStrict(structuredClone(removed))
    expect(reloaded.cigarettes.map((item) => item.id)).toEqual(['older-before-lapse'])
    expect(reloaded.lapses).toEqual([])
    expect(computeClientProgress(reloaded, progressAt)).toEqual(progressBefore)
  })

  it('撤销最新逐支记录后重算最后吸烟时间', () => {
    const before = plannedState()
    const older = applyCigaretteLog(before, {
      id: 'older', createdAt: '2026-08-12T10:00:00+08:00', count: 1,
      trigger: 'meal', cravingIntensity: 3, source: 'QUICK_LOG',
    })
    const newer = applyCigaretteLog(older, {
      id: 'newer', createdAt: '2026-08-12T12:00:00+08:00', count: 1,
      trigger: 'work', cravingIntensity: 4, source: 'QUICK_LOG',
    })
    const removed = removeCigaretteLog(newer, 'newer')
    expect(removed.cigarettes.map((item) => item.id)).toEqual(['older'])
    expect(removed.lastCigaretteAt).toBe('2026-08-12T02:00:00.000Z')
  })

  it('编辑吸烟时间、原因和烟瘾时保留事件 ID 并使当日完整确认失效', () => {
    const base = plannedState()
    const logged = applyCigaretteLog(base, {
      id: 'editable', createdAt: '2026-08-12T10:00:00+08:00', loggedAt: '2026-08-12T10:01:00+08:00',
      count: 1, trigger: 'meal', cravingIntensity: 3, attemptId: base.plan!.id, source: 'QUICK_LOG',
    })
    const confirmed = applyDailyCheckIn(logged, {
      id: 'confirmed', date: '2026-08-12', cigarettesSmoked: 1, cravingPeak: 3, smokeFree: false,
      createdAt: '2026-08-12T22:00:00+08:00', attemptId: base.plan!.id,
    })
    const updated = updateCigaretteLog(confirmed, 'editable', {
      smokedAt: '2026-08-11T21:30:00+08:00', trigger: 'stress', cravingIntensity: 5,
      updatedAt: '2026-08-12T22:05:00+08:00',
    })
    expect(updated.cigarettes[0]).toMatchObject({
      id: 'editable', trigger: 'stress', cravingIntensity: 5,
      createdAt: '2026-08-11T13:30:00.000Z', loggedAt: '2026-08-12T10:01:00+08:00',
    })
    expect(updated.checkIns).toEqual([])
  })

  it('每日小结记录吸烟时保存最后吸烟时间并重算连续时间', () => {
    const before = plannedState()
    const after = applyDailyCheckIn(before, {
      id: 'checkin-smoking',
      date: '2026-08-12',
      cigarettesSmoked: 2,
      cravingPeak: 4,
      smokeFree: false,
      createdAt: '2026-08-12T18:00:00+08:00',
      attemptId: before.plan!.id,
    })

    expect(after.lastCigaretteAt).toBe('2026-08-12T10:00:00.000Z')
    expect(computeClientProgress(after, new Date('2026-08-13T12:00:00+08:00')).currentStreakHours).toBe(18)
  })

  it('撤销每日确认时保留逐支记录并只移除指定尝试和日期', () => {
    const base = plannedState()
    const logged = applyCigaretteLog(base, {
      id: 'kept-cigarette', createdAt: '2026-08-12T10:00:00+08:00', count: 1,
      trigger: 'work', cravingIntensity: 4, attemptId: base.plan!.id, source: 'QUICK_LOG',
    })
    const confirmed = applyDailyCheckIn(logged, {
      id: 'current-confirmation', date: '2026-08-12', cigarettesSmoked: 1, cravingPeak: 4,
      smokeFree: false, createdAt: '2026-08-12T22:00:00+08:00', attemptId: base.plan!.id,
    })
    const withOtherAttempt = {
      ...confirmed,
      checkIns: [...confirmed.checkIns, {
        ...confirmed.checkIns[0]!, id: 'archived-confirmation', attemptId: 'archived-attempt',
      }],
    }

    const removed = removeDailyCheckIn(withOtherAttempt, base.plan!.id, '2026-08-12')
    expect(removed.checkIns.map((item) => item.id)).toEqual(['archived-confirmation'])
    expect(removed.cigarettes.map((item) => item.id)).toEqual(['kept-cigarette'])
    expect(removed.lastCigaretteAt).toBe('2026-08-12T02:00:00.000Z')
  })

  it('逐支记录完整时日终确认不会把确认时刻伪装成最后吸烟时刻', () => {
    const base = plannedState()
    const logged = applyCigaretteLog(base, {
      id: 'exact-cigarette',
      createdAt: '2026-08-12T10:00:00+08:00',
      count: 1,
      trigger: 'work',
      cravingIntensity: 4,
      attemptId: base.plan!.id,
      source: 'QUICK_LOG',
    })
    const confirmed = applyDailyCheckIn(logged, {
      id: 'confirmed-later',
      date: '2026-08-12',
      cigarettesSmoked: 1,
      cravingPeak: 4,
      smokeFree: false,
      createdAt: '2026-08-12T23:00:00+08:00',
      attemptId: base.plan!.id,
    })

    expect(confirmed.lastCigaretteAt).toBe('2026-08-12T02:00:00.000Z')
    expect(computeClientProgress(confirmed, new Date('2026-08-13T12:00:00+08:00')).currentStreakHours).toBe(26)
  })

  it('拒绝小数支数和不存在引用的滑倒事件', () => {
    const before = plannedState()
    const decimal = applyLapseEvent(before, {
      id: 'decimal-lapse',
      createdAt: '2026-08-12T10:00:00+08:00',
      cigarettes: 1.5,
      recoveryAction: '马上做一次烟瘾急救',
      attemptId: before.plan!.id,
    })
    const missingReference = applyLapseEvent(before, {
      id: 'missing-reference',
      createdAt: '2026-08-12T10:00:00+08:00',
      cigarettes: 1,
      recoveryAction: '马上做一次烟瘾急救',
      attemptId: before.plan!.id,
      cigaretteLogId: 'missing-cigarette',
    })

    expect(decimal).toBe(before)
    expect(missingReference).toBe(before)
  })

  it('兼容没有 lastCigaretteAt 的旧快速记烟和旧每日小结', () => {
    const oldQuickLog: ClientState = {
      ...plannedState(),
      cigarettes: [{
        id: 'old-cigarette',
        createdAt: '2026-08-12T10:00:00+08:00',
        count: 1,
      }],
    }
    expect(computeClientProgress(oldQuickLog, new Date('2026-08-13T12:00:00+08:00')).currentStreakHours).toBe(26)

    const oldCheckInBase = plannedState()
    const oldCheckIn: ClientState = {
      ...oldCheckInBase,
      checkIns: [{
        id: 'old-checkin',
        date: '2026-08-12',
        cigarettesSmoked: 1,
        cravingPeak: 3,
        smokeFree: false,
        createdAt: '2026-08-12T20:00:00+08:00',
        attemptId: oldCheckInBase.plan!.id,
      }],
    }
    expect(computeClientProgress(oldCheckIn, new Date('2026-08-13T12:00:00+08:00')).currentStreakHours).toBe(16)
  })

  it('快速记烟时间晚于滑倒时以最后一次真实吸烟为准', () => {
    const stateBase = plannedState()
    const state: ClientState = {
      ...stateBase,
      lastCigaretteAt: '2026-08-12T21:00:00+08:00',
      lapses: [{
        id: 'earlier-lapse',
        createdAt: '2026-08-12T12:00:00+08:00',
        cigarettes: 1,
        recoveryAction: '马上做一次烟瘾急救',
        attemptId: stateBase.plan!.id,
      }],
    }
    expect(computeClientProgress(state, new Date('2026-08-13T12:00:00+08:00')).currentStreakHours).toBe(15)
  })

  it('少吸和节省只累计已经完整结束的自然日', () => {
    const base = plannedState()
    const state: ClientState = {
      ...base,
      cigarettes: [
        { id: 'today', createdAt: '2026-08-13T14:00:00+08:00', count: 1 },
        { id: 'yesterday', createdAt: '2026-08-12T14:00:00+08:00', count: 3 },
      ],
      checkIns: [
        {
          id: 'confirmed-today', date: '2026-08-13', cigarettesSmoked: 1, cravingPeak: 3,
          smokeFree: false, createdAt: '2026-08-13T15:00:00+08:00', attemptId: base.plan!.id,
        },
        {
          id: 'confirmed-yesterday', date: '2026-08-12', cigarettesSmoked: 3, cravingPeak: 3,
          smokeFree: false, createdAt: '2026-08-12T23:00:00+08:00', attemptId: base.plan!.id,
        },
      ],
    }

    const duringToday = computeClientProgress(state, new Date('2026-08-13T15:00:00+08:00'))
    expect(duringToday.cigarettesAvoided).toBe(8)
    expect(duringToday.moneySaved).toBe(10)

    const nextDay = computeClientProgress(state, new Date('2026-08-14T08:00:00+08:00'))
    expect(nextDay.cigarettesAvoided).toBe(18)
    expect(nextDay.moneySaved).toBe(22.5)
  })

  it('没有每日完整确认时不把缺失记录当作少吸或连续戒断成功', () => {
    const state = plannedState()
    const snapshot = computeClientProgress(state, new Date('2026-09-13T12:00:00+08:00'))
    expect(snapshot.knownTrackingDays).toBe(0)
    expect(snapshot.cigarettesAvoided).toBe(0)
    expect(snapshot.moneySaved).toBe(0)
    expect(snapshot.smokeFreeDays).toBe(0)
    expect(snapshot.streakConfirmed).toBe(false)
  })

  it('只确认今天无烟不会把此前漏答的多天算为已确认小时', () => {
    const base = plannedState()
    const today = applyDailyCheckIn(base, {
      id: 'today-only', date: '2026-09-13', cigarettesSmoked: 0, cravingPeak: 1,
      smokeFree: true, createdAt: '2026-09-13T12:00:00+08:00', attemptId: base.plan!.id,
    })
    const progress = computeClientProgress(today, new Date('2026-09-13T12:00:00+08:00'))
    expect(progress.streakConfirmed).toBe(true)
    expect(progress.currentStreakHours).toBe(12)
    expect(progress.smokeFreeDays).toBe(0)
  })

  it('连续已确认窗口遇到漏答日停止，不跨过未知日累计时长', () => {
    let state = plannedState()
    for (const date of ['2026-09-10', '2026-09-12', '2026-09-13']) {
      state = applyDailyCheckIn(state, {
        id: date, date, cigarettesSmoked: 0, cravingPeak: 1, smokeFree: true,
        createdAt: `${date}T12:00:00+08:00`, attemptId: state.plan!.id,
      })
    }
    const progress = computeClientProgress(state, new Date('2026-09-13T12:00:00+08:00'))
    expect(progress.currentStreakHours).toBe(36)
    expect(progress.smokeFreeDays).toBe(1)
  })

  it('更新烟瘾强度和完成练习时只更新原事件', () => {
    const original = [{
      id: 'craving-one',
      createdAt: '2026-08-12T12:00:00+08:00',
      level: 3 as const,
      attemptId: plannedState().plan!.id,
    }]
    const changed = updateCravingEventLevel(original, 'craving-one', 5)
    const resolved = resolveCravingEvent(changed, 'craving-one', 'breathing', 5)

    expect(changed).toHaveLength(1)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({
      id: 'craving-one',
      level: 5,
      technique: 'breathing',
      resolved: true,
    })
  })

  it('明确开始新尝试时归档当前计划并保留累计行动', () => {
    const before = plannedState()
    const after = startNextClientAttempt(before, 'reduction', '2026-08-20', new Date('2026-08-06T08:00:00+08:00'))
    expect(after.plan?.attemptNumber).toBe((before.plan?.attemptNumber ?? 0) + 1)
    expect(after.plan?.path).toBe('reduction')
    expect(after.archivedPlans).toEqual([before.plan])
    expect(after.completedTasks).toEqual(before.completedTasks)
    expect(after.cravings).toEqual(before.cravings)
    expect(computeClientProgress(after, new Date('2026-08-21T08:00:00+08:00')).completedTasks).toBe(0)
  })

  it('新尝试允许更新基线并把价格快照写入新计划', () => {
    const before = plannedState()
    const after = startNextClientAttempt(
      before,
      'abrupt',
      '2026-08-10',
      new Date('2026-08-06T08:00:00+08:00'),
      { cigarettesPerDay: 7, pricePerPack: 31 },
    )
    expect(after.baseline).toMatchObject({ cigarettesPerDay: 7, pricePerPack: 31 })
    expect(after.plan).toMatchObject({ baselineCigarettesPerDay: 7, baselinePricePerPack: 31 })
  })
})

describe('本地状态恢复', () => {
  it('不完整的已入组状态安全回到免登录首次设置，避免永久加载', () => {
    const recovered = parseStoredState({
      ...createInitialState(),
      onboarded: true,
      settings: { ...createInitialState().settings, sensitiveHealthData: true },
    })
    expect(recovered).toEqual(createInitialState())
  })

  it('严格恢复完整保留拉屎原因', () => {
    const valid = plannedState()
    const triggerAt = '2026-08-03T09:30:00+08:00'
    const recovered = parseStoredStateStrict({
      ...valid,
      baseline: { ...valid.baseline!, triggers: ['toilet'] },
      cravings: [{
        id: 'toilet-craving',
        createdAt: triggerAt,
        level: 4,
        trigger: 'toilet',
        attemptId: valid.plan!.id,
      }],
      cigarettes: [{
        id: 'toilet-cigarette',
        createdAt: triggerAt,
        count: 1,
        trigger: 'toilet',
        cravingIntensity: 4,
        attemptId: valid.plan!.id,
        source: 'QUICK_LOG',
      }],
      lapses: [{
        id: 'toilet-lapse',
        createdAt: triggerAt,
        cigarettes: 1,
        trigger: 'toilet',
        cravingIntensity: 4,
        recoveryAction: '重新开始',
        attemptId: valid.plan!.id,
      }],
    })

    expect(recovered.baseline?.triggers).toEqual(['toilet'])
    expect(recovered.cravings[0]?.trigger).toBe('toilet')
    expect(recovered.cigarettes[0]?.trigger).toBe('toilet')
    expect(recovered.lapses[0]?.trigger).toBe('toilet')
  })

  it('丢弃损坏事件并规范化派生字段，不让单条坏记录拖垮客户端', () => {
    const valid = plannedState()
    const recovered = parseStoredState({
      ...valid,
      checkIns: [
        {
          id: 'valid-checkin',
          date: '2026-08-03',
          cigarettesSmoked: 0,
          cravingPeak: 3,
          smokeFree: false,
          createdAt: '2026-08-03T08:00:00+08:00',
        },
        { id: 'broken', createdAt: 'not-a-date' },
      ],
      cigarettes: [null, { id: 'bad-count', createdAt: '2026-08-03T08:00:00Z', count: -1 }],
    })
    expect(recovered.onboarded).toBe(true)
    expect(recovered.checkIns).toHaveLength(1)
    expect(recovered.checkIns[0]?.smokeFree).toBe(true)
    expect(recovered.cigarettes).toEqual([])
  })

  it('把旧版正数每日小结迁移为单条合计记录而不伪造逐支时间', () => {
    const valid = plannedState()
    const recovered = parseStoredState({
      ...valid,
      cigarettes: [],
      checkIns: [{
        id: 'old-total',
        date: '2026-08-03',
        cigarettesSmoked: 7,
        cravingPeak: 4,
        smokeFree: false,
        createdAt: '2026-08-03T20:00:00+08:00',
      }],
    })
    expect(recovered.cigarettes).toHaveLength(1)
    expect(recovered.cigarettes[0]).toMatchObject({ count: 7, source: 'DAILY_CHECKIN' })
  })

  it('旧版正数小结只与同一尝试的同日记录去重并保留原尝试归属', () => {
    const valid = plannedState()
    const currentPlan = valid.plan!
    const archivedPlan = {
      ...currentPlan,
      id: 'plan-archived',
      attemptNumber: currentPlan.attemptNumber - 1,
    }
    const scenarios = [
      { checkInAttemptId: archivedPlan.id, existingAttemptId: currentPlan.id },
      { checkInAttemptId: currentPlan.id, existingAttemptId: archivedPlan.id },
    ]

    scenarios.forEach(({ checkInAttemptId, existingAttemptId }, index) => {
      const checkInId = `legacy-total-${index}`
      const recovered = parseStoredStateStrict({
        ...valid,
        archivedPlans: [archivedPlan],
        checkIns: [{
          id: checkInId,
          date: '2026-08-03',
          cigarettesSmoked: 4,
          cravingPeak: 4,
          smokeFree: false,
          createdAt: '2026-08-03T20:00:00+08:00',
          attemptId: checkInAttemptId,
        }],
        cigarettes: [{
          id: `other-attempt-${index}`,
          createdAt: '2026-08-03T09:00:00+08:00',
          count: 1,
          attemptId: existingAttemptId,
          source: 'QUICK_LOG',
        }],
      })

      expect(recovered.cigarettes).toContainEqual(expect.objectContaining({
        id: `daily-checkin-${checkInId}`,
        count: 4,
        attemptId: checkInAttemptId,
        source: 'DAILY_CHECKIN',
      }))
    })
  })

  it('migrates large paired check-in and cigarette collections in linear time', () => {
    const valid = plannedState()
    const size = 10_000
    const start = Date.UTC(2000, 0, 1, 4)
    const pairs = Array.from({ length: size }, (_, index) => {
      const createdAt = new Date(start + index * 86_400_000).toISOString()
      return {
        date: createdAt.slice(0, 10),
        createdAt,
      }
    })
    const candidate = {
      ...valid,
      checkIns: pairs.map((item, index) => ({
        id: `scale-checkin-${index}`,
        date: item.date,
        cigarettesSmoked: 1,
        cravingPeak: 2,
        smokeFree: false,
        createdAt: item.createdAt,
        attemptId: valid.plan!.id,
      })),
      cigarettes: pairs.map((item, index) => ({
        id: `scale-cigarette-${index}`,
        createdAt: item.createdAt,
        count: 1,
        attemptId: valid.plan!.id,
      })),
    }

    const started = performance.now()
    const recovered = parseStoredStateStrict(candidate)
    const elapsed = performance.now() - started

    expect(recovered.cigarettes).toHaveLength(size)
    expect(elapsed).toBeLessThan(2_000)
  })

  it('可选云处理缺少单独同意时间时保持关闭', () => {
    const valid = plannedState()
    const recovered = parseStoredState({
      ...valid,
      settings: {
        ...valid.settings,
        cloudSync: true,
        outcomeAnalytics: true,
      },
    })
    expect(recovered.settings.cloudSync).toBe(false)
    expect(recovered.settings.outcomeAnalytics).toBe(false)
  })

  it('旧任务和事件缺少 attemptId 时仍迁移到当前尝试作用域', () => {
    const valid = plannedState()
    const recovered = parseStoredState({
      ...valid,
      checkIns: [{
        id: 'legacy-checkin',
        date: '2026-08-02',
        cigarettesSmoked: 0,
        cravingPeak: 3,
        createdAt: '2026-08-02T20:00:00+08:00',
      }],
      completedTasks: [{ contentId: 'prep-01', completedAt: '2026-08-02T08:00:00+08:00' }],
      cravings: [{ id: 'legacy-craving', createdAt: '2026-08-02T08:00:00+08:00', level: 4 }],
      cigarettes: [{ id: 'legacy-cigarette', createdAt: '2026-08-02T09:00:00+08:00', count: 1 }],
      lapses: [{
        id: 'legacy-lapse',
        createdAt: '2026-08-02T09:00:00+08:00',
        cigarettes: 1,
        recoveryAction: '重新开始',
      }],
    })
    expect(recovered.checkIns[0]?.attemptId).toBe(valid.plan!.id)
    expect(recovered.completedTasks[0]?.attemptId).toBe(valid.plan!.id)
    expect(recovered.cravings[0]?.attemptId).toBe(valid.plan!.id)
    expect(recovered.cigarettes[0]?.attemptId).toBe(valid.plan!.id)
    expect(recovered.lapses[0]?.attemptId).toBe(valid.plan!.id)
  })

  it('只为唯一精确匹配的旧 LAPSE_FLOW 孤儿补引用，歧义和无匹配历史原样保留', () => {
    const valid = plannedState()
    const attemptId = valid.plan!.id
    const exactTime = '2026-08-03T09:00:00+08:00'
    const ambiguousTime = '2026-08-04T09:00:00+08:00'
    const unmatchedTime = '2026-08-05T09:00:00+08:00'
    const recovered = parseStoredStateStrict({
      ...valid,
      cigarettes: [
        { id: 'exact-cigarette', createdAt: exactTime, count: 1, trigger: 'stress', attemptId, source: 'LAPSE_FLOW' },
        { id: 'ambiguous-cigarette-a', createdAt: ambiguousTime, count: 1, attemptId, source: 'LAPSE_FLOW' },
        { id: 'ambiguous-cigarette-b', createdAt: ambiguousTime, count: 1, attemptId, source: 'LAPSE_FLOW' },
      ],
      lapses: [
        { id: 'exact-lapse', createdAt: exactTime, cigarettes: 1, trigger: 'stress', recoveryAction: '重新开始', attemptId },
        { id: 'ambiguous-lapse', createdAt: ambiguousTime, cigarettes: 1, recoveryAction: '重新开始', attemptId },
        { id: 'unmatched-lapse', createdAt: unmatchedTime, cigarettes: 1, recoveryAction: '重新开始', attemptId },
      ],
    })

    expect(recovered.lapses.find((item) => item.id === 'exact-lapse')?.cigaretteLogId).toBe('exact-cigarette')
    expect(recovered.lapses.find((item) => item.id === 'ambiguous-lapse')?.cigaretteLogId).toBeUndefined()
    expect(recovered.lapses.find((item) => item.id === 'unmatched-lapse')?.cigaretteLogId).toBeUndefined()
    expect(recovered.lapses).toHaveLength(3)
    expect(computeClientProgress(recovered, new Date('2026-08-06T09:00:00+08:00')).lastRecordedCigaretteAt)
      .toBe(new Date(unmatchedTime).toISOString())
  })

  it('以线性时间处理上限数量且完全同键的旧滑倒记录', () => {
    const valid = plannedState()
    const size = 50_000
    const attemptId = valid.plan!.id
    const createdAt = '2026-08-03T09:00:00+08:00'
    const candidate = {
      ...valid,
      cigarettes: Array.from({ length: size }, (_, index) => ({
        id: `same-key-cigarette-${index}`,
        createdAt,
        count: 1,
        trigger: 'stress' as const,
        attemptId,
        source: 'LAPSE_FLOW' as const,
      })),
      lapses: Array.from({ length: size }, (_, index) => ({
        id: `same-key-lapse-${index}`,
        createdAt,
        cigarettes: 1,
        trigger: 'stress' as const,
        recoveryAction: '重新开始',
        attemptId,
      })),
    }

    const started = performance.now()
    const recovered = parseStoredStateStrict(candidate)
    const elapsed = performance.now() - started

    expect(recovered.lapses).toHaveLength(size)
    expect(recovered.lapses.every((item) => item.cigaretteLogId === undefined)).toBe(true)
    expect(elapsed).toBeLessThan(5_000)
  })

  it('严格导入拒绝超过60支及不存在逐支引用的滑倒记录', () => {
    const valid = plannedState()
    const tooMany = {
      ...valid,
      lapses: [{
        id: 'too-many',
        createdAt: '2026-08-03T08:00:00+08:00',
        cigarettes: 61,
        recoveryAction: '重新开始',
        attemptId: valid.plan!.id,
      }],
    }
    const missingReference = {
      ...valid,
      lapses: [{
        id: 'missing-reference',
        createdAt: '2026-08-03T08:00:00+08:00',
        cigarettes: 1,
        recoveryAction: '重新开始',
        cigaretteLogId: 'not-found',
        attemptId: valid.plan!.id,
      }],
    }

    expect(() => parseStoredStateStrict(tooMany)).toThrow('本机记录包含无法识别的项目')
    expect(() => parseStoredStateStrict(missingReference)).toThrow('本机记录包含无法识别的项目')
    expect(parseStoredState(tooMany).lapses).toEqual([])
    expect(parseStoredState(missingReference).lapses).toEqual([])
  })

  it('严格导入拒绝所有跨集合中显式写入的未知计划引用', () => {
    const valid = plannedState()
    const unknownAttemptId = 'missing-plan-id'
    const candidates = [
      {
        ...valid,
        checkIns: [{
          id: 'unknown-checkin',
          date: '2026-08-03',
          cigarettesSmoked: 0,
          cravingPeak: 3,
          createdAt: '2026-08-03T20:00:00+08:00',
          attemptId: unknownAttemptId,
        }],
      },
      {
        ...valid,
        cravings: [{
          id: 'unknown-craving',
          createdAt: '2026-08-03T08:00:00+08:00',
          level: 4,
          attemptId: unknownAttemptId,
        }],
      },
      {
        ...valid,
        cigarettes: [{
          id: 'unknown-cigarette',
          createdAt: '2026-08-03T08:00:00+08:00',
          count: 1,
          attemptId: unknownAttemptId,
          source: 'QUICK_LOG',
        }],
      },
      {
        ...valid,
        lapses: [{
          id: 'unknown-lapse',
          createdAt: '2026-08-03T08:00:00+08:00',
          cigarettes: 1,
          recoveryAction: '重新开始',
          attemptId: unknownAttemptId,
        }],
      },
      {
        ...valid,
        completedTasks: [{
          contentId: 'unknown-task',
          completedAt: '2026-08-03T08:00:00+08:00',
          attemptId: unknownAttemptId,
        }],
      },
      {
        ...valid,
        outcomes: [{
          id: 'unknown-outcome',
          planId: unknownAttemptId,
          dueMonth: 3,
          assessedAt: '2026-11-03T08:00:00+08:00',
          sevenDayAbstinent: null,
          thirtyDayAbstinent: null,
          continuouslyAbstinent: null,
          currentCigarettesPerDay: null,
          additionalQuitAttempts: null,
          confidence: null,
          usedProfessionalSupport: null,
          selfReported: true,
          biochemicallyVerified: false,
        }],
      },
    ]

    candidates.forEach((candidate) => {
      expect(() => parseStoredStateStrict(candidate)).toThrow('本机记录包含无法识别的项目')
    })
  })

  it.each([
    '2026-02-30T12:00:00+08:00',
    '2026-08-28T12:00:00',
    '2026-13-01T12:00:00Z',
    '2026-08-28T24:00:00Z',
    '2026-08-28T12:00:00+24:00',
  ])('严格导入拒绝非真实或无明确时区的时间戳 %s', (createdAt) => {
    const valid = plannedState()
    expect(() => parseStoredStateStrict({
      ...valid,
      cravings: [{ ...valid.cravings[0]!, createdAt }],
    })).toThrow('本机记录包含无法识别的项目')
  })

  it('严格导入逐一拒绝每个集合关键字段中的不存在日期', () => {
    const valid = plannedState()
    const badTimestamp = '2026-02-30T12:00:00+08:00'
    const archivedPlan = {
      ...valid.plan!,
      id: 'archived-for-time-test',
      attemptNumber: valid.plan!.attemptNumber - 1,
    }
    const candidates: Array<[string, unknown]> = [
      ['plan.createdAt', { ...valid, plan: { ...valid.plan!, createdAt: badTimestamp } }],
      ['archivedPlans.createdAt', { ...valid, archivedPlans: [{ ...archivedPlan, createdAt: badTimestamp }] }],
      ['checkIns.createdAt', {
        ...valid,
        checkIns: [{
          id: 'bad-time-checkin', date: '2026-08-03', cigarettesSmoked: 0, cravingPeak: 3,
          createdAt: badTimestamp, attemptId: valid.plan!.id,
        }],
      }],
      ['cravings.createdAt', {
        ...valid,
        cravings: [{ ...valid.cravings[0]!, createdAt: badTimestamp }],
      }],
      ['cigarettes.createdAt', {
        ...valid,
        cigarettes: [{
          id: 'bad-time-cigarette', createdAt: badTimestamp, count: 1,
          attemptId: valid.plan!.id, source: 'QUICK_LOG',
        }],
      }],
      ['cigarettes.loggedAt', {
        ...valid,
        cigarettes: [{
          id: 'bad-logged-at', createdAt: '2026-08-03T08:00:00+08:00', loggedAt: badTimestamp,
          count: 1, attemptId: valid.plan!.id, source: 'QUICK_LOG',
        }],
      }],
      ['cigarettes.updatedAt', {
        ...valid,
        cigarettes: [{
          id: 'bad-updated-at', createdAt: '2026-08-03T08:00:00+08:00', updatedAt: badTimestamp,
          count: 1, attemptId: valid.plan!.id, source: 'QUICK_LOG',
        }],
      }],
      ['lapses.createdAt', {
        ...valid,
        lapses: [{
          id: 'bad-time-lapse', createdAt: badTimestamp, cigarettes: 1,
          recoveryAction: '重新开始', attemptId: valid.plan!.id,
        }],
      }],
      ['outcomes.assessedAt', {
        ...valid,
        outcomes: [{
          id: 'bad-time-outcome', planId: valid.plan!.id, dueMonth: 3, assessedAt: badTimestamp,
          sevenDayAbstinent: null, thirtyDayAbstinent: null, continuouslyAbstinent: null,
          currentCigarettesPerDay: null, additionalQuitAttempts: null, confidence: null,
          usedProfessionalSupport: null, selfReported: true, biochemicallyVerified: false,
        }],
      }],
      ['completedTasks.completedAt', {
        ...valid,
        completedTasks: [{ ...valid.completedTasks[0]!, completedAt: badTimestamp }],
      }],
    ]

    candidates.forEach(([field, candidate]) => {
      expect(() => parseStoredStateStrict(candidate), field).toThrow()
    })
  })

  it('严格导入拒绝显式存在但无效的可选 lastCigaretteAt', () => {
    const valid = plannedState()
    expect(() => parseStoredStateStrict({
      ...valid,
      lastCigaretteAt: '2026-08-28T12:00:00',
    })).toThrow('本机记录包含无法识别的项目')
  })

  it('带偏移 RFC3339 时间戳的严格读取不受进程时区影响', () => {
    const previousTimezone = process.env.TZ
    const valid = plannedState()
    const createdAt = '2026-08-28T12:34:56.123456789+08:00'
    try {
      for (const timezone of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
        process.env.TZ = timezone
        const recovered = parseStoredStateStrict({
          ...valid,
          cravings: [{ ...valid.cravings[0]!, createdAt }],
        })
        expect(recovered.cravings[0]?.createdAt).toBe(createdAt)
        expect(() => parseStoredStateStrict({
          ...valid,
          cravings: [{ ...valid.cravings[0]!, createdAt: '2026-08-28T12:34:56' }],
        })).toThrow('本机记录包含无法识别的项目')
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimezone
    }
  })

  it.each([
    'archivedPlans',
    'checkIns',
    'cravings',
    'cigarettes',
    'lapses',
    'outcomes',
    'completedTasks',
  ] as const)('严格读取拒绝已存在但不是数组的 %s 容器', (field) => {
    const valid = plannedState()
    expect(() => parseStoredStateStrict({
      ...valid,
      [field]: 'not-an-array',
    })).toThrow('本机记录集合格式无法识别')
  })

  it('严格读取拒绝各身份集合中的重复 ID', () => {
    const valid = plannedState()
    const plan = valid.plan!
    const archivedPlan = { ...plan, id: 'plan-archived', attemptNumber: plan.attemptNumber + 1 }
    const checkIn = {
      id: 'check-in-1',
      date: '2026-08-03',
      cigarettesSmoked: 0,
      cravingPeak: 3 as const,
      smokeFree: true,
      createdAt: '2026-08-03T20:00:00+08:00',
      attemptId: plan.id,
    }
    const cigarette = {
      id: 'cigarette-1',
      createdAt: '2026-08-03T08:00:00+08:00',
      count: 1,
      attemptId: plan.id,
      source: 'QUICK_LOG' as const,
    }
    const lapse = {
      id: 'lapse-1',
      createdAt: cigarette.createdAt,
      cigarettes: 1,
      recoveryAction: '重新开始',
      attemptId: plan.id,
    }
    const outcome: ClientOutcomeAssessment = {
      id: 'outcome-1',
      planId: plan.id,
      dueMonth: 3,
      assessedAt: '2026-11-03T08:00:00+08:00',
      sevenDayAbstinent: null,
      thirtyDayAbstinent: null,
      continuouslyAbstinent: null,
      currentCigarettesPerDay: null,
      additionalQuitAttempts: null,
      confidence: null,
      usedProfessionalSupport: null,
      selfReported: true,
      biochemicallyVerified: false,
    }
    const duplicateCandidates = [
      { ...valid, archivedPlans: [archivedPlan, { ...archivedPlan }] },
      { ...valid, checkIns: [checkIn, { ...checkIn }] },
      { ...valid, cravings: [valid.cravings[0]!, { ...valid.cravings[0]! }] },
      { ...valid, cigarettes: [cigarette, { ...cigarette }] },
      { ...valid, lapses: [lapse, { ...lapse }] },
      { ...valid, outcomes: [outcome, { ...outcome }] },
    ]

    duplicateCandidates.forEach((candidate) => {
      expect(() => parseStoredStateStrict(candidate)).toThrow('本机记录包含重复项目')
    })
    expect(parseStoredState(duplicateCandidates[3])).toEqual(createInitialState())
  })

  it('严格读取拒绝会让更新语义产生歧义的重复业务键', () => {
    const valid = plannedState()
    const plan = valid.plan!
    const checkIn = {
      id: 'check-in-1',
      date: '2026-08-03',
      cigarettesSmoked: 0,
      cravingPeak: 3 as const,
      smokeFree: true,
      createdAt: '2026-08-03T20:00:00+08:00',
      attemptId: plan.id,
    }
    const cigarette = {
      id: 'cigarette-1',
      createdAt: '2026-08-03T08:00:00+08:00',
      count: 1,
      attemptId: plan.id,
      source: 'QUICK_LOG' as const,
    }
    const lapse = {
      id: 'lapse-1',
      createdAt: cigarette.createdAt,
      cigarettes: 1,
      recoveryAction: '重新开始',
      cigaretteLogId: cigarette.id,
      attemptId: plan.id,
    }
    const outcome: ClientOutcomeAssessment = {
      id: 'outcome-1',
      planId: plan.id,
      dueMonth: 3,
      assessedAt: '2026-11-03T08:00:00+08:00',
      sevenDayAbstinent: null,
      thirtyDayAbstinent: null,
      continuouslyAbstinent: null,
      currentCigarettesPerDay: null,
      additionalQuitAttempts: null,
      confidence: null,
      usedProfessionalSupport: null,
      selfReported: true,
      biochemicallyVerified: false,
    }
    const duplicateBusinessKeys = [
      { ...valid, checkIns: [checkIn, { ...checkIn, id: 'check-in-2' }] },
      {
        ...valid,
        cigarettes: [cigarette],
        lapses: [lapse, { ...lapse, id: 'lapse-2' }],
      },
      { ...valid, outcomes: [outcome, { ...outcome, id: 'outcome-2' }] },
      {
        ...valid,
        completedTasks: [valid.completedTasks[0]!, {
          ...valid.completedTasks[0]!,
          completedAt: '2026-08-03T08:00:00+08:00',
        }],
      },
      { ...valid, archivedPlans: [{ ...plan }] },
      {
        ...valid,
        archivedPlans: [{ ...plan, id: 'plan-archived' }],
      },
    ]

    duplicateBusinessKeys.forEach((candidate) => {
      expect(() => parseStoredStateStrict(candidate)).toThrow('本机记录包含重复项目')
    })
  })

  it('严格读取在旧版每日汇总迁移后再次校验生成 ID 冲突', () => {
    const valid = plannedState()
    const checkIn = {
      id: 'legacy-total',
      date: '2026-08-03',
      cigarettesSmoked: 2,
      cravingPeak: 3,
      smokeFree: false,
      createdAt: '2026-08-03T20:00:00+08:00',
      attemptId: valid.plan!.id,
    }
    const collidingCigarette = {
      id: `daily-checkin-${checkIn.id}`,
      createdAt: '2026-08-02T08:00:00+08:00',
      count: 1,
      attemptId: valid.plan!.id,
      source: 'QUICK_LOG',
    }

    expect(() => parseStoredStateStrict({
      ...valid,
      checkIns: [checkIn],
      cigarettes: [collidingCigarette],
    })).toThrow('本机记录包含重复项目')
  })

  it('严格读取仍允许旧版 version-1 快照缺少后加入的数组字段', () => {
    const valid = plannedState()
    const { archivedPlans: _archivedPlans, ...legacy } = valid
    expect(parseStoredStateStrict(legacy).archivedPlans).toEqual([])
  })
})

describe('自报结局', () => {
  it('漏答保持未知，不当作0支或成功', () => {
    expect(assessSelfReportedWindow(plannedState(), 7, new Date('2026-08-20T12:00:00+08:00'))).toBe('unknown')
  })

  it('按自然月计算3/6/12月随访日期并处理月末', () => {
    expect(addMonths('2026-01-31', 3)).toBe('2026-04-30')
    expect(addMonths('2026-01-31', 6)).toBe('2026-07-31')
    expect(addMonths('2026-01-31', 12)).toBe('2027-01-31')
  })

  it('同一计划同一随访月更新而不重复，未知按null保存', () => {
    const original: ClientOutcomeAssessment = {
      id: 'outcome-1',
      planId: 'plan-1',
      dueMonth: 3,
      assessedAt: '2026-11-01T08:00:00+08:00',
      sevenDayAbstinent: null,
      thirtyDayAbstinent: true,
      continuouslyAbstinent: null,
      currentCigarettesPerDay: null,
      additionalQuitAttempts: null,
      confidence: null,
      usedProfessionalSupport: null,
      selfReported: true,
      biochemicallyVerified: false,
    }
    const updated: ClientOutcomeAssessment = {
      ...original,
      id: 'outcome-2',
      assessedAt: '2026-11-02T08:00:00+08:00',
      sevenDayAbstinent: true,
    }
    const sixMonth: ClientOutcomeAssessment = {
      ...original,
      id: 'outcome-3',
      dueMonth: 6,
      assessedAt: '2027-02-01T08:00:00+08:00',
    }
    const result = upsertOutcomeAssessment([original, sixMonth], updated)
    expect(result).toHaveLength(2)
    expect(result.find((item) => item.dueMonth === 3)?.id).toBe('outcome-2')
    expect(result.find((item) => item.dueMonth === 3)?.currentCigarettesPerDay).toBeNull()
    expect(result.find((item) => item.dueMonth === 6)?.id).toBe('outcome-3')
  })
})
