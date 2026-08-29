import { expect, type Locator, type Page } from '@playwright/test'

export const STORAGE_KEY = 'wuyan-tongxing/client-state/v1'

export type QuitPath = 'abrupt' | 'reduction'

export interface StoredClientState {
  version: 1
  onboarded: boolean
  baseline?: {
    cigarettesPerDay: number
    reasons: string[]
    triggers: string[]
  }
  plan?: {
    id: string
    path: QuitPath
    quitDate: string
    attemptNumber: number
    reductionLimits?: { stage75: number; stage50: number; stage25: number }
  }
  archivedPlans: Array<{
    id: string
    path: QuitPath
    quitDate: string
    attemptNumber: number
    reductionLimits?: { stage75: number; stage50: number; stage25: number }
  }>
  lastCigaretteAt?: string
  checkIns: Array<{ cigarettesSmoked: number; smokeFree: boolean }>
  cravings: Array<{ level: number; resolved?: boolean; technique?: string }>
  cigarettes: Array<{
    id: string
    createdAt: string
    loggedAt?: string
    updatedAt?: string
    count: number
    trigger?: string
    cravingIntensity?: number
    attemptId?: string
    source?: string
  }>
  lapses: Array<{
    id: string
    createdAt: string
    cigarettes: number
    recoveryAction: string
    attemptId: string
    cigaretteLogId?: string
  }>
  outcomes: Array<{
    planId: string
    dueMonth: 3 | 6 | 12
    sevenDayAbstinent: boolean | null
    thirtyDayAbstinent: boolean | null
    continuouslyAbstinent: boolean | null
    currentCigarettesPerDay: number | null
    additionalQuitAttempts: number | null
    confidence: number | null
    usedProfessionalSupport: boolean | null
    selfReported: true
    biochemicallyVerified: false
  }>
  completedTasks: Array<{ contentId: string; attemptId?: string }>
  settings: {
    sensitiveHealthData: boolean
    inAppReminder: boolean
    subscriptionEnabled: boolean
    cloudSync: boolean
    outcomeAnalytics: boolean
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function taroButton(page: Page, label: string): Locator {
  return page.getByRole('button', { name: new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`) }).last()
}

export function taroButtonContaining(page: Page, text: string): Locator {
  return page.getByRole('button', { name: new RegExp(escapeRegExp(text)) }).last()
}

/** Android/H5 使用真实的中央 Taro tab，避免 WebView 覆盖层命中差异。 */
export function sosButton(page: Page): Locator {
  return page.locator('taro-tabbar').getByRole('tab', { name: /^急救，/ })
}

export async function startFresh(page: Page): Promise<void> {
  await page.goto('/#/pages/onboarding/index')
  await page.evaluate(() => window.localStorage.clear())
  await page.reload()
  await expect(page.getByText('先确认这几项', { exact: true })).toBeVisible()
}

export async function selectAccessibleCheckbox(page: Page, label: string): Promise<void> {
  const control = page.getByRole('checkbox', { name: `${label}，未选`, exact: true })
  await expect(control).toBeVisible()
  await control.click()
  await expect(page.getByRole('checkbox', { name: `${label}，已选`, exact: true })).toBeChecked()
}

export async function selectAccessibleRadio(page: Page, label: string): Promise<void> {
  const control = page.getByRole('radio', { name: label, exact: true })
  await expect(control).toBeVisible()
  await control.click()
  await expect(page.getByRole('radio', { name: `${label}，已选`, exact: true })).toBeChecked()
}

export async function completeOnboarding(page: Page, path: QuitPath = 'abrupt'): Promise<StoredClientState> {
  await startFresh(page)

  await selectAccessibleRadio(page, '我已满 18 岁')
  await selectAccessibleRadio(page, '是，当前吸纸烟')
  await selectAccessibleCheckbox(page, '接受产品与医疗边界')
  await selectAccessibleCheckbox(page, '单独同意本机处理敏感健康信息')
  await taroButton(page, '继续').click()

  await expect(page.getByText('你的吸烟情况', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '起床后多久吸第一支，尚未选择', exact: true }).click()
  await page.locator('.weui-picker__action').filter({ hasText: '确定' }).click()
  await expect(page.getByRole('button', { name: '起床后多久吸第一支，当前 起床后 5 分钟内', exact: true })).toBeVisible()
  await taroButton(page, '继续').click()

  await expect(page.getByText('烟瘾来时，什么值得你坚持？', { exact: true })).toBeVisible()
  await taroButton(page, '继续').click()

  await expect(page.getByText('最容易点烟的场景有哪些？', { exact: true })).toBeVisible()
  await selectAccessibleCheckbox(page, '压力或烦躁')
  await taroButton(page, '继续').click()

  await expect(page.getByText('你想怎样开始？', { exact: true })).toBeVisible()
  if (path === 'reduction') await selectAccessibleRadio(page, '限期减量')
  else await expect(page.getByRole('radio', { name: '直接戒断，已选', exact: true })).toBeChecked()
  await taroButton(page, '创建我的计划').click()

  await expect(page).toHaveURL(/#\/pages\/today\/index/)
  await expect(page.locator('.today-page:visible')).toBeVisible()
  await expect.poll(() => readStoredState(page).then((state) => state?.plan?.path)).toBe(path)
  return (await readStoredState(page))!
}

export function tabLink(page: Page, label: '今日' | '记录' | '急救' | '进展' | '我的'): Locator {
  return page.locator('taro-tabbar').getByRole('tab', { name: new RegExp(`^${label}，`) })
}

export function settingSwitch(page: Page, label: string): Locator {
  return page.locator('.setting-row').filter({ hasText: label }).getByRole('checkbox')
}

export async function readSwitch(control: Locator): Promise<boolean> {
  return control.isChecked()
}

export async function readStoredState(page: Page): Promise<StoredClientState | null> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const wrapped = JSON.parse(raw) as { data?: StoredClientState }
    return wrapped.data ?? null
  }, STORAGE_KEY)
}

export async function readTaroClipboard(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('taro_clipboard')
    if (!raw) return null
    const wrapped = JSON.parse(raw) as { data?: string }
    return wrapped.data ?? null
  })
}
