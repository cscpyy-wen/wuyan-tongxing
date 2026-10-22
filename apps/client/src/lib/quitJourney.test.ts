import { describe, expect, it } from 'vitest'
import type { ClientCheckIn, ClientCigaretteLog, ClientState } from '../types'
import {
  applyCigaretteLog, computeClientProgress, createClientPlan, createInitialState,
  parseStoredStateStrict, removeCigaretteLog, startNextClientAttempt, STORAGE_KEY, updateCigaretteLog,
} from './model'
import { BACKUP_STORAGE_KEY, createLocalStateRepository } from './localRepository'
import { parseRecoveryImportCandidate } from './recoveryBundle'
import { computeQuitJourney, parseQuitJourney, setQuitJourney, validateQuitJourneyInput, type QuitJourneyInput } from './quitJourney'

const START = '2026-08-01T10:15:00+08:00'
const CONFIRMED = new Date('2026-08-03T10:15:00+08:00')
const NOW = new Date('2026-08-05T12:30:00+08:00')

function plannedState(): ClientState {
  const initial = createInitialState()
  const baseline = {
    cigarettesPerDay: 10, pricePerPack: 25, firstCigaretteMinutes: 30,
    previousAttempts: 0, reasons: ['为了健康'], triggers: ['stress' as const],
  }
  return {
    ...initial, onboarded: true, baseline,
    plan: createClientPlan({ baseline, path: 'abrupt', quitDate: '2026-08-01' }, new Date('2026-08-01T08:00:00+08:00')),
    settings: { ...initial.settings, sensitiveHealthData: true },
  }
}

function input(state: ClientState, patch: Partial<QuitJourneyInput> = {}): QuitJourneyInput {
  return {
    attemptId: state.plan!.id, startedAt: START, cigarettesPerDay: 10,
    pricePerPack: 25, cigarettesPerPack: 20, ...patch,
  }
}

function configured(): ClientState {
  const state = plannedState()
  return setQuitJourney(state, input(state), CONFIRMED)
}

function cigarette(state: ClientState, id: string, createdAt: string, patch: Partial<ClientCigaretteLog> = {}): ClientCigaretteLog {
  return { id, createdAt, count: 1, attemptId: state.plan!.id, source: 'QUICK_LOG', ...patch }
}

function checkIn(state: ClientState, date: string, count: number, createdAt = `${date}T20:00:00+08:00`): ClientCheckIn {
  return { id: `check-${date}`, date, createdAt, cigarettesSmoked: count, cravingPeak: 1, smokeFree: count === 0, attemptId: state.plan!.id }
}

