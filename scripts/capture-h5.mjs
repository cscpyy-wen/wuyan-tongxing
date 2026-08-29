import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const baseURL = process.env.H5_BASE_URL ?? 'http://127.0.0.1:4173'
const outputDir = resolve(process.cwd(), 'docs/qa-screenshots')
await mkdir(outputDir, { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  colorScheme: 'light',
  deviceScaleFactor: 1,
})
const page = await context.newPage()

try {
  await page.goto(`${baseURL}/#/pages/onboarding/index`)
  await page.evaluate(() => window.localStorage.clear())
  await page.reload()
  await page.getByText('先了解你，再一起定计划', { exact: true }).waitFor()
  await page.screenshot({ path: resolve(outputDir, '01-onboarding.png'), fullPage: true })

  await page.getByRole('button', { name: '我已满 18 岁', exact: true }).click()
  await page.getByRole('button', { name: '是，当前吸纸烟', exact: true }).click()
  await page.getByRole('checkbox', { name: '接受产品与医疗边界', exact: true }).click()
  await page.getByRole('checkbox', { name: '单独同意本机处理敏感健康信息', exact: true }).click()
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: '压力或烦躁', exact: true }).click()
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: /直接戒断/ }).click()
  await page.getByRole('button', { name: '创建我的计划', exact: true }).click()
  await page.locator('.today-page:visible').waitFor()
  await page.screenshot({ path: resolve(outputDir, '02-today.png'), fullPage: true })

  await page.locator('.smoke-log-primary').click()
  await page.getByRole('dialog', { name: '记录这一支烟', exact: true }).waitFor()
  await page.waitForTimeout(250)
  await page.screenshot({ path: resolve(outputDir, '04-smoking-sheet.png'), fullPage: true })
  await page.getByRole('radio', { name: '吸烟原因：工作疲惫', exact: true }).click()
  await page.getByRole('radio', { name: '烟瘾强度 4，很强', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(1800)
  await page.locator('taro-tabbar').getByRole('link', { name: '记录', exact: true }).click()
  await page.locator('.records-page:visible').waitFor()
  await page.screenshot({ path: resolve(outputDir, '05-records.png'), fullPage: true })

  await page.locator('taro-tabbar').getByRole('link', { name: '进展', exact: true }).click()
  await page.locator('.progress-page:visible').waitFor()
  await page.screenshot({ path: resolve(outputDir, '06-progress.png'), fullPage: true })

  await page.locator('taro-tabbar').getByRole('link', { name: '我的', exact: true }).click()
  await page.locator('.profile-page:visible').waitFor()
  await page.screenshot({ path: resolve(outputDir, '03-profile.png'), fullPage: true })
  if (process.env.QA_DEBUG_DOM === '1') {
    const tabbarHtml = await page.locator('taro-tabbar').evaluate((element) => element.outerHTML)
    process.stdout.write(`${tabbarHtml}\n`)
  }
} finally {
  await browser.close()
}

process.stdout.write(`已生成视觉 QA 截图：${outputDir}\n`)
