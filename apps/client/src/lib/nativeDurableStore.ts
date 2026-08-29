export const NATIVE_DURABLE_STATE_MAX_BYTES = 4 * 1024 * 1024

export interface WuyanDurableStoreBridge {
  readValue(key: string): string | null
  readRawValue(key: string): string | null
  hasValue(key: string): boolean
  writeValue(key: string, json: string): void
  removeValue(key: string): void
}

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

export function parseNativeDurableValue(raw: string | null): unknown {
  if (raw === null) return undefined
  if (raw.length > NATIVE_DURABLE_STATE_MAX_BYTES) throw new Error('本机持久数据超过安全读取上限')
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error('本机持久数据无法安全读取')
  }
}

/** Allocation-free strict UTF-8 preflight matching the native 4 MiB contract. */
export function nativeDurableUtf8Fits(value: string): boolean {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      bytes += 4
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
    else bytes += 3
    if (bytes > NATIVE_DURABLE_STATE_MAX_BYTES) return false
  }
  return true
}