describe('用户校准的无烟起点', () => {
  it('旧版存档保持未设置且不猜测计划日期为起点', () => {
    const state = plannedState()
    expect(parseStoredStateStrict(state).quitJourney).toBeUndefined()
    expect(computeQuitJourney(state, NOW)).toBeUndefined()
  })

  it('设置只添加自报档案，不补写未知日，不改变原确认统计', () => {
    const state = plannedState()
    const oldProgress = computeClientProgress(state, NOW)
    const next = setQuitJourney(state, input(state), CONFIRMED)
    expect(next.quitJourney).toEqual({ ...input(state), startedAt: '2026-08-01T02:15:00.000Z', confirmedAt: CONFIRMED.toISOString() })
    expect(next.checkIns).toBe(state.checkIns)
    expect(next.cigarettes).toBe(state.cigarettes)
    expect(next.baseline).toBe(state.baseline)
    expect(next.plan).toBe(state.plan)
    expect(computeClientProgress(next, NOW)).toEqual(oldProgress)
    expect(oldProgress).toMatchObject({ streakConfirmed: false, smokeFreeDays: 0, moneySaved: 0 })
  })

  it('允许明确自报早于建计划时间的起点，不篡改计划日期', () => {
    const state = plannedState()
    const next = setQuitJourney(state, input(state, { startedAt: '2026-07-01T10:15:00+08:00' }), CONFIRMED)
    expect(parseStoredStateStrict(next).quitJourney?.startedAt).toBe('2026-07-01T02:15:00.000Z')
    expect(next.plan).toBe(state.plan)
  })

  it.each([
    { startedAt: '2026-08-06T00:00:00+08:00' },
    { startedAt: '2026-02-30T00:00:00+08:00' },
    { startedAt: '2026-08-01' },
    { startedAt: '2026-08-01T24:00:00+08:00' },
    { cigarettesPerDay: 0 }, { cigarettesPerDay: 1.5 }, { cigarettesPerDay: 101 },
    { pricePerPack: -1 }, { pricePerPack: Number.NaN }, { pricePerPack: Number.POSITIVE_INFINITY },
    { cigarettesPerPack: 0 }, { cigarettesPerPack: 20.5 }, { cigarettesPerPack: 101 },
  ])('拒绝非法参数 %j', (patch) => {
    const state = plannedState()
    expect(() => setQuitJourney(state, input(state, patch), CONFIRMED)).toThrow()
    expect(state.quitJourney).toBeUndefined()
  })

  it('零元包价合法，不用默认值覆盖', () => {
    const state = plannedState()
    const next = setQuitJourney(state, input(state, { pricePerPack: 0, cigarettesPerPack: 10 }), CONFIRMED)
    expect(computeQuitJourney(next, NOW)).toMatchObject({ cigarettesAvoided: 40, moneySaved: 0 })
  })

  it('提交时重验计划和同意状态', () => {
    const state = plannedState()
    const request = input(state)
    const next = startNextClientAttempt(state, 'abrupt', '2026-08-05', NOW)
    expect(() => setQuitJourney(next, request, NOW)).toThrow('计划已变化')
    expect(() => setQuitJourney({ ...state, settings: { ...state.settings, sensitiveHealthData: false } }, request, NOW)).toThrow()
  })

  it('首次设置或修改起点时，拒绝起点之后的新记烟（包括弹窗期间新增）', () => {
    const state = plannedState()
    const request = input(state)
    const newer = applyCigaretteLog(state, cigarette(state, 'new', '2026-08-02T12:00:00+08:00'))
    expect(validateQuitJourneyInput(newer, request, CONFIRMED)).toContain('之后还有吸烟记录')
    expect(() => setQuitJourney(newer, request, CONFIRMED)).toThrow()
    const valid = setQuitJourney(newer, { ...request, startedAt: '2026-08-02T12:00:00+08:00' }, CONFIRMED)
    expect(computeQuitJourney(valid, CONFIRMED)?.recordedSinceStart).toBe(0)
    expect(() => setQuitJourney(valid, request, CONFIRMED)).toThrow()
  })

  it('仅修改价格或包装可保留起点和原确认时间，不再声明期间没有吸烟', () => {
    const state = configured()
    const smoked = applyCigaretteLog(state, cigarette(state, 'later', '2026-08-04T12:00:00+08:00'))
    const next = setQuitJourney(smoked, input(smoked, { pricePerPack: 40, cigarettesPerPack: 10 }), NOW)
    expect(next.quitJourney?.confirmedAt).toBe(state.quitJourney?.confirmedAt)
    expect(computeQuitJourney(next, NOW)).toMatchObject({ recordedSinceStart: 1, cigarettesAvoided: 39, moneySaved: 156 })
  })
})

