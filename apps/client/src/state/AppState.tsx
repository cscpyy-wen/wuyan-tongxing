import Taro from '@tarojs/taro'
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  applyCigaretteLog,
  applyDailyCheckIn,
  applyLapseEvent,
  adjustClientReductionLimit,
  createClientPlan,
  createId,
  createInitialState,
  STORAGE_KEY,
  parseStoredStateStrict,
  resolveCravingEvent,
  removeDailyCheckIn,
  removeCigaretteLog,
  updateLapseRecoveryAction,
  startNextClientAttempt,
  toLocalDate,
  updateCravingEventLevel,
  updateCigaretteLog,
  upsertOutcomeAssessment,
} from '../lib/model'
import {
  BACKUP_STORAGE_KEY,
  createLocalStateRepository,
  MAX_CLIENT_STATE_BYTES,
  MAX_TARO_STORAGE_WRAPPER_CHARACTERS,
} from '../lib/localRepository'
import {
  encodeLosslessBase64,
  MAX_SINGLE_NATIVE_RECOVERY_BYTES,
  utf8ByteLength,
} from '../lib/recoveryCodec'
import {
  acknowledgeAndroidBootstrapQuarantine,
  acknowledgeAndroidBootstrapQueue,
  applyAndroidBootstrapImportJournal,
  ANDROID_BOOTSTRAP_QUARANTINE_KEY,
  ANDROID_BOOTSTRAP_QUEUE_KEY,
  ANDROID_BOOTSTRAP_QUEUE_EVENT,
  ANDROID_BOOTSTRAP_IMPORT_MARKER_FIELD,
  ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY,
  clearAndroidBootstrapImportJournal,
  clearAndroidBackupRestoreIntent,
  clearAndroidBootstrapData,
  isolateAndroidBootstrapQuarantineCorruption,
  isolateAndroidBootstrapQueueCorruption,
  hasAndroidBootstrapRecoveryToRotate,
  hasAndroidBackupRestoreIntent,
  markAndroidBackupRestoreResultCommitted,
  moveAndroidBootstrapEventsToQuarantine,
  readAndroidBackupRestoreIntentState,
  readAndroidBootstrapQuarantine,
  readAndroidBootstrapQueue,
  readAndroidBootstrapImportJournal,
  readAndroidBootstrapImportMarker,
  rotateAndroidBootstrapCorruptArchiveAfterExport,
  sanitizeAndroidBootstrapRecoveryData,
  exportAndroidBootstrapRecoveryData,
  snapshotAndroidBootstrapData,
  stageAndroidBootstrapImportJournal,
  type AndroidBootstrapCigarette,
  AndroidBootstrapImportRollbackError,
  AndroidBootstrapRecoveryBlockedError,
} from '../lib/androidBootstrapQueue'
import {
  DataMutationCoordinator,
  type DataImportLease,
  type DataImportReservation,
  type DataPlatformMutationLease,
} from '../lib/dataMutation'
import {
  cancelDailyReminder,
  acknowledgePendingNativeExportOutcome,
  nativeExportCleanupIssue,
  nativeExportCleanupFilename,
  isNativeAndroidApp,
  purgeNativeAppPrivatePendingExports,
  saveNativeRecoveryJsonFile,
} from '../lib/runtime'
import { runAppModal } from '../lib/modalCoordinator'
import { showNativeExportCleanupIssue } from '../lib/nativeExportCleanupUi'
import { assertProjectedTaroWriteFits } from '../lib/localStorageBudget'
import {
  createBoundedNativeRecoveryBundle,
  MAX_RECOVERY_IMPORT_CHARACTERS,
  MAX_RECOVERY_PENDING_IMPORT_RAW_CHARACTERS,
  parseRecoveryImportCandidate,
} from '../lib/recoveryBundle'
import {
  getNativeDurableStore,
  NATIVE_DURABLE_STATE_MAX_BYTES,
  parseNativeDurableValue,
} from '../lib/nativeDurableStore'
import { getAndroidHealthStorage, migrateLegacyAndroidHealthStorage } from '../lib/androidHealthStorage'
import type {
  ClientBaseline,
  ClientCheckIn,
  ClientCigaretteLog,
  ClientCravingEvent,
  ClientLapseEvent,
  ClientOutcomeAssessment,
  ClientSettings,
  ClientState,
  CravingLevel,
  OnboardingPayload,
  Trigger,
} from '../types'

interface AppStateActions {
  finishOnboarding(payload: OnboardingPayload): boolean
  startNewAttempt(
    path: OnboardingPayload['path'],
    quitDate: string,
    baselineUpdate?: Pick<ClientBaseline, 'cigarettesPerDay' | 'pricePerPack'>,
  ): boolean
  adjustReductionLimit(ratio: 0.75 | 0.5 | 0.25, delta: -1 | 1): boolean
  recordCheckIn(cigarettesSmoked: number, cravingPeak: CravingLevel): boolean
  removeTodayCheckIn(): boolean
  recordCraving(level: CravingLevel, trigger?: Trigger, technique?: string): string | undefined
  updateCravingLevel(id: string, level: CravingLevel): boolean
  resolveCraving(id: string, technique: string, level: CravingLevel): boolean
  recordCigarette(input: { smokedAt: string; trigger: Trigger; cravingIntensity: CravingLevel }): string | undefined
  editCigarette(id: string, input: { smokedAt: string; trigger: Trigger; cravingIntensity: CravingLevel }): boolean
  deleteCigaretteLog(id: string): boolean
  recordLapse(
    cigarettes: number,
    trigger: Trigger | undefined,
    recoveryAction: string,
    cigaretteLogId: string | undefined,
    operationId: string,
    context?: { smokedAt?: string; cravingIntensity?: CravingLevel },
  ): boolean
  editLapseRecoveryAction(id: string, recoveryAction: string): boolean
  recordOutcome(outcome: Omit<ClientOutcomeAssessment, 'id' | 'assessedAt' | 'selfReported' | 'biochemicallyVerified'>): boolean
  completeTask(contentId: string): boolean
  updateSettings(patch: Partial<ClientSettings>): boolean
  reserveDataImport(): DataImportReservation | undefined
  beginDataImport(reservation?: DataImportReservation): Promise<DataImportLease | undefined>
  beginDataPlatformMutation(): Promise<DataPlatformMutationLease | undefined>
  deleteAllData(): Promise<boolean>
  exportData(): string
  importData(json: string, lease: DataImportLease): false | { bootstrapRecoverySkipped: boolean }
  offerAndroidBootstrapRecoveryRotationAfterExport(): Promise<void>
  retryLocalState(): void
  exportRecoveryData(): Promise<void>
  clearCorruptedState(): Promise<void>
  finishPendingBackupRestore(): void
}

interface AppStateContextValue {
  state: ClientState
  ready: boolean
  loadFailure: Error | undefined
  backupRestorePending: boolean
  actions: AppStateActions
}

const AppStateContext = createContext<AppStateContextValue | undefined>(undefined)

const taroStorageReadCache = new Map<string, {
  raw: string
  value?: unknown
  error?: Error
}>()

