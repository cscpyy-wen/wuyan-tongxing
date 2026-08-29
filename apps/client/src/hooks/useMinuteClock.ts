import { useEffect, useState } from 'react'
import { useDidShow } from '@tarojs/taro'

/** Keeps elapsed-time and Shanghai-day UI fresh while a page remains open. */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date())

  useDidShow(() => setNow(new Date()))

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])

  return now
}
