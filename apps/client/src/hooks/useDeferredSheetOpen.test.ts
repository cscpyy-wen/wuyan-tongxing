import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDeferredSheetOpen } from './useDeferredSheetOpen'

let runtimeEnvironment = 'WEB'
let didHide: (() => void) | undefined
let didShow: (() => void) | undefined

vi.mock('@tarojs/taro', () => ({
  default: {
    getEnv: () => runtimeEnvironment,
  },
  useDidHide: (callback: () => void) => {
    didHide = callback
  },
  useDidShow: (callback: () => void) => {
    didShow = callback
  },
}))

describe('useDeferredSheetOpen', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    runtimeEnvironment = 'WEB'
    didHide = undefined
    didShow = undefined
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('keeps the visibility guard on web after a page hide', () => {
    const open = vi.fn()
    const { result } = renderHook(() => useDeferredSheetOpen(20))

    act(() => didHide?.())
    act(() => result.current(open))
    act(() => vi.advanceTimersByTime(20))

    expect(open).not.toHaveBeenCalled()
  })

  it('opens on Harmony after returning to a tab with an unpaired didHide event', () => {
    runtimeEnvironment = 'HARMONY'
    const open = vi.fn()
    const { result } = renderHook(() => useDeferredSheetOpen(20))

    act(() => didHide?.())
    act(() => result.current(open))
    act(() => vi.advanceTimersByTime(20))

    expect(open).toHaveBeenCalledTimes(1)
  })

  it('opens normally after a paired show event', () => {
    const open = vi.fn()
    const { result } = renderHook(() => useDeferredSheetOpen(20))

    act(() => didHide?.())
    act(() => didShow?.())
    act(() => result.current(open))
    act(() => vi.advanceTimersByTime(20))

    expect(open).toHaveBeenCalledTimes(1)
  })
})
