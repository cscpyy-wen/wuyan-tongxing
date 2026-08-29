import {
  ANDROID_BACKUP_RESTORE_INTENT_KEY,
  ANDROID_BOOTSTRAP_RAW_CHARACTER_LIMITS,
  ANDROID_BOOTSTRAP_CORRUPT_KEY,
  ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY,
  ANDROID_BOOTSTRAP_QUARANTINE_KEY,
  ANDROID_BOOTSTRAP_QUEUE_KEY,
  type AndroidBootstrapStorage,
} from './androidBootstrapQueue'
import { getNativeDurableStore, nativeDurableUtf8Fits } from './nativeDurableStore'

const DURABLE_AUXILIARY_KEYS = new Set([
  ANDROID_BOOTSTRAP_QUEUE_KEY,
  ANDROID_BOOTSTRAP_QUARANTINE_KEY,
  ANDROID_BOOTSTRAP_CORRUPT_KEY,
  ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY,
  ANDROID_BACKUP_RESTORE_INTENT_KEY,
])

let cachedFallback: Storage | undefined
let cachedAdapter: AndroidBootstrapStorage | undefined
let cachedDurable: ReturnType<typeof getNativeDurableStore>

export function getAndroidHealthStorage(): AndroidBootstrapStorage | undefined {
  if (typeof window === 'undefined' || !window.localStorage) return undefined
  const fallback = window.localStorage
  const durable = getNativeDurableStore()
  if (!durable) return fallback
  if (cachedAdapter && cachedFallback === fallback && cachedDurable === durable) return cachedAdapter
  cachedFallback = fallback
  cachedDurable = durable
  cachedAdapter = {
    getItem(key) {
      if (!DURABLE_AUXILIARY_KEYS.has(key)) return fallback.getItem(key)
      if (durable.hasValue(key)) return durable.readRawValue(key)
      return fallback.getItem(key)
    },
    setItem(key, value) {
      if (!DURABLE_AUXILIARY_KEYS.has(key)) {
        fallback.setItem(key, value)
        return
      }
      durable.writeValue(key, value)
      try { fallback.removeItem(key) } catch { /* native value is authoritative */ }
    },
    removeItem(key) {
      if (DURABLE_AUXILIARY_KEYS.has(key)) {
        durable.removeValue(key)
        if (durable.hasValue(key)) throw new Error('本机快速记录删除后仍存在')
      }
      fallback.removeItem(key)
    },
  }
  return cachedAdapter
}

/** One-way migration of valid legacy JSON before quick-log state is exposed. */
export function migrateLegacyAndroidHealthStorage(): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  const durable = getNativeDurableStore()
  if (!durable) return
  for (const key of DURABLE_AUXILIARY_KEYS) {
    const legacy = window.localStorage.getItem(key)
    if (durable.hasValue(key)) {
      if (legacy !== null) {
        const native = durable.readRawValue(key)
        if (native === legacy) {
          try { window.localStorage.removeItem(key) } catch { /* retry next startup */ }
        } else if (key === ANDROID_BOOTSTRAP_QUEUE_KEY || key === ANDROID_BOOTSTRAP_QUARANTINE_KEY) {
          const characterLimit = ANDROID_BOOTSTRAP_RAW_CHARACTER_LIMITS[key]
          if (characterLimit === undefined
            || typeof native !== 'string'
            || native.length > characterLimit
            || legacy.length > characterLimit
            || !nativeDurableUtf8Fits(native)
            || !nativeDurableUtf8Fits(legacy)) {
            // Two divergent authorities must remain intact for recovery. In
            // particular, never parse an oversized legacy value on startup.
            throw new Error('本机快速记录存在两份不一致的恢复数据')
          }
          let nativeItems: unknown[]
          let legacyItems: unknown[]
          try {
            const nativeParsed = JSON.parse(native ?? '') as { data?: unknown }
            const legacyParsed = JSON.parse(legacy) as { data?: unknown }
            if (!Array.isArray(nativeParsed.data) || !Array.isArray(legacyParsed.data)) throw new Error('invalid')
            nativeItems = nativeParsed.data
            legacyItems = legacyParsed.data
          } catch {
            throw new Error('本机快速记录存在两份不一致的恢复数据')
          }
          const exact = new Set(nativeItems.map((item) => JSON.stringify(item)))
          const merged = JSON.stringify({
            data: [...nativeItems, ...legacyItems.filter((item) => !exact.has(JSON.stringify(item)))],
          })
          // Any conflicting duplicate ID remains byte-represented in this
          // merged JSON and is routed to the ordinary corruption archive by
          // the strict queue parser; no event is silently preferred.
          durable.writeValue(key, merged)
          try { window.localStorage.removeItem(key) } catch { /* native value is authoritative */ }
        } else {
          throw new Error('本机恢复事务存在两份不一致的数据')
        }
      }
      continue
    }
    if (legacy === null) continue
    const characterLimit = ANDROID_BOOTSTRAP_RAW_CHARACTER_LIMITS[key]
    if (characterLimit === undefined || legacy.length > characterLimit || !nativeDurableUtf8Fits(legacy)) {
      // Leave oversized or non-UTF-8 evidence untouched for the bounded
      // recovery/export flow; never parse it on the startup path.
      continue
    }
    try {
      JSON.parse(legacy)
    } catch {
      // Keep malformed legacy evidence in place. The bounded isolation flow
      // will archive it before any queue consumer can proceed.
      continue
    }
    durable.writeValue(key, legacy)
    try { window.localStorage.removeItem(key) } catch { /* native value is authoritative */ }
  }
}
