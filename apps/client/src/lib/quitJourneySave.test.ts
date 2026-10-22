import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientState } from '../types'
import type { AndroidBootstrapCigarette, AndroidBootstrapStorage } from './androidBootstrapQueue'
import { createClientPlan, createInitialState } from './model'
import type { QuitJourneyInput } from './quitJourney'
import { saveQuitJourneyAfterQueue } from './quitJourneySave'

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  isNativeAndroidApp: vi.fn(),
  getStorage: vi.fn(),
  readBootstrap: vi.fn(),
  readSystem: vi.fn(),
  readQuarantine: vi.fn(),
}))

vi.mock('@tarojs/taro', () => ({ default: { showToast: mocks.showToast } }))
vi.mock('./runtime', () => ({ isNativeAndroidApp: mocks.isNativeAndroidApp }))
vi.mock('./androidHealthStorage', () => ({ getAndroidHealthStorage: mocks.getStorage }))
vi.mock('./androidBootstrapQueue', () => ({
  readAndroidBootstrapQueue: mocks.readBootstrap,
  readAndroidSystemShortcutQueue: mocks.readSystem,
  readAndroidBootstrapQuarantine: mocks.readQuarantine,
}))

const NOW = new Date('2026-09-05T12:00:00+08:00')
const START = '2026-09-02T12:00:00+08:00'
const EARLIER = '2026-09-01T10:00:00+08:00'

function sensitiveState(): ClientState {
  const initial = createInitialState()
  const baseline = {
    cigarettesPerDay: 10, pricePerPack: 25, firstCigaretteMinutes: 30,
    previousAttempts: 1, reasons: ['私人健康原因'], triggers: ['stress' as const],
  }
  const plan = {
    ...createClientPlan({ baseline, path: 'abrupt', quitDate: '2026-09-02' }, new Date(EARLIER)),
    id: 'current-attempt', attemptNumber: 2,
  }
  return {
    ...initial, onboarded: true, baseline, plan,
    archivedPlans: [{ ...plan, id: 'previous-attempt', attemptNumber: 1 }],
    lastCigaretteAt: EARLIER,
    cigarettes: [{ id: 'saved-cigarette', createdAt: EARLIER, count: 1, attemptId: plan.id, source: 'LAPSE_FLOW' }],
    deletedCigaretteIds: ['deleted-cigarette'],
    checkIns: [{ id: 'check', date: '2026-09-01', cigarettesSmoked: 1, cravingPeak: 4, smokeFree: false, createdAt: EARLIER, attemptId: plan.id }],
    cravings: [{ id: 'craving', createdAt: EARLIER, level: 4, trigger: 'stress', technique: '私人应对方式', attemptId: plan.id }],
    lapses: [{ id: 'lapse', createdAt: EARLIER, cigarettes: 1, recoveryAction: '私人恢复记录', cigaretteLogId: 'saved-cigarette', attemptId: plan.id }],
    outcomes: [{
      id: 'outcome', planId: 'previous-attempt', dueMonth: 3, assessedAt: EARLIER,
      sevenDayAbstinent: false, thirtyDayAbstinent: false, continuouslyAbstinent: false,
      currentCigarettesPerDay: 10, additionalQuitAttempts: 1, confidence: 3,
      usedProfessionalSupport: true, selfReported: true, biochemicallyVerified: false,
    }],
    completedTasks: [{ contentId: 'private-task', completedAt: EARLIER, attemptId: plan.id }],
    settings: { ...initial.settings, sensitiveHealthData: true, inAppReminder: true, reminderHour: 9 },
  }
}

function input(state: ClientState): QuitJourneyInput {
  return { attemptId: state.plan!.id, startedAt: START, cigarettesPerDay: 10, pricePerPack: 25, cigarettesPerPack: 20 }
}

function harness(initial = sensitiveState()) {
  let current = initial
  const errors: string[] = []
  return {
    getState: vi.fn(() => current),
    replace: (next: ClientState) => { current = next },
    commit: vi.fn((update: (state: ClientState) => ClientState, _failure: string) => {
      try {
        current = update(current)
        return true
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
        return false
      }
    }),
    errors,
  }
}