function readLegacyTaroStorageSafely(key: string): unknown {
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(key)
    if (raw !== null) {
      const cached = taroStorageReadCache.get(key)
      if (cached?.raw === raw) {
        if (cached.error) throw cached.error
        return cached.value
      }
      // Taro H5 stores { data: value }. Inspect the raw wrapper before parsing
      // so a corrupt multi-megabyte value cannot allocate an object graph on
      // the WebView main thread. readRaw still exposes it for recovery export.
      const wrapperLimit = getNativeDurableStore()
        ? NATIVE_DURABLE_STATE_MAX_BYTES + 1_024
        : MAX_TARO_STORAGE_WRAPPER_CHARACTERS
      if (raw.length > wrapperLimit) {
        const error = new Error('本机数据超过安全读取上限')
        taroStorageReadCache.set(key, { raw, error })
        throw error
      }
      try {
        const wrapper = JSON.parse(raw) as { data?: unknown }
        if (!wrapper || typeof wrapper !== 'object'
          || !Object.prototype.hasOwnProperty.call(wrapper, 'data')) throw new Error('invalid wrapper')
        taroStorageReadCache.set(key, { raw, value: wrapper.data })
        return wrapper.data
      } catch {
        const error = new Error('本机数据无法安全读取')
        taroStorageReadCache.set(key, { raw, error })
        throw error
      }
    }
  }
  return Taro.getStorageSync(key)
}

function readCoreStorageSafely(key: string): unknown {
  const durable = getNativeDurableStore()
  if (durable?.hasValue(key)) return parseNativeDurableValue(durable.readValue(key))
  return readLegacyTaroStorageSafely(key)
}

const localRepository = createLocalStateRepository({
  read: readCoreStorageSafely,
  write: (key, value) => {
    taroStorageReadCache.delete(key)
    const durable = getNativeDurableStore()
    if (durable) {
      const serialized = JSON.stringify(value)
      durable.writeValue(key, serialized)
      // writeValue returns only after native fsync, atomic replace and exact
      // readback. A second bridge read could misreport a committed write as
      // failed if that verification call alone were interrupted.
      // Durable state is authoritative after its atomic write completes. The
      // legacy WebView copy is removed only afterwards for one-way migration.
      try { Taro.removeStorageSync(key) } catch { /* retried on next startup */ }
      return
    }
    if (typeof window !== 'undefined' && window.localStorage) {
      assertProjectedTaroWriteFits(window.localStorage, key, value)
    }
    Taro.setStorageSync(key, value)
  },
  remove: (key) => {
    taroStorageReadCache.delete(key)
    const durable = getNativeDurableStore()
    if (durable) {
      durable.removeValue(key)
      if (durable.hasValue(key)) throw new Error('本机持久数据删除后仍存在')
    }
    Taro.removeStorageSync(key)
  },
  exists: (key) => Boolean(getNativeDurableStore()?.hasValue(key))
    || Taro.getStorageInfoSync().keys.includes(key),
  readRaw: (key) => {
    const durable = getNativeDurableStore()
    if (durable?.hasValue(key)) return durable.readRawValue(key)
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(key)
    }
    try {
      return readLegacyTaroStorageSafely(key)
    } catch {
      return undefined
    }
  },
  maxStateBytes: () => getNativeDurableStore()
    ? NATIVE_DURABLE_STATE_MAX_BYTES
    : MAX_CLIENT_STATE_BYTES,
  maxReadStateBytes: NATIVE_DURABLE_STATE_MAX_BYTES,
  supportsDedicatedDeletionIntent: () => Boolean(getNativeDurableStore()),
  readLegacyDeletionFallback: () => {
    if (typeof window === 'undefined' || !window.localStorage) return undefined
    const raw = window.localStorage.getItem(BACKUP_STORAGE_KEY)
    if (raw === null || raw.length > 512) return undefined
    try {
      const wrapper = JSON.parse(raw) as { data?: unknown }
      return wrapper && typeof wrapper === 'object'
        && Object.prototype.hasOwnProperty.call(wrapper, 'data')
        ? wrapper.data
        : undefined
    } catch {
      return undefined
    }
  },
  clearLegacyDeletionFallback: () => {
    taroStorageReadCache.delete(BACKUP_STORAGE_KEY)
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(BACKUP_STORAGE_KEY)
    }
  },
})

function markLocalStateLoad(status: 'loaded' | 'failed'): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.wuyanLocalState = status
  }
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark(`wuyan-local-state-${status}`)
  }
}

type BackupRestoreRecoveryNotice = 'none' | 'completed-after-restart'

function hasDurableBackupRestoreIntent(): boolean {
  const storage = getAndroidHealthStorage()
  return Boolean(storage && hasAndroidBackupRestoreIntent(storage))
}

function recoverPendingAndroidBootstrapImport(): BackupRestoreRecoveryNotice {
  migrateLegacyAndroidHealthStorage()
  const storage = getAndroidHealthStorage()
  if (!storage) return 'none'
  const restoreIntent = readAndroidBackupRestoreIntentState(storage)
  const journal = readAndroidBootstrapImportJournal(storage)
  if (!journal) {
    // The backup is non-authoritative while a valid primary exists. Reading it
    // here used to let an unrelated damaged/oversized backup block startup.
    const rawPrimary = readCoreStorageSafely(STORAGE_KEY)
    const primaryMarker = readAndroidBootstrapImportMarker(rawPrimary)
    if (primaryMarker) throw new Error('快速记录导入事务缺少恢复日志')
    if (rawPrimary === undefined || rawPrimary === null || rawPrimary === '') {
      const backupMarker = readAndroidBootstrapImportMarker(readCoreStorageSafely(BACKUP_STORAGE_KEY))
      if (backupMarker) throw new Error('快速记录导入事务缺少恢复日志')
    }
    // A selected Android document is staged in the native no-backup store,
    // independently of this auxiliary import journal. Keep waiting/accepted/
    // committed intent intact so NativeRuntimeBridge can probe, replay or
    // acknowledge the exact native UUID after this provider has mounted.
    return 'none'
  }
  let rawPrimary: unknown
  let primaryMarker: string | undefined
  try {
    rawPrimary = readCoreStorageSafely(STORAGE_KEY)
    primaryMarker = readAndroidBootstrapImportMarker(rawPrimary)
  } catch {
    // A matching verified backup may still complete the explicit transaction.
  }
  let matchingCore = primaryMarker === journal.id ? rawPrimary : undefined
  let matchingBackup = false
  if (matchingCore === undefined) {
    const rawBackup = readCoreStorageSafely(BACKUP_STORAGE_KEY)
    const backupMarker = readAndroidBootstrapImportMarker(rawBackup)
    if (backupMarker === journal.id) {
      matchingCore = rawBackup
      matchingBackup = true
    }
  }
  if (matchingCore === undefined) {
    // The journal was staged, but the imported primary never committed (or a
    // later verified write already removed its marker). It is an orphan and
    // must never be applied to whichever plan is currently stored.
    clearAndroidBootstrapImportJournal(storage)
    // If a native restore intent still exists, its authenticated staged file
    // remains the source for a clean retry. Clearing it here would orphan that
    // payload before the app-level controller can inspect it.
    return 'none'
  }
  const imported = parseStoredStateStrict(matchingCore)
  applyAndroidBootstrapImportJournal(storage, journal)
  if (matchingBackup) localRepository.replaceCorruptedPrimaryFromVerifiedBackup(imported)
  else localRepository.save(imported)
  clearAndroidBootstrapImportJournal(storage)
  if (restoreIntent?.phase === 'accepted' && restoreIntent.id) {
    // The core and auxiliary records are now one verified transaction. Mark
    // committed before the native payload is acknowledged so a crash retries
    // only notification/ack, never the whole-state import.
    markAndroidBackupRestoreResultCommitted(storage, restoreIntent.id)
    return 'none'
  }
  if (restoreIntent?.phase === 'committed') return 'none'
  if (restoreIntent?.phase === 'accepted') {
    // Compatibility with the pre-ID v20 intent. That release had no durable
    // native selected-file slot to acknowledge after this journal completes.
    clearAndroidBackupRestoreIntent(storage)
    return 'completed-after-restart'
  }
  return 'none'
}

function showRecoveredFromBackupNotice(): void {
  void runAppModal(() => Taro.showModal({
    title: '已恢复上次完整记录',
    content: '主数据无法读取，应用已使用上一份校验通过的本机副本。原数据没有被静默覆盖。',
    showCancel: false,
    confirmText: '知道了',
  })).catch(() => showToastBestEffort('已从本机完整副本恢复'))
}

