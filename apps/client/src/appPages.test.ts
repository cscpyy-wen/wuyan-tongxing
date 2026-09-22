import { describe, expect, it } from 'vitest'
import { appPagesForBuildTarget, CORE_APP_PAGES, REVIEW_GATED_APP_PAGES } from './appPages'

describe('app release page inventory', () => {
  it('omits every review-gated page from the first Harmony package', () => {
    const harmonyPages = appPagesForBuildTarget('harmony_cpp')
    expect(CORE_APP_PAGES).toHaveLength(8)
    expect(harmonyPages).toHaveLength(8)
    for (const page of REVIEW_GATED_APP_PAGES) expect(harmonyPages).not.toContain(page)
    expect(harmonyPages).toContain('pages/today/index')
    expect(harmonyPages).toContain('pages/sos/index')
    expect(harmonyPages.some((page) => page.includes('privacy'))).toBe(false)
  })

  it('preserves the existing H5 and WeChat page inventory', () => {
    for (const buildTarget of ['h5', 'weapp', undefined]) {
      const pages = appPagesForBuildTarget(buildTarget)
      for (const page of REVIEW_GATED_APP_PAGES) expect(pages).toContain(page)
    }
  })
})