describe('无烟时间与估算的独立口径', () => {
  it('按真实24小时累计，而不是跨午夜多算一天', () => {
    const state = configured()
    expect(computeQuitJourney(state, NOW)).toMatchObject({ days: 4, hours: 2, minutes: 15, cigarettesAvoided: 40, moneySaved: 50, selfReported: true, assumesCompleteRecording: true })
    const base = plannedState()
    const start = '2026-08-01T23:59:00+08:00'
    const at = new Date('2026-08-02T00:01:00+08:00')
    const midnight = setQuitJourney(base, input(base, { startedAt: start }), at)
    expect(computeQuitJourney(midnight, at)).toMatchObject({ days: 0, hours: 0, minutes: 2 })
  })

  it('支持闰日和RFC3339不同偏移，恰好24小时为1天', () => {
    const base = plannedState()
    const at = new Date('2024-03-01T00:00:00+08:00')
    const next = setQuitJourney(base, input(base, { startedAt: '2024-02-28T11:00:00-05:00' }), at)
    expect(computeQuitJourney(next, at)).toMatchObject({ days: 1, hours: 0, minutes: 0, elapsedDays: 1 })
  })

  it('新烟支重启当前连续时长，保留累计估算并扣除已记支数', () => {
    const state = configured()
    const smoked = applyCigaretteLog(state, cigarette(state, 'later', '2026-08-04T12:00:00+08:00'))
    expect(computeQuitJourney(smoked, NOW)).toMatchObject({ days: 1, hours: 0, minutes: 30, recordedSinceStart: 1, cigarettesAvoided: 39, moneySaved: 48.75, continuousStartedAt: '2026-08-04T04:00:00.000Z' })
  })

  it('删除和时间编辑从原始记录重算，不固化错误计时', () => {
    const state = configured()
    const smoked = applyCigaretteLog(state, cigarette(state, 'later', '2026-08-04T12:00:00+08:00'))
    const edited = updateCigaretteLog(smoked, 'later', { smokedAt: '2026-08-03T12:00:00+08:00' })
    expect(computeQuitJourney(edited, NOW)).toMatchObject({ days: 2, hours: 0, minutes: 30, recordedSinceStart: 1 })
    expect(computeQuitJourney(removeCigaretteLog(edited, 'later'), NOW)).toMatchObject({ days: 4, recordedSinceStart: 0, cigarettesAvoided: 40 })
  })

  it('新计划不继承旧档案，但旧档案仍可恢复，不破坏旧历史', () => {
    const state = configured()
    const next = startNextClientAttempt(state, 'abrupt', '2026-08-05', NOW)
    expect(parseStoredStateStrict(next).quitJourney).toEqual(state.quitJourney)
    expect(computeQuitJourney(next, NOW)).toBeUndefined()
  })

  it('时钟回退给显式标记且不产生负数，未来烟支不污染过去快照', () => {
    const state = configured()
    const future = applyCigaretteLog(state, cigarette(state, 'future', '2026-08-07T10:00:00+08:00'))
    expect(computeQuitJourney(future, NOW)).toMatchObject({ days: 4, recordedSinceStart: 0, clockSkew: true })
    expect(computeQuitJourney(state, new Date('2026-07-31T00:00:00+08:00'))).toMatchObject({ days: 0, hours: 0, minutes: 0, cigarettesAvoided: 0, moneySaved: 0, clockSkew: true })
    expect(computeQuitJourney(state, new Date('2026-08-02T12:00:00+08:00'))?.clockSkew).toBe(true)
    expect(parseStoredStateStrict(state).quitJourney).toEqual(state.quitJourney)
  })

  it.each(['cigarette', 'lapse', 'checkIn', 'cached'] as const)('回拨后即使仍晚于起点和确认，也不能忽略已存未来 %s 证据冒称连续无烟', (kind) => {
    const state = configured()
    const futureAt = '2026-08-07T10:00:00+08:00'
    if (kind === 'cigarette') state.cigarettes = [cigarette(state, 'future', futureAt, { attemptId: 'archived-attempt' })]
    if (kind === 'lapse') state.lapses = [{ id: 'future', createdAt: futureAt, cigarettes: 1, recoveryAction: '重新开始', attemptId: state.plan!.id }]
    if (kind === 'checkIn') state.checkIns = [checkIn(state, '2026-08-07', 1, futureAt)]
    if (kind === 'cached') state.lastCigaretteAt = futureAt
    const before = JSON.stringify(state)

    expect(computeQuitJourney(state, NOW)?.clockSkew).toBe(true)
    expect(() => setQuitJourney(state, input(state, { startedAt: '2026-08-05T10:00:00+08:00' }), NOW)).toThrow('检查设备时间')
    const { quitJourney: _removed, ...unconfigured } = state
    expect(() => setQuitJourney(unconfigured, input(state), NOW)).toThrow('检查设备时间')
    expect(computeQuitJourney(state, new Date(futureAt))).toMatchObject({ clockSkew: false, days: 0, recordedSinceStart: 1 })
    expect(JSON.stringify(state)).toBe(before)
  })

  it('时钟异常时可修改原起点估算参数，但不能借此清除异常标记', () => {
    const state = configured()
    state.cigarettes = [cigarette(state, 'future', '2026-08-07T10:00:00+08:00')]
    const next = setQuitJourney(state, input(state, { pricePerPack: 30 }), NOW)
    expect(next.quitJourney?.confirmedAt).toBe(state.quitJourney?.confirmedAt)
    expect(computeQuitJourney(next, NOW)?.clockSkew).toBe(true)
  })

  it('少吸与省钱不因短时间内大量记烟而变成负数', () => {
    const state = configured()
    const at = new Date('2026-08-01T10:16:00+08:00')
    state.cigarettes = [cigarette(state, 'many', '2026-08-01T10:16:00+08:00', { count: 60 })]
    expect(computeQuitJourney(state, at)).toMatchObject({ cigarettesAvoided: 0, moneySaved: 0, recordedSinceStart: 60 })
  })
})

