import { describe, expect, it } from 'vitest'
import { HEALTH_CONTENT_ENABLED as DEFAULT_HEALTH_CONTENT_ENABLED } from './healthContentGate'
import { HEALTH_CONTENT_ENABLED as HARMONY_HEALTH_CONTENT_ENABLED } from './healthContentGate.harmony_cpp'

describe('compile-time health-content gate', () => {
  it('fails closed for Harmony while preserving existing channels', () => {
    expect(HARMONY_HEALTH_CONTENT_ENABLED).toBe(false)
    expect(DEFAULT_HEALTH_CONTENT_ENABLED).toBe(true)
  })
})
