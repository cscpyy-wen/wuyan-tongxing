import Taro from '@tarojs/taro'
import type { PropsWithChildren } from 'react'
import { useEffect, useRef } from 'react'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { getAndroidHealthStorage } from './lib/androidHealthStorage'
import {
  consumeAndroidBootstrapBack,
  dismissAndroidBootstrap,
  shouldDismissAndroidBootstrap,
} from './lib/androidBootstrap'
import {
  clearAndroidBackupRestoreIntent,
  isAndroidBackupRestoreResultAccepted,
  markAndroidBackupRestoreResultAccepted,
  markAndroidBackupRestoreResultCommitted,
  markAndroidBackupRestoreSelection,
  readAndroidBackupRestoreIntentState,
} from './lib/androidBootstrapQueue'
import { runAppModal } from './lib/modalCoordinator'
import {
  consumeRestoredOpenJson,
  formatNativeBackupRestoreConfirmation,
  runRestoredOpenJsonProcessingSafely,
  shouldRetainNativeRestorePayload,
  summarizeNativeBackupRestore,
  type RestoredOpenJsonEvent,
} from './lib/nativeBackupRestore'
import {
  acknowledgeNativeLastExportOutcome,
  acknowledgeNativePendingOpenJson,
  acknowledgePendingNativeExportOutcome,
  cancelDailyReminder,
  consumeNativeBackHandler,
  consumeTaroOverlayBack,
  getNativeExportCleanupWarning,
  getNativeLastExportOutcome,
  isTerminalNativeOpenJsonReadError,
  isNativeAndroidApp,
  nativeExportCleanupIssue,
  nativeExportCleanupFilename,
  NATIVE_OPEN_JSON_READY_EVENT,
  NATIVE_OPEN_JSON_RETRY_EVENT,
  parseNativePendingOpenJsonMetadata,
  probeNativePendingOpenJson,
  readAndVerifyNativePendingOpenJson,
  reconcileDailyReminderAfterSystemChange,
  rescheduleDailyReminderForLocalTime,
} from './lib/runtime'
import { showNativeExportCleanupIssue } from './lib/nativeExportCleanupUi'
import { installTabBarAccessibility } from './lib/tabBarAccessibility'
import { AppStateProvider, useAppState } from './state/AppState'
import './app.scss'