describe('旧聚合记录不丢失、不重复统计', () => {
  it('旧日终总数被迁移后仍只算一次；不把保存时刻冒充精确吸烟时间', () => {
    const state = configured()
    state.checkIns = [checkIn(state, '2026-08-04', 3)]
    const restored = parseStoredStateStrict(state)
    expect(restored.cigarettes).toHaveLength(1)
    expect(computeQuitJourney(restored, NOW)).toMatchObject({ recordedSinceStart: 3, cigarettesAvoided: 37, hasApproximateSmokingTime: true })
    expect(computeQuitJourney(state, NOW)).toEqual(computeQuitJourney(restored, NOW))
  })

  it('日终总数有部分逐支记录时只补未覆盖差额，完整覆盖时保留真实最后一支时间', () => {
    const state = configured()
    state.cigarettes = [cigarette(state, 'one', '2026-08-04T12:00:00+08:00')]
    state.checkIns = [checkIn(state, '2026-08-04', 3)]
    expect(computeQuitJourney(state, NOW)).toMatchObject({ recordedSinceStart: 3, hasApproximateSmokingTime: true })
    state.checkIns = [checkIn(state, '2026-08-04', 1)]
    state.lastCigaretteAt = state.checkIns[0]!.createdAt
    expect(computeQuitJourney(state, NOW)).toMatchObject({ recordedSinceStart: 1, continuousStartedAt: '2026-08-04T04:00:00.000Z', hasApproximateSmokingTime: false })
  })

  it('旧聚合之后新增烟支不能被旧总数覆盖掉', () => {
    const state = configured()
    state.checkIns = [checkIn(state, '2026-08-04', 3)]
    const migrated = parseStoredStateStrict(state)
    const next = applyCigaretteLog(migrated, cigarette(state, 'after-total', '2026-08-04T21:00:00+08:00'))
    expect(next.checkIns).toHaveLength(0)
    expect(computeQuitJourney(next, NOW)).toMatchObject({ recordedSinceStart: 4, continuousStartedAt: '2026-08-04T13:00:00.000Z' })
  })

  it('聚合覆盖已有更早逐支记录，多个累计小结只补差额', () => {
    const state = configured()
    state.cigarettes = [
      cigarette(state, 'early', '2026-08-04T10:00:00+08:00'),
      cigarette(state, 'aggregate', '2026-08-04T12:00:00+08:00', { source: 'DAILY_CHECKIN', count: 3 }),
    ]
    state.checkIns = [checkIn(state, '2026-08-04', 4)]
    expect(computeQuitJourney(state, NOW)?.recordedSinceStart).toBe(4)
  })

  it('有链接和无歧义旧复盘都不重复加支数，独立复盘保留', () => {
    const state = configured()
    state.cigarettes = [cigarette(state, 'one', '2026-08-04T12:00:00+08:00')]
    const lapse = { id: 'lapse', createdAt: state.cigarettes[0]!.createdAt, cigarettes: 1, recoveryAction: '离开现场', attemptId: state.plan!.id }
    state.lapses = [{ ...lapse, cigaretteLogId: 'one' }]
    expect(computeQuitJourney(state, NOW)?.recordedSinceStart).toBe(1)
    state.lapses = [lapse]
    expect(computeQuitJourney(state, NOW)?.recordedSinceStart).toBe(1)
    state.lapses.push({ ...lapse, id: 'separate', createdAt: '2026-08-04T15:00:00+08:00', cigarettes: 2 })
    state.checkIns = [checkIn(state, '2026-08-04', 3)]
    expect(computeQuitJourney(state, NOW)?.recordedSinceStart).toBe(3)
  })

  it('旧缓存单独存在时保留至少一支证据，与任何计划已知记录都不重复', () => {
    const state = configured()
    state.lastCigaretteAt = '2026-08-04T12:00:00+08:00'
    expect(computeQuitJourney(state, NOW)).toMatchObject({ recordedSinceStart: 1, hasApproximateSmokingTime: true })
    state.cigarettes = [cigarette(state, 'other', state.lastCigaretteAt, { attemptId: 'old-plan' })]
    expect(computeQuitJourney(state, NOW)).toMatchObject({ recordedSinceStart: 1, hasApproximateSmokingTime: false })
  })

  it('首次校准不会越过旧正数日终或独立复盘', () => {
    const state = plannedState()
    state.checkIns = [checkIn(state, '2026-08-02', 2)]
    expect(() => setQuitJourney(state, input(state), CONFIRMED)).toThrow('之后还有吸烟记录')
    state.checkIns = []
    state.lapses = [{ id: 'legacy', createdAt: '2026-08-02T12:00:00+08:00', cigarettes: 2, recoveryAction: '重新开始', attemptId: state.plan!.id }]
    expect(() => setQuitJourney(state, input(state), CONFIRMED)).toThrow('之后还有吸烟记录')
  })

  it('在起点之前的逐支记录不能与之后的总数差额重复相减', () => {
    const state = configured()
    state.cigarettes = [cigarette(state, 'before', '2026-08-01T09:00:00+08:00', { count: 4 })]
    state.checkIns = [checkIn(state, '2026-08-01', 5)]
    expect(computeQuitJourney(state, NOW)?.recordedSinceStart).toBe(1)
  })
})

