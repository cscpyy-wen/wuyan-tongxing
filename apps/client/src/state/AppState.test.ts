import { act, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeRestoredOpenJson } from '../lib/nativeBackupRestore'
import {
  createClientPlan,
  createInitialState,
  MAX_PREVIOUS_ATTEMPTS,
  removeCigaretteLog,
  STORAGE_KEY,
} from '../lib/model'
import { BACKUP_STORAGE_KEY, DELETION_INTENT_STORAGE_KEY } from '../lib/localRepository'
import {
  beginAndroidBackupRestoreIntent,
  ANDROID_BACKUP_RESTORE_INTENT_KEY,
  ANDROID_BOOTSTRAP_CORRUPT_KEY,
  ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY,
  ANDROID_BOOTSTRAP_QUARANTINE_KEY,
  ANDROID_BOOTSTRAP_QUEUE_KEY,
  markAndroidBackupRestoreResultAccepted,
  sanitizeAndroidBootstrapRecoveryData,
} from '../lib/androidBootstrapQueue'
import type { ClientState } from '../types'
import { decodeLosslessBase64 } from '../lib/recoveryCodec'
import { AppStateProvider, useAppState } from './AppState'

const taroMocks = vi.hoisted(() => {
  const values = new Map<string, unknown>()
  return {
    values,
    failRemoveKey: undefined as string | undefined,
    failWriteAfterSetKey: undefined as string | undefined,
    failWriteAfterSetRemaining: 0,
    stripInternalFieldsOnCoreWrite: false,
    showToast: vi.fn(),
    showModal: vi.fn(),
    reLaunch: vi.fn(),
  }
})

const runtimeMocks = vi.hoisted(() => ({
  native: false,
  cancelReminder: vi.fn(async () => undefined),
  purgeExports: vi.fn(async () => undefined),
  saveJson: vi.fn(async (_json: string) => true),
  getExportOutcome: vi.fn(async () => undefined),
  acknowledgeExportOutcome: vi.fn(async () => undefined),
  acknowledgePendingExportOutcome: vi.fn(async () => false),
}))

vi.mock('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => taroMocks.values.get(key),
    setStorageSync: (key: string, value: unknown) => {
      if (taroMocks.failWriteAfterSetKey === key && taroMocks.failWriteAfterSetRemaining === 1) {
        taroMocks.failWriteAfterSetRemaining = 0
        throw new Error('write unavailable before commit')
      }
      const cloned = structuredClone(value) as Record<string, unknown>
      if (taroMocks.stripInternalFieldsOnCoreWrite
        && (key === STORAGE_KEY || key === BACKUP_STORAGE_KEY)
        && cloned && typeof cloned === 'object') {
        delete cloned._androidBootstrapImportTransactionId
        delete cloned._androidBootstrapSummary
      }
      taroMocks.values.set(key, cloned)
      if (taroMocks.failWriteAfterSetKey === key && taroMocks.failWriteAfterSetRemaining > 0) {
        taroMocks.failWriteAfterSetRemaining -= 1
        throw new Error('write result unavailable')
      }
    },
    removeStorageSync: (key: string) => {
      if (taroMocks.failRemoveKey === key) throw new Error('remove failed')
      taroMocks.values.delete(key)
    },
    getStorageInfoSync: () => ({ keys: [...taroMocks.values.keys()] }),
    showToast: taroMocks.showToast,
    showModal: taroMocks.showModal,
    reLaunch: taroMocks.reLaunch,
  },
}))

vi.mock('../lib/runtime', () => ({
  isNativeAndroidApp: () => runtimeMocks.native,
  cancelDailyReminder: runtimeMocks.cancelReminder,
  purgeNativeAppPrivatePendingExports: runtimeMocks.purgeExports,
  saveNativeJsonFile: runtimeMocks.saveJson,
  saveNativeRecoveryJsonFile: runtimeMocks.saveJson,
  getNativeLastExportOutcome: runtimeMocks.getExportOutcome,
  acknowledgeNativeLastExportOutcome: runtimeMocks.acknowledgeExportOutcome,
  acknowledgePendingNativeExportOutcome: runtimeMocks.acknowledgePendingExportOutcome,
  nativeExportCleanupIssue: () => undefined,
  nativeExportCleanupFilename: () => undefined,
}))

function validState(): ClientState {
  const baseline = {
    cigarettesPerDay: 10,
    firstCigaretteMinutes: 30,
    previousAttempts: 0,
    reasons: ['为了健康'],
    triggers: ['stress' as const],
    pricePerPack: 25,
  }
  const initial = createInitialState()
  return {
    ...initial,
    onboarded: true,
    baseline,
    plan: createClientPlan(
      { baseline, path: 'abrupt', quitDate: '2026-09-01' },
      new Date('2026-08-28T08:00:00+08:00'),
    ),
    settings: { ...initial.settings, sensitiveHealthData: true, inAppReminder: true, reminderHour: 9 },
  }
}

