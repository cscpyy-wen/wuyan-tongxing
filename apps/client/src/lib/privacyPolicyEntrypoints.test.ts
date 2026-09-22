import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const onboardingSource = readFileSync(
  resolve(process.cwd(), 'src/pages/onboarding/index.tsx'),
  'utf8',
)
const profileSource = readFileSync(
  resolve(process.cwd(), 'src/pages/profile/index.tsx'),
  'utf8',
)
const onboardingStyles = readFileSync(
  resolve(process.cwd(), 'src/pages/onboarding/index.scss'),
  'utf8',
)
const onboardingConfig = readFileSync(
  resolve(process.cwd(), 'src/pages/onboarding/index.config.ts'),
  'utf8',
)
const privacyComponentsSource = readFileSync(
  resolve(process.cwd(), 'src/components/PrivacyPolicyModal.tsx'),
  'utf8',
)

describe('Harmony privacy policy entry placement', () => {
  it('places the local policy entry before the first sensitive-health consent control', () => {
    const policyEntry = onboardingSource.indexOf("<HarmonyPrivacyPolicyEntry placement='onboarding'")
    const consentControls = onboardingSource.indexOf("<View className='card stack onboarding-consent'>")

    expect(onboardingSource).toMatch(/<ScrollView[\s\S]{0,240}className='onboarding__scroll'[\s\S]{0,80}scrollY/)
    expect(onboardingSource).toContain('key: `onboarding-step-${step}`')
    expect(onboardingSource).toContain("<HarmonyPrivacyPolicyEntry placement='onboarding' onOpen={() => setPrivacyOpen(true)} />")
    expect(policyEntry).toBeGreaterThan(-1)
    expect(consentControls).toBeGreaterThan(policyEntry)
  })

  it('keeps each policy modal outside its page ScrollView and lets pages own open state', () => {
    const onboardingScrollEnd = onboardingSource.indexOf('</ScrollView>')
    const onboardingModal = onboardingSource.indexOf('<PrivacyPolicyModal open={privacyOpen}')
    const onboardingActions = onboardingSource.indexOf("<View className='onboarding__actions'>")

    expect(onboardingModal).toBeGreaterThan(onboardingScrollEnd)
    expect(onboardingActions).toBeGreaterThan(onboardingModal)
    expect(profileSource).toContain('<HarmonyScrollablePage')
    expect(profileSource).toContain("viewport='tab'")
    expect(profileSource).toContain("fallback='scroll'")
    expect(profileSource).toContain('overlay={(')
    expect(profileSource).toContain("<HarmonyPrivacyPolicyEntry placement='profile' onOpen={() => setPrivacyOpen(true)} />")
    expect(profileSource).toContain("<Text className='section-title'>关于与隐私</Text>")
    expect(`${onboardingSource}\n${profileSource}`).not.toMatch(/navigateTo\(\{\s*url:\s*['\"]\/pages\/privacy/)
  })

  it('keeps HarmonyPrivacyPolicyEntry as a stateless onOpen-only entry', () => {
    const entrySource = privacyComponentsSource.slice(
      privacyComponentsSource.indexOf('export function HarmonyPrivacyPolicyEntry'),
    )

    expect(privacyComponentsSource).toContain('onOpen: () => void')
    expect(entrySource).toContain('onClick={onOpen}')
    expect(entrySource).not.toContain('useState')
    expect(entrySource).not.toContain('<PrivacyPolicyModal')
  })

  it('uses Harmony native onboarding navigation without duplicating the brand or removing progress', () => {
    expect(onboardingConfig).toContain("process.env.TARO_ENV === 'harmony_cpp' ? 'default' : 'custom'")
    expect(onboardingSource).toContain("{!harmony ? <View className='onboarding__brand'>无烟同行</View> : null}")
    expect(onboardingSource).toContain("<Text className='muted'>{step + 1} / 5</Text>")
    expect(onboardingSource).toContain("className='progress-track'")
    expect(onboardingStyles).toMatch(/\.onboarding__top--native\s*\{[^}]*justify-content:\s*flex-end;/s)
  })

  it('keeps both fixed onboarding action buttons inside the available row width', () => {
    expect(onboardingStyles).toMatch(/\.onboarding__actions \.button\s*\{[^}]*flex:\s*1 1 0;/s)
    expect(onboardingStyles).toMatch(/\.onboarding__actions \.button\s*\{[^}]*width:\s*auto;/s)
    expect(onboardingStyles).toMatch(/\.onboarding__actions \.button\s*\{[^}]*min-width:\s*0;/s)
  })
})