describe('严格解析与本地备份', () => {
  it.each([
    null, [], {}, { startedAt: '2026-02-30T00:00:00Z' },
    { confirmedAt: '2026-07-01T00:00:00Z' }, { attemptId: 'missing' },
    { cigarettesPerDay: '10' }, { cigarettesPerPack: 0 }, { pricePerPack: Number.NaN },
  ])('新增字段畸形时拒绝整份导入，不默默丢弃 %j', (patch) => {
    const state = configured()
    const quitJourney = patch === null || Array.isArray(patch) ? patch : { ...state.quitJourney, ...patch }
    if (patch && !Array.isArray(patch) && Object.keys(patch).length === 0) {
      expect(() => parseStoredStateStrict({ ...state, quitJourney: {} })).toThrow()
    } else expect(() => parseStoredStateStrict({ ...state, quitJourney })).toThrow()
  })

  it('空壳状态有残留无烟档案时不能误判成新用户', () => {
    expect(() => parseStoredStateStrict({ ...createInitialState(), quitJourney: configured().quitJourney })).toThrow()
  })

  it('直接解析保持缺省和已知归档计划引用，规范化时间偏移', () => {
    const state = configured()
    expect(parseQuitJourney(undefined, new Set())).toBeUndefined()
    expect(parseQuitJourney({ ...state.quitJourney, startedAt: START }, new Set([state.plan!.id]))).toEqual(state.quitJourney)
  })

  it('主副本、损坏主档恢复、普通JSON和恢复包均保留完整档案与v1协议', () => {
    const values = new Map<string, unknown>()
    const repository = createLocalStateRepository({
      read: (key) => values.get(key), write: (key, value) => values.set(key, structuredClone(value)),
      remove: (key) => values.delete(key), exists: (key) => values.has(key), readRaw: (key) => values.get(key),
    })
    const state = configured()
    repository.save(state)
    expect(repository.load().state.quitJourney).toEqual(state.quitJourney)
    expect(parseStoredStateStrict(JSON.parse(JSON.stringify(values.get(BACKUP_STORAGE_KEY)))).quitJourney).toEqual(state.quitJourney)
    expect(parseRecoveryImportCandidate(JSON.parse(repository.recoveryBundle()))?.state.quitJourney).toEqual(state.quitJourney)
    expect(values.get(STORAGE_KEY)).toMatchObject({ version: 1, _androidBootstrapSummary: { version: 1, planId: state.plan!.id, count: 0 } })
    values.set(STORAGE_KEY, '{bad-json')
    expect(() => repository.load()).toThrow()
    expect(parseRecoveryImportCandidate(JSON.parse(repository.recoveryBundle()))?.state.quitJourney).toEqual(state.quitJourney)
    expect(values.get(STORAGE_KEY)).toBe('{bad-json')
    values.delete(STORAGE_KEY)
    expect(repository.load()).toMatchObject({ recoveredFromBackup: true, state: { quitJourney: state.quitJourney } })
  })
})

