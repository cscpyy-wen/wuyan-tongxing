import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useReminderReconciliation } from './useReminderReconciliation'

const lifecycleMocks = vi.hoisted(() => ({
  didShow: undefined as (() => void) | undefined,
  appStateChange: undefined as ((event: { isActive: boolean }) => void) | undefined,
  addListener: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('@tarojs/taro', () => ({
  useDidShow: (callback: () => void) => {
    lifecycleMocks.didShow = callback
  },
}))

vi.mock('@capacitor/app', () => ({
  App: { addListener: lifecycleMocks.addListener },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

describe('profile reminder reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lifecycleMocks.didShow = undefined
    lifecycleMocks.appStateChange = undefined
    lifecycleMocks.addListener.mockImplementation(async (
      eventName: string,
      callback: (event: { isActive: boolean }) => void,
    ) => {
      if (eventName === 'appStateChange') lifecycleMocks.appStateChange = callback
      return { remove: lifecycleMocks.removeListener }
    })
  })

  it('ignores a stale initial read after a user reminder mutation completes', async () => {
    const initialRead = deferred<boolean>()
    const checkSystemState = vi.fn(() => initialRead.promise)
    const onSystemDisabled = vi.fn()
    const { result } = renderHook(() => useReminderReconciliation({
      enabled: true,
      locallyEnabled: true,
      checkSystemState,
      onSystemDisabled,
    }))
    await waitFor(() => expect(checkSystemState).toHaveBeenCalledTimes(1))

    await act(async () => {
      await result.current.runReminderMutation(async () => {
        result.current.publishReminderActive(true)
      })
    })
    await act(async () => {
      initialRead.resolve(false)
      await initialRead.promise
    })

    expect(result.current.reminderActive).toBe(true)
    expect(onSystemDisabled).not.toHaveBeenCalled()
  })

  it('rechecks on page show and foreground, syncing a revoked permission locally', async () => {
    const checkSystemState = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const onSystemDisabled = vi.fn()
    const onAppResume = vi.fn()
    const { result } = renderHook(() => useReminderReconciliation({
      enabled: true,
      locallyEnabled: true,
      checkSystemState,
      onSystemDisabled,
      onAppResume,
    }))

    await waitFor(() => expect(result.current.reminderActive).toBe(true))
    await waitFor(() => expect(lifecycleMocks.didShow).toBeTypeOf('function'))
    act(() => lifecycleMocks.didShow!())
    await waitFor(() => expect(result.current.reminderActive).toBe(false))
    expect(onSystemDisabled).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(lifecycleMocks.appStateChange).toBeTypeOf('function'))
    const callsBeforeBackground = checkSystemState.mock.calls.length
    act(() => lifecycleMocks.appStateChange!({ isActive: false }))
    expect(checkSystemState).toHaveBeenCalledTimes(callsBeforeBackground)
    expect(onAppResume).not.toHaveBeenCalled()
    act(() => lifecycleMocks.appStateChange!({ isActive: true }))
    await waitFor(() => expect(result.current.reminderActive).toBe(true))
    expect(onAppResume).toHaveBeenCalledTimes(1)
  })
})
