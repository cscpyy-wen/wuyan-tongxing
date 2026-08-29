import { useDidHide, useDidShow } from '@tarojs/taro'
import { useCallback, useEffect, useRef } from 'react'

/**
 * Some Android WebView builds emit a delayed synthetic click after a tap.
 * Mounting a bottom sheet before that click is emitted can retarget it onto a
 * control in the new sheet. Give the source event loop a short chance to
 * settle before mounting the sheet. The sheet itself keeps an input quiet
 * period that is extended by every residual tap, so this delay can stay short
 * enough to preserve immediate visual feedback.
 */
export function useDeferredSheetOpen(delayMs = 120) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const pendingRef = useRef(false)
  const pageVisibleRef = useRef(true)

  const cancel = useCallback(() => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
    timerRef.current = undefined
    pendingRef.current = false
  }, [])

  useDidShow(() => {
    pageVisibleRef.current = true
  })

  useDidHide(() => {
    pageVisibleRef.current = false
    cancel()
  })

  useEffect(() => cancel, [cancel])

  return useCallback((open: () => void) => {
    if (pendingRef.current) return
    pendingRef.current = true
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined
      pendingRef.current = false
      if (pageVisibleRef.current) open()
    }, delayMs)
  }, [delayMs])
}