describe('起点早于计划时跨计划核对物理吸烟事实', () => {
  function restarted(): ClientState {
    const state = plannedState()
    return startNextClientAttempt(state, 'abrupt', '2026-08-03', new Date('2026-08-03T10:00:00+08:00'))
  }

  it('首次和修改起点不能越过归档计划中的烟支', () => {
    const state = restarted()
    const oldAttempt = state.archivedPlans[0]!.id
    state.cigarettes = [cigarette(state, 'old-smoke', '2026-08-02T12:00:00+08:00', { attemptId: oldAttempt })]
    expect(() => setQuitJourney(state, input(state), CONFIRMED)).toThrow('之后还有吸烟记录')
    const valid = setQuitJourney(state, input(state, { startedAt: '2026-08-02T12:00:00+08:00' }), CONFIRMED)
    expect(valid.quitJourney?.startedAt).toBe('2026-08-02T04:00:00.000Z')
    expect(() => setQuitJourney(valid, input(state), CONFIRMED)).toThrow('之后还有吸烟记录')
  })

  it('设置后恢复或补入归档烟支也要重启连续时长并扣除支数', () => {
    const state = restarted()
    const next = setQuitJourney(state, input(state), CONFIRMED)
    next.cigarettes = [cigarette(next, 'old-smoke', '2026-08-02T12:00:00+08:00', { attemptId: state.archivedPlans[0]!.id })]
    const restored = parseStoredStateStrict(next)
    const oldLogs = JSON.stringify(restored.cigarettes)
    const oldCheckIns = JSON.stringify(restored.checkIns)
    expect(computeQuitJourney(restored, NOW)).toMatchObject({ days: 3, hours: 0, minutes: 30, recordedSinceStart: 1, cigarettesAvoided: 39 })
    expect(JSON.stringify(restored.cigarettes)).toBe(oldLogs)
    expect(JSON.stringify(restored.checkIns)).toBe(oldCheckIns)
  })

  it('归档日报和独立复盘同样阻止矛盾起点，迁移后不重复', () => {
    const state = restarted()
    const oldAttempt = state.archivedPlans[0]!.id
    state.checkIns = [{ ...checkIn(state, '2026-08-02', 3), attemptId: oldAttempt }]
    expect(() => setQuitJourney(state, input(state), CONFIRMED)).toThrow()
    state.checkIns = []
    state.lapses = [{ id: 'old-lapse', createdAt: '2026-08-02T12:00:00+08:00', cigarettes: 2, recoveryAction: '重新开始', attemptId: oldAttempt }]
    expect(() => setQuitJourney(state, input(state), CONFIRMED)).toThrow()
    const clean = restarted()
    const next = setQuitJourney(clean, input(clean), CONFIRMED)
    next.checkIns = [{ ...checkIn(next, '2026-08-02', 3), attemptId: next.archivedPlans[0]!.id }]
    expect(computeQuitJourney(parseStoredStateStrict(next), NOW)?.recordedSinceStart).toBe(3)
  })

  it('同日不同计划的日报各自只抵扣本计划逐支记录', () => {
    const state = restarted()
    const next = setQuitJourney(state, input(state), CONFIRMED)
    const oldAttempt = next.archivedPlans[0]!.id
    next.cigarettes = [
      cigarette(next, 'old-morning', '2026-08-03T09:00:00+08:00', { attemptId: oldAttempt }),
      cigarette(next, 'new-noon', '2026-08-03T12:00:00+08:00'),
    ]
    next.checkIns = [
      { ...checkIn(next, '2026-08-03', 2, '2026-08-03T09:30:00+08:00'), id: 'old-total', attemptId: oldAttempt },
      { ...checkIn(next, '2026-08-03', 3), id: 'new-total' },
    ]
    expect(computeQuitJourney(parseStoredStateStrict(next), NOW)?.recordedSinceStart).toBe(5)
  })

  it('无关联旧复盘不会仅因时间支数相同而与另一计划记录合并', () => {
    const state = restarted()
    const next = setQuitJourney(state, input(state), CONFIRMED)
    next.cigarettes = [cigarette(next, 'current', '2026-08-03T12:00:00+08:00')]
    next.lapses = [{ id: 'old-lapse', createdAt: '2026-08-03T12:00:00+08:00', cigarettes: 1, recoveryAction: '重新开始', attemptId: next.archivedPlans[0]!.id }]
    next.lastCigaretteAt = next.cigarettes[0]!.createdAt
    expect(computeQuitJourney(next, NOW)?.recordedSinceStart).toBe(2)
  })

  it('仅存旧缓存且早于当前建计划时间时仍不能漏掉', () => {
    const state = restarted()
    state.lastCigaretteAt = '2026-08-02T12:00:00+08:00'
    expect(() => setQuitJourney(state, input(state), CONFIRMED)).toThrow()
    const { lastCigaretteAt: oldTime, ...withoutCache } = state
    const next = setQuitJourney(withoutCache, input(state), CONFIRMED)
    next.lastCigaretteAt = oldTime
    expect(computeQuitJourney(next, NOW)).toMatchObject({ recordedSinceStart: 1, hasApproximateSmokingTime: true })
  })
})
