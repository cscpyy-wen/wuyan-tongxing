import { expect, test } from '@playwright/test'
import {
  completeOnboarding,
  readStoredState,
  readSwitch,
  readTaroClipboard,
  settingSwitch,
  tabLink,
  taroButton,
} from './support'

test('可选同步、统计和订阅默认关闭，并支持数据导出与删除', async ({ page }) => {
  await completeOnboarding(page)
  await tabLink(page, '我的').click()
  await expect(page.locator('.profile-page:visible')).toBeVisible()

  await expect.poll(() => readSwitch(settingSwitch(page, '微信提醒'))).toBe(false)
  await expect.poll(() => readSwitch(settingSwitch(page, '云端同步'))).toBe(false)
  await expect.poll(() => readSwitch(settingSwitch(page, '成效统计'))).toBe(false)
  await expect(settingSwitch(page, '微信提醒')).toHaveAttribute('aria-label', '微信订阅消息，已关闭')
  await expect(settingSwitch(page, '云端同步')).toHaveAttribute('aria-label', '云端同步，已关闭')
  await expect(settingSwitch(page, '成效统计')).toHaveAttribute('aria-label', '假名化成效统计，已关闭')
  await expect(settingSwitch(page, '健康记录')).toHaveAttribute('aria-label', '本机处理敏感健康信息，已开启')
  await expect(page.getByText('微信提醒', { exact: true })).toBeVisible()
  await expect.poll(async () => (await readStoredState(page))?.settings.inAppReminder).toBe(false)

  await taroButton(page, '导出副本').click()
  await expect(page.locator('.taro-modal__title')).toHaveText('导出敏感健康数据副本？')
  await expect(page.locator('.taro-modal__content')).toContainText('系统剪贴板')
  await page.locator('.taro-model__confirm').click()
  await expect.poll(() => readTaroClipboard(page)).not.toBeNull()
  const exported = JSON.parse((await readTaroClipboard(page))!) as Awaited<ReturnType<typeof readStoredState>>
  expect(exported?.onboarded).toBe(true)
  expect(exported?.settings).toMatchObject({
    subscriptionEnabled: false,
    cloudSync: false,
    outcomeAnalytics: false,
  })

  await taroButton(page, '删除所有数据').click()
  await expect(page.locator('.taro-modal__title')).toHaveText('删除本机全部数据？')
  await page.locator('.taro-model__confirm').click()

  await expect(page).toHaveURL(/#\/pages\/onboarding\/index/)
  await expect(page.getByText('先确认这几项', { exact: true })).toBeVisible()
  await expect.poll(async () => (await readStoredState(page))?.onboarded ?? false).toBe(false)

  const resetState = await readStoredState(page)
  expect(resetState).toBeNull()
  await expect.poll(() => readTaroClipboard(page)).toBeNull()
})
