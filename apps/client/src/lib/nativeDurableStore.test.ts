import { afterEach, describe, expect, it } from 'vitest'
import {
  getNativeDurableStore,
  nativeDurableFileName,
  nativeDurableUtf8Fits,
  parseNativeDurableValue,
} from './nativeDurableStore'

describe('native durable-store bridge adapter', () => {
  afterEach(() => { delete window.WuyanDurableStore })

  it('accepts only the complete synchronous bridge surface', () => {
    window.WuyanDurableStore = {
      readValue: () => null,
      readRawValue: () => null,
      hasValue: () => false,
      writeValue: () => undefined,
      removeValue: () => undefined,
    }
    expect(getNativeDurableStore()).toBe(window.WuyanDurableStore)
  })

  it('keeps every durable key inside the fixed native filename allowlist', () => {
    expect(nativeDurableFileName('wuyan-tongxing/client-state/v1')).toBe('client-state.json')
    expect(nativeDurableFileName('wuyan-tongxing/client-state/v1/last-known-good'))
      .toBe('client-state-backup.json')
    expect(nativeDurableFileName('wuyan-tongxing/client-state/v1/deletion-in-progress'))
      .toBe('deletion-intent.json')
    expect(nativeDurableFileName('wuyan-tongxing/android-bootstrap-cigarettes/v1'))
      .toBe('android-bootstrap-cigarettes.json')
    expect(nativeDurableFileName('wuyan-tongxing/android-system-shortcut-cigarettes/v1'))
      .toBe('android-system-shortcut-cigarettes.json')
    expect(nativeDurableFileName('wuyan-tongxing/android-bootstrap-cigarettes-quarantine/v1'))
      .toBe('android-bootstrap-quarantine.json')
    expect(nativeDurableFileName('wuyan-tongxing/android-bootstrap-cigarettes-corrupt/v1'))
      .toBe('android-bootstrap-corrupt.json')
    expect(nativeDurableFileName('wuyan-tongxing/android-bootstrap-import-journal/v1'))
      .toBe('android-bootstrap-import-journal.json')
    expect(nativeDurableFileName('wuyan-tongxing/android-backup-restore-intent/v1'))
      .toBe('android-backup-restore-intent.json')
    expect(() => nativeDurableFileName('../client-state.json')).toThrow('不支持的本机持久数据键')
  })

  it('parses exact JSON and fails closed on damaged raw text', () => {
    expect(parseNativeDurableValue('{"version":1}')).toEqual({ version: 1 })
    expect(() => parseNativeDurableValue('{')).toThrow('无法安全读取')
  })

  it('matches strict native UTF-8 limits without allocating an encoded copy', () => {
    expect(nativeDurableUtf8Fits('{"值":"正常"}')).toBe(true)
    expect(nativeDurableUtf8Fits(String.fromCharCode(0xd800))).toBe(false)
    expect(nativeDurableUtf8Fits('中'.repeat(2_800_000))).toBe(false)
  })
})
