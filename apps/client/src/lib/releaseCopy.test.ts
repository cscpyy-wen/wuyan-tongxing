import { describe, expect, it } from 'vitest'
import {
  EMERGENCY_SUPPORT_COPY as HARMONY_EMERGENCY_SUPPORT_COPY,
  LAPSE_SUPPORT_BOUNDARY_COPY as HARMONY_LAPSE_SUPPORT_BOUNDARY_COPY,
} from './releaseCopy.harmony_cpp'

describe('Harmony first-release copy', () => {
  it('contains no unreviewed hotline number or route promise', () => {
    const visibleCopy = `${HARMONY_EMERGENCY_SUPPORT_COPY} ${HARMONY_LAPSE_SUPPORT_BOUNDARY_COPY}`
    expect(visibleCopy).not.toMatch(/(?:120|110|12320|12356)/u)
    expect(visibleCopy).not.toContain('“我的”中查找专业支持')
  })
})
