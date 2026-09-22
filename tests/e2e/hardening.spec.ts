import { expect, test } from '@playwright/test'
import {
  completeOnboarding,
  readStoredState,
  readTaroClipboard,
  sosButton,
  startFresh,
  STORAGE_KEY,
  tabLink,
  taroButton,
} from './support'
import { decodeLosslessBase64, type LosslessBase64String } from '../../apps/client/src/lib/recoveryCodec'

const BACKUP_STORAGE_KEY = `${STORAGE_KEY}/last-known-good`

test('未同意健康信息时 SOS 可用但不保存烟瘾记录', async ({ page }) => {
  await startFresh(page)
  await page.goto('/#/pages/sos/index')
  await expect(page.getByText('这一阵会过去', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '调整烟瘾强度和练习方法', exact: true }).click()
  await page.getByRole('radio', { name: '烟瘾强度 5', exact: true }).click()
  await taroButton(page, '开始练习').click()
  await taroButton(page, '我已经稳住一些了').click()
  await expect(page.getByText('你穿过了这一阵', { exact: true })).toBeVisible()
  expect(await readStoredState(page)).toBeNull()
})

test('主副本同时损坏时不静默清空或覆盖原始数据', async ({ page }) => {
  await startFresh(page)
  const corruptPrimary = JSON.stringify({ data: { version: 1, onboarded: true, baseline: 'damaged-primary' } })
  const corruptBackup = JSON.stringify({ data: { version: 1, onboarded: true, plan: 'damaged-backup' } })
  await page.evaluate(({ key, backupKey, primary, backup }) => {
    localStorage.setItem(key, primary)
    localStorage.setItem(backupKey, backup)
  }, { key: STORAGE_KEY, backupKey: BACKUP_STORAGE_KEY, primary: corruptPrimary, backup: corruptBackup })

  await page.reload()
  await expect(page.getByText('本机数据需要恢复', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '导出恢复副本', exact: true })).toBeVisible()
  const stored = await page.evaluate(({ key, backupKey }) => ({
    primary: localStorage.getItem(key),
    backup: localStorage.getItem(backupKey),
  }), { key: STORAGE_KEY, backupKey: BACKUP_STORAGE_KEY })
  expect(stored).toEqual({ primary: corruptPrimary, backup: corruptBackup })
})

test('主备用原始 JSON 同时截断时显示恢复页并可导出原文', async ({ page }) => {
  await startFresh(page)
  const corruptPrimary = '{"data":'
  const corruptBackup = '{"data":{"version":1,"onboarded":'
  await page.evaluate(({ key, backupKey, primary, backup }) => {
    localStorage.setItem(key, primary)
    localStorage.setItem(backupKey, backup)
  }, { key: STORAGE_KEY, backupKey: BACKUP_STORAGE_KEY, primary: corruptPrimary, backup: corruptBackup })

  await page.reload()
  await expect(page.getByText('本机数据需要恢复', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '导出恢复副本', exact: true }).click()
  await expect.poll(() => readTaroClipboard(page)).not.toBeNull()
  const recovery = JSON.parse((await readTaroClipboard(page))!) as {
    readStatus: { primary: string; lastKnownGood: string }
    primary: LosslessBase64String
    lastKnownGood: LosslessBase64String
  }
  expect(recovery.readStatus).toEqual({ primary: 'unreadable', lastKnownGood: 'unreadable' })
  expect(decodeLosslessBase64(recovery.primary)).toBe(corruptPrimary)
  expect(decodeLosslessBase64(recovery.lastKnownGood)).toBe(corruptBackup)
  const stored = await page.evaluate(({ key, backupKey }) => ({
    primary: localStorage.getItem(key),
    backup: localStorage.getItem(backupKey),
  }), { key: STORAGE_KEY, backupKey: BACKUP_STORAGE_KEY })
  expect(stored).toEqual({ primary: corruptPrimary, backup: corruptBackup })
})

