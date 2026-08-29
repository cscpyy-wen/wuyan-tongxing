import { describe, expect, it } from 'vitest'
import {
  assertProjectedTaroWriteFits,
  conservativeStorageBytes,
  projectedStorageAreaBytes,
  SAFE_LOCAL_STORAGE_OPERATIONAL_BYTES,
  type StringStorageArea,
} from './localStorageBudget'
import { MAX_CLIENT_STATE_BYTES } from './localRepository'

function area(values: Map<string, string>): StringStorageArea {
  return {
    get length() { return values.size },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
  }
}

describe('WebView localStorage operational budget', () => {
  it('uses Blink quota accounting: two bytes for every UTF-16 code unit', () => {
    expect(conservativeStorageBytes('abc中😀')).toBe(12)
  })

  it('admits bounded core slots only while shared auxiliary headroom remains', () => {
    const values = new Map<string, string>([
      ['primary', 'a'.repeat(1_700_000)],
      ['queue', 'q'.repeat(100_000)],
      ['archive', 'r'.repeat(400_000)],
    ])
    expect(projectedStorageAreaBytes(area(values), 'backup', 'b'.repeat(1_700_000)))
      .toBeLessThan(SAFE_LOCAL_STORAGE_OPERATIONAL_BYTES)
  })

  it('keeps two declared maximum H5 cores plus required auxiliary records below the operational budget', () => {
    const values = new Map<string, string>([
      ['primary', 'a'.repeat(MAX_CLIENT_STATE_BYTES)],
      ['queue', 'q'.repeat(65_536)],
      ['archive', 'r'.repeat(400_000)],
      ['restore-intent', '{"version":1}'],
    ])
    expect(projectedStorageAreaBytes(area(values), 'backup', 'b'.repeat(MAX_CLIENT_STATE_BYTES)))
      .toBeLessThan(SAFE_LOCAL_STORAGE_OPERATIONAL_BYTES)
  })

  it('rejects a write before the shared area loses all mutation headroom', () => {
    const values = new Map<string, string>([
      ['primary', 'a'.repeat(1_800_000)],
      ['queue', 'q'.repeat(200_000)],
      ['archive', 'r'.repeat(1_000_000)],
    ])
    expect(() => assertProjectedTaroWriteFits(
      area(values),
      'backup',
      { payload: 'b'.repeat(1_800_000) },
    )).toThrow('安全容量上限')
  })
})