let storage: AndroidBootstrapStorage
let storageValues: Map<string, string>

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  storageValues = new Map([['private-recovery-snapshot', '{"health":"原始恢复证据"}']])
  storage = {
    getItem: vi.fn((key) => storageValues.get(key) ?? null),
    setItem: vi.fn((key, value) => { storageValues.set(key, value) }),
    removeItem: vi.fn((key) => { storageValues.delete(key) }),
  }
  mocks.isNativeAndroidApp.mockReturnValue(true)
  mocks.getStorage.mockReturnValue(storage)
  mocks.readBootstrap.mockReturnValue([])
  mocks.readSystem.mockReturnValue([])
  mocks.readQuarantine.mockReturnValue([])
})

afterEach(() => vi.useRealTimers())

describe('save quit journey after synchronous shortcut reconciliation', () => {
  it('consumes first, commits the latest state and preserves every sensitive-history field and recovery snapshot', () => {
    const state = sensitiveState()
    const live = harness(state)
    const request = input(state)
    const event: AndroidBootstrapCigarette = { id: 'just-consumed', smokedAt: EARLIER }
    const consumed: ClientState = {
      ...state,
      cigarettes: [...state.cigarettes, { id: event.id, createdAt: event.smokedAt, count: 1, attemptId: state.plan!.id }],
      settings: { ...state.settings, reminderHour: 11 },
    }
    const originalSnapshot = JSON.stringify(state)
    const recoverySnapshot = [...storageValues]
    const consume = vi.fn(() => { live.replace(consumed) })
    // A persisted event may still be waiting for its native acknowledgement.
    mocks.readBootstrap.mockReturnValue([event])

    expect(saveQuitJourneyAfterQueue(request, live.getState, live.commit, consume)).toBe(true)

    expect(consume).toHaveBeenCalledOnce()
    expect(consume.mock.invocationCallOrder[0]).toBeLessThan(live.getState.mock.invocationCallOrder[0]!)
    expect(live.getState.mock.invocationCallOrder[0]).toBeLessThan(mocks.readBootstrap.mock.invocationCallOrder[0]!)
    expect(mocks.readSystem.mock.invocationCallOrder[0]).toBeLessThan(live.commit.mock.invocationCallOrder[0]!)
    expect(live.commit).toHaveBeenCalledWith(expect.any(Function), '无烟设置保存失败')
    expect(live.getState()).toEqual({
      ...consumed,
      quitJourney: { ...request, startedAt: new Date(START).toISOString(), confirmedAt: NOW.toISOString() },
    })
    expect(JSON.stringify(state)).toBe(originalSnapshot)
    expect([...storageValues]).toEqual(recoverySnapshot)
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(mocks.showToast).not.toHaveBeenCalled()
  })

  it('rejects a declaration contradicted by a cigarette consumed immediately before submission', () => {
    const state = sensitiveState()
    const live = harness(state)
    const consumed: ClientState = {
      ...state,
      cigarettes: [...state.cigarettes, { id: 'new-smoke', createdAt: '2026-09-03T12:00:00+08:00', count: 1, attemptId: state.plan!.id }],
    }
    const consume = vi.fn(() => { live.replace(consumed) })

    expect(saveQuitJourneyAfterQueue(input(state), live.getState, live.commit, consume)).toBe(false)

    expect(live.errors[0]).toContain('所选时间之后还有吸烟记录')
    expect(live.getState()).toBe(consumed)
    expect(live.getState().quitJourney).toBeUndefined()
  })

  it.each(['bootstrap', 'system'] as const)('does not submit while an unconsumed %s event remains pending', (queue) => {
    const live = harness()
    const state = live.getState()
    const before = JSON.stringify(state)
    const pending = [{ id: 'uncommitted', smokedAt: EARLIER }]
    const reader = queue === 'bootstrap' ? mocks.readBootstrap : mocks.readSystem
    reader.mockReturnValue(pending)
    const consume = vi.fn() // Simulates a consumer that retained the queue after a failed durable write.

    expect(saveQuitJourneyAfterQueue(input(state), live.getState, live.commit, consume)).toBe(false)

    expect(consume).toHaveBeenCalledOnce()
    expect(live.commit).not.toHaveBeenCalled()
    expect(JSON.stringify(live.getState())).toBe(before)
    expect(reader).toHaveReturnedWith(pending)
    expect(mocks.showToast).toHaveBeenCalledWith({ title: '快捷记录尚未同步，请稍后重试', icon: 'none' })
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it('does not submit or read native storage when synchronous queue consumption throws', () => {
    const live = harness()
    const state = live.getState()
    const consume = vi.fn(() => { throw new Error('durable write failed') })

    expect(() => saveQuitJourneyAfterQueue(input(state), live.getState, live.commit, consume)).toThrow('durable write failed')

    expect(live.commit).not.toHaveBeenCalled()
    expect(mocks.getStorage).not.toHaveBeenCalled()
    expect(live.getState()).toBe(state)
  })

  it.each(['bootstrap', 'system'] as const)('blocks conflicting saved-ID payloads left in the %s queue after failed quarantine', (queue) => {
    const conflicts = [
      { label: 'time', stored: {}, pending: { smokedAt: '2026-09-04T12:00:00+08:00' } },
      { label: 'count', stored: { count: 2 }, pending: {} },
      { label: 'trigger', stored: { trigger: 'meal' as const, cravingIntensity: 3 as const }, pending: { trigger: 'stress' as const, cravingIntensity: 3 as const } },
      { label: 'craving', stored: { trigger: 'stress' as const, cravingIntensity: 2 as const }, pending: { trigger: 'stress' as const, cravingIntensity: 3 as const } },
    ]
    const reader = queue === 'bootstrap' ? mocks.readBootstrap : mocks.readSystem
    for (const conflict of conflicts) {
      const state = sensitiveState()
      state.cigarettes = state.cigarettes.map((item) => ({ ...item, ...conflict.stored }))
      const live = harness(state)
      const pending = [{ id: 'saved-cigarette', smokedAt: EARLIER, ...conflict.pending }]
      reader.mockReturnValue(pending)
      const before = JSON.stringify(state)
      // The consumer preserves the original queue if moving this collision to
      // quarantine fails, so an existing ID alone cannot authorize submission.
      expect(saveQuitJourneyAfterQueue(input(state), live.getState, live.commit, vi.fn()), conflict.label).toBe(false)
      expect(live.commit, conflict.label).not.toHaveBeenCalled()
      expect(JSON.stringify(live.getState()), conflict.label).toBe(before)
      expect(reader, conflict.label).toHaveReturnedWith(pending)
      expect(mocks.showToast, conflict.label).toHaveBeenLastCalledWith({ title: '快捷记录尚未同步，请稍后重试', icon: 'none' })
    }
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it('blocks when consumption moves an unknown-attempt cigarette to quarantine before its asynchronous assignment finishes', () => {
    const live = harness()
    const state = live.getState()
    const pending = [{ id: 'old-widget-record', smokedAt: '2026-09-04T12:00:00+08:00', attemptId: 'unknown-attempt' }]
    const recoverySnapshot = [...storageValues]
    mocks.readSystem.mockReturnValue(pending)
    const consume = vi.fn(() => {
      mocks.readSystem.mockReturnValue([])
      mocks.readQuarantine.mockReturnValue(pending)
    })

    expect(saveQuitJourneyAfterQueue(input(state), live.getState, live.commit, consume)).toBe(false)

    expect(live.commit).not.toHaveBeenCalled()
    expect(live.getState()).toBe(state)
    expect(mocks.showToast).toHaveBeenCalledWith({ title: '有待归类的快捷记录，请先处理后重试', icon: 'none' })
    expect([...storageValues]).toEqual(recoverySnapshot)
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it('allows exact saved and deleted quarantine replays, but blocks a conflicting payload with a saved id', () => {
    const live = harness()
    const state = live.getState()
    mocks.readQuarantine.mockReturnValue([
      { id: 'saved-cigarette', smokedAt: EARLIER },
      { id: 'deleted-cigarette', smokedAt: '2026-09-04T12:00:00+08:00' },
    ])
    expect(saveQuitJourneyAfterQueue(input(state), live.getState, live.commit, vi.fn())).toBe(true)
    expect(live.getState().cigarettes).toBe(state.cigarettes)
    expect(live.getState().deletedCigaretteIds).toBe(state.deletedCigaretteIds)

    live.commit.mockClear()
    mocks.readQuarantine.mockReturnValue([{ id: 'saved-cigarette', smokedAt: '2026-09-04T12:00:00+08:00' }])
    expect(saveQuitJourneyAfterQueue(input(state), live.getState, live.commit, vi.fn())).toBe(false)
    expect(live.commit).not.toHaveBeenCalled()
  })

  it('allows already saved and user-deleted events awaiting acknowledgement without reviving or duplicating them', () => {
    const live = harness()
    const state = live.getState()
    mocks.readBootstrap.mockReturnValue([{ id: 'saved-cigarette', smokedAt: EARLIER }])
    mocks.readSystem.mockReturnValue([
      { id: 'saved-cigarette', smokedAt: EARLIER },
      { id: 'deleted-cigarette', smokedAt: '2026-09-04T12:00:00+08:00' },
    ])

    expect(saveQuitJourneyAfterQueue(input(state), live.getState, live.commit, vi.fn())).toBe(true)

    expect(live.getState().cigarettes).toBe(state.cigarettes)
    expect(live.getState().deletedCigaretteIds).toBe(state.deletedCigaretteIds)
    expect(live.getState().cigarettes).toHaveLength(1)
    expect(mocks.showToast).not.toHaveBeenCalled()
  })

  it.each(['attempt', 'consent'] as const)('revalidates %s against the latest state at commit, not the earlier queue-check snapshot', (change) => {
    const live = harness()
    const state = live.getState()
    const changed: ClientState = change === 'attempt'
      ? { ...state, plan: { ...state.plan!, id: 'next-attempt' } }
      : { ...state, settings: { ...state.settings, sensitiveHealthData: false } }
    const commit = vi.fn((update: (state: ClientState) => ClientState, failure: string) => {
      live.replace(changed)
      return live.commit(update, failure)
    })

    expect(saveQuitJourneyAfterQueue(input(state), live.getState, commit, vi.fn())).toBe(false)

    expect(live.errors[0]).toContain('计划已变化')
    expect(live.getState()).toBe(changed)
    expect(live.getState().quitJourney).toBeUndefined()
  })

  it('never reads native storage or queues on non-native platforms', () => {
    mocks.isNativeAndroidApp.mockReturnValue(false)
    mocks.getStorage.mockImplementation(() => { throw new Error('must not access native storage') })
    const live = harness()
    const consume = vi.fn()

    expect(saveQuitJourneyAfterQueue(input(live.getState()), live.getState, live.commit, consume)).toBe(true)

    expect(consume).toHaveBeenCalledOnce()
    expect(mocks.getStorage).not.toHaveBeenCalled()
    expect(mocks.readBootstrap).not.toHaveBeenCalled()
    expect(mocks.readSystem).not.toHaveBeenCalled()
    expect(mocks.readQuarantine).not.toHaveBeenCalled()
  })

  it('fails closed when native health storage is unavailable', () => {
    mocks.getStorage.mockReturnValue(undefined)
    const live = harness()
    const state = live.getState()

    expect(saveQuitJourneyAfterQueue(input(state), live.getState, live.commit, vi.fn())).toBe(false)

    expect(live.commit).not.toHaveBeenCalled()
    expect(mocks.readBootstrap).not.toHaveBeenCalled()
    expect(mocks.readSystem).not.toHaveBeenCalled()
    expect(live.getState()).toBe(state)
  })

  it('propagates a failed durable commit without changing the current health snapshot', () => {
    const live = harness()
    const state = live.getState()
    const commit = vi.fn(() => false)

    expect(saveQuitJourneyAfterQueue(input(state), live.getState, commit, vi.fn())).toBe(false)

    expect(live.getState()).toBe(state)
    expect(mocks.showToast).not.toHaveBeenCalled()
  })
})
