import Taro from '@tarojs/taro'
import { useCallback, useRef } from 'react'

/** Reject only overlapping taps; cancellation and failures always permit a fresh action. */
export function useModalAction() {
  const running = useRef(false)
  return useCallback(async (action: () => Promise<void>): Promise<void> => {
    if (running.current) return
    running.current = true
    try {
      await action()
    } catch {
      try { await Taro.showToast({ title: '无法打开确认框，请重试', icon: 'none' }) } catch { /* Transient UI must not retain the guard. */ }
    } finally {
      running.current = false
    }
  }, [])
}