function showToastBestEffort(title: string): void {
  try {
    void Promise.resolve(Taro.showToast({ title, icon: 'none' })).catch(() => undefined)
  } catch {
    // State and durable recovery data remain authoritative if transient UI fails.
  }
}

function showBootstrapIsolationFailure(error: unknown): void {
  if (!(error instanceof AndroidBootstrapRecoveryBlockedError)) {
    showToastBestEffort('快速记录异常，原数据已保留')
    return
  }
  void runAppModal(() => Taro.showModal({
    title: '快速记录恢复区已满',
    content: '异常原始记录仍完整保留。请先到“我的”导出数据副本，再按提示释放恢复区。',
    confirmText: '去导出',
    cancelText: '稍后',
  })).then((result) => {
    if (result.confirm) void Taro.switchTab({ url: '/pages/profile/index' })
  }).catch(() => showToastBestEffort('恢复区已满，请到“我的”导出副本'))
}

function bootstrapEventMatchesStoredLog(
  event: AndroidBootstrapCigarette,
  attemptId: string,
  stored: ClientCigaretteLog,
): boolean {
  return stored.id === event.id
    && new Date(stored.createdAt).getTime() === new Date(event.smokedAt).getTime()
    && stored.count === 1
    && stored.trigger === event.trigger
    && stored.cravingIntensity === event.cravingIntensity
    && stored.attemptId === attemptId
    && stored.source === 'QUICK_LOG'
}

