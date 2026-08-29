import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY, ANDROID_BOOTSTRAP_QUEUE_KEY } from './androidBootstrapQueue'
import { getAndroidHealthStorage, migrateLegacyAndroidHealthStorage } from './androidHealthStorage'

describe('Android crash-safe auxiliary storage adapter', () => {
  afterEach(() => {
    window.localStorage.clear()
    delete window.WuyanDurableStore
  })

  it('migrates a valid legacy queue then keeps native storage authoritative', () => {
    const values = new Map<string, string>()
    window.WuyanDurableStore = {
      hasValue: (key) => values.has(key),
      readValue: (key) => values.get(key) ?? null,
      readRawValue: (key) => values.get(key) ?? null,
      writeValue: (key, value) => { values.set(key, value) },
      removeValue: (key) => { values.delete(key) },
    }
    const queue = JSON.stringify({ data: [] })
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, queue)

    migrateLegacyAndroidHealthStorage()

    expect(values.get(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(queue)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull()
    expect(getAndroidHealthStorage()?.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(queue)
  })

  it('keeps malformed legacy evidence for the isolation path', () => {
    const values = new Map<string, string>()
    window.WuyanDurableStore = {
      hasValue: (key) => values.has(key),
      readValue: (key) => values.get(key) ?? null,
      readRawValue: (key) => values.get(key) ?? null,
      writeValue: (key, value) => { values.set(key, value) },
      removeValue: (key) => { values.delete(key) },
    }
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, '{')
    migrateLegacyAndroidHealthStorage()
    expect(values.has(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(false)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe('{')
  })

  it('does not parse oversized or over-byte-budget legacy auxiliary evidence', () => {
    const values = new Map<string, string>()
    window.WuyanDurableStore = {
      hasValue: (key) => values.has(key),
      readValue: (key) => values.get(key) ?? null,
      readRawValue: (key) => values.get(key) ?? null,
      writeValue: (key, value) => { values.set(key, value) },
      removeValue: (key) => { values.delete(key) },
    }
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, 'x'.repeat(65_537))
    window.localStorage.setItem(
      ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY,
      `{"payload":"${'中'.repeat(2_800_000)}"}`,
    )
    const parse = vi.spyOn(JSON, 'parse')

    migrateLegacyAndroidHealthStorage()

    expect(parse).not.toHaveBeenCalled()
    expect(values.size).toBe(0)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).not.toBeNull()
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY)).not.toBeNull()
  })

  it('fails closed before parsing an oversized divergent legacy queue', () => {
    const nativeQueue = JSON.stringify({ data: [] })
    const values = new Map<string, string>([[ANDROID_BOOTSTRAP_QUEUE_KEY, nativeQueue]])
    window.WuyanDurableStore = {
      hasValue: (key) => values.has(key),
      readValue: (key) => values.get(key) ?? null,
      readRawValue: (key) => values.get(key) ?? null,
      writeValue: (key, value) => { values.set(key, value) },
      removeValue: (key) => { values.delete(key) },
    }
    const oversizedLegacy = 'x'.repeat(65_537)
    window.localStorage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, oversizedLegacy)
    const parse = vi.spyOn(JSON, 'parse')

    expect(() => migrateLegacyAndroidHealthStorage()).toThrow(
      '本机快速记录存在两份不一致的恢复数据',
    )

    expect(parse).not.toHaveBeenCalled()
    expect(values.get(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(nativeQueue)
    expect(window.localStorage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(oversizedLegacy)
  })
})