describe('AppState onboarding transaction', () => {
  beforeEach(() => {
    taroMocks.values.clear()
    taroMocks.failRemoveKey = undefined
    taroMocks.failWriteAfterSetKey = undefined
    taroMocks.failWriteAfterSetRemaining = 0
    taroMocks.stripInternalFieldsOnCoreWrite = false
    window.localStorage.clear()
    delete window.WuyanDurableStore
    delete document.documentElement.dataset.wuyanLocalState
    runtimeMocks.native = false
    vi.clearAllMocks()
    taroMocks.showModal.mockResolvedValue({ confirm: false, cancel: true })
  })

  it('does not mutate DOM or performance markers during React render', () => {
    const mark = vi.fn()
    const originalMark = performance.mark
    Object.defineProperty(performance, 'mark', { configurable: true, value: mark })
    try {
      renderToString(createElement(AppStateProvider, undefined, createElement('span', undefined, 'probe')))
      expect(document.documentElement.dataset.wuyanLocalState).toBeUndefined()
      expect(mark).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(performance, 'mark', { configurable: true, value: originalMark })
    }
  })

  it('migrates a verified legacy WebView state into the native durable store before ready', async () => {
    const stored = validState()
    const nativeValues = new Map<string, string>()
    window.WuyanDurableStore = {
      hasValue: (key) => nativeValues.has(key),
      readValue: (key) => nativeValues.get(key) ?? null,
      readRawValue: (key) => nativeValues.get(key) ?? null,
      writeValue: (key, value) => { nativeValues.set(key, value) },
      removeValue: (key) => { nativeValues.delete(key) },
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ data: stored }))
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.ready).toBe(true))

    expect(JSON.parse(nativeValues.get(STORAGE_KEY)!)).toMatchObject({ onboarded: true })
    expect(JSON.parse(nativeValues.get(BACKUP_STORAGE_KEY)!)).toMatchObject({ onboarded: true })
  })

  it('keeps React state and regular mutations blocked while a restored picker result is pending', async () => {
    const stored = validState()
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    beginAndroidBackupRestoreIntent(window.localStorage)
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.backupRestorePending).toBe(true))

    let id: string | undefined
    act(() => {
      id = current!.actions.recordCigarette({
        smokedAt: '2026-08-28T11:00:00.000Z',
        trigger: 'work',
        cravingIntensity: 4,
      })
    })
    expect(current?.ready).toBe(false)
    expect(id).toBeUndefined()
    expect(taroMocks.values.get(STORAGE_KEY)).toEqual(stored)
    expect(taroMocks.showToast).toHaveBeenCalledWith({ title: '正在等待备份恢复结果', icon: 'none' })
  })

  it('keeps an accepted native picker result pending for cold-start probe when no import journal exists', async () => {
    const stored = validState()
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    beginAndroidBackupRestoreIntent(window.localStorage)
    markAndroidBackupRestoreResultAccepted(
      window.localStorage,
      '29292929-2929-4929-8929-292929292929',
    )
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.backupRestorePending).toBe(true))

    expect(current?.ready).toBe(false)
    expect(window.localStorage.getItem(ANDROID_BACKUP_RESTORE_INTENT_KEY)).toContain('29292929')
    expect(taroMocks.showToast).not.toHaveBeenCalledWith(expect.objectContaining({
      title: '上次恢复中断，请重新选择备份',
    }))
  })

  it('blocks a regular mutation when a restore intent appears after the provider is already ready', async () => {
    const stored = validState()
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.ready).toBe(true))
    beginAndroidBackupRestoreIntent(window.localStorage)

    let id: string | undefined
    act(() => {
      id = current!.actions.recordCigarette({
        smokedAt: '2026-08-28T11:05:00.000Z',
        trigger: 'stress',
        cravingIntensity: 5,
      })
    })

    expect(id).toBeUndefined()
    expect(current?.state.cigarettes).toHaveLength(stored.cigarettes.length)
    expect(taroMocks.values.get(STORAGE_KEY)).toEqual(stored)
    expect(taroMocks.showToast).toHaveBeenCalledWith({ title: '正在等待备份恢复结果', icon: 'none' })
  })

  it('commits a static Android cold-start quick log once and acknowledges its queue id', async () => {
    runtimeMocks.native = true
    const stored = validState()
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    const queued = {
      id: '33333333-3333-4333-8333-333333333333',
      smokedAt: '2026-08-28T10:15:00.000Z',
      attemptId: stored.plan!.id,
      trigger: 'toilet',
      cravingIntensity: 4,
    }
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, JSON.stringify({ data: [queued] }))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.state.cigarettes).toHaveLength(1))

    expect(current?.state.cigarettes[0]).toMatchObject({
      id: queued.id,
      createdAt: queued.smokedAt,
      attemptId: stored.plan?.id,
      trigger: 'toilet',
      cravingIntensity: 4,
      source: 'QUICK_LOG',
    })
    expect((taroMocks.values.get(STORAGE_KEY) as ClientState).cigarettes).toHaveLength(1)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull()
  })

  it('acknowledges an exact same-id crash replay without duplicating it', async () => {
    runtimeMocks.native = true
    const stored = validState()
    const queued = {
      id: '33444444-3333-4333-8333-333333333333',
      smokedAt: '2026-08-28T10:15:00.000Z',
      attemptId: stored.plan!.id,
      trigger: 'work' as const,
      cravingIntensity: 4 as const,
    }
    stored.cigarettes = [{
      id: queued.id,
      createdAt: queued.smokedAt,
      loggedAt: queued.smokedAt,
      count: 1,
      attemptId: queued.attemptId,
      trigger: queued.trigger,
      cravingIntensity: queued.cravingIntensity,
      source: 'QUICK_LOG',
    }]
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, JSON.stringify({ data: [queued] }))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))

    await waitFor(() => expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull())
    expect(current?.state.cigarettes).toHaveLength(1)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY)).toBeNull()
  })

  it('moves a same-id different-payload restore to quarantine instead of deleting it', async () => {
    runtimeMocks.native = true
    const stored = validState()
    const id = '33555555-3333-4333-8333-333333333333'
    stored.cigarettes = [{
      id,
      createdAt: '2026-08-28T10:15:00.000Z',
      count: 1,
      attemptId: stored.plan!.id,
      trigger: 'meal',
      cravingIntensity: 2,
      source: 'QUICK_LOG',
    }]
    const conflicting = {
      id,
      smokedAt: '2026-08-28T10:16:00.000Z',
      attemptId: stored.plan!.id,
      trigger: 'work',
      cravingIntensity: 4,
    }
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, JSON.stringify({ data: [conflicting] }))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))

    await waitFor(() => expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull())
    expect(JSON.parse(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY)!).data).toEqual([conflicting])
    expect(current?.state.cigarettes).toEqual(stored.cigarettes)
    expect(taroMocks.showToast).toHaveBeenCalledWith({ title: '1 条冲突记录已保留', icon: 'none' })
  })

  it('does not resurrect a deleted quick log when its crash-left queue acknowledgement retries', async () => {
    runtimeMocks.native = true
    const stored = validState()
    const queued = {
      id: '34343434-3434-4434-8434-343434343434',
      smokedAt: '2026-08-28T10:14:00.000Z',
      attemptId: stored.plan!.id,
      trigger: 'work' as const,
      cravingIntensity: 4 as const,
    }
    const committed: ClientState = {
      ...stored,
      cigarettes: [{
        id: queued.id,
        createdAt: queued.smokedAt,
        loggedAt: queued.smokedAt,
        count: 1,
        attemptId: queued.attemptId,
        trigger: queued.trigger,
        cravingIntensity: queued.cravingIntensity,
        source: 'QUICK_LOG',
      }],
      lastCigaretteAt: queued.smokedAt,
    }
    const afterUserDelete = removeCigaretteLog(committed, queued.id)
    taroMocks.values.set(STORAGE_KEY, structuredClone(afterUserDelete))
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, JSON.stringify({ data: [queued] }))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull())
    expect(current?.state.cigarettes).toHaveLength(0)
    expect(current?.state.deletedCigaretteIds).toContain(queued.id)
  })

  it('silently acknowledges a deleted old-attempt event before quarantine prompting', async () => {
    runtimeMocks.native = true
    const stored = validState()
    const deletedId = '35353535-3535-4535-8535-353535353535'
    stored.deletedCigaretteIds = [deletedId]
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, JSON.stringify({ data: [{
      id: deletedId,
      smokedAt: '2026-08-28T10:16:00.000Z',
      attemptId: 'plan-from-another-backup',
      trigger: 'social',
      cravingIntensity: 3,
    }] }))

    render(createElement(AppStateProvider, undefined, createElement('span')))

    await waitFor(() => expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull())
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY)).toBeNull()
    expect(taroMocks.showModal).not.toHaveBeenCalledWith(expect.objectContaining({
      title: '有待归类的快速记录',
    }))
  })

  it('quarantines a pending quick log from another plan and retains it after cancel', async () => {
    runtimeMocks.native = true
    const stored = validState()
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    const queued = {
      id: '44444444-4444-4444-8444-444444444444',
      smokedAt: '2026-08-28T10:20:00.000Z',
      attemptId: 'plan-from-another-backup',
      trigger: 'stress',
      cravingIntensity: 5,
    }
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, JSON.stringify({ data: [queued] }))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(taroMocks.showModal).toHaveBeenCalledWith(expect.objectContaining({
      title: '有待归类的快速记录',
      confirmText: '归入当前',
    })))
    expect(current?.state.cigarettes).toHaveLength(0)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull()
    expect(JSON.parse(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY)!).data).toEqual([queued])
  })

  it('assigns a quarantined quick log only after explicit confirmation', async () => {
    runtimeMocks.native = true
    taroMocks.showModal.mockResolvedValueOnce({ confirm: true, cancel: false })
    const stored = validState()
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    const queued = {
      id: '45454545-4545-4545-8545-454545454545',
      smokedAt: '2026-08-28T10:22:00.000Z',
      attemptId: 'plan-from-another-backup',
      trigger: 'stress',
      cravingIntensity: 5,
    }
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, JSON.stringify({ data: [queued] }))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.state.cigarettes).toHaveLength(1))
    expect(current?.state.cigarettes[0]).toMatchObject({
      id: queued.id,
      attemptId: stored.plan!.id,
    })
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull()
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY)).toBeNull()
  })

  it('offers quarantined records after onboarding grants health-data consent in the same session', async () => {
    runtimeMocks.native = true
    const queued = {
      id: '46464646-4646-4646-8646-464646464646',
      smokedAt: '2026-08-28T10:23:00.000Z',
      attemptId: 'plan-from-another-install',
      trigger: 'coffee',
      cravingIntensity: 3,
    }
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, JSON.stringify({ data: [queued] }))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }
    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull())
    expect(taroMocks.showModal).not.toHaveBeenCalled()

    act(() => {
      current!.actions.finishOnboarding({
        path: 'abrupt',
        quitDate: '2026-09-01',
        baseline: {
          cigarettesPerDay: 10,
          firstCigaretteMinutes: 30,
          previousAttempts: 0,
          reasons: ['为了健康'],
          triggers: ['stress'],
          pricePerPack: 25,
        },
      })
    })
    await waitFor(() => expect(taroMocks.showModal).toHaveBeenCalledWith(expect.objectContaining({
      title: '有待归类的快速记录',
    })))
  })

  it('keeps a durable deletion intent and never restores health queues when primary deletion is interrupted', async () => {
    const stored = validState()
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    const queuedRaw = JSON.stringify({ data: [{
      id: '55555555-5555-4555-8555-555555555555',
      smokedAt: '2026-08-28T10:25:00.000Z',
      attemptId: stored.plan!.id,
      trigger: 'meal',
      cravingIntensity: 3,
    }] })
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, queuedRaw)
    const quarantinedRaw = JSON.stringify({ data: [{
      id: '56565656-5656-4565-8565-565656565656',
      smokedAt: '2026-08-28T10:26:00.000Z',
      attemptId: 'old-plan',
      trigger: 'social',
      cravingIntensity: 2,
    }] })
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY, quarantinedRaw)
    const corruptRaw = JSON.stringify({ data: [{ capturedAt: '2026-08-28T10:27:00.000Z', raw: '{broken' }] })
    window.localStorage.setItem(ANDROID_BOOTSTRAP_CORRUPT_KEY, corruptRaw)
    taroMocks.failRemoveKey = STORAGE_KEY
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }
    render(createElement(AppStateProvider, undefined, createElement(Probe)))

    await act(async () => {
      await expect(current!.actions.deleteAllData()).resolves.toBe(false)
    })

    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull()
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY)).toBeNull()
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)).toBeNull()
    expect(taroMocks.values.has(DELETION_INTENT_STORAGE_KEY)).toBe(true)
    expect(taroMocks.values.get(STORAGE_KEY)).toEqual(stored)
    expect(current?.state.onboarded).toBe(false)
    expect(current?.ready).toBe(false)
    expect(current?.loadFailure?.message).toContain('删除尚未完成')

    taroMocks.failRemoveKey = undefined
    act(() => current!.actions.retryLocalState())
    await waitFor(() => expect(taroMocks.values.has(DELETION_INTENT_STORAGE_KEY)).toBe(false))
    expect(taroMocks.values.has(STORAGE_KEY)).toBe(false)
    expect(current?.ready).toBe(true)
  })

  it('continues a validated crash-interrupted deletion before exposing any old health state', async () => {
    const stored = validState()
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    taroMocks.values.set(BACKUP_STORAGE_KEY, structuredClone(stored))
    taroMocks.values.set(DELETION_INTENT_STORAGE_KEY, {
      version: 1,
      intent: 'delete-all-local-health-data',
    })
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, JSON.stringify({ data: [{
      id: '57575757-5757-4575-8575-575757575750',
      smokedAt: '2026-08-28T10:28:00.000Z',
      attemptId: stored.plan!.id,
      trigger: 'work',
      cravingIntensity: 3,
    }] }))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))

    expect(current?.state.onboarded).toBe(false)
    expect(current?.ready).toBe(false)
    await waitFor(() => expect(taroMocks.values.has(DELETION_INTENT_STORAGE_KEY)).toBe(false))
    expect(taroMocks.values.has(STORAGE_KEY)).toBe(false)
    expect(taroMocks.values.has(BACKUP_STORAGE_KEY)).toBe(false)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull()
    expect(current?.state.onboarded).toBe(false)
    expect(current?.ready).toBe(true)
    expect(taroMocks.reLaunch).toHaveBeenCalledWith({ url: '/pages/onboarding/index' })
  })

  it('migrates an exact legacy backup deletion marker before an Android native upgrade can expose health data', async () => {
    const stored = validState()
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    window.localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify({
      data: { version: 1, intent: 'delete-all-local-health-data' },
    }))
    const nativeValues = new Map<string, string>()
    window.WuyanDurableStore = {
      hasValue: (key) => nativeValues.has(key),
      readValue: (key) => nativeValues.get(key) ?? null,
      readRawValue: (key) => nativeValues.get(key) ?? null,
      writeValue: (key, value) => { nativeValues.set(key, value) },
      removeValue: (key) => { nativeValues.delete(key) },
    }
    runtimeMocks.native = true
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))

    expect(current?.state.onboarded).toBe(false)
    expect(current?.ready).toBe(false)
    await waitFor(() => expect(current?.ready).toBe(true))
    expect(taroMocks.values.has(STORAGE_KEY)).toBe(false)
    expect(nativeValues.has(DELETION_INTENT_STORAGE_KEY)).toBe(false)
    expect(window.localStorage.getItem(BACKUP_STORAGE_KEY)).toBeNull()
    expect(taroMocks.reLaunch).toHaveBeenCalledWith({ url: '/pages/onboarding/index' })
  })

  it('round-trips pending, quarantined and corrupt quick-log recovery data through normal export and import', async () => {
    const stored = validState()
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    const queueRaw = JSON.stringify({ data: [{
      id: '57575757-5757-4575-8575-575757575757',
      smokedAt: '2026-08-28T10:28:00.000Z',
      attemptId: stored.plan!.id,
      trigger: 'work',
      cravingIntensity: 3,
    }] })
    const quarantineRaw = JSON.stringify({ data: [{
      id: '58585858-5858-4585-8585-585858585858',
      smokedAt: '2026-08-28T10:29:00.000Z',
      trigger: 'meal',
      cravingIntensity: 2,
    }] })
    const corruptRaw = JSON.stringify({ data: [{
      capturedAt: '2026-08-28T10:30:00.000Z',
      sourceKey: ANDROID_BOOTSTRAP_QUEUE_KEY,
      raw: '{broken',
    }] })
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, queueRaw)
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY, quarantineRaw)
    window.localStorage.setItem(ANDROID_BOOTSTRAP_CORRUPT_KEY, corruptRaw)
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }
    render(createElement(AppStateProvider, undefined, createElement(Probe)))

    const exported = current!.actions.exportData()
    window.localStorage.clear()
    const lease = await current!.actions.beginDataImport(current!.actions.reserveDataImport())
    expect(lease).toBeDefined()
    let outcome: Awaited<ReturnType<typeof consumeRestoredOpenJson>> | undefined
    await act(async () => {
      outcome = await consumeRestoredOpenJson({
        success: true,
        data: { selected: true, json: exported },
      }, {
        currentState: current!.state,
        isCurrent: lease!.isCurrent,
        importData: (json) => current!.actions.importData(json, lease!),
      })
    })
    lease!.release()

    expect(outcome?.status).toBe('restored')
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(queueRaw)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY)).toBe(quarantineRaw)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)).toBe(corruptRaw)
  })

  it('restores a valid main plan while preserving current bootstrap data when the auxiliary archive is malformed', async () => {
    const stored = validState()
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    const existingQueue = JSON.stringify({ data: [] })
    const existingDamagedArchive = '{destination-archive-damaged'
    const restoredQueue = JSON.stringify({ data: [{
      id: '60606060-6060-4060-8060-606060606060',
      smokedAt: '2026-08-28T10:32:00.000Z',
      attemptId: stored.plan!.id,
      trigger: 'work',
      cravingIntensity: 3,
    }] })
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, existingQueue)
    window.localStorage.setItem(ANDROID_BOOTSTRAP_CORRUPT_KEY, existingDamagedArchive)
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }
    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    const imported = {
      ...stored,
      baseline: { ...stored.baseline!, pricePerPack: 31 },
      _androidBootstrapRecovery: {
        [ANDROID_BOOTSTRAP_QUEUE_KEY]: restoredQueue,
        [ANDROID_BOOTSTRAP_CORRUPT_KEY]: '',
      },
    }
    const reservation = current!.actions.reserveDataImport()
    const lease = await current!.actions.beginDataImport(reservation)
    expect(lease).toBeDefined()

    let restored: false | { bootstrapRecoverySkipped: boolean } = false
    act(() => { restored = current!.actions.importData(JSON.stringify(imported), lease!) })
    lease!.release()

    expect(restored).toEqual({ bootstrapRecoverySkipped: true })
    expect(current?.state.baseline?.pricePerPack).toBe(31)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(restoredQueue)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)).toBe(existingDamagedArchive)
    expect(taroMocks.showToast).not.toHaveBeenCalledWith(expect.objectContaining({
      title: '备份已恢复',
    }))
  })

  it('finishes a matching cross-store import transaction before exposing its state after restart', async () => {
    const imported = validState()
    imported.baseline = { ...imported.baseline!, pricePerPack: 42 }
    const transactionId = '61616161-6161-4161-8161-616161616161'
    taroMocks.values.set(STORAGE_KEY, {
      ...structuredClone(imported),
      _androidBootstrapImportTransactionId: transactionId,
    })
    const restoredQueue = JSON.stringify({ data: [] })
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, '{old-partial')
    window.localStorage.setItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY, JSON.stringify({
      version: 1,
      id: transactionId,
      mode: 'replace',
      snapshot: { [ANDROID_BOOTSTRAP_QUEUE_KEY]: restoredQueue },
    }))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.ready).toBe(true))

    expect(current?.state.baseline?.pricePerPack).toBe(42)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(restoredQueue)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY)).toBeNull()
    expect(taroMocks.values.get(STORAGE_KEY)).not.toHaveProperty('_androidBootstrapImportTransactionId')
  })

  it('promotes an accepted native restore to committed after restart finishes its matching journal', async () => {
    const imported = validState()
    imported.baseline = { ...imported.baseline!, pricePerPack: 43 }
    const transactionId = '62626262-6262-4262-8262-626262626262'
    const nativeRestoreId = '27272727-2727-4727-8727-272727272727'
    taroMocks.values.set(STORAGE_KEY, {
      ...structuredClone(imported),
      _androidBootstrapImportTransactionId: transactionId,
    })
    window.localStorage.setItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY, JSON.stringify({
      version: 1,
      id: transactionId,
      mode: 'replace',
      snapshot: { [ANDROID_BOOTSTRAP_QUEUE_KEY]: JSON.stringify({ data: [] }) },
    }))
    beginAndroidBackupRestoreIntent(window.localStorage)
    markAndroidBackupRestoreResultAccepted(window.localStorage, nativeRestoreId)
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.backupRestorePending).toBe(true))

    expect(current?.ready).toBe(false)
    expect(current?.state.baseline?.pricePerPack).toBe(43)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY)).toBeNull()
    expect(JSON.parse(window.localStorage.getItem(ANDROID_BACKUP_RESTORE_INTENT_KEY)!)).toEqual({
      version: 1,
      intent: 'restore-backup',
      phase: 'result-committed',
      id: nativeRestoreId,
    })
  })

  it('finishes a matching import transaction from the last-known-good slot when the primary is unreadable', async () => {
    const imported = validState()
    imported.baseline = { ...imported.baseline!, pricePerPack: 46 }
    const transactionId = '62626262-6262-4262-8262-626262626262'
    taroMocks.values.set(STORAGE_KEY, { version: 1, onboarded: true, cigarettes: 'broken' })
    taroMocks.values.set(BACKUP_STORAGE_KEY, {
      ...structuredClone(imported),
      _androidBootstrapImportTransactionId: transactionId,
    })
    const restoredQueue = JSON.stringify({ data: [] })
    window.localStorage.setItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY, JSON.stringify({
      version: 1,
      id: transactionId,
      mode: 'replace',
      snapshot: { [ANDROID_BOOTSTRAP_QUEUE_KEY]: restoredQueue },
    }))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.ready).toBe(true))

    expect(current?.state.baseline?.pricePerPack).toBe(46)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(restoredQueue)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY)).toBeNull()
  })

  it('does not let an unrelated damaged backup block a valid primary without an import journal', async () => {
    const primary = validState()
    primary.baseline = { ...primary.baseline!, pricePerPack: 37 }
    taroMocks.values.set(STORAGE_KEY, structuredClone(primary))
    taroMocks.values.set(BACKUP_STORAGE_KEY, { ...structuredClone(primary), cigarettes: 'broken' })
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.ready).toBe(true))

    expect(current?.state.baseline?.pricePerPack).toBe(37)
    expect(current?.loadFailure).toBeUndefined()
  })

  it('completes a matching ghost-committed import instead of deleting its only recovery journal', async () => {
    const stored = validState()
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }
    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.ready).toBe(true))
    const restoredQueue = JSON.stringify({ data: [] })
    const imported = {
      ...stored,
      baseline: { ...stored.baseline!, pricePerPack: 39 },
      _androidBootstrapRecovery: { [ANDROID_BOOTSTRAP_QUEUE_KEY]: restoredQueue },
    }
    const lease = await current!.actions.beginDataImport(current!.actions.reserveDataImport())
    expect(lease).toBeDefined()
    taroMocks.failWriteAfterSetKey = STORAGE_KEY
    taroMocks.failWriteAfterSetRemaining = 2
    taroMocks.failRemoveKey = STORAGE_KEY

    let restored: false | { bootstrapRecoverySkipped: boolean } = false
    act(() => { restored = current!.actions.importData(JSON.stringify(imported), lease!) })
    lease!.release()

    expect(restored).toEqual({ bootstrapRecoverySkipped: false })
    expect(current?.state.baseline?.pricePerPack).toBe(39)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(restoredQueue)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY)).toBeNull()
  })

  it('fails closed when a storage adapter strips the transaction marker from an otherwise successful core write', async () => {
    const stored = validState()
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }
    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.ready).toBe(true))
    const imported = {
      ...stored,
      baseline: { ...stored.baseline!, pricePerPack: 41 },
      _androidBootstrapRecovery: { [ANDROID_BOOTSTRAP_QUEUE_KEY]: JSON.stringify({ data: [] }) },
    }
    const lease = await current!.actions.beginDataImport(current!.actions.reserveDataImport())
    taroMocks.stripInternalFieldsOnCoreWrite = true

    let restored: false | { bootstrapRecoverySkipped: boolean } = false
    act(() => { restored = current!.actions.importData(JSON.stringify(imported), lease!) })
    lease!.release()

    expect(restored).toBe(false)
    expect(current?.ready).toBe(false)
    expect(current?.loadFailure?.message).toContain('状态不一致')
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY)).not.toBeNull()
    expect(current?.state.baseline?.pricePerPack).toBe(stored.baseline!.pricePerPack)
  })

  it('includes bootstrap recovery keys when exporting a corrupted-state recovery bundle before clearing', async () => {
    runtimeMocks.native = true
    taroMocks.values.set(STORAGE_KEY, { version: 1, onboarded: true, cigarettes: 'broken' })
    const queueRaw = JSON.stringify({ data: [{
      id: '59595959-5959-4595-8595-595959595959',
      smokedAt: '2026-08-28T10:31:00.000Z',
      attemptId: 'plan-damaged',
      trigger: 'stress',
      cravingIntensity: 4,
    }] })
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, queueRaw)
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }
    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    expect(current?.loadFailure).toBeDefined()

    await act(async () => current!.actions.exportRecoveryData())
    const recovery = JSON.parse(runtimeMocks.saveJson.mock.calls.at(-1)![0] as string)
    expect(sanitizeAndroidBootstrapRecoveryData(recovery._androidBootstrapRecovery).snapshot)
      .toMatchObject({ [ANDROID_BOOTSTRAP_QUEUE_KEY]: queueRaw })

    taroMocks.showModal.mockResolvedValueOnce({ confirm: true, cancel: false })
    await act(async () => current!.actions.clearCorruptedState())
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull()
  })

  it('includes a matching pending import journal in the recovery export before destructive clearing', async () => {
    runtimeMocks.native = true
    const transactionId = '63636363-6363-4363-8363-636363636363'
    taroMocks.values.set(STORAGE_KEY, {
      version: 1,
      onboarded: true,
      cigarettes: 'broken',
      _androidBootstrapImportTransactionId: transactionId,
    })
    const journal = {
      version: 1,
      id: transactionId,
      mode: 'replace',
      snapshot: { [ANDROID_BOOTSTRAP_QUEUE_KEY]: JSON.stringify({ data: [] }) },
    }
    window.localStorage.setItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY, JSON.stringify(journal))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }
    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.loadFailure).toBeDefined())

    await act(async () => current!.actions.exportRecoveryData())

    const recovery = JSON.parse(runtimeMocks.saveJson.mock.calls.at(-1)![0] as string)
    expect(recovery._androidBootstrapPendingImport).toMatchObject({
      status: 'validated',
      transactionId,
    })
    expect(JSON.parse(decodeLosslessBase64(recovery._androidBootstrapPendingImport.evidence))).toEqual(journal)
    expect(recovery._recoveryIntegrity.pendingImportIncluded).toBe(true)
  })

  it('does not expand an oversized unreadable import journal and records the bounded omission', async () => {
    runtimeMocks.native = true
    taroMocks.values.set(STORAGE_KEY, { version: 1, onboarded: true, cigarettes: 'broken' })
    const rawJournal = `unreadable-${'x'.repeat(3 * 1024 * 1024)}`
    window.localStorage.setItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY, rawJournal)
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }
    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.loadFailure).toBeDefined())

    await act(async () => current!.actions.exportRecoveryData())

    const recovery = JSON.parse(runtimeMocks.saveJson.mock.calls.at(-1)![0] as string)
    expect(recovery._androidBootstrapPendingImport).toBeUndefined()
    expect(recovery._recoveryIntegrity.pendingImportIncluded).toBe(false)
    expect(recovery._recoveryIntegrity.pendingImportOmittedForSize).toBe(true)
    expect(recovery.primary).toBeDefined()
    expect(recovery.lastKnownGood).toBeDefined()
  })

  it('contains plan construction failures and leaves both memory and storage unchanged', async () => {
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    expect(current?.ready).toBe(true)
    await waitFor(() => expect(current?.ready).toBe(true))

    let saved: boolean | undefined
    expect(() => {
      act(() => {
        saved = current!.actions.finishOnboarding({
          path: 'abrupt',
          quitDate: '2026-08-30',
          baseline: {
            cigarettesPerDay: 10,
            firstCigaretteMinutes: 30,
            previousAttempts: MAX_PREVIOUS_ATTEMPTS + 1,
            reasons: ['为了健康'],
            triggers: ['stress'],
            pricePerPack: 25,
          },
        })
      })
    }).not.toThrow()

    expect(saved).toBe(false)
    expect(current?.state.onboarded).toBe(false)
    expect(taroMocks.values.has(STORAGE_KEY)).toBe(false)
    expect(taroMocks.showToast).toHaveBeenCalledWith({
      title: '创建计划失败，请检查本机存储空间',
      icon: 'none',
    })
  })

  it('0/150/300/450ms 重复滑倒调用只原子落一组关联记录，重载后仍完整', async () => {
    taroMocks.values.set(STORAGE_KEY, structuredClone(validState()))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }

    const mounted = render(createElement(AppStateProvider, undefined, createElement(Probe)))
    expect(current?.ready).toBe(true)
    const operationId = 'lapse-operation-replayed-at-four-delays'
    const results: boolean[] = []

    vi.useFakeTimers()
    try {
      for (const delay of [0, 150, 300, 450]) {
        setTimeout(() => {
          results.push(current!.actions.recordLapse(
            1,
            'stress',
            '马上做一次烟瘾急救',
            undefined,
            operationId,
            { cravingIntensity: 4 },
          ))
        }, delay)
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(450)
      })

      expect(results).toEqual([true, true, true, true])
      expect(current?.state.cigarettes).toHaveLength(1)
      expect(current?.state.lapses).toHaveLength(1)
      expect(current?.state.lapses[0]).toMatchObject({
        id: operationId,
        cigaretteLogId: current?.state.cigarettes[0]?.id,
      })

      const persisted = structuredClone(taroMocks.values.get(STORAGE_KEY)) as ClientState
      expect(persisted.cigarettes).toHaveLength(1)
      expect(persisted.lapses).toHaveLength(1)
      expect(persisted.lapses[0]?.cigaretteLogId).toBe(persisted.cigarettes[0]?.id)

      mounted.unmount()
      render(createElement(AppStateProvider, undefined, createElement(Probe)))
      expect(current?.ready).toBe(true)
      expect(current?.state.cigarettes).toEqual(persisted.cigarettes)
      expect(current?.state.lapses).toEqual(persisted.lapses)
    } finally {
      vi.useRealTimers()
    }
  })

  it('删除会等待已获得的导入租约退出，随后完成全部清理', async () => {
    runtimeMocks.native = true
    const stored = validState()
    taroMocks.values.set(STORAGE_KEY, structuredClone(stored))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }
    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.ready).toBe(true))

    const reservation = current!.actions.reserveDataImport()
    const importLease = await current!.actions.beginDataImport(reservation)
    const deletion = current!.actions.deleteAllData()
    await Promise.resolve()
    expect(runtimeMocks.purgeExports).not.toHaveBeenCalled()
    importLease!.release()
    await act(async () => {
      await expect(deletion).resolves.toBe(true)
    })

    expect(runtimeMocks.cancelReminder).toHaveBeenCalledTimes(1)
    expect(runtimeMocks.purgeExports).toHaveBeenCalledTimes(1)
    expect(taroMocks.values.has(STORAGE_KEY)).toBe(false)
    expect(taroMocks.values.has(BACKUP_STORAGE_KEY)).toBe(false)
    await waitFor(() => expect(current?.state.onboarded).toBe(false))
  })

  it('损坏清除的原生清理失败时保持 loadFailure，重试成功后才切换为空状态', async () => {
    runtimeMocks.native = true
    taroMocks.values.set(STORAGE_KEY, '{broken-json')
    taroMocks.showModal.mockResolvedValue({ confirm: true })
    runtimeMocks.purgeExports.mockRejectedValueOnce(new Error('purge failed'))
    let current: ReturnType<typeof useAppState> | undefined
    function Probe() {
      current = useAppState()
      return null
    }
    render(createElement(AppStateProvider, undefined, createElement(Probe)))
    await waitFor(() => expect(current?.loadFailure).toBeInstanceOf(Error))

    await act(async () => current!.actions.clearCorruptedState())
    expect(current?.ready).toBe(false)
    expect(current?.loadFailure).toBeInstanceOf(Error)
    expect(taroMocks.values.get(STORAGE_KEY)).toBe('{broken-json')

    await act(async () => current!.actions.clearCorruptedState())
    expect(current?.ready).toBe(true)
    expect(current?.loadFailure).toBeUndefined()
    expect(taroMocks.values.has(STORAGE_KEY)).toBe(false)
    expect(runtimeMocks.cancelReminder).toHaveBeenCalledTimes(2)
    expect(runtimeMocks.purgeExports).toHaveBeenCalledTimes(2)
  })
})
