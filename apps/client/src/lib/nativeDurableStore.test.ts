import { afterEach, describe, expect, it } from 'vitest'
import { getNativeDurableStore, nativeDurableUtf8Fits, parseNativeDurableValue } from './nativeDurableStore'

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
