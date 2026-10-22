import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import {
  completeOnboarding,
  readStoredState,
  readTaroClipboard,
  selectAccessibleCheckbox,
  STORAGE_KEY,
  tabLink,
  taroButton,
  type StoredClientState,
} from './support'

const NOW = '2026-10-13T04:00:00.000Z' // 北京时间 12:00；计时器仍按真实时间运行。
const DAY_MS = 86_400_000
type QuitState = StoredClientState & {
  quitJourney?: {
    attemptId: string
    startedAt: string
    confirmedAt: string
    cigarettesPerDay: number
    pricePerPack: number
    cigarettesPerPack: number
  }
}

async function readQuitState(page: Page): Promise<QuitState> {
  const state = await readStoredState(page)
  if (!state) throw new Error('缺少已完成引导的本机状态')
  return state as QuitState
}

async function confirmCurrentPicker(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click()
  // The overlay wrapper has no area; its fixed-position picker is the visible UI.
  const overlay = page.locator('.weui-picker:visible')
  await expect(overlay).toBeVisible()
  await overlay.locator('.weui-picker__action').filter({ hasText: '确定' }).click()
  await expect(overlay).toHaveCount(0)
}

/** Other scenarios use the same persisted shape; the first test exercises the actual form. */
async function seedThirtyDayJourney(page: Page): Promise<void> {
  await page.evaluate(({ key, now, startedAt }) => {
    const raw = localStorage.getItem(key)
    if (!raw) throw new Error('缺少本机状态')
    const wrapped = JSON.parse(raw) as { data: QuitState }
    if (!wrapped.data.plan || wrapped.data.cigarettes.length) throw new Error('需要无吸烟记录的引导结果')
    wrapped.data.quitJourney = {
      attemptId: wrapped.data.plan.id,
      startedAt,
      confirmedAt: now,
      cigarettesPerDay: 20,
      pricePerPack: 30,
      cigarettesPerPack: 20,
    }
    localStorage.setItem(key, JSON.stringify(wrapped))
  }, { key: STORAGE_KEY, now: NOW, startedAt: new Date(Date.parse(NOW) - 30 * DAY_MS).toISOString() })
  await page.reload()
  await expect(page.locator('.quit-orbit__number')).toHaveText('30')
}

async function expectNoHorizontalOverflow(page: Page, selector: string): Promise<void> {
  // A newly navigated page is visible while it is still sliding into the viewport.
  // Retry the exact same zero-overflow assertion rather than measuring one animation frame.
  await expect.poll(() => page.locator(selector).evaluate((root) => {
    const elements = [root, ...root.querySelectorAll<HTMLElement>(
      '.quit-orbit__inside, .quit-orbit__time, .quit-gain, .quit-gain__value, .quit-nicotine, '
      + '.quit-nicotine__value, .quit-risk-card, .quit-timeline__item, .quit-basis, '
      + '.quit-settings__fields, .quit-settings__field, button, input',
    )]
    const result = elements.filter((element) => {
      const box = element.getBoundingClientRect()
      if (!box.width || !box.height) return false
      return box.left < -1 || box.right > window.innerWidth + 1
        || (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1)
    }).map((element) => `${element.tagName}.${element.className}`)
    if (document.documentElement.scrollWidth > window.innerWidth + 1) result.push('document')
    return result
  }), { message: '320px 视口内文字和操作应完整重排，不依赖横向滚动或裁切' }).toEqual([])
}

async function doubleTextSize(page: Page, selector: string): Promise<void> {
  // Resize actual text independently of card geometry, including pixel-sized text.
  // Read all original sizes before writes to avoid multiplying inherited sizes twice.
  const resized = await page.locator(selector).evaluate((root) => {
    const sizes = [root as HTMLElement, ...root.querySelectorAll<HTMLElement>('*')]
      .filter((element) => element.tagName === 'INPUT'
        || [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()))
      .map((element) => ({ element, size: Number.parseFloat(getComputedStyle(element).fontSize) }))
      .filter(({ size }) => Number.isFinite(size) && size > 0)
    sizes.forEach(({ element, size }) => element.style.setProperty('font-size', `${size * 2}px`, 'important'))
    return sizes.length
  })
  expect(resized).toBeGreaterThan(10)
}