function NativeRuntimeBridge({ children }: PropsWithChildren) {
  const appState = useAppState()
  const latestAppState = useRef(appState)
  const processingOpenResult = useRef(false)
  const openJsonReplayRequested = useRef(false)
  const openJsonWakeHint = useRef<RestoredOpenJsonEvent>()
  const reminderReconciliationRunning = useRef(false)
  const reminderReconciliationPending = useRef(false)
  const nativeExportProbeRunning = useRef(false)
  const nativeExportProbePending = useRef(false)
  const nativeExportSuccessFallback = useRef(false)
  const processOpenResult = useRef<(
    event?: RestoredOpenJsonEvent,
  ) => Promise<void>>(async () => undefined)
  const reconcileNativeReminder = useRef<() => Promise<void>>(async () => undefined)
  const probeNativeExportState = useRef<(fallbackSaved?: boolean) => Promise<void>>(async () => undefined)
  latestAppState.current = appState

  useEffect(() => {
    if (process.env.TARO_ENV !== 'h5' || typeof document === 'undefined') return undefined
    return installTabBarAccessibility(document)
  }, [])

  useEffect(() => {
    if (shouldDismissAndroidBootstrap(
      appState.ready,
      Boolean(appState.loadFailure),
      appState.backupRestorePending,
    )) {
      dismissAndroidBootstrap()
    }
  }, [appState.backupRestorePending, appState.loadFailure, appState.ready])

  reconcileNativeReminder.current = async () => {
    if (reminderReconciliationRunning.current) {
      reminderReconciliationPending.current = true
      return
    }
    reminderReconciliationRunning.current = true
    try {
      do {
        reminderReconciliationPending.current = false
        const latest = latestAppState.current
        if (!latest.ready || !isNativeAndroidApp()) continue
        const platformLease = await latest.actions.beginDataPlatformMutation()
        if (!platformLease) continue
        try {
          if (!platformLease.isCurrent()) continue
          if (!latest.state.settings.inAppReminder) {
            await cancelDailyReminder()
            continue
          }
          const status = await reconcileDailyReminderAfterSystemChange(() => {
            const current = latestAppState.current
            if (current.ready && current.state.settings.inAppReminder) {
              current.actions.updateSettings({ inAppReminder: false })
            }
          })
          if (status !== 'active' || !platformLease.isCurrent()) continue

          const current = latestAppState.current
          if (!current.ready || !current.state.settings.inAppReminder) continue
          const rescheduled = await rescheduleDailyReminderForLocalTime(current.state.settings.reminderHour)
          if (!platformLease.isCurrent()) continue
          if (rescheduled === 'denied') {
            await cancelDailyReminder().catch(() => undefined)
            const afterPermissionChange = latestAppState.current
            if (afterPermissionChange.ready && afterPermissionChange.state.settings.inAppReminder) {
              afterPermissionChange.actions.updateSettings({ inAppReminder: false })
            }
          }
        } catch {
          // A plugin read/cancel failure is transient. Keep the persisted intent
          // and retry on the next foreground event instead of guessing state.
        } finally {
          platformLease.release()
        }
      } while (reminderReconciliationPending.current)
    } finally {
      reminderReconciliationRunning.current = false
    }
  }

  probeNativeExportState.current = async (fallbackSaved = false) => {
    if (fallbackSaved) nativeExportSuccessFallback.current = true
    if (nativeExportProbeRunning.current) {
      nativeExportProbePending.current = true
      return
    }
    nativeExportProbeRunning.current = true
    try {
      do {
        nativeExportProbePending.current = false
        const fallback = nativeExportSuccessFallback.current
        let outcomeShown = false
        try {
          const outcome = await getNativeLastExportOutcome()
          if (outcome) {
            await Taro.showToast({ title: '数据副本已保存', icon: 'success' })
            outcomeShown = true
            // Clear any restored-result fallback that arrived while get/show
            // was pending; both describe this same single-slot native outcome.
            nativeExportSuccessFallback.current = false
            await acknowledgeNativeLastExportOutcome(outcome.id)
          }
        } catch {
          // Keep the durable native marker for the next foreground attempt.
        }
        if (!outcomeShown && fallback && nativeExportSuccessFallback.current) {
          try {
            await Taro.showToast({ title: '数据副本已保存', icon: 'success' })
            nativeExportSuccessFallback.current = false
          } catch {
            // Retry the visible acknowledgement on the next foreground.
          }
        }
        try {
          const notice = await getNativeExportCleanupWarning()
          if (notice) await showNativeExportCleanupIssue(notice.issue, notice.filename)
        } catch {
          // Cleanup metadata stays durable and will be probed again.
        }
      } while (nativeExportProbePending.current)
    } finally {
      nativeExportProbeRunning.current = false
    }
  }

  processOpenResult.current = async (event) => {
    if (event) openJsonWakeHint.current = event
    if (processingOpenResult.current) {
      openJsonReplayRequested.current = true
      return
    }
    const initial = latestAppState.current
    if (!initial.ready && !initial.backupRestorePending && !initial.loadFailure) return

    processingOpenResult.current = true
    let importLease: Awaited<ReturnType<typeof initial.actions.beginDataImport>> = undefined
    try {
      const androidStorage = getAndroidHealthStorage()
      if (!androidStorage) return
      const intent = readAndroidBackupRestoreIntentState(androidStorage)
      const wake = openJsonWakeHint.current
      openJsonWakeHint.current = undefined

      const finishIntent = () => {
        clearAndroidBackupRestoreIntent(androidStorage)
        latestAppState.current.actions.finishPendingBackupRestore()
      }
      const releaseIntentThenAcknowledge = async (id: string) => {
        // Make current data visible first. If the process dies before native
        // cleanup, the next intent-free probe deletes this exact orphan.
        finishIntent()
        await acknowledgeNativePendingOpenJson(id).catch(() => undefined)
      }
      const notifyTerminal = async (status: 'cancelled' | 'read-failed' | 'invalid') => {
        const title = status === 'cancelled'
          ? '已取消恢复'
          : status === 'read-failed'
            ? '备份读取失败，数据未改变'
            : '备份格式无效，未修改现有数据'
        await Taro.showToast({ title, icon: 'none' })
      }

      const notifyRetryable = async () => {
        await Taro.showToast({ title: '恢复未完成，备份已保留', icon: 'none' })
      }

      if (wake?.success && wake.data?.selected === false) {
        await notifyTerminal('cancelled')
        if (intent) finishIntent()
        return
      }

      let descriptor
      let invalidWakeHint = false
      if (wake?.success && wake.data?.selected === true) {
        // An invalid wake hint is not authority to discard anything. A cold
        // probe can still recover the native journal's exact metadata.
        try {
          descriptor = parseNativePendingOpenJsonMetadata(wake.data)
        } catch {
          invalidWakeHint = true
        }
        descriptor ??= await probeNativePendingOpenJson()
      } else {
        descriptor = await probeNativePendingOpenJson()
      }

      if (!descriptor) {
        if (intent?.phase === 'committed') {
          const reminderCancelled = await cancelDailyReminder().then(() => true, () => false)
          await Taro.showToast({
            title: reminderCancelled
              ? '备份已恢复 · 提醒已关闭'
              : '备份已恢复；提醒清理将在下次重试',
            icon: 'none',
          })
          finishIntent()
        } else if (intent?.phase === 'accepted' || intent?.phase === 'selected') {
          await Taro.showToast({ title: '上次备份文件未保留，请重新选择', icon: 'none' })
          finishIntent()
        } else if (wake && (!wake.success || invalidWakeHint)) {
          await notifyTerminal('read-failed')
          if (intent) finishIntent()
        }
        // A plain waiting intent may still own an active system picker.
        return
      }

      if (!intent) {
        // The cross-store import journal may have completed and cleared the JS
        // intent before native acknowledgement. The single-slot payload is then
        // stale and must only be deleted, never re-imported without intent.
        await acknowledgeNativePendingOpenJson(descriptor.id)
        return
      }
      if (intent.phase === 'committed') {
        const reminderCancelled = await cancelDailyReminder().then(() => true, () => false)
        await Taro.showToast({
          title: intent.id !== descriptor.id
            ? '备份已恢复；异常暂存已隔离'
            : reminderCancelled
              ? '备份已恢复 · 提醒已关闭'
              : '备份已恢复；提醒清理将在下次重试',
          icon: 'none',
        })
        await releaseIntentThenAcknowledge(descriptor.id)
        return
      }
      if (intent.phase === 'selected'
        && (intent.id !== descriptor.id
          || intent.byteLength !== descriptor.byteLength
          || intent.sha256 !== descriptor.sha256)) {
        await notifyTerminal('read-failed')
        await releaseIntentThenAcknowledge(descriptor.id)
        return
      }
      if (intent.phase === 'accepted' && intent.id && intent.id !== descriptor.id) {
        await notifyTerminal('read-failed')
        await releaseIntentThenAcknowledge(descriptor.id)
        return
      }
      let verified
      try {
        verified = await readAndVerifyNativePendingOpenJson(descriptor)
      } catch (error) {
        if (!isTerminalNativeOpenJsonReadError(error)) throw error
        await notifyTerminal('read-failed')
        await releaseIntentThenAcknowledge(descriptor.id)
        return
      }

      const summary = summarizeNativeBackupRestore(verified.json)
      if (!summary) {
        await notifyTerminal('invalid')
        await releaseIntentThenAcknowledge(descriptor.id)
        return
      }
      if (intent.phase === 'waiting' || intent.phase === 'selected') {
        markAndroidBackupRestoreSelection(androidStorage, descriptor)
      }
      const confirmation = await runAppModal(() => Taro.showModal({
        title: '确认替换当前数据？',
        content: formatNativeBackupRestoreConfirmation(summary, descriptor),
        confirmText: '确认替换',
        confirmColor: '#A8382D',
        cancelText: '保留',
      }))
      if (!confirmation.confirm) {
        await releaseIntentThenAcknowledge(descriptor.id)
        await Taro.showToast({ title: '已取消，当前数据未改变', icon: 'none' })
        return
      }
      // Move the already fingerprint-bound selected state to accepted only
      // after the user confirms. A process death before this point re-prompts;
      // after this point the durable import journal remains authoritative.
      markAndroidBackupRestoreResultAccepted(androidStorage, descriptor.id)

      // No reservation is acquired until the bounded payload is reconstructed
      // and authenticated. Duplicate wake/probe events only set replayRequested.
      const currentBeforeReservation = latestAppState.current
      const reservation = currentBeforeReservation.actions.reserveDataImport()
      if (!reservation) {
        await notifyRetryable()
        return
      }
      importLease = await currentBeforeReservation.actions.beginDataImport(reservation)
      if (!importLease) {
        await notifyRetryable()
        return
      }
      const current = latestAppState.current
      const outcome = await consumeRestoredOpenJson({
        success: true,
        data: { selected: true, json: verified.json },
      }, {
        currentState: current.state,
        isCurrent: importLease.isCurrent,
        importData: (json) => current.actions.importData(json, importLease!),
      })

      if (outcome.status === 'restored') {
        // Persist committed(id) before the required notification. A toast or
        // acknowledgement failure is replayed as notify+ack, never re-import.
        markAndroidBackupRestoreResultCommitted(androidStorage, descriptor.id)
        const partialRestore = outcome.bootstrapRecoverySkipped
        const reminderCancelled = await cancelDailyReminder().then(() => true, () => false)
        await Taro.showToast({
          title: partialRestore
            ? `主记录已恢复，部分快速记录未恢复；提醒${reminderCancelled ? '已关闭' : '清理待重试'}`
            : reminderCancelled
              ? '备份已恢复 · 提醒已关闭'
              : '备份已恢复；提醒清理将在下次重试',
          icon: 'none',
        })
      } else {
        if (shouldRetainNativeRestorePayload(outcome)) {
          await notifyRetryable()
          return
        }
        await notifyTerminal(outcome.status)
      }
      await releaseIntentThenAcknowledge(descriptor.id)
      if (outcome.status === 'restored') {
        setTimeout(() => { void Taro.reLaunch({ url: '/pages/today/index' }).catch(() => undefined) }, 400)
      }
    } finally {
      try { importLease?.release() } catch { /* the durable controller still unlocks */ }
      processingOpenResult.current = false
      if (openJsonReplayRequested.current) {
        openJsonReplayRequested.current = false
        void runRestoredOpenJsonProcessingSafely(
          () => processOpenResult.current(),
          () => Taro.showToast({ title: '恢复流程中断，请核对记录', icon: 'none' }),
        )
      }
    }
  }

  useEffect(() => {
    if ((!appState.ready && !appState.backupRestorePending && !appState.loadFailure)
      || processingOpenResult.current) return
    void runRestoredOpenJsonProcessingSafely(
      () => processOpenResult.current(),
      () => Taro.showToast({ title: '恢复流程中断，请核对记录', icon: 'none' }),
    )
  }, [appState.backupRestorePending, appState.loadFailure, appState.ready])

  useEffect(() => {
    if (!appState.backupRestorePending) return undefined
    const timer = setTimeout(() => {
      if (!latestAppState.current.backupRestorePending || processingOpenResult.current) return
      void runAppModal(() => Taro.showModal({
        title: '仍在等待备份结果',
        content: '如果系统文件选择器已经关闭且没有返回结果，可以放弃本次恢复；现有记录不会改变。',
        confirmText: '放弃恢复',
        cancelText: '继续等待',
      })).then(async (decision) => {
        if (!decision.confirm || !latestAppState.current.backupRestorePending) return
        const androidStorage = getAndroidHealthStorage()
        if (!androidStorage) return
        if (processingOpenResult.current || isAndroidBackupRestoreResultAccepted(androidStorage)) {
          void Taro.showToast({ title: '备份结果正在处理', icon: 'none' })
          return
        }
        try {
          // Re-probe inside the same single-flight boundary before abandoning.
          // If staging won the race, replay owns the exact descriptor instead.
          const pending = await probeNativePendingOpenJson()
          if (pending) {
            await processOpenResult.current()
            return
          }
          clearAndroidBackupRestoreIntent(androidStorage)
          latestAppState.current.actions.finishPendingBackupRestore()
        } catch {
          await Taro.showToast({ title: '恢复状态未释放，请重试', icon: 'none' }).catch(() => undefined)
        }
      }).catch(() => undefined)
    }, 60_000)
    return () => clearTimeout(timer)
  }, [appState.backupRestorePending])

  useEffect(() => {
    if (!appState.ready || !isNativeAndroidApp()) return
    void reconcileNativeReminder.current()
  }, [appState.ready, appState.state.settings.inAppReminder])

  useEffect(() => {
    if (!isNativeAndroidApp()) return undefined

    let disposed = false
    const removeListeners: Array<() => Promise<void>> = []
    const handleOpenJsonReady = (rawEvent: Event) => {
      const detail = (rawEvent as CustomEvent<unknown>).detail
      let metadata
      try { metadata = parseNativePendingOpenJsonMetadata(detail) }
      catch { return }
      void runRestoredOpenJsonProcessingSafely(
        () => processOpenResult.current({ success: true, data: { selected: true, ...metadata } }),
        () => Taro.showToast({ title: '恢复流程中断，请核对记录', icon: 'none' }),
      )
    }
    window.addEventListener(NATIVE_OPEN_JSON_READY_EVENT, handleOpenJsonReady)
    const handleOpenJsonRetry = () => {
      void runRestoredOpenJsonProcessingSafely(
        () => processOpenResult.current(),
        () => Taro.showToast({ title: '恢复流程中断，请核对记录', icon: 'none' }),
      )
    }
    window.addEventListener(NATIVE_OPEN_JSON_RETRY_EVENT, handleOpenJsonRetry)
    const trackListener = (listener: Promise<{ remove: () => Promise<void> }>) => {
      void listener.then((handle) => {
        if (disposed) void handle.remove()
        else removeListeners.push(() => handle.remove())
      }).catch(() => undefined)
    }

    void Promise.all([
      import('@capacitor/app'),
      import('@capacitor/local-notifications'),
    ]).then(([{ App: NativeApp }, { LocalNotifications }]) => {
      if (disposed) return
      trackListener(NativeApp.addListener('backButton', () => {
        if (consumeAndroidBootstrapBack()) return
        if (consumeTaroOverlayBack()) return
        if (consumeNativeBackHandler()) return
        const pages = Taro.getCurrentPages?.() ?? []
        if (pages.length > 1) {
          void Taro.navigateBack()
          return
        }
        void NativeApp.minimizeApp()
      }))

      trackListener(NativeApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          void reconcileNativeReminder.current()
          void probeNativeExportState.current()
          void runRestoredOpenJsonProcessingSafely(
            () => processOpenResult.current(),
            () => Taro.showToast({ title: '恢复流程中断，请核对记录', icon: 'none' }),
          )
        }
      }))

      trackListener(NativeApp.addListener('appRestoredResult', (event) => {
        if (event.pluginId !== 'PersonalExport') return
        if (event.methodName === 'saveJson') {
          if (event.success && event.data?.saved === true) {
            void probeNativeExportState.current(true)
          } else if (!event.success) {
            const cleanupIssue = nativeExportCleanupIssue(event.error)
            if (cleanupIssue) {
              void (async () => {
                const visible = await showNativeExportCleanupIssue(
                  cleanupIssue,
                  nativeExportCleanupFilename(event.error),
                )
                if (cleanupIssue === 'saved-local-temporary' && visible) {
                  await acknowledgePendingNativeExportOutcome().catch(() => false)
                }
              })()
            } else {
              void Taro.showToast({ title: '数据副本保存未完成', icon: 'none' })
            }
          }
          return
        }
        if (event.methodName === 'openJson') {
          const androidStorage = getAndroidHealthStorage()
          if (!androidStorage) return
          const restoredEvent: RestoredOpenJsonEvent = { success: event.success }
          if (event.data != null) restoredEvent.data = event.data
          void runRestoredOpenJsonProcessingSafely(
            () => processOpenResult.current(restoredEvent),
            () => Taro.showToast({ title: '恢复流程中断，请核对记录', icon: 'none' }),
          )
        }
      }))

      trackListener(LocalNotifications.addListener('localNotificationActionPerformed', () => {
        void Taro.switchTab({ url: '/pages/today/index' })
      }))
    }).catch(() => undefined)

    void probeNativeExportState.current()
    void runRestoredOpenJsonProcessingSafely(
      () => processOpenResult.current(),
      () => Taro.showToast({ title: '恢复流程中断，请核对记录', icon: 'none' }),
    )

    return () => {
      disposed = true
      window.removeEventListener(NATIVE_OPEN_JSON_READY_EVENT, handleOpenJsonReady)
      window.removeEventListener(NATIVE_OPEN_JSON_RETRY_EVENT, handleOpenJsonRetry)
      for (const removeListener of removeListeners) void removeListener()
    }
  }, [])

  return <>{children}</>
}

export default function App({ children }: PropsWithChildren) {
  return (
    <AppErrorBoundary>
      <AppStateProvider>
        <NativeRuntimeBridge>
          {children}
        </NativeRuntimeBridge>
      </AppStateProvider>
    </AppErrorBoundary>
  )
}
