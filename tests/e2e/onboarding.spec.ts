import { expect, test } from '@playwright/test'
import {
  completeOnboarding,
  readStoredState,
  selectAccessibleCheckbox,
  selectAccessibleRadio,
  startFresh,
  taroButton,
} from './support'

test.describe('成人边界与首次设置', () => {
  test('未成年人退出时不持久化问卷、计划或敏感同意', async ({ page }) => {
    await startFresh(page)
    await page.getByRole('radio', { name: '我未满 18 岁', exact: true }).click()

    await expect(page.getByText('这版产品暂不面向未成年人', { exact: true })).toBeVisible()
    await expect(page.getByText('我们没有保存你的任何回答。', { exact: false })).toBeVisible()

    const state = await readStoredState(page)
    expect(state?.onboarded ?? false).toBe(false)
    expect(state?.baseline).toBeUndefined()
    expect(state?.plan).toBeUndefined()
    expect(state?.settings.sensitiveHealthData ?? false).toBe(false)

    await page.reload()
    await expect(page.getByText('先确认这几项', { exact: true })).toBeVisible()
  })

  test('首次设置明确免登录和本机保存且不显示内部审核提示', async ({ page }) => {
    await startFresh(page)
    await expect(page.getByText('无需登录，数据只存本机。', { exact: true })).toBeVisible()
    await expect(page.getByText('循证草案', { exact: false })).toHaveCount(0)
    await expect(page.getByText('待医学审核', { exact: false })).toHaveCount(0)
  })

  test('晨起首支烟必须主动回答，选择器可确认首个分组', async ({ page }) => {
    await startFresh(page)
    await selectAccessibleRadio(page, '我已满 18 岁')
    await selectAccessibleRadio(page, '是，当前吸纸烟')
    await selectAccessibleCheckbox(page, '接受产品与医疗边界')
    await selectAccessibleCheckbox(page, '单独同意本机处理敏感健康信息')
    await taroButton(page, '继续').click()

    const currentValue = page.getByRole('button', {
      name: '起床后多久吸第一支，尚未选择',
      exact: true,
    })
    await expect(currentValue).toBeVisible()
    await expect(currentValue).toBeEnabled()
    await expect(taroButton(page, '继续')).toBeDisabled()
    await currentValue.click()
    await expect(page.locator('.weui-picker__item').filter({ hasText: '5 分钟内' })).toBeVisible()
    await page.locator('.weui-picker__action').filter({ hasText: '确定' }).click()
    await expect(page.getByRole('button', {
      name: '起床后多久吸第一支，当前 起床后 5 分钟内',
      exact: true,
    })).toHaveText('起床后 5 分钟内')
    await expect(taroButton(page, '继续')).toBeEnabled()
  })

  test('首次必选项使用单一原生控件并暴露实时状态和完整触控范围', async ({ page }) => {
    await startFresh(page)

    const adult = page.getByRole('radio', { name: '我已满 18 岁', exact: true })
    await adult.click()
    const selectedAdult = page.getByRole('radio', { name: '我已满 18 岁，已选', exact: true })
    await expect(selectedAdult).toBeChecked()

    const consent = page.getByRole('checkbox', { name: '接受产品与医疗边界，未选', exact: true })
    const before = await consent.boundingBox()
    expect(before?.width).toBeGreaterThanOrEqual(44)
    expect(before?.height).toBeGreaterThanOrEqual(44)
    await consent.click()
    const selectedConsent = page.getByRole('checkbox', { name: '接受产品与医疗边界，已选', exact: true })
    await expect(selectedConsent).toBeChecked()

    await expect(page.locator('.consent-switch .accessible-choice-input')).toHaveCount(2)
    await expect(page.locator('.consent-switch__track')).toHaveCount(2)
    await expect(page.locator('.consent-switch > .taro-checkbox_checked')).toHaveCount(0)
  })

  test('直接戒断路径完成首次设置并默认保存在本机', async ({ page }) => {
    const state = await completeOnboarding(page, 'abrupt')

    expect(state.onboarded).toBe(true)
    expect(state.plan?.path).toBe('abrupt')
    expect(state.plan?.attemptNumber).toBe(1)
    expect(state.baseline?.cigarettesPerDay).toBe(10)
    expect((state.baseline as { firstCigaretteMinutes?: number } | undefined)?.firstCigaretteMinutes).toBe(5)
    expect(state.baseline?.reasons).toContain('为了健康')
    expect(state.baseline?.triggers).toContain('stress')
    expect(state.settings.sensitiveHealthData).toBe(true)
    await expect(page.getByText('三阶段减量计划', { exact: true })).toHaveCount(0)
  })

  test('限期减量路径生成三阶段计划并在目标日归零', async ({ page }) => {
    const state = await completeOnboarding(page, 'reduction')

    expect(state.onboarded).toBe(true)
    expect(state.plan?.path).toBe('reduction')
    await expect(page.getByText('减量计划', { exact: true })).toBeVisible()
    await expect(page.locator('.schedule-row')).toHaveCount(3)
    await expect(page.getByText('戒烟日归零', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: '降低先减到约四分之三上限', exact: true }).click()
    await expect(page.locator('.schedule-row').first()).toContainText('≤ 6 支')
    const adjusted = await readStoredState(page)
    expect(adjusted?.plan?.reductionLimits).toEqual({ stage75: 6, stage50: 5, stage25: 2 })
  })
})
