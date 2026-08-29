import { useDidShow } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'

interface ReminderReconciliationOptions {
  enabled: boolean
  locallyEnabled: boolean
  checkSystemState(): Promise<boolean>
  onSystemDisabled(): void | Promise<void>
  onAppResume?(): void | Promise<void>
}

interface ReminderReconciliationResult {
  reminderActive: boolean | undefined
  publishReminderActive(active: boolean): void
  reconcileReminder(): Promise<void>
  runReminderMutation<T>(operation: () => Promise<T>): Promise<T>
}

/**
 * Mirrors the native permission/pending state without scheduling or cancelling
 * anything. A monotonically increasing revision prevents an older check from
 * overwriting a newer lifecycle check or a user-triggered reminder mutation.
 */
export function useReminderReconciliation({
  enabled,
  locallyEnabled,
  checkSystemState,
  onSystemDisabled,
  onAppResume,
}: ReminderReconciliationOptions): ReminderReconciliationResult {
  const [reminderActive, setReminderActive] = useState<boolean>()
  const enabledRef = useRef(enabled)
  const locallyEnabledRef = useRef(locallyEnabled)
  const checkSystemStateRef = useRef(checkSystemState)
  const onSystemDisabledRef = useRef(onSystemDisabled)
  const onAppResumeRef = useRef(onAppResume)
  const revisionRef = useRef(0)
  const mutationDepthRef = useRef(0)
  const mountedRef = useRef(true)

  enabledRef.current = enabled
  locallyEnabledRef.current = locallyEnabled
  checkSystemStateRef.current = checkSystemState
  onSystemDisabledRef.current = onSystemDisabled
  onAppResumeRef.current = onAppResume

  const publishReminderActive = useCallback((active: boolean) => {
    revisionRef.current += 1
    if (mountedRef.current) setReminderActive(active)
  }, [])

  const runReminderMutation = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    revisionRef.current += 1
    mutationDepthRef.current += 1
    try {
      return await operation()
    } finally {
      mutationDepthRef.current = Math.max(0, mutationDepthRef.current - 1)
    }
  }, [])

  const reconcileReminder = useCallback(async () => {
    if (!enabledRef.current || mutationDepthRef.current > 0) return
    const revision = ++revisionRef.current
    let scheduled: boolean
    try {
      scheduled = await checkSystemStateRef.current()
    } catch {
      // A transient plugin/read error is not evidence that a valid reminder
      // was revoked. Keep the last known UI state and retry on the next event.
      return
    }
    if (
      !mountedRef.current
      || !enabledRef.current
      || mutationDepthRef.current > 0
      || revision !== revisionRef.current
    ) return

    setReminderActive(scheduled)
    if (!scheduled && locallyEnabledRef.current) {
      try {
        await onSystemDisabledRef.current()
      } catch {
        // The system state remains reflected in reminderActive. A later page
        // show can retry synchronising the persisted local toggle.
      }
    }
  }, [])

  useDidShow(() => {
    void reconcileReminder()
  })

  useEffect(() => {
    if (!enabled) {
      revisionRef.current += 1
      setReminderActive(false)
      return
    }
    void reconcileReminder()
  }, [enabled, reconcileReminder])

  useEffect(() => {
    if (!enabled) return undefined
    let disposed = false
    let removeListener: (() => Promise<void>) | undefined
    void import('@capacitor/app').then(({ App }) => App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        void reconcileReminder()
        void onAppResumeRef.current?.()
      }
    })).then((handle) => {
      if (disposed) void handle.remove()
      else removeListener = () => handle.remove()
    }).catch(() => undefined)

    return () => {
      disposed = true
      revisionRef.current += 1
      if (removeListener) void removeListener()
    }
  }, [enabled, reconcileReminder])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      revisionRef.current += 1
    }
  }, [])

  return {
    reminderActive,
    publishReminderActive,
    reconcileReminder,
    runReminderMutation,
  }
}
