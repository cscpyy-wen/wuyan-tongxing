import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const readClientSource = (path: string) => readFileSync(resolve(process.cwd(), 'src', path), 'utf8')

describe('Harmony scroll viewport contracts', () => {
  it('uses one Harmony-only native ScrollView wrapper with tab and full viewport modes', () => {
    const source = readClientSource('components/HarmonyScrollablePage.tsx')
    const styles = readClientSource('components/HarmonyScrollablePage.scss')

    expect(source).toContain('if (!isHarmonyApp())')
    expect(source).toContain("fallback?: 'view' | 'scroll'")
    expect(source).toContain("fallback = 'view'")
    expect(source).toContain("if (fallback === 'scroll')")
    expect(source).toContain('<View className={className}>{children}{overlay}</View>')
    expect(source).toContain('harmony-page-scroll--${viewport}')
    expect(source).toContain('scrollY')
    expect(styles).toMatch(/\.harmony-page-frame\s*\{[^}]*box-sizing:\s*border-box;[^}]*display:\s*flex;[^}]*height:\s*100%;[^}]*max-height:\s*100%;[^}]*flex-direction:\s*column;/s)
    expect(styles).toMatch(/\.harmony-page-frame--tab\s*\{[^}]*padding-bottom:\s*56px;/s)
    expect(styles).toMatch(/\.screen\.harmony-page-scroll\s*\{[^}]*height:\s*1px;[^}]*min-height:\s*0;[^}]*flex:\s*1;/s)
    expect(styles).not.toContain('height: calc(100vh - 56px)')
    expect(styles).toMatch(/\.screen\.harmony-page-scroll\s*\{[^}]*min-height:\s*0;/s)
  })

  it('applies the shared viewport to every affected page and keeps sheets outside native scrolling', () => {
    const records = readClientSource('pages/records/index.tsx')
    const today = readClientSource('pages/today/index.tsx')
    const progress = readClientSource('pages/progress/index.tsx')
    const profile = readClientSource('pages/profile/index.tsx')
    const sos = readClientSource('pages/sos/index.tsx')
    const partner = readClientSource('pages/partner/index.tsx')
    const lapse = readClientSource('pages/lapse/index.tsx')

    for (const source of [records, today, progress, profile]) {
      expect(source).toContain('HarmonyScrollablePage')
      expect(source).toContain("viewport='tab'")
    }
    expect(profile).toContain("fallback='scroll'")
    expect(profile).toContain('overlay={(')
    for (const source of [records, today]) expect(source).toContain('overlay={(')
    expect(sos).toContain('HarmonyScrollablePage')
    expect(sos).toContain("viewport='full'")
    for (const source of [partner, lapse]) {
      expect(source).toContain('HarmonyScrollablePage')
      expect(source).toContain("viewport='full'")
    }
  })

  it('keeps the Harmony smoking sheet scroll viewport above the native tab bar', () => {
    const source = readClientSource('components/SmokingEventSheet.tsx')
    const styles = readClientSource('components/SmokingEventSheet.scss')

    expect(source).toContain('const SheetPanel = harmony ? ScrollView : View')
    expect(source).toContain('scrollY={harmony}')
    expect(styles).toMatch(/\.smoking-sheet--harmony\s*\{[^}]*bottom:\s*calc\(56px \+ var\(--safe-bottom, 0px\)\);/s)
    expect(styles).toContain('height: calc(100vh - 28px - var(--safe-top, 0px) - 56px - var(--safe-bottom, 0px));')
  })

  it('reserves the native tab bar only for the Profile privacy-policy modal', () => {
    const source = readClientSource('components/PrivacyPolicyModal.tsx')
    const profile = readClientSource('pages/profile/index.tsx')
    const onboarding = readClientSource('pages/onboarding/index.tsx')
    const styles = readClientSource('components/PrivacyPolicyModal.scss')

    expect(profile).toContain('<PrivacyPolicyModal')
    expect(profile).toContain('reserveNativeTabBar')
    expect(onboarding).toContain('<PrivacyPolicyModal open={privacyOpen} onClose={() => setPrivacyOpen(false)} />')
    expect(source.slice(source.indexOf('export function HarmonyPrivacyPolicyEntry'))).not.toContain('<PrivacyPolicyModal')
    expect(source).toContain("<View className='privacy-policy-modal__footer'>")
    expect(styles).toMatch(/\.privacy-policy-modal--above-tabbar\s*\{[^}]*bottom:\s*calc\(56px \+ var\(--safe-bottom, 0px\)\);/s)
    expect(styles).toMatch(/\.privacy-policy-modal__scroll\s*\{[^}]*height:\s*1px;[^}]*flex:\s*1;/s)
    expect(styles).toMatch(/\.privacy-policy-modal__footer\s*\{[^}]*flex:\s*0 0 auto;/s)
    expect(styles).toMatch(/\.privacy-policy-modal__done\s*\{[^}]*min-height:\s*52px;[^}]*margin:\s*0;/s)
  })

  it('keeps a compact, semantic Harmony SOS entry while omitting the duplicate in-content title', () => {
    const header = readClientSource('components/PageHeader.tsx')
    const sos = readClientSource('components/GlobalSos.tsx')
    const styles = readClientSource('components/GlobalSos.scss')
    const appStyles = readClientSource('app.scss')

    expect(header).toContain('const harmonyCompact = compact && isHarmonyApp()')
    expect(header).toContain("harmonyCompact ? 'page-header--harmony-compact' : ''")
    expect(header).toContain('{!harmonyCompact ? (')
    expect(header).toContain(") : <Text className='page-header__harmony-spacer'>{'\\u00A0'}</Text>}")
    expect(header).toContain("showSos && process.env.TARO_ENV !== 'h5' ? <GlobalSos /> : null")
    expect(sos).toContain("if (isHarmonyApp())")
    expect(sos).toContain("role='button'")
    expect(styles).toMatch(/\.sos-header\.sos-header--harmony\s*\{[^}]*width:\s*76px;[^}]*height:\s*52px;/s)
    expect(styles).toMatch(/\.sos-header\.sos-header--harmony\s*\{[^}]*position:\s*relative;[^}]*right:\s*auto;/s)
    expect(styles).toMatch(/\.sos-header\.sos-header--harmony\s*\{[^}]*margin-left:\s*auto;/s)
    expect(appStyles).toMatch(/\.page-header--harmony-compact \.page-header__compact-row\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;/s)
    expect(appStyles).toMatch(/\.page-header__compact-row\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*row;/s)
    expect(appStyles).toMatch(/\.page-header__harmony-spacer\s*\{[^}]*display:\s*block;[^}]*height:\s*52px;[^}]*min-width:\s*0;[^}]*flex:\s*1;/s)
  })

  it('replaces unsupported Harmony grids for records, today, progress, and SOS controls', () => {
    const records = readClientSource('pages/records/index.scss')
    const today = readClientSource('pages/today/index.scss')
    const progress = readClientSource('pages/progress/index.scss')
    const sos = readClientSource('pages/sos/index.scss')

    expect(records).toMatch(/\.records-page\.harmony-page-scroll \.records-metrics\s*\{[^}]*display:\s*flex;/s)
    expect(today).toMatch(/\.today-page\.harmony-page-scroll \.smoking-hero__metrics,[\s\S]*display:\s*flex;/)
    expect(progress).toMatch(/\.progress-page\.harmony-page-scroll \.milestone-list\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/s)
    expect(sos).toMatch(/\.sos-page\.harmony-page-scroll \.sos-level-options,[\s\S]*display:\s*flex;/)
  })
})
