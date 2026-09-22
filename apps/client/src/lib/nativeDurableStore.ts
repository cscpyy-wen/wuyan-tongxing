import type { WuyanDurableStoreBridge } from './nativeDurableStoreCore'

export * from './nativeDurableStoreCore'

declare global {
  interface Window {
    WuyanDurableStore?: WuyanDurableStoreBridge
  }
}

export function getNativeDurableStore(): WuyanDurableStoreBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const candidate = window.WuyanDurableStore
  return candidate
    && typeof candidate.readValue === 'function'
    && typeof candidate.readRawValue === 'function'
    && typeof candidate.hasValue === 'function'
    && typeof candidate.writeValue === 'function'
    && typeof candidate.removeValue === 'function'
    ? candidate
    : undefined
}
