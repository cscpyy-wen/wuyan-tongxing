import { defineConfig } from '@playwright/test'

const portText = process.env.WUYAN_E2E_PORT ?? '4173'
const port = Number.parseInt(portText, 10)
const targetRoot = process.env.WUYAN_E2E_ROOT
const baseURL = `http://127.0.0.1:${port}`

if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`WUYAN_E2E_PORT 无效：${process.env.WUYAN_E2E_PORT ?? ''}`)
}
if (targetRoot && targetRoot !== 'deploy/tencent-cloudbase/dist') {
  throw new Error(`WUYAN_E2E_ROOT 不在允许列表：${targetRoot}`)
}

export default defineConfig({
  testDir: './tests',
  testMatch: targetRoot ? ['e2e/**/*.spec.ts', 'e2e-cn/**/*.spec.ts'] : 'e2e/**/*.spec.ts',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    viewport: { width: 390, height: 844 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    permissions: ['clipboard-read', 'clipboard-write'],
    actionTimeout: 8_000,
    navigationTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    // Taro 的 H5 watch 模式会走不同于生产构建的 ESM 解析路径；
    // E2E 针对最终交付产物，先构建再用无状态静态服务器托管。
    command: targetRoot
      ? `pnpm build:cn-preview && node scripts/serve-h5.mjs ${port} ${targetRoot}`
      : `pnpm build:h5 && node scripts/serve-h5.mjs ${port}`,
    url: baseURL,
    // Never attach to an arbitrary process already listening on the test port:
    // doing so can make a stale bundle pass while the current source is broken.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