export function AppStateProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<ClientState>(createInitialState)
  const stateRef = useRef<ClientState>(state)
  const dataMutationsRef = useRef<DataMutationCoordinator>()
  if (!dataMutationsRef.current) dataMutationsRef.current = new DataMutationCoordinator()
  const dataMutations = dataMutationsRef.current
  const [ready, setReady] = useState(false)
  const [loadFailure, setLoadFailure] = useState<Error | undefined>()
  const [backupRestorePending, setBackupRestorePending] = useState(false)
  const initializationStarted = useRef(false)
  const quarantinePromptRunning = useRef(false)
  const quarantinePromptedSignature = useRef<string>()
  const resolveQuarantineRef = useRef<() => Promise<void>>(async () => undefined)

  const loadLocalState = useCallback(() => {
    try {
      const backupRestoreRecoveryNotice = recoverPendingAndroidBootstrapImport()
      const loaded = localRepository.load()
      if (getNativeDurableStore()) {
        const legacyPrimary = typeof window !== 'undefined' && window.localStorage
          ? window.localStorage.getItem(STORAGE_KEY)
          : null
        const legacyBackup = typeof window !== 'undefined' && window.localStorage
          ? window.localStorage.getItem(BACKUP_STORAGE_KEY)
          : null
        if (legacyPrimary !== null || legacyBackup !== null) {
          // One verified startup migrates both legacy WebView slots into the
          // no-backup atomic native store before any page can report ready.
          localRepository.save(loaded.state)
        }
      }
      const androidStorage = getAndroidHealthStorage()
      const restorePending = Boolean(androidStorage && hasAndroidBackupRestoreIntent(androidStorage))
      stateRef.current = loaded.state
      setState(loaded.state)
      setLoadFailure(undefined)
      setBackupRestorePending(restorePending)
      setReady(!restorePending)
      if (!restorePending) markLocalStateLoad('loaded')
      if (!restorePending && loaded.recoveredFromBackup) showRecoveredFromBackupNotice()
      if (!restorePending && backupRestoreRecoveryNotice === 'completed-after-restart') {
        showToastBestEffort('上次备份恢复已完成')
      }
    } catch (error) {
      setReady(false)
      setBackupRestorePending(false)
      setLoadFailure(error instanceof Error ? error : new Error('本机数据无法安全读取'))
      markLocalStateLoad('failed')
    }
  }, [])

  const commitState = useCallback((
    update: (previous: ClientState) => ClientState,
    failureTitle = '本地保存失败，本次更改未生效',
    importLease?: DataImportLease,
  ): boolean => {
    if (!importLease && (backupRestorePending || hasDurableBackupRestoreIntent())) {
      Taro.showToast({ title: '正在等待备份恢复结果', icon: 'none' })
      return false
    }
    if (importLease) {
      if (!importLease.isCurrent()) return false
    } else if (!dataMutations.canCommitRegularMutation()) {
      Taro.showToast({ title: '数据清理进行中，请稍后再试', icon: 'none' })
      return false
    }
    const previous = stateRef.current
    let next: ClientState
    try {
      next = update(previous)
    } catch {
      Taro.showToast({ title: failureTitle, icon: 'none' })
      return false
    }
    if (next === previous) return false
    try {
      if (importLease && !importLease.isCurrent()) return false
      localRepository.save(next)
      // A committed whole-state import also invalidates any older import that
      // was queued behind it; sensitive state is never overwritten by a stale
      // second restore merely because the operations were serialised.
      dataMutations.invalidateImports()
      stateRef.current = next
      setState(next)
      return true
    } catch {
      Taro.showToast({ title: failureTitle, icon: 'none' })
      return false
    }
  }, [backupRestorePending, dataMutations])

  const resolveAndroidBootstrapQuarantine = useCallback(async () => {
    if (!isNativeAndroidApp()) return
    if (hasDurableBackupRestoreIntent()) return
    const storage = getAndroidHealthStorage()
    if (!storage) return
    try {
      if (isolateAndroidBootstrapQuarantineCorruption(storage)) {
        Taro.showToast({ title: '异常待归类记录已保留在数据副本中', icon: 'none' })
      }
    } catch (error) {
      showBootstrapIsolationFailure(error)
      return
    }
    const quarantined = readAndroidBootstrapQuarantine(storage)
    if (quarantined.length === 0) return
    const promptState = stateRef.current
    const deletedIds = new Set(promptState.deletedCigaretteIds)
    const deletedQuarantined = quarantined.filter((event) => deletedIds.has(event.id))
    if (deletedQuarantined.length > 0) {
      try {
        acknowledgeAndroidBootstrapQuarantine(storage, new Set(deletedQuarantined.map((event) => event.id)))
      } catch {
        Taro.showToast({ title: '已删除记录仍待清理，将自动重试', icon: 'none' })
        return
      }
    }
    let liveQuarantined = quarantined.filter((event) => !deletedIds.has(event.id))
    if (liveQuarantined.length === 0) return
    if (!promptState.onboarded || !promptState.plan || !promptState.settings.sensitiveHealthData) return
    if (!dataMutations.canCommitRegularMutation() || quarantinePromptRunning.current) return

    const existingById = new Map(promptState.cigarettes.map((item) => [item.id, item]))
    const exactReplays = liveQuarantined.filter((event) => {
      const stored = existingById.get(event.id)
      return Boolean(stored && bootstrapEventMatchesStoredLog(event, promptState.plan!.id, stored))
    })
    if (exactReplays.length > 0) {
      try {
        acknowledgeAndroidBootstrapQuarantine(storage, new Set(exactReplays.map((event) => event.id)))
      } catch {
        showToastBestEffort('已保存记录的暂存清理将重试')
        return
      }
      const replayIds = new Set(exactReplays.map((event) => event.id))
      liveQuarantined = liveQuarantined.filter((event) => !replayIds.has(event.id))
      if (liveQuarantined.length === 0) return
    }

    const signature = `${promptState.plan.id}:${liveQuarantined.map((event) => event.id).sort().join('|')}`
    if (quarantinePromptedSignature.current === signature) return
    quarantinePromptedSignature.current = signature
    const conflicting = liveQuarantined.filter((event) => {
      const stored = existingById.get(event.id)
      return Boolean(stored && !bootstrapEventMatchesStoredLog(event, promptState.plan!.id, stored))
    })
    const conflictingIds = new Set(conflicting.map((event) => event.id))
    const actionable = liveQuarantined.filter((event) => !conflictingIds.has(event.id))
    if (conflicting.length > 0) {
      showToastBestEffort(`${conflicting.length} 条冲突记录已保留`)
    }
    if (actionable.length === 0) return
    quarantinePromptRunning.current = true
    const promptedPlanId = promptState.plan.id
    try {
      const choice = await runAppModal(() => Taro.showModal({
        title: '有待归类的快速记录',
        content: `${actionable.length} 条记录来自已替换的计划，是否归入当前计划？`,
        confirmText: '归入当前',
        cancelText: '暂不处理',
      }))
      if (!choice.confirm) return

      const current = stateRef.current
      if (current !== promptState) {
        quarantinePromptedSignature.current = undefined
        Taro.showToast({ title: '记录已变化，请重新确认', icon: 'none' })
        return
      }
      if (!current.onboarded || !current.plan || !current.settings.sensitiveHealthData) return
      if (current.plan.id !== promptedPlanId || !dataMutations.canCommitRegularMutation()) {
        quarantinePromptedSignature.current = undefined
        Taro.showToast({ title: '计划已变化，请重新确认', icon: 'none' })
        return
      }

      const loggedAt = new Date().toISOString()
      const next = actionable
        .filter((event) => !current.deletedCigaretteIds.includes(event.id))
        .reduce((candidate, event) => applyCigaretteLog(candidate, {
        id: event.id,
        createdAt: event.smokedAt,
        loggedAt,
        count: 1,
        trigger: event.trigger,
        cravingIntensity: event.cravingIntensity,
        attemptId: current.plan!.id,
        source: 'QUICK_LOG',
        }), current)
      let stateCommitted = next === current
      try {
        if (next !== current) {
          localRepository.save(next)
          stateCommitted = true
          dataMutations.invalidateImports()
          stateRef.current = next
          setState(next)
        }
        acknowledgeAndroidBootstrapQuarantine(storage, new Set(actionable.map((event) => event.id)))
        quarantinePromptedSignature.current = conflicting.length > 0
          ? `${current.plan.id}:${conflicting.map((event) => event.id).sort().join('|')}`
          : undefined
      } catch {
        quarantinePromptedSignature.current = undefined
        Taro.showToast({
          title: stateCommitted ? '记录已保存，暂存清理将重试' : '待归类记录尚未处理，请稍后重试',
          icon: 'none',
        })
      }
    } catch {
      quarantinePromptedSignature.current = undefined
      Taro.showToast({ title: '待归类记录尚未处理，请稍后重试', icon: 'none' })
    } finally {
      quarantinePromptRunning.current = false
      // A static queue event can append a new quarantined record while the
      // modal is open. Re-read once only when the plan/ID set actually changed;
      // retrying an unchanged failed batch at 0 ms would create a modal loop.
      try {
        const remaining = readAndroidBootstrapQuarantine(storage)
        const currentPlanId = stateRef.current.plan?.id
        const nextSignature = currentPlanId && remaining.length > 0
          ? `${currentPlanId}:${remaining.map((event) => event.id).sort().join('|')}`
          : undefined
        if (nextSignature && nextSignature !== signature) {
          setTimeout(() => void resolveQuarantineRef.current(), 0)
        }
      } catch {
        // Corrupt/oversized recovery remains durable for the next real event.
      }
    }
  }, [dataMutations])
  resolveQuarantineRef.current = resolveAndroidBootstrapQuarantine

  const consumeAndroidBootstrapQueue = useCallback(() => {
    if (!isNativeAndroidApp()) return
    // Do not acknowledge a quick-log record against the pre-import state: the
    // selected backup could replace that state moments later. It is replayed
    // against the imported plan after finishPendingBackupRestore.
    if (hasDurableBackupRestoreIntent()) return
    const storage = getAndroidHealthStorage()
    if (!storage) return
    try {
      if (isolateAndroidBootstrapQueueCorruption(storage)) {
        Taro.showToast({ title: '异常快速记录已保留在数据副本中', icon: 'none' })
      }
    } catch (error) {
      showBootstrapIsolationFailure(error)
      return
    }
    const pending = readAndroidBootstrapQueue(storage)
    if (pending.length === 0) {
      void resolveAndroidBootstrapQuarantine()
      return
    }
    const current = stateRef.current
    const deletedIds = new Set(current.deletedCigaretteIds)
    const deletedPending = pending.filter((event) => deletedIds.has(event.id))
    if (deletedPending.length > 0) {
      try {
        acknowledgeAndroidBootstrapQueue(storage, new Set(deletedPending.map((event) => event.id)))
      } catch {
        Taro.showToast({ title: '已删除记录仍待清理，将自动重试', icon: 'none' })
        return
      }
    }
    const livePending = pending.filter((event) => !deletedIds.has(event.id))
    if (livePending.length === 0) {
      void resolveAndroidBootstrapQuarantine()
      return
    }
    if (!current.onboarded || !current.plan || !current.settings.sensitiveHealthData) {
      try {
        moveAndroidBootstrapEventsToQuarantine(storage, livePending)
      } catch {
        Taro.showToast({ title: '快速记录尚未转存，将自动重试', icon: 'none' })
      }
      return
    }
    if (!dataMutations.canCommitRegularMutation()) return

    const knownAttemptIds = new Set([current.plan.id, ...current.archivedPlans.map((plan) => plan.id)])
    const applicable = livePending.filter((event): event is AndroidBootstrapCigarette & { attemptId: string } => (
      typeof event.attemptId === 'string' && knownAttemptIds.has(event.attemptId)
    ))
    const unmatched = livePending.filter((event) => !event.attemptId || !knownAttemptIds.has(event.attemptId))
    const existingById = new Map(current.cigarettes.map((item) => [item.id, item]))
    const conflicting = applicable.filter((event) => {
      const stored = existingById.get(event.id)
      return Boolean(stored && !bootstrapEventMatchesStoredLog(event, event.attemptId, stored))
    })
    const conflictingIds = new Set(conflicting.map((event) => event.id))
    const applicableWithoutConflicts = applicable.filter((event) => !conflictingIds.has(event.id))
    const acknowledgedIds = new Set(applicableWithoutConflicts.map((event) => event.id))
    if (unmatched.length > 0) {
      try {
        moveAndroidBootstrapEventsToQuarantine(storage, unmatched)
      } catch {
        Taro.showToast({ title: '待归类记录尚未转存，将自动重试', icon: 'none' })
      }
    }
    if (conflicting.length > 0) {
      try {
        moveAndroidBootstrapEventsToQuarantine(storage, conflicting)
        showToastBestEffort(`${conflicting.length} 条冲突记录已保留`)
      } catch {
        Taro.showToast({ title: '冲突记录尚未隔离，将自动重试', icon: 'none' })
        return
      }
    }
    if (applicableWithoutConflicts.length === 0) {
      void resolveAndroidBootstrapQuarantine()
      return
    }

    const loggedAt = new Date().toISOString()
    const next = applicableWithoutConflicts
      .filter((event) => !current.deletedCigaretteIds.includes(event.id))
      .reduce((candidate, event) => applyCigaretteLog(candidate, {
      id: event.id,
      createdAt: event.smokedAt,
      loggedAt,
      count: 1,
      trigger: event.trigger,
      cravingIntensity: event.cravingIntensity,
      attemptId: event.attemptId,
      source: 'QUICK_LOG',
      }), current)
    let stateCommitted = next === current
    try {
      if (next !== current) {
        localRepository.save(next)
        stateCommitted = true
        dataMutations.invalidateImports()
        stateRef.current = next
        setState(next)
      }
      // A repeated queue after a successful state write is safe: event ids
      // deduplicate in applyCigaretteLog, then this acknowledgement removes it.
      acknowledgeAndroidBootstrapQueue(storage, acknowledgedIds)
      void resolveAndroidBootstrapQuarantine()
    } catch {
      Taro.showToast({
        title: stateCommitted ? '记录已保存，暂存清理将重试' : '快速记录尚未保存，将自动重试',
        icon: 'none',
      })
    }
  }, [dataMutations, resolveAndroidBootstrapQuarantine])

  useEffect(() => {
    if (!ready || !isNativeAndroidApp() || typeof window === 'undefined') return undefined
    let scheduled: number | undefined
    const handleQueue = () => {
      if (scheduled !== undefined) return
      // The static shell dispatches this event inside the user's Save click.
      // Yield first so it can close the sheet, paint the persisted count, and
      // restore focus before strict parsing/writing a potentially large state.
      scheduled = window.setTimeout(() => {
        scheduled = undefined
        consumeAndroidBootstrapQueue()
      }, 0)
    }
    window.addEventListener(ANDROID_BOOTSTRAP_QUEUE_EVENT, handleQueue)
    handleQueue()
    return () => {
      window.removeEventListener(ANDROID_BOOTSTRAP_QUEUE_EVENT, handleQueue)
      if (scheduled !== undefined) window.clearTimeout(scheduled)
    }
  }, [consumeAndroidBootstrapQueue, ready])

  useEffect(() => {
    if (!ready || !state.onboarded || !state.plan || !state.settings.sensitiveHealthData) return
    void resolveAndroidBootstrapQuarantine()
  }, [
    ready,
    resolveAndroidBootstrapQuarantine,
    state.onboarded,
    state.plan?.id,
    state.settings.sensitiveHealthData,
  ])

  const finishOnboarding = useCallback((payload: OnboardingPayload) => {
    return commitState((previous) => {
      const plan = createClientPlan(payload)
      return {
        ...previous,
        onboarded: true,
        baseline: payload.baseline,
        plan,
        settings: { ...previous.settings, sensitiveHealthData: true },
      }
    }, '创建计划失败，请检查本机存储空间')
  }, [commitState])

  const startNewAttempt = useCallback((
    path: OnboardingPayload['path'],
    quitDate: string,
    baselineUpdate?: Pick<ClientBaseline, 'cigarettesPerDay' | 'pricePerPack'>,
  ) => {
    return commitState((previous) => startNextClientAttempt(previous, path, quitDate, new Date(), baselineUpdate), '新计划保存失败')
  }, [commitState])

  const adjustReductionLimit = useCallback((ratio: 0.75 | 0.5 | 0.25, delta: -1 | 1) => {
    return commitState((previous) => previous.plan
      ? { ...previous, plan: adjustClientReductionLimit(previous.plan, ratio, delta) }
      : previous, '减量上限保存失败')
  }, [commitState])

  const recordCheckIn = useCallback((cigarettesSmoked: number, cravingPeak: CravingLevel) => {
    const now = new Date()
    const currentPlan = stateRef.current.plan
    if (!currentPlan) return false
    const next: ClientCheckIn = {
      id: createId('checkin'),
      date: toLocalDate(now),
      cigarettesSmoked,
      cravingPeak,
      smokeFree: cigarettesSmoked === 0,
      createdAt: now.toISOString(),
      attemptId: currentPlan.id,
    }
    return commitState((previous) => applyDailyCheckIn(previous, next), '今日记录确认失败')
  }, [commitState])

  const removeTodayCheckIn = useCallback(() => {
    const currentPlan = stateRef.current.plan
    if (!currentPlan) return false
    return commitState(
      (previous) => removeDailyCheckIn(previous, currentPlan.id, toLocalDate(new Date())),
      '撤销今日确认失败',
    )
  }, [commitState])

  const recordCraving = useCallback((level: CravingLevel, trigger?: Trigger, technique?: string) => {
    const current = stateRef.current
    if (!current.onboarded || !current.settings.sensitiveHealthData || !current.plan) return undefined
    const id = createId('craving')
    const event: ClientCravingEvent = {
      id,
      createdAt: new Date().toISOString(),
      level,
      ...(trigger ? { trigger } : {}),
      ...(technique ? { technique } : {}),
      attemptId: current.plan.id,
    }
    return commitState(
      (previous) => ({ ...previous, cravings: [event, ...previous.cravings] }),
      '烟瘾记录保存失败，练习仍可继续',
    ) ? id : undefined
  }, [commitState])

  const resolveCraving = useCallback((id: string, technique: string, level: CravingLevel) => {
    return commitState((previous) => ({
      ...previous,
      cravings: resolveCravingEvent(previous.cravings, id, technique, level),
    }), '练习结果保存失败')
  }, [commitState])

  const updateCravingLevel = useCallback((id: string, level: CravingLevel) => {
    return commitState((previous) => ({
      ...previous,
      cravings: updateCravingEventLevel(previous.cravings, id, level),
    }), '烟瘾强度保存失败')
  }, [commitState])

  const recordCigarette = useCallback((input: {
    smokedAt: string
    trigger: Trigger
    cravingIntensity: CravingLevel
  }) => {
    if (!Number.isFinite(new Date(input.smokedAt).getTime())) return undefined
    const currentPlan = stateRef.current.plan
    if (!currentPlan) return undefined
    const id = createId('cigarette')
    const event: ClientCigaretteLog = {
      id,
      createdAt: input.smokedAt,
      loggedAt: new Date().toISOString(),
      count: 1,
      trigger: input.trigger,
      cravingIntensity: input.cravingIntensity,
      attemptId: currentPlan.id,
      source: 'QUICK_LOG',
    }
    return commitState(
      (previous) => applyCigaretteLog(previous, event),
      '本地保存失败，这支烟没有被记录',
    ) ? id : undefined
  }, [commitState])

  const deleteCigaretteLog = useCallback((id: string) => {
    return commitState((previous) => removeCigaretteLog(previous, id), '删除失败，原记录仍保留')
  }, [commitState])

  const editCigarette = useCallback((id: string, input: {
    smokedAt: string
    trigger: Trigger
    cravingIntensity: CravingLevel
  }) => {
    if (!Number.isFinite(new Date(input.smokedAt).getTime())) return false
    return commitState(
      (previous) => updateCigaretteLog(previous, id, input),
      '修改失败，原记录仍保留',
    )
  }, [commitState])

  const recordLapse = useCallback(
    (
      cigarettes: number,
      trigger: Trigger | undefined,
      recoveryAction: string,
      cigaretteLogId: string | undefined,
      operationId: string,
      context?: { smokedAt?: string; cravingIntensity?: CravingLevel },
    ) => {
      const current = stateRef.current
      const currentAttemptId = current.plan?.id
      if (!currentAttemptId) return false
      if (!operationId || operationId.length > 128) return false
      // Replaying the same page-generated operation is already successful.
      // The model performs the same check so idempotency does not depend on
      // this action-layer fast path.
      if (current.lapses.some((item) => item.id === operationId)) return true
      const referenced = cigaretteLogId
        ? current.cigarettes.find((item) => item.id === cigaretteLogId && item.attemptId === currentAttemptId)
        : undefined
      if (cigaretteLogId && !referenced) return false
      if (!referenced && (!Number.isInteger(cigarettes) || cigarettes < 1 || cigarettes > 60)) return false
      const createdAt = referenced?.createdAt ?? context?.smokedAt ?? new Date().toISOString()
      if (!Number.isFinite(new Date(createdAt).getTime()) || new Date(createdAt).getTime() > Date.now() + 60_000) return false
      const lapseTrigger = referenced?.trigger ?? trigger
      const cravingIntensity = referenced?.cravingIntensity ?? context?.cravingIntensity
      if (!referenced && (!lapseTrigger || !cravingIntensity)) return false
      const event: ClientLapseEvent = {
        id: operationId,
        createdAt,
        cigarettes: referenced?.count ?? cigarettes,
        recoveryAction,
        ...(lapseTrigger ? { trigger: lapseTrigger } : {}),
        ...(cravingIntensity ? { cravingIntensity } : {}),
        ...(referenced ? { cigaretteLogId: referenced.id } : {}),
        attemptId: currentAttemptId,
      }
      return commitState((previous) => applyLapseEvent(previous, event), '恢复记录保存失败')
    },
    [commitState],
  )

  const editLapseRecoveryAction = useCallback((id: string, recoveryAction: string) => {
    if (!id || id.length > 128) return false
    return commitState(
      (previous) => updateLapseRecoveryAction(previous, id, recoveryAction),
      '复盘修改保存失败，原记录仍保留',
    )
  }, [commitState])

  const completeTask = useCallback((contentId: string) => {
    return commitState((previous) => {
      if (!previous.plan) return previous
      if (previous.completedTasks.some((item) => item.contentId === contentId && item.attemptId === previous.plan!.id)) return previous
      return {
        ...previous,
        completedTasks: [
          ...previous.completedTasks,
          { contentId, completedAt: new Date().toISOString(), attemptId: previous.plan.id },
        ],
      }
    }, '任务完成状态保存失败')
  }, [commitState])

  const recordOutcome = useCallback((outcome: Omit<ClientOutcomeAssessment, 'id' | 'assessedAt' | 'selfReported' | 'biochemicallyVerified'>) => {
    const next: ClientOutcomeAssessment = {
      ...outcome,
      id: createId('outcome'),
      assessedAt: new Date().toISOString(),
      selfReported: true,
      biochemicallyVerified: false,
    }
    return commitState((previous) => ({
      ...previous,
      outcomes: upsertOutcomeAssessment(previous.outcomes, next),
    }), '随访保存失败')
  }, [commitState])

  const updateSettings = useCallback((patch: Partial<ClientSettings>) => {
    return commitState((previous) => {
      // Sensitive-health consent owns the whole local plan lifecycle. It can
      // only be granted by onboarding or withdrawn through complete deletion;
      // a generic settings patch must never persist an internally invalid
      // "no consent but health data remains" state.
      if (patch.sensitiveHealthData !== undefined
        && patch.sensitiveHealthData !== previous.settings.sensitiveHealthData) return previous
      return {
        ...previous,
        settings: { ...previous.settings, ...patch },
      }
    }, '设置保存失败')
  }, [commitState])

  const performCompleteDataDeletion = useCallback(async (failureTitle: string): Promise<boolean> => {
    const mutationLease = await dataMutations.beginDestructiveMutation()
    try {
      // Persist the user's deletion decision before any asynchronous platform
      // work. A process death at every later phase restarts into a blocked,
      // resumable deletion path instead of loading old health data.
      localRepository.beginDeletion()
      // These cleanup steps are deliberately idempotent. If any one fails, the
      // local state and failure UI are not advanced; the same action can safely
      // retry from the beginning without claiming that deletion succeeded.
      if (isNativeAndroidApp()) {
        // A stale notification contains no health payload and must not retain
        // the actual local database when Android temporarily refuses the
        // cancellation request. It will be reconciled again after restart.
        await cancelDailyReminder().catch(() => undefined)
        // This deletion-specific bridge makes only app-private JSON payloads a
        // hard prerequisite. An offline provider grant may remain as a minimal,
        // payload-free cleanup intent, but it cannot keep the core state alive.
        await purgeNativeAppPrivatePendingExports()
      }
      // Taro H5 keeps a compatibility copy of clipboard data in origin
      // storage. It can contain the full export and therefore belongs to the
      // app-local deletion boundary even though the OS clipboard itself is
      // outside the application's reliable control.
      Taro.removeStorageSync('taro_clipboard')
      const clipboardCopy = Taro.getStorageSync('taro_clipboard')
      if (clipboardCopy !== undefined && clipboardCopy !== null && clipboardCopy !== '') {
        throw new Error('剪贴板兼容副本删除失败')
      }
      const androidStorage = getAndroidHealthStorage()
      if (androidStorage) clearAndroidBootstrapData(androidStorage)
      localRepository.clearCoreAfterDeletionIntent()
      localRepository.finishDeletion()
      const initial = createInitialState()
      stateRef.current = initial
      setState(initial)
      setLoadFailure(undefined)
      setBackupRestorePending(false)
      setReady(true)
      markLocalStateLoad('loaded')
      return true
    } catch {
      const initial = createInitialState()
      stateRef.current = initial
      setState(initial)
      setReady(false)
      setLoadFailure(new Error('本机数据删除尚未完成，应用将在重启后继续'))
      markLocalStateLoad('failed')
      Taro.showToast({ title: failureTitle, icon: 'none' })
      return false
    } finally {
      mutationLease.release()
    }
  }, [dataMutations])

  useEffect(() => {
    if (initializationStarted.current) return
    initializationStarted.current = true
    try {
      if (localRepository.hasPendingDeletion()) {
        void performCompleteDataDeletion('正在继续上次未完成的数据删除').then((completed) => {
          if (completed) void Taro.reLaunch({ url: '/pages/onboarding/index' })
        })
        return
      }
      loadLocalState()
    } catch (error) {
      setReady(false)
      setLoadFailure(error instanceof Error ? error : new Error('本机删除状态无法验证'))
      markLocalStateLoad('failed')
    }
  }, [loadLocalState, performCompleteDataDeletion])

  const reserveDataImport = useCallback(() => dataMutations.reserveImport(), [dataMutations])
  const beginDataImport = useCallback(
    (reservation?: DataImportReservation) => dataMutations.beginImport(reservation),
    [dataMutations],
  )
  const beginDataPlatformMutation = useCallback(
    () => dataMutations.beginPlatformMutation(),
    [dataMutations],
  )

  const deleteAllData = useCallback(() => performCompleteDataDeletion(
    '删除未完成，请保留当前页面并重试',
  ), [performCompleteDataDeletion])

  const exportData = useCallback(() => {
    const androidStorage = getAndroidHealthStorage()
    const bootstrapRecovery = androidStorage
      ? exportAndroidBootstrapRecoveryData(androidStorage)
      : undefined
    return JSON.stringify({
      ...state,
      ...(bootstrapRecovery === undefined ? {} : { _androidBootstrapRecovery: bootstrapRecovery }),
    }, null, 2)
  }, [state])

  const importData = useCallback((json: string, importLease: DataImportLease) => {
    if (!importLease.isCurrent()) return false
    let imported: ClientState
    let bootstrapRecovery: unknown
    let bootstrapRecoverySkipped = false
    let bootstrapRecoveryPresent = false
    try {
      if (json.length > MAX_RECOVERY_IMPORT_CHARACTERS) throw new Error('备份超过安全读取上限')
      const parsed = JSON.parse(json) as unknown
      const recovery = parseRecoveryImportCandidate(parsed)
      imported = recovery?.state ?? parseStoredStateStrict(parsed)
      bootstrapRecoveryPresent = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.prototype.hasOwnProperty.call(parsed, '_androidBootstrapRecovery'))
        || recovery?.bootstrapRecovery !== undefined
      bootstrapRecovery = recovery?.bootstrapRecovery ?? (bootstrapRecoveryPresent
        ? (parsed as { _androidBootstrapRecovery?: unknown })._androidBootstrapRecovery
        : undefined)
      bootstrapRecoverySkipped = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && (parsed as { _androidBootstrapRecoverySkipped?: unknown })._androidBootstrapRecoverySkipped === true)
        || Boolean(recovery?.bootstrapRecoverySkipped)
      if (!imported.onboarded || !imported.plan || !imported.baseline || !imported.settings.sensitiveHealthData) {
        throw new Error('备份不包含可恢复的个人计划')
      }
    } catch {
      Taro.showToast({ title: '备份格式无效，未修改现有数据', icon: 'none' })
      return false
    }
    if (!importLease.isCurrent()) return false
    const sanitizedBootstrap = sanitizeAndroidBootstrapRecoveryData(bootstrapRecovery)
    const sanitizedBootstrapRecovery = sanitizedBootstrap.snapshot
    bootstrapRecovery = sanitizedBootstrapRecovery
    bootstrapRecoverySkipped = bootstrapRecoverySkipped || sanitizedBootstrap.skippedInvalidData
    if (!importLease.isCurrent()) return false

    // Imports carrying static quick-log recovery use a small two-record
    // transaction: a durable journal plus the same UUID on the imported core.
    // A process death before the core commit discards the orphan journal; a
    // death afterwards completes the matching journal before state is exposed.
    const androidStorage = getAndroidHealthStorage()
    if (bootstrapRecoveryPresent && androidStorage) {
      const storage = androidStorage
      const transactionId = createId('bootstrap-import')
      const previousState = stateRef.current
      const staged = {
        ...imported,
        [ANDROID_BOOTSTRAP_IMPORT_MARKER_FIELD]: transactionId,
      }
      let journal
      try {
        journal = stageAndroidBootstrapImportJournal(
          storage,
          transactionId,
          bootstrapRecoverySkipped ? 'overlay' : 'replace',
          sanitizedBootstrapRecovery,
        )
        localRepository.save(staged)
        const stagedPrimaryMarker = readAndroidBootstrapImportMarker(
          readCoreStorageSafely(STORAGE_KEY),
        )
        const stagedBackupMarker = readAndroidBootstrapImportMarker(
          readCoreStorageSafely(BACKUP_STORAGE_KEY),
        )
        if (stagedPrimaryMarker !== transactionId && stagedBackupMarker !== transactionId) {
          throw new Error('导入事务标记写入后校验失败')
        }
      } catch {
        let primaryMarker: string | undefined
        let backupMarker: string | undefined
        let loadedAfterFailure: ClientState
        try {
          primaryMarker = readAndroidBootstrapImportMarker(readCoreStorageSafely(STORAGE_KEY))
          backupMarker = readAndroidBootstrapImportMarker(readCoreStorageSafely(BACKUP_STORAGE_KEY))
          loadedAfterFailure = localRepository.load().state
        } catch {
          // The commit result is unknown. Preserve both recovery records and
          // block the current UI until retry can establish one truth.
          setReady(false)
          setLoadFailure(new Error('导入提交状态无法验证，请重试恢复'))
          markLocalStateLoad('failed')
          return false
        }
        const loadedCanonical = JSON.stringify(loadedAfterFailure)
        const importedCanonical = JSON.stringify(imported)
        const previousCanonical = JSON.stringify(previousState)
        let transactionCommitted = primaryMarker === transactionId || backupMarker === transactionId
        if (!transactionCommitted && loadedCanonical === importedCanonical) {
          // Identical core contents are not authorization to apply an aux
          // journal: the staged marker may never have committed. Re-establish
          // and verify that durable marker before proceeding.
          try {
            localRepository.save(staged)
            primaryMarker = readAndroidBootstrapImportMarker(readCoreStorageSafely(STORAGE_KEY))
            backupMarker = readAndroidBootstrapImportMarker(readCoreStorageSafely(BACKUP_STORAGE_KEY))
            transactionCommitted = primaryMarker === transactionId || backupMarker === transactionId
          } catch {
            transactionCommitted = false
          }
        }
        if (!transactionCommitted && loadedCanonical === previousCanonical
          && primaryMarker === undefined && backupMarker === undefined) {
          try {
            clearAndroidBootstrapImportJournal(storage)
          } catch {
            // A journal without a matching core marker is safely discarded on
            // the next startup before any quick-log data can be consumed.
          }
          Taro.showToast({ title: '导入失败，现有数据保持不变', icon: 'none' })
          return false
        }
        if (!transactionCommitted) {
          setReady(false)
          setLoadFailure(new Error('导入提交状态不一致，请重试恢复'))
          markLocalStateLoad('failed')
          return false
        }
        // The repository reported failure, but the exact matching staged
        // primary is durable (a verified ghost commit). Continue the same
        // transaction instead of deleting its only recovery journal.
      }

      if (!journal) {
        try {
          journal = readAndroidBootstrapImportJournal(storage)
        } catch {
          journal = undefined
        }
      }
      if (!journal || journal.id !== transactionId) {
        setReady(false)
        setLoadFailure(new Error('导入恢复日志无法验证，请重试'))
        markLocalStateLoad('failed')
        return false
      }
      try {
        applyAndroidBootstrapImportJournal(storage, journal)
      } catch (error) {
        if (error instanceof AndroidBootstrapImportRollbackError) {
          setReady(false)
          setLoadFailure(new Error('快速记录恢复尚未完成，请重试'))
          markLocalStateLoad('failed')
          return false
        }
        // The imported core is already durable. Keep the transaction marker
        // only until the core can be cleaned; valid auxiliary data that could
        // not be written is reported as a partial restore, never as full
        // success or silently merged.
        bootstrapRecoverySkipped = true
      }
      try {
        localRepository.save(imported)
        clearAndroidBootstrapImportJournal(storage)
      } catch {
        let primaryMarker: string | undefined
        let backupMarker: string | undefined
        let loadedAfterCleanup: ClientState
        try {
          primaryMarker = readAndroidBootstrapImportMarker(readCoreStorageSafely(STORAGE_KEY))
          backupMarker = readAndroidBootstrapImportMarker(readCoreStorageSafely(BACKUP_STORAGE_KEY))
          loadedAfterCleanup = localRepository.load().state
        } catch {
          setReady(false)
          setLoadFailure(new Error('导入完成状态无法验证，请重试'))
          markLocalStateLoad('failed')
          return false
        }
        if (primaryMarker === transactionId || backupMarker === transactionId) {
          // A matching marker+journal is an intentional at-least-once recovery
          // record. Do not expose or consume either side until retry/startup
          // finishes it as one transaction.
          setReady(false)
          setLoadFailure(new Error('导入恢复尚未完成，请重试'))
          markLocalStateLoad('failed')
          return false
        }
        if (JSON.stringify(loadedAfterCleanup) !== JSON.stringify(imported)) {
          setReady(false)
          setLoadFailure(new Error('导入完成状态不一致，请重试恢复'))
          markLocalStateLoad('failed')
          return false
        }
        // The clean primary did commit and only the now-orphan journal failed
        // to clear. It no longer authorizes an aux write and startup will drop
        // it; one immediate best-effort retry avoids an unnecessary residue.
        try { clearAndroidBootstrapImportJournal(storage) } catch { /* orphan is harmless */ }
      }
      dataMutations.invalidateImports()
      stateRef.current = imported
      setState(imported)
      setTimeout(consumeAndroidBootstrapQueue, 0)
      return { bootstrapRecoverySkipped }
    }

    const committed = commitState(() => imported, '导入失败，现有数据保持不变', importLease)
    if (!committed) return false
    setTimeout(consumeAndroidBootstrapQueue, 0)
    return { bootstrapRecoverySkipped }
  }, [commitState, consumeAndroidBootstrapQueue, dataMutations])

  const exportRecoveryData = useCallback(async () => {
    try {
      const recovery = localRepository.recoverySnapshot()
      const androidStorage = getAndroidHealthStorage()
      const bootstrapRecovery = androidStorage
        ? exportAndroidBootstrapRecoveryData(androidStorage)
        : undefined
      let pendingBootstrapImport: unknown
      let pendingImportAvailable = false
      if (androidStorage) {
        const rawJournal = androidStorage.getItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY)
        pendingImportAvailable = rawJournal !== null
        if (rawJournal === null || rawJournal.length <= MAX_RECOVERY_PENDING_IMPORT_RAW_CHARACTERS) {
          try {
            const journal = readAndroidBootstrapImportJournal(androidStorage)
            const primaryMarker = readAndroidBootstrapImportMarker(readCoreStorageSafely(STORAGE_KEY))
            const backupMarker = readAndroidBootstrapImportMarker(readCoreStorageSafely(BACKUP_STORAGE_KEY))
            if (journal && (primaryMarker === journal.id || backupMarker === journal.id)) {
              pendingBootstrapImport = {
                status: 'validated',
                transactionId: journal.id,
                evidence: encodeLosslessBase64(rawJournal ?? JSON.stringify(journal)),
              }
            }
          } catch {
            if (rawJournal !== null) {
              pendingBootstrapImport = {
                status: 'unreadable',
                evidence: encodeLosslessBase64(rawJournal),
              }
            }
          }
        }
      }
      const bundle = createBoundedNativeRecoveryBundle({
        core: recovery,
        bootstrapRecovery,
        bootstrapAvailable: bootstrapRecovery !== undefined,
        pendingBootstrapImport,
        pendingImportAvailable,
      })
      if (isNativeAndroidApp()) {
        const announceAndAcknowledge = async (title: string): Promise<boolean> => {
          try {
            await Taro.showToast({ title, icon: 'success' })
          } catch {
            await showNativeExportCleanupIssue('pending-export-outcome')
            return false
          }
          try {
            // A foreground lifecycle probe may have acknowledged this same
            // durable outcome after saveJson returned. Absence is therefore an
            // idempotent success; only an actual acknowledgement error blocks.
            await acknowledgePendingNativeExportOutcome()
            return true
          } catch { /* durable outcome remains for foreground/manual acknowledgement */ }
          await showNativeExportCleanupIssue('pending-export-outcome')
          return false
        }

        if (utf8ByteLength(bundle) > MAX_SINGLE_NATIVE_RECOVERY_BYTES) {
          throw new Error('恢复副本超过单文件安全上限')
        }
        const saved = await saveNativeRecoveryJsonFile(bundle)
        if (!saved) {
          await Taro.showToast({ title: '已取消保存', icon: 'none' })
          return
        }
        await announceAndAcknowledge('恢复副本已保存')
      } else {
        await Taro.setClipboardData({ data: bundle })
        await Taro.showToast({ title: '恢复副本已复制', icon: 'success' })
      }
    } catch (error) {
      const cleanupIssue = nativeExportCleanupIssue(error)
      if (cleanupIssue) {
        const savedOutcomeVisible = await showNativeExportCleanupIssue(cleanupIssue, nativeExportCleanupFilename(error))
        if (cleanupIssue === 'saved-local-temporary' && savedOutcomeVisible) {
          await acknowledgePendingNativeExportOutcome().catch(() => false)
        }
      } else {
        Taro.showToast({ title: '恢复副本导出失败', icon: 'none' })
      }
    }
  }, [])

  const offerAndroidBootstrapRecoveryRotationAfterExport = useCallback(async () => {
    const androidStorage = getAndroidHealthStorage()
    if (!androidStorage || !hasAndroidBootstrapRecoveryToRotate(androidStorage)) return
    const result = await runAppModal(() => Taro.showModal({
      title: '释放快速记录恢复区？',
      content: '恢复快照已包含在刚导出的副本中。释放后，当前异常记录会重新隔离，快速记录可继续使用。',
      confirmText: '确认释放',
      cancelText: '继续保留',
    }))
    if (!result.confirm) return
    try {
      rotateAndroidBootstrapCorruptArchiveAfterExport(androidStorage)
      consumeAndroidBootstrapQueue()
      Taro.showToast({ title: '快速记录恢复区已释放', icon: 'success' })
    } catch {
      Taro.showToast({ title: '恢复区未改变，请保留导出副本', icon: 'none' })
    }
  }, [consumeAndroidBootstrapQueue])

  const clearCorruptedState = useCallback(async () => {
    const result = await runAppModal(() => Taro.showModal({
      title: '清除无法读取的数据？',
      content: '仅在已经导出恢复副本或确定不需要旧记录时继续。清除后无法撤销。',
      confirmText: '确认清除',
      confirmColor: '#A8382D',
      cancelText: '保留数据',
    }))
    if (!result.confirm) return
    await performCompleteDataDeletion('清除未完成，请保留当前页面并重试')
  }, [performCompleteDataDeletion])

  const retryLocalState = useCallback(() => {
    dataMutations.invalidateImports()
    try {
      if (localRepository.hasPendingDeletion()) {
        void performCompleteDataDeletion('正在继续上次未完成的数据删除').then((completed) => {
          if (completed) void Taro.reLaunch({ url: '/pages/onboarding/index' })
        })
        return
      }
      loadLocalState()
    } catch {
      // Preserve the recovery UI when even the deletion marker cannot be read;
      // event-handler exceptions are not caught by React error boundaries.
      setReady(false)
      setLoadFailure(new Error('本机删除状态无法验证'))
      markLocalStateLoad('failed')
      showToastBestEffort('本机数据仍无法安全读取')
    }
  }, [dataMutations, loadLocalState, performCompleteDataDeletion])

  const finishPendingBackupRestore = useCallback(() => {
    setBackupRestorePending(false)
    // Re-read through the same fail-closed path. A restore may have left a
    // matching cross-store journal that must finish before the UI can reopen.
    loadLocalState()
    setTimeout(consumeAndroidBootstrapQueue, 0)
  }, [consumeAndroidBootstrapQueue, loadLocalState])

  const actions = useMemo<AppStateActions>(
    () => ({
      finishOnboarding,
      startNewAttempt,
      adjustReductionLimit,
      recordCheckIn,
      removeTodayCheckIn,
      recordCraving,
      updateCravingLevel,
      resolveCraving,
      recordCigarette,
      editCigarette,
      deleteCigaretteLog,
      recordLapse,
      editLapseRecoveryAction,
      completeTask,
      recordOutcome,
      updateSettings,
      reserveDataImport,
      beginDataImport,
      beginDataPlatformMutation,
      deleteAllData,
      exportData,
      importData,
      offerAndroidBootstrapRecoveryRotationAfterExport,
      retryLocalState,
      exportRecoveryData,
      clearCorruptedState,
      finishPendingBackupRestore,
    }),
    [
      finishOnboarding,
      startNewAttempt,
      adjustReductionLimit,
      recordCheckIn,
      removeTodayCheckIn,
      recordCraving,
      updateCravingLevel,
      resolveCraving,
      recordCigarette,
      editCigarette,
      deleteCigaretteLog,
      recordLapse,
      editLapseRecoveryAction,
      completeTask,
      recordOutcome,
      updateSettings,
      reserveDataImport,
      beginDataImport,
      beginDataPlatformMutation,
      deleteAllData,
      exportData,
      importData,
      offerAndroidBootstrapRecoveryRotationAfterExport,
      retryLocalState,
      exportRecoveryData,
      clearCorruptedState,
      finishPendingBackupRestore,
    ],
  )

  return (
    <AppStateContext.Provider value={{ state, ready, loadFailure, backupRestorePending, actions }}>
      {children}
    </AppStateContext.Provider>
  )
}

export function useAppState(): AppStateContextValue {
  const context = useContext(AppStateContext)
  if (!context) throw new Error('useAppState 必须在 AppStateProvider 内使用')
  return context
}