test('没有逐日确认时不会把时间流逝算成戒烟成功或节省', async ({ page }) => {
  await completeOnboarding(page)
  await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    if (!raw) throw new Error('missing state')
    const wrapped = JSON.parse(raw) as { data: { plan: { quitDate: string; createdAt: string } } }
    const date = new Date(Date.now() - 30 * 86_400_000)
    wrapped.data.plan.quitDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date)
    wrapped.data.plan.createdAt = new Date(`${wrapped.data.plan.quitDate}T12:00:00+08:00`).toISOString()
    localStorage.setItem(key, JSON.stringify(wrapped))
  }, STORAGE_KEY)
  await page.reload()
  await tabLink(page, '进展').click()

  await expect(page.locator('.progress-hero__label')).toHaveText('尚未确认无烟')
  await expect(page.locator('.progress-hero__value')).toHaveText('—')
  await expect(page.getByText('节省', { exact: true })).toHaveCount(0)
  await expect(page.getByText('已确认 1 天', { exact: true })).toHaveCount(0)
})

test('高烟瘾事件不会无提示替换当天既定任务', async ({ page }) => {
  await completeOnboarding(page)
  const taskBefore = await page.locator('.lesson-card .lesson-card__title').innerText()
  await sosButton(page).click()
  await page.getByRole('button', { name: '调整烟瘾强度和练习方法', exact: true }).click()
  await page.getByRole('radio', { name: '烟瘾强度 5', exact: true }).click()
  await taroButton(page, '开始练习').click()
  await taroButton(page, '我已经稳住一些了').click()
  await tabLink(page, '今日').click()
  await expect(page).toHaveURL(/#\/pages\/today\/index/)
  await expect(page.locator('.lesson-card .lesson-card__title')).toHaveText(taskBefore)
})

test('编辑吸烟记录保留身份与原始录入时间并更新统计', async ({ page }) => {
  await completeOnboarding(page)
  await page.locator('.smoke-log-primary').click()
  await page.getByRole('radio', { name: '吸烟原因：工作疲惫', exact: true }).click()
  await page.getByRole('radio', { name: '烟瘾强度 4，很强', exact: true }).click()
  await taroButton(page, '保存').click()
  const before = (await readStoredState(page))!.cigarettes[0]!

  await tabLink(page, '记录').click()
  const edit = page.locator('.records-page:visible').getByRole('button', { name: /编辑 .* 的吸烟记录/ }).first()
  const editBox = await edit.boundingBox()
  expect(editBox).not.toBeNull()
  await edit.click()
  // Android WebView can emit a delayed click after the source control has been
  // replaced by the sheet. Inject it at the source's old device coordinate;
  // locator.click() would wait for the covered source and would not model this.
  await page.waitForTimeout(150)
  await page.mouse.click(
    editBox!.x + editBox!.width / 2,
    editBox!.y + editBox!.height / 2,
  )
  await expect(page.getByText('编辑记录', { exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: '烟瘾强度 4，很强，已选', exact: true })).toBeChecked()
  await expect(page.getByRole('radio', { name: '烟瘾强度 2，较轻', exact: true })).not.toBeChecked()
  await page.getByRole('radio', { name: '吸烟原因：刚吃完饭', exact: true }).click()
  await page.getByRole('radio', { name: '烟瘾强度 2，较轻', exact: true }).click()
  await taroButton(page, '保存').click()

  const after = (await readStoredState(page))!.cigarettes[0]!
  expect(after.id).toBe(before.id)
  expect(after.loggedAt).toBe(before.loggedAt)
  expect(after).toMatchObject({ trigger: 'meal', cravingIntensity: 2 })
  expect(after.updatedAt).toBeTruthy()
  const currentRecords = page.locator('.records-page:visible')
  await expect(currentRecords.getByText('刚吃完饭', { exact: true }).first()).toBeVisible()
  await expect(currentRecords.getByText('烟瘾 2/5', { exact: true })).toBeVisible()
})

test('已有计划冷启动不会短暂渲染首次设置内容', async ({ page }) => {
  await completeOnboarding(page)
  await page.addInitScript(() => {
    const marker = '先确认这几项'
    ;(window as typeof window & { __wuyanSawWrongOnboarding?: boolean }).__wuyanSawWrongOnboarding = false
    const inspect = () => {
      if (document.body?.innerText.includes(marker)) {
        ;(window as typeof window & { __wuyanSawWrongOnboarding?: boolean }).__wuyanSawWrongOnboarding = true
      }
    }
    new MutationObserver(inspect).observe(document.documentElement, { childList: true, subtree: true, characterData: true })
    document.addEventListener('DOMContentLoaded', inspect, { once: true })
  })

  await page.goto('/')
  await expect(page).toHaveURL(/#\/pages\/today\/index/)
  await expect(page.locator('.today-page:visible')).toBeVisible()
  expect(await page.evaluate(() => (
    window as typeof window & { __wuyanSawWrongOnboarding?: boolean }
  ).__wuyanSawWrongOnboarding)).toBe(false)
})

test('快捷记录可只修改时间而不虚构原因或烟瘾强度', async ({ page }) => {
  await completeOnboarding(page)
  const before = await page.evaluate((key) => {
    const wrapped = JSON.parse(localStorage.getItem(key)!)
    const event = {
      id: crypto.randomUUID(),
      createdAt: new Date(Date.now() - 600_000).toISOString(),
      loggedAt: new Date().toISOString(),
      count: 1, attemptId: wrapped.data.plan.id, source: 'QUICK_LOG',
    }
    wrapped.data.cigarettes = [event]
    localStorage.setItem(key, JSON.stringify(wrapped))
    return event
  }, STORAGE_KEY)
  await page.reload()
  await tabLink(page, '记录').click()
  await page.locator('.records-page:visible').getByRole('button', { name: /编辑 .* 的吸烟记录/ }).first().click()
  await expect(page.getByText('编辑记录', { exact: true })).toBeVisible()
  await expect(taroButton(page, '保存')).toBeEnabled()
  const editedAt = new Date(new Date(before.createdAt).getTime() + 120_000)
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(editedAt)
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(editedAt)
  // Exercise the platform picker's public change contract; Android gestures are
  // independently checked on-device. No React state or action is bypassed.
  const pickers = page.locator('.smoking-time-row taro-picker-core')
  await pickers.nth(0).evaluate((element, value) => {
    element.dispatchEvent(new CustomEvent('change', { detail: { value }, bubbles: true }))
  }, date)
  await pickers.nth(1).evaluate((element, value) => {
    element.dispatchEvent(new CustomEvent('change', { detail: { value }, bubbles: true }))
  }, time)
  await taroButton(page, '保存').click()
  await expect(page.getByText('编辑记录', { exact: true })).toHaveCount(0)
  const after = (await readStoredState(page))!.cigarettes[0]!
  expect(after.id).toBe(before.id)
  expect(after.loggedAt).toBe(before.loggedAt)
  expect(after.createdAt).toBe(new Date(`${date}T${time}:00+08:00`).toISOString())
  expect(after.trigger).toBeUndefined()
  expect(after.cravingIntensity).toBeUndefined()
  expect(after.updatedAt).toBeTruthy()
  await expect(page.locator('.records-page:visible').getByText('快捷记录', { exact: true })).toBeVisible()
})

test('日终确认弹窗跨过北京时间午夜后必须重新确认', async ({ page }) => {
  await completeOnboarding(page)
  await page.clock.install({ time: new Date('2026-09-22T15:59:50Z') })
  await taroButton(page, '确认今日 0 支').click()
  await expect(page.getByText('确认今日记录？', { exact: true })).toBeVisible()
  await page.clock.setSystemTime(new Date('2026-09-22T16:00:02Z'))
  await page.locator('.taro-model__confirm').click()
  await expect(page.getByText('日期或记录已变化，请重新确认', { exact: true })).toBeVisible()
  expect((await readStoredState(page))!.checkIns).toHaveLength(0)
})
