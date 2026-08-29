import { expect, test } from '@playwright/test'

test('CloudBase 入口 CSP 先于脚本生效并阻止未授权内联脚本', async ({ page }) => {
  await page.goto('/#/pages/onboarding/index')
  await expect(page.getByText('无需登录，数据只存本机。')).toBeVisible()

  const result = await page.evaluate(async () => {
    const marker = '__wuyanUnauthorizedInlineScript'
    const violation = new Promise<boolean>((resolve) => {
      const timeout = window.setTimeout(() => resolve(false), 500)
      window.addEventListener('securitypolicyviolation', () => {
        window.clearTimeout(timeout)
        resolve(true)
      }, { once: true })
    })
    const script = document.createElement('script')
    script.textContent = `window.${marker}=true`
    document.body.append(script)
    const blocked = !(window as Window & Record<string, unknown>)[marker]
    script.remove()
    return { blocked, violated: await violation }
  })

  expect(result).toEqual({ blocked: true, violated: true })
})
