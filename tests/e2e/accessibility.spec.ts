import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator } from '@playwright/test'
import { completeOnboarding, sosButton, tabLink } from './support'

async function expectFocusNotObscured(control: Locator, label: string) {
  await control.focus()
  const hasVisibleFocusPoint = await control.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const inset = 3
    const points = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + inset, rect.top + inset],
      [rect.right - inset, rect.bottom - inset],
    ]
    return points.some(([x = -1, y = -1]) => {
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false
      const top = document.elementFromPoint(x, y)
      return Boolean(top && (top === element || element.contains(top) || top.contains(element)))
    })
  })
  expect(hasVisibleFocusPoint, `${label}获得焦点后不应被固定层完全遮挡`).toBe(true)
}

test('手机视口下主旅程具备基本可访问性且无横向溢出', async ({ page }) => {
  await completeOnboarding(page)
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 })
  let consistentSosBox: { x: number; y: number; width: number; height: number } | undefined

  for (const tab of ['今日', '记录', '进展', '我的'] as const) {
    await tabLink(page, tab).click()
    await expect(tabLink(page, tab)).toBeVisible()
    await expect(tabLink(page, tab)).toHaveAttribute('aria-selected', 'true')
    await expect(tabLink(page, tab)).toHaveAttribute('aria-current', 'page')
    const currentSos = sosButton(page)
    await expect(currentSos).toBeVisible()
    await expect.poll(async () => currentSos.boundingBox()).not.toBeNull()
    const currentSosBox = await currentSos.boundingBox()
    expect(currentSosBox).not.toBeNull()
    if (consistentSosBox) {
      expect(currentSosBox!.x).toBeCloseTo(consistentSosBox.x, 0)
      expect(currentSosBox!.y).toBeCloseTo(consistentSosBox.y, 0)
      expect(currentSosBox!.width).toBeCloseTo(consistentSosBox.width, 0)
      expect(currentSosBox!.height).toBeCloseTo(consistentSosBox.height, 0)
    } else {
      consistentSosBox = currentSosBox!
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)

    const tabResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
      .analyze()
    expect(
      tabResults.violations,
      `${tab}页：\n${tabResults.violations.map((item) => `${item.id}: ${item.help}`).join('\n')}`,
    ).toEqual([])

    // axe 默认关闭 2.5.8 target-size；在候选验收中显式启用。
    const targetResults = await new AxeBuilder({ page }).withRules(['target-size']).analyze()
    expect(
      targetResults.violations,
      `${tab}页目标尺寸：\n${targetResults.violations.map((item) => `${item.id}: ${item.help}`).join('\n')}`,
    ).toEqual([])

    // axe 尚未自动覆盖 2.4.11；逐一聚焦当前页自定义按钮，确认至少
    // 有一个可见焦点采样点未被底部 tabBar 或浮动 SOS 完全遮挡。
    const focusableButtons = page.locator('[role="button"][tabindex="0"]:visible')
    for (let index = 0; index < await focusableButtons.count(); index += 1) {
      await expectFocusNotObscured(focusableButtons.nth(index), `${tab}页第 ${index + 1} 个按钮`)
    }
  }

  const sos = sosButton(page)
  const box = await sos.boundingBox()
  expect(box, '烟瘾急救按钮应有可测量的触控区域').not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(44)
  expect(box!.height).toBeGreaterThanOrEqual(44)
  const tabbarBox = await page.locator('taro-tabbar .weui-tabbar').boundingBox()
  expect(tabbarBox, '底部导航应有可测量的布局区域').not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(tabbarBox!.y)
  expect(box!.y + box!.height).toBeLessThanOrEqual(tabbarBox!.y + tabbarBox!.height)
  const centreHitTarget = await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y)
    return {
      isSos: target?.closest('.weui-tabbar__item:nth-child(3)')?.textContent?.trim() === '急救',
    }
  }, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 })
  expect(centreHitTarget.isSos, '底栏中央坐标必须真正命中急救按钮').toBe(true)
  for (const tab of ['今日', '记录', '进展', '我的'] as const) {
    const tabBox = await tabLink(page, tab).boundingBox()
    expect(tabBox, `${tab}入口应有可测量的触控区域`).not.toBeNull()
    const overlaps = !(
      box!.x + box!.width <= tabBox!.x
      || tabBox!.x + tabBox!.width <= box!.x
      || box!.y + box!.height <= tabBox!.y
      || tabBox!.y + tabBox!.height <= box!.y
    )
    expect(overlaps, `急救按钮不得覆盖${tab}入口`).toBe(false)
  }

  await tabLink(page, '今日').click()
  const smokingEntry = page.locator('.smoke-log-primary')
  const smokingEntryBox = await smokingEntry.boundingBox()
  expect(smokingEntryBox?.width).toBeGreaterThanOrEqual(44)
  expect(smokingEntryBox?.height).toBeGreaterThanOrEqual(64)
  await smokingEntry.click()
  await expect(page.getByRole('dialog', { name: '记录这一支烟', exact: true })).toBeVisible()
  const dialogResults = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
    .analyze()
  expect(dialogResults.violations).toEqual([])
  await page.getByRole('button', { name: '关闭吸烟记录面板', exact: true }).click()

  const restoredSos = sosButton(page)
  await expect(restoredSos).toBeVisible()
  await expect(restoredSos).not.toHaveAttribute('inert', '')
  await restoredSos.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/pages\/sos\/index/)

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
    .analyze()
  const blocking = results.violations
  expect(
    blocking,
    blocking.map((item) => `${item.id}: ${item.help}`).join('\n'),
  ).toEqual([])
})

test('限期减量调整控件满足移动端目标尺寸、名称与横向重排要求', async ({ page }) => {
  await completeOnboarding(page, 'reduction')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)

  for (const label of [
    '降低先减到约四分之三上限', '提高先减到约四分之三上限',
    '降低再减到约一半上限', '提高再减到约一半上限',
    '降低最后减到约四分之一上限', '提高最后减到约四分之一上限',
  ]) {
    const control = page.getByRole('button', { name: label, exact: true })
    await expect(control).toBeVisible()
    const box = await control.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(box?.height).toBeGreaterThanOrEqual(44)
  }

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
    .analyze()
  expect(results.violations).toEqual([])
})
