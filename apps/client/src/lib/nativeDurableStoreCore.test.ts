import { describe, expect, it } from 'vitest'
import {
  NATIVE_DURABLE_FILE_NAMES,
  NATIVE_DURABLE_STATE_MAX_BYTES,
  nativeDurableFileName,
  nativeDurableUtf8Fits,
} from './nativeDurableStoreCore'

describe('native durable-store core', () => {
  it('maps only the fixed allowlist to unique path-safe basenames', () => {
    const entries = Object.entries(NATIVE_DURABLE_FILE_NAMES)
    expect(entries).toHaveLength(9)

    for (const [key, filename] of entries) {
      expect(nativeDurableFileName(key)).toBe(filename)
      expect(filename).toMatch(/^[a-z0-9][a-z0-9-]*\.json$/)
      expect(filename).not.toMatch(/[\\/]/)
      expect(filename).not.toContain('..')
    }
    expect(new Set(entries.map(([, filename]) => filename)).size).toBe(entries.length)

    for (const key of [
      '',
      '__proto__',
      'constructor',
      'toString',
      '../client-state',
      'wuyan-tongxing/client-state/v1/../../escape',
      'taro_clipboard',
    ]) {
      expect(() => nativeDurableFileName(key)).toThrow('不支持的本机持久数据键')
    }
  })

  it('enforces the exact strict UTF-8 byte boundary', () => {
    const exactThreeByte = '中'.repeat(Math.floor(NATIVE_DURABLE_STATE_MAX_BYTES / 3))
      + 'a'.repeat(NATIVE_DURABLE_STATE_MAX_BYTES % 3)
    expect(nativeDurableUtf8Fits(exactThreeByte)).toBe(true)
    expect(nativeDurableUtf8Fits(`${exactThreeByte}a`)).toBe(false)

    const exactFourByte = '😀'.repeat(NATIVE_DURABLE_STATE_MAX_BYTES / 4)
    expect(nativeDurableUtf8Fits(exactFourByte)).toBe(true)
    expect(nativeDurableUtf8Fits(`${exactFourByte}a`)).toBe(false)

    expect(nativeDurableUtf8Fits('\ud800')).toBe(false)
    expect(nativeDurableUtf8Fits('\udc00')).toBe(false)
    expect(nativeDurableUtf8Fits('\ud800a')).toBe(false)
  })
})