async function expectAccessible(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
    .analyze()
  expect(result.violations, result.violations.map((item) => `${item.id}: ${item.help}`).join('\n')).toEqual([])
}

test.describe('已戒烟用户的无烟首页', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date(NOW))
    await completeOnboarding(page)
  })

  test('实际选择起点并明确自报，30天估算可调整、刷新保留，记一支只重启连续计时', async ({ page }) => {
    test.setTimeout(75_000)
    const initial = await readQuitState(page)
    expect(initial.quitJourney).toBeUndefined()
    await expect(page.locator('.quit-dashboard')).toHaveCount(0)
    await page.getByRole('button', { name: /我已戒烟/ }).click()
    await expect(page).toHaveURL(/#\/pages\/quit-settings\/index/)
    await expect(page.getByText('你的无烟起点', { exact: true })).toBeVisible()

    await taroButton(page, '保存并查看成就').click()
    await expect(page.getByRole('alert')).toHaveText('请选择最后一支烟的日期和时间')
    // Both values must be selected through the real Picker, not injected into React/storage.
    await confirmCurrentPicker(page, '最后一支烟的日期')
    await expect(page.getByRole('button', { name: '最后一支烟的日期', exact: true })).toHaveText('2026-10-13')
    await confirmCurrentPicker(page, '最后一支烟的时间')
    await expect(page.getByRole('button', { name: '最后一支烟的时间', exact: true })).toHaveText('12:00')
    await taroButton(page, '保存并查看成就').click()
    await expect(page.getByRole('alert')).toHaveText('请确认此后没有再吸烟')
    expect((await readQuitState(page)).quitJourney).toBeUndefined()
    await selectAccessibleCheckbox(page, '从这个时间起，我没有再吸烟')
    await page.getByRole('spinbutton', { name: '每天支数', exact: true }).fill('20')
    await page.getByRole('spinbutton', { name: '每包价格', exact: true }).fill('30')
    await page.getByRole('spinbutton', { name: '每包支数', exact: true }).fill('20')
    await taroButton(page, '保存并查看成就').click()

    await expect(page).toHaveURL(/#\/pages\/today\/index/)
    await expect(page.locator('.quit-orbit__label')).toHaveText('持续无烟')
    await expect(page.locator('.quit-orbit__number')).toHaveText('0')
    await expect(page.locator('.quit-orbit__time')).toHaveText('0 小时 · 0 分钟')
    const saved = await readQuitState(page)
    expect(saved.quitJourney).toEqual({
      attemptId: initial.plan!.id, startedAt: NOW, confirmedAt: NOW,
      cigarettesPerDay: 20, pricePerPack: 30, cigarettesPerPack: 20,
    })
    expect(saved.checkIns).toEqual(initial.checkIns)
    expect(saved.plan).toEqual(initial.plan)

    await page.clock.setFixedTime(new Date(Date.parse(NOW) + 30 * DAY_MS))
    await page.reload()
    await expect(page.locator('.quit-orbit__number')).toHaveText('30')
    await expect(page.locator('.quit-hero__badge')).toHaveText('30 天纪念')
    await expect(page.locator('.quit-gain--money .quit-gain__value')).toHaveText('¥900')
    await expect(page.locator('.quit-gain').filter({ hasText: '少吸卷烟' }).locator('.quit-gain__value')).toHaveText('600 支')
    await expect(page.locator('.quit-nicotine__value')).toHaveText('600–1,200 mg')
    await expect(page.locator('.quit-nicotine')).toContainText('粗估 · 非体内测量')

    await page.getByRole('button', { name: '修改无烟起点和估算参数', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: /从这个时间起/ })).toHaveCount(0)
    await page.getByRole('spinbutton', { name: '每包价格', exact: true }).fill('40')
    await page.getByRole('spinbutton', { name: '每包支数', exact: true }).fill('25')
    await taroButton(page, '保存并查看成就').click()
    await expect(page.locator('.quit-gain--money .quit-gain__value')).toHaveText('¥960')
    await page.reload()
    await expect(page.locator('.quit-orbit__number')).toHaveText('30')
    await expect(page.locator('.quit-gain--money .quit-gain__value')).toHaveText('¥960')
    expect((await readQuitState(page)).quitJourney).toEqual({ ...saved.quitJourney, pricePerPack: 40, cigarettesPerPack: 25 })

    await taroButton(page, '记一支').click()
    await expect(page.getByRole('dialog', { name: '记录这一支烟', exact: true })).toBeVisible()
    await page.getByRole('radio', { name: '吸烟原因：刚吃完饭', exact: true }).click()
    await page.getByRole('radio', { name: '烟瘾强度 3，明显', exact: true }).click()
    await taroButton(page, '保存').click()
    await expect.poll(async () => (await readQuitState(page)).cigarettes.length).toBe(1)
    await expect(page.locator('.quit-orbit__label')).toHaveText('重新无烟')
    await expect(page.locator('.quit-orbit__number')).toHaveText('0')
    await expect(page.locator('.quit-orbit__time')).toHaveText('0 小时 · 0 分钟')
    await expect(page.locator('.quit-gain').filter({ hasText: '少吸卷烟' }).locator('.quit-gain__value')).toHaveText('599 支')
    await expect(page.locator('.quit-gain--money .quit-gain__value')).toHaveText('¥958')
    await expect(page.locator('.quit-nicotine__value')).toHaveText('599–1,198 mg')
    await page.reload()
    await expect(page.locator('.quit-orbit__number')).toHaveText('0')
    await expect(page.locator('.quit-nicotine__value')).toHaveText('599–1,198 mg')
    expect((await readQuitState(page)).quitJourney?.startedAt).toBe(NOW)
  })

  test('健康时间线与科学依据可折叠，保持群体额外风险口径并提供可复制来源', async ({ page }) => {
    await seedThirtyDayJourney(page)
    const timelineToggle = page.getByRole('button', { name: /^时间线/ })
    await expect(timelineToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.quit-timeline')).toHaveCount(0)
    await expect(page.locator('.quit-health__caption')).toHaveText('群体研究参考，不代表你的个人风险测量')
    await expect(page.locator('.quit-risk-card').filter({ hasText: '冠心病额外风险' })).toContainText('3–6 年')
    await expect(page.locator('.quit-risk-card').filter({ hasText: '肺癌额外风险' })).toContainText('10–15 年')
    await expect(page.locator('.quit-health__comparison')).toContainText('相对继续吸烟')
    await timelineToggle.click()
    await expect(page.getByRole('button', { name: /^收起/ })).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.quit-timeline__item')).toHaveCount(9)
    await expect(page.locator('.quit-timeline__item--general')).toHaveCount(2)
    await expect(page.locator('.quit-timeline__item').filter({ hasText: '冠心病额外风险' })).toContainText('未来参考')
    const healthText = await page.locator('.quit-health').innerText()
    expect(healthText).not.toMatch(/\d+(?:\.\d+)?\s*[%％]|健康评分|恢复完成|风险下降已达成/)
    await page.getByRole('button', { name: /^收起/ }).click()
    await expect(page.locator('.quit-timeline')).toHaveCount(0)

    const basisToggle = page.getByRole('button', { name: /^计算方式与科学依据/ })
    await expect(basisToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.quit-basis')).toHaveCount(0)
    await basisToggle.click()
    await expect(basisToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.quit-basis')).toContainText('不表示身体已达到该状态')
    await expect(page.locator('.quit-basis')).toContainText('不包括贴片、口香糖、电子烟等来源')
    await expect(page.locator('.quit-basis')).toContainText('尼古丁量不能换算成癌症风险')
    await expect(page.locator('.quit-basis')).toContainText('2026-10-13')
    await taroButton(page, '复制 CDC 来源链接').click()
    await expect.poll(() => readTaroClipboard(page)).toBe('https://www.cdc.gov/tobacco/about/benefits-of-quitting.html')
    await taroButton(page, '复制尼古丁估算来源').click()
    await expect.poll(() => readTaroClipboard(page)).toBe('https://www.cancer.org/cancer/risk-prevention/tobacco/guide-quitting-smoking/why-people-start-using-tobacco.html')
    await basisToggle.click()
    await expect(page.locator('.quit-basis')).toHaveCount(0)
  })

  test('无烟首页可确认和撤销今日0支，新增记录后快捷编辑与撤销同步保存', async ({ page }) => {
    test.setTimeout(75_000)
    await seedThirtyDayJourney(page)
    const originalJourney = (await readQuitState(page)).quitJourney
    await taroButton(page, '确认今日 0 支').click()
    await expect(page.locator('.taro-modal__content').getByText('今天记录了 0 支。确认后仍可撤销。', { exact: true })).toBeVisible()
    expect((await readQuitState(page)).checkIns).toHaveLength(0)
    await page.locator('.taro-model__confirm').click()
    await expect.poll(async () => (await readQuitState(page)).checkIns.length).toBe(1)
    expect((await readQuitState(page)).checkIns[0]).toMatchObject({ cigarettesSmoked: 0, smokeFree: true })
    await expect(page.locator('.quit-day-confirmation')).toContainText('今日已确认 0 支')
    await taroButton(page, '撤销今日确认').click()
    await expect(page.locator('.taro-modal__content').getByText('逐支记录不会删除。', { exact: true })).toBeVisible()
    await page.locator('.taro-model__confirm').click()
    await expect.poll(async () => (await readQuitState(page)).checkIns.length).toBe(0)
    await expect(taroButton(page, '确认今日 0 支')).toBeVisible()
    await expect(page.locator('.quit-orbit__number')).toHaveText('30')

    // A cigarette can be logged between two 30-second clock ticks. Saving must
    // update the dashboard immediately, rather than wait for the next clock tick.
    const smokedAt = new Date(Date.parse(NOW) + 10_000).toISOString()
    await page.clock.setFixedTime(new Date(smokedAt))
    await taroButton(page, '记一支').click()
    await page.getByRole('radio', { name: '吸烟原因：刚吃完饭', exact: true }).click()
    await page.getByRole('radio', { name: '烟瘾强度 3，明显', exact: true }).click()
    await taroButton(page, '保存').click()
    await expect.poll(async () => (await readQuitState(page)).cigarettes.length).toBe(1)
    const recorded = (await readQuitState(page)).cigarettes[0]!
    expect(recorded.createdAt).toBe(smokedAt)
    await expect(page.locator('.quit-orbit__label')).toHaveText('重新无烟')
    await expect(page.locator('.quit-orbit__number')).toHaveText('0')
    await expect(page.locator('.quit-nicotine__value')).toHaveText('599–1,198 mg')

    const recent = page.locator('.quit-recent-actions')
    await recent.getByRole('button', { name: '编辑', exact: true }).click()
    await expect(page.getByText('编辑记录', { exact: true })).toBeVisible()
    await page.getByRole('radio', { name: '吸烟原因：工作疲惫', exact: true }).click()
    await page.getByRole('radio', { name: '烟瘾强度 4，很强', exact: true }).click()
    await taroButton(page, '保存').click()
    await expect.poll(async () => (await readQuitState(page)).cigarettes[0]?.trigger).toBe('work')
    expect((await readQuitState(page)).cigarettes).toHaveLength(1)
    expect((await readQuitState(page)).cigarettes[0]).toMatchObject({
      id: recorded.id, createdAt: smokedAt, count: 1, trigger: 'work', cravingIntensity: 4,
    })

    await taroButton(page, '确认今日 1 支').click()
    await page.locator('.taro-model__confirm').click()
    await expect(page.locator('.quit-day-confirmation')).toContainText('今日已确认 1 支')
    await recent.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.locator('.taro-modal__content')).toContainText('撤销关联日终确认')
    await page.locator('.taro-model__cancel').click()
    expect((await readQuitState(page)).cigarettes).toHaveLength(1)
    expect((await readQuitState(page)).checkIns).toHaveLength(1)
    await recent.getByRole('button', { name: '撤销', exact: true }).click()
    await page.locator('.taro-model__confirm').click()
    await expect.poll(async () => (await readQuitState(page)).cigarettes.length).toBe(0)
    expect((await readQuitState(page)).checkIns).toHaveLength(0)
    await expect(recent).toHaveCount(0)
    await expect(page.locator('.quit-orbit__number')).toHaveText('30')
    await expect(page.locator('.quit-nicotine__value')).toHaveText('600–1,200 mg')
    await page.reload()
    await expect(taroButton(page, '确认今日 0 支')).toBeVisible()
    expect((await readQuitState(page)).cigarettes).toHaveLength(0)
    expect((await readQuitState(page)).checkIns).toHaveLength(0)
    expect((await readQuitState(page)).quitJourney).toEqual(originalJourney)
  })

  test('最近准确时间排除日汇总，只选真实逐支记录并保留原秒数', async ({ page }) => {
    const dailyAt = '2026-10-13T03:00:00.000Z'
    const exactAt = '2026-10-13T02:00:45.678Z'
    await page.evaluate(({ key, createdAt }) => {
      const wrapped = JSON.parse(localStorage.getItem(key)!) as { data: QuitState }
      wrapped.data.cigarettes = [{
        id: '77777777-7777-4777-8777-777777777777', createdAt, count: 1,
        attemptId: wrapped.data.plan!.id, source: 'DAILY_CHECKIN',
      }]
      localStorage.setItem(key, JSON.stringify(wrapped))
    }, { key: STORAGE_KEY, createdAt: dailyAt })
    await page.reload()
    await page.getByRole('button', { name: /我已戒烟/ }).click()
    await expect(page.getByText('你的无烟起点', { exact: true })).toBeVisible()
    await expect(taroButton(page, '使用最近记录的准确时间')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '最后一支烟的时间', exact: true })).toHaveText('选择时间')
    await taroButton(page, '‹ 返回首页').click()
    await expect(page).toHaveURL(/#\/pages\/today\/index/)

    await page.evaluate(({ key, createdAt }) => {
      const wrapped = JSON.parse(localStorage.getItem(key)!) as { data: QuitState }
      wrapped.data.cigarettes.push({
        id: '88888888-8888-4888-8888-888888888888', createdAt, loggedAt: createdAt, count: 1,
        attemptId: wrapped.data.plan!.id, source: 'QUICK_LOG', trigger: 'meal', cravingIntensity: 3,
      })
      localStorage.setItem(key, JSON.stringify(wrapped))
    }, { key: STORAGE_KEY, createdAt: exactAt })
    await page.reload()
    await page.getByRole('button', { name: /我已戒烟/ }).click()
    await taroButton(page, '使用最近记录的准确时间').click()
    await expect(page.getByRole('button', { name: '最后一支烟的日期', exact: true })).toHaveText('2026-10-13')
    await expect(page.getByRole('button', { name: '最后一支烟的时间', exact: true })).toHaveText('10:00')
    await taroButton(page, '保存并查看成就').click()
    await expect(page.getByRole('alert')).toHaveText('请确认此后没有再吸烟')
    await selectAccessibleCheckbox(page, '从这个时间起，我没有再吸烟')
    await taroButton(page, '保存并查看成就').click()
    await expect(page).toHaveURL(/#\/pages\/today\/index/)
    expect((await readQuitState(page)).quitJourney?.startedAt).toBe(exactAt)
    expect((await readQuitState(page)).cigarettes).toHaveLength(2)
  })

  test('Picker 选出同日未来时间时明确拒绝且不保存档案', async ({ page }) => {
    await page.getByRole('button', { name: /我已戒烟/ }).click()
    await confirmCurrentPicker(page, '最后一支烟的日期')
    await page.getByRole('button', { name: '最后一支烟的时间', exact: true }).click()
    const overlay = page.locator('.weui-picker:visible')
    const hours = overlay.locator('.weui-picker__group').first()
    await expect(hours).toBeVisible()
    const box = await hours.boundingBox()
    const row = await hours.locator('.weui-picker__indicator').boundingBox()
    expect(box).not.toBeNull()
    expect(row).not.toBeNull()
    // A real pointer selection one row below 12 chooses 13; no synthetic change event.
    await hours.click({ position: { x: box!.width / 2, y: box!.height / 2 + row!.height } })
    await overlay.locator('.weui-picker__action').filter({ hasText: '确定' }).click()
    await expect(overlay).toHaveCount(0)
    await expect(page.getByRole('button', { name: '最后一支烟的时间', exact: true })).toHaveText('13:00')
    await selectAccessibleCheckbox(page, '从这个时间起，我没有再吸烟')
    await taroButton(page, '保存并查看成就').click()
    await expect(page.getByRole('alert')).toHaveText('最后一支时间不能晚于现在')
    expect((await readQuitState(page)).quitJourney).toBeUndefined()
    await expect(page).toHaveURL(/#\/pages\/quit-settings\/index/)
  })

  test('320px 与两倍文字下首页和设置完整重排并通过 axe', async ({ page }) => {
    test.setTimeout(75_000)
    await page.setViewportSize({ width: 320, height: 812 })
    await seedThirtyDayJourney(page)
    await page.getByRole('button', { name: /^时间线/ }).click()
    await page.getByRole('button', { name: /^计算方式与科学依据/ }).click()
    await expectNoHorizontalOverflow(page, '.quit-dashboard')
    await expectAccessible(page)
    await expect(page.locator('.quit-orbit__ring')).toBeVisible()
    await doubleTextSize(page, '.quit-dashboard')
    // Text must not be crossed by an oval decoration after accessibility zoom.
    // Horizontal overflow alone cannot detect that visual regression.
    await expect(page.locator('.quit-orbit')).toHaveClass(/quit-orbit--expanded/)
    await expect(page.locator('.quit-orbit__ring')).toBeHidden()
    await expectNoHorizontalOverflow(page, '.quit-dashboard')
    await expectAccessible(page)
    for (const name of ['修改无烟起点和估算参数', '记一支']) {
      const button = page.getByRole('button', { name, exact: true })
      await button.scrollIntoViewIfNeeded()
      await expect(button).toBeVisible()
      expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    }
    await page.getByRole('button', { name: '修改无烟起点和估算参数', exact: true }).click()
    await expect(page.locator('.quit-settings:visible')).toBeVisible()
    await expectNoHorizontalOverflow(page, '.quit-settings:visible')
    await expectAccessible(page)
    await doubleTextSize(page, '.quit-settings:visible')
    await expectNoHorizontalOverflow(page, '.quit-settings:visible')
    await expectAccessible(page)
    await taroButton(page, '保存并查看成就').click()
    await expect(page.locator('.quit-orbit__number')).toHaveText('30')
  })

  test('初始化后可断网重载、首次进入设置并保存，再跨栏返回无烟首页', async ({ page, context }) => {
    await seedThirtyDayJourney(page)
    const controlled = await page.evaluate(async () => {
      await navigator.serviceWorker.ready
      return Boolean(navigator.serviceWorker.controller)
    })
    if (!controlled) await page.reload({ waitUntil: 'domcontentloaded' })
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
      if (!navigator.serviceWorker.controller) throw new Error('离线缓存尚未接管')
    })
    await context.setOffline(true)
    try {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.locator('.quit-orbit__number')).toHaveText('30')
      await page.getByRole('button', { name: '修改无烟起点和估算参数', exact: true }).click()
      await expect(page.getByText('你的无烟起点', { exact: true })).toBeVisible()
      await page.getByRole('spinbutton', { name: '每包价格', exact: true }).fill('40')
      await page.getByRole('spinbutton', { name: '每包支数', exact: true }).fill('25')
      await taroButton(page, '保存并查看成就').click()
      await expect(page.locator('.quit-gain--money .quit-gain__value')).toHaveText('¥960')
      await tabLink(page, '记录').click()
      await expect(page.locator('.records-page:visible')).toBeVisible()
      await tabLink(page, '今日').click()
      await expect(page.locator('.quit-orbit__number')).toHaveText('30')
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.locator('.quit-gain--money .quit-gain__value')).toHaveText('¥960')
      expect((await readQuitState(page)).quitJourney).toMatchObject({ pricePerPack: 40, cigarettesPerPack: 25 })
    } finally {
      await context.setOffline(false)
    }
  })
})
