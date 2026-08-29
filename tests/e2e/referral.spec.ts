import { expect, test } from '@playwright/test'
import { completeOnboarding, tabLink, taroButton } from './support'

test('转介页只提供有证据支持的省级选择，不请求定位或伪造城市目录', async ({ page }) => {
  await page.addInitScript(() => {
    let calls = 0
    const geolocation = navigator.geolocation
    if (geolocation) {
      Object.defineProperty(geolocation, 'getCurrentPosition', { configurable: true, value: () => { calls += 1 } })
      Object.defineProperty(geolocation, 'watchPosition', { configurable: true, value: () => { calls += 1; return 1 } })
    }
    Object.defineProperty(window, '__wuyanGeolocationCalls', { configurable: true, get: () => calls })
  })
  await completeOnboarding(page)
  await tabLink(page, '我的').click()
  await taroButton(page, '专业支持 ›').click()

  await expect(page.getByText('手动选择省级地区', { exact: true })).toBeVisible()
  await expect(page.getByText('现有核验数据不足以诚实提供城市级目录', { exact: false })).toBeVisible()
  await expect(page.getByText('北京地区可用查询方式', { exact: true })).toBeVisible()
  await expect(page.getByText('中国戒烟平台', { exact: true })).toBeVisible()
  await expect(page.getByText('当地 12320 卫生热线', { exact: true })).toBeVisible()
  await expect(page.getByText('手动选择市', { exact: false })).toHaveCount(0)

  await page.getByTestId('province-picker').click()
  await expect(page.getByRole('group', { name: '省级地区列表' })).toBeVisible()
  await page.getByRole('button', { name: '广东', exact: true }).click()
  await expect(page.getByText('广东地区可用查询方式', { exact: true })).toBeVisible()
  await expect(page.getByRole('group', { name: '省级地区列表' })).toHaveCount(0)

  const geolocationCalls = await page.evaluate(() => (window as unknown as { __wuyanGeolocationCalls: number }).__wuyanGeolocationCalls)
  expect(geolocationCalls).toBe(0)
})
