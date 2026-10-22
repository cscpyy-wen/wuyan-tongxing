import { expect, test, type Page } from '@playwright/test'
import { completeOnboarding, readStoredState, STORAGE_KEY, tabLink, taroButton } from './support'

const NOW = '2026-10-13T04:00:00.000Z'

async function prepareToday(page: Page, withJourney = false): Promise<void> {
  await page.clock.setFixedTime(new Date(NOW))
  await completeOnboarding(page)
  if (!withJourney) return
  await page.evaluate(({ key, now }) => {
    const wrapped = JSON.parse(localStorage.getItem(key)!)
    wrapped.data.quitJourney = {
      attemptId: wrapped.data.plan.id,
      startedAt: '2026-09-13T04:00:00.000Z',
      confirmedAt: now,
      cigarettesPerDay: 20,
      pricePerPack: 30,
      cigarettesPerPack: 20,
    }
    localStorage.setItem(key, JSON.stringify(wrapped))
  }, { key: STORAGE_KEY, now: NOW })
  await page.reload()
  await expect(page.locator('.quit-orbit__number')).toHaveText('30')
}

for (const key of ['Enter', 'Space'] as const) {
  for (const field of [
    { label: '最后一支烟的日期', value: '2026-10-13' },
    { label: '最后一支烟的时间', value: '12:00' },
  ]) {
    test(`无烟起点${field.label}可用 ${key} 打开选择器`, async ({ page }) => {
      await prepareToday(page)
      await page.getByRole('button', { name: /我已戒烟/ }).click()
      const button = page.getByRole('button', { name: field.label, exact: true })
      await expect(button).toBeVisible()
      await button.focus()
      await button.press(key)
      const picker = page.locator('.weui-picker:visible')
      await expect(picker).toHaveCount(1)
      await picker.locator('.weui-picker__action').filter({ hasText: '确定' }).click()
      await expect(picker).toHaveCount(0)
      await expect(button).toHaveText(field.value)
      expect(await readStoredState(page)).not.toHaveProperty('quitJourney')
    })
  }
}

for (const withJourney of [false, true]) {
  for (const delayMs of [0, 100, 200]) {
    test(`${withJourney ? '已有无烟档案' : '尚未设置起点'}进入设置 ${delayMs}ms 后返回不会空白`, async ({ page }) => {
      await prepareToday(page, withJourney)
      const before = await readStoredState(page)
      await page.getByRole('button', {
        name: withJourney ? '修改无烟起点和估算参数' : /我已戒烟/,
      }).click()
      // These short delays deliberately exercise the unfinished route animation.
      // Do not wait for the setting page's entrance animation to settle first.
      if (delayMs) await page.waitForTimeout(delayMs)
      await taroButton(page, '‹ 返回首页').click()
      await expect(page).toHaveURL(/#\/pages\/today\/index/)
      // The bug hid Today after it was initially visible, when the old detail
      // animation callback fired. Assert again after that callback can run.
      await page.waitForTimeout(800)
      await expect(page.locator('.today-page:visible')).toHaveCount(1)
      await expect(page.locator('.quit-settings:visible')).toHaveCount(0)
      if (withJourney) await expect(page.locator('.quit-orbit__number')).toBeVisible()
      else await expect(page.getByRole('button', { name: /我已戒烟/ })).toBeVisible()
      expect(await readStoredState(page)).toEqual(before)
      // The returned page must still be operable, not merely retained in the DOM.
      await tabLink(page, '记录').click()
      await expect(page.locator('.records-page:visible')).toBeVisible()
      await tabLink(page, '今日').click()
      await expect(page.locator('.today-page:visible')).toBeVisible()
    })
  }
}
