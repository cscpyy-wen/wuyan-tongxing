export const NATIVE_DURABLE_STATE_MAX_BYTES = 4 * 1024 * 1024

export const NATIVE_DURABLE_FILE_NAMES = {
  'wuyan-tongxing/client-state/v1': 'client-state.json',
  'wuyan-tongxing/client-state/v1/last-known-good': 'client-state-backup.json',
  'wuyan-tongxing/client-state/v1/deletion-in-progress': 'deletion-intent.json',
  'wuyan-tongxing/android-bootstrap-cigarettes/v1': 'android-bootstrap-cigarettes.json',
  'wuyan-tongxing/android-system-shortcut-cigarettes/v1': 'android-system-shortcut-cigarettes.json',
  'wuyan-tongxing/android-bootstrap-cigarettes-quarantine/v1': 'android-bootstrap-quarantine.json',
  'wuyan-tongxing/android-bootstrap-cigarettes-corrupt/v1': 'android-bootstrap-corrupt.json',
  'wuyan-tongxing/android-bootstrap-import-journal/v1': 'android-bootstrap-import-journal.json',
  'wuyan-tongxing/android-backup-restore-intent/v1': 'android-backup-restore-intent.json',
} as const

export type NativeDurableStorageKey = keyof typeof NATIVE_DURABLE_FILE_NAMES

export interface WuyanDurableStoreBridge {
  /**
   * True when a missing native key is authoritative and must not fall through
   * to Taro's legacy WebView storage. Android omits this during one-way
   * migration; Harmony sets it because the C-API runtime has no localStorage.
   */
  authoritativeWhenMissing?: boolean
  readValue(key: string): string | null
  readRawValue(key: string): string | null
  hasValue(key: string): boolean
  writeValue(key: string, json: string): void
  removeValue(key: string): void
  /** Android-only compare-by-id acknowledgement, atomic with native shortcut appends. */
  acknowledgeSystemShortcutRecords?(idsJson: string): void
}

export function nativeDurableFileName(key: string): string {
  if (!Object.prototype.hasOwnProperty.call(NATIVE_DURABLE_FILE_NAMES, key)) {
    throw new Error('不支持的本机持久数据键')
  }
  return NATIVE_DURABLE_FILE_NAMES[key as NativeDurableStorageKey]
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
