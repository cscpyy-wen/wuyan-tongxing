import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY,
  ANDROID_BOOTSTRAP_QUEUE_KEY,
  ANDROID_SYSTEM_SHORTCUT_QUEUE_KEY,
} from './androidBootstrapQueue'
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

  it('uses native atomic acknowledgement so a concurrently appended shortcut is retained', () => {
    const firstId = '11111111-1111-4111-8111-111111111111'
    const secondId = '22222222-2222-4222-8222-222222222222'
    const first = { id: firstId, smokedAt: '2026-09-19T08:00:00.000Z', attemptId: 'plan', entryPoint: 'APP_WIDGET' }
    const second = { id: secondId, smokedAt: '2026-09-19T08:00:01.000Z', attemptId: 'plan', entryPoint: 'QUICK_SETTINGS_TILE' }
    const values = new Map<string, string>([[
      ANDROID_SYSTEM_SHORTCUT_QUEUE_KEY,
      JSON.stringify({ data: [first] }),
    ]])
    const acknowledge = vi.fn((idsJson: string) => {
      const ids = new Set(JSON.parse(idsJson) as string[])
      const current = JSON.parse(values.get(ANDROID_SYSTEM_SHORTCUT_QUEUE_KEY)!) as {
        data: Array<{ id: string; smokedAt: string; attemptId: string; entryPoint: string }>
      }
      current.data.push(second)
      values.set(ANDROID_SYSTEM_SHORTCUT_QUEUE_KEY, JSON.stringify({
        data: current.data.filter((event) => !ids.has(event.id)),
      }))
    })
    window.WuyanDurableStore = {
      hasValue: (key) => values.has(key),
      readValue: (key) => values.get(key) ?? null,
      readRawValue: (key) => values.get(key) ?? null,
      writeValue: (key, value) => { values.set(key, value) },
      removeValue: (key) => { values.delete(key) },
      acknowledgeSystemShortcutRecords: acknowledge,
    }
    window.localStorage.setItem(ANDROID_SYSTEM_SHORTCUT_QUEUE_KEY, JSON.stringify({ data: [first] }))

    getAndroidHealthStorage()!.acknowledgeSystemShortcutRecords!([firstId])

    expect(acknowledge).toHaveBeenCalledWith(JSON.stringify([firstId]))
    expect(JSON.parse(values.get(ANDROID_SYSTEM_SHORTCUT_QUEUE_KEY)!).data).toEqual([second])
    expect(window.localStorage.getItem(ANDROID_SYSTEM_SHORTCUT_QUEUE_KEY)).toBeNull()
  })
})
