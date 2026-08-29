import { expect, test } from '@playwright/test'
import { completeOnboarding, readStoredState, sosButton, taroButton } from './support'

test('完成一次在线初始化后可断网重载并首次进入 SOS', async ({ page, context }) => {
  await completeOnboarding(page)

  const controlled = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('当前浏览器不支持 Service Worker')
    await navigator.serviceWorker.ready
    return Boolean(navigator.serviceWorker.controller)
  })

  // 首次安装通常会立即接管；保留一次在线重载作为浏览器实现差异的兜底。
  if (!controlled) await page.reload({ waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) throw new Error('离线缓存未接管页面')
    const cacheKeys = await caches.keys()
    if (!cacheKeys.some((key) => key.startsWith('wuyan-h5-static-'))) {
      throw new Error('未找到无烟同行离线缓存')
    }
  })

  await context.setOffline(true)
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.today-page:visible')).toBeVisible()
    await page.locator('.smoke-log-primary').click()
    await page.getByRole('radio', { name: '吸烟原因：工作疲惫', exact: true }).click()
    await page.getByRole('radio', { name: '烟瘾强度 5，难忍', exact: true }).click()
    await taroButton(page, '保存').click()
    await expect.poll(async () => (await readStoredState(page))?.cigarettes.length).toBe(1)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.smoking-hero__count')).toContainText('1 支')
    await sosButton(page).click()
    await expect(page).toHaveURL(/#\/pages\/sos\/index/)
    await expect(page.getByText('先把呼吸放慢', { exact: true })).toBeVisible()
  } finally {
    await context.setOffline(false)
  }
})
