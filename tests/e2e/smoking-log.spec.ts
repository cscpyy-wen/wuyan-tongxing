import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { SMOKING_TRIGGER_OPTIONS } from '../../apps/client/src/lib/smokingLogs'
import { completeOnboarding, readStoredState, sosButton, tabLink, taroButton } from './support'

test.describe('逐支吸烟记录', () => {
  test.beforeEach(async ({ page }) => {
    await completeOnboarding(page)
  })

  test('首页首屏完成原因和强度记录，刷新后自动统计仍一致', async ({ page }) => {
    const entry = page.locator('.smoke-log-primary')
    await expect(entry).toBeVisible()
    const entryBox = await entry.boundingBox()
    expect(entryBox?.height).toBeGreaterThanOrEqual(64)
    expect(entryBox!.y).toBeGreaterThan(page.viewportSize()!.height * 0.35)
    expect(entryBox!.y + entryBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height)

    const before = Date.now()
    await entry.click()
    const dialog = page.getByRole('dialog', { name: '记录这一支烟', exact: true })
    await expect(dialog).toBeVisible()
    const confirm = taroButton(page, '保存')
    await expect(confirm).toBeDisabled()
    await page.getByRole('radio', { name: '吸烟原因：拉屎', exact: true }).click()
    await expect(confirm).toBeDisabled()
    await page.getByRole('radio', { name: '烟瘾强度 4，很强', exact: true }).click()
    await expect(confirm).toBeEnabled()
    await confirm.click()
    const after = Date.now()

    await expect.poll(async () => (await readStoredState(page))?.cigarettes.length).toBe(1)
    const saved = (await readStoredState(page))!.cigarettes[0]!
    expect(saved).toMatchObject({ count: 1, trigger: 'toilet', cravingIntensity: 4, source: 'QUICK_LOG' })
    expect(new Date(saved.createdAt).getTime()).toBeGreaterThanOrEqual(before)
    expect(new Date(saved.createdAt).getTime()).toBeLessThanOrEqual(after)
    await expect(page.locator('.smoking-hero__count')).toContainText('1 支')
    await expect(page.getByText('刚刚记录', { exact: true })).toBeVisible()
    await expect(taroButton(page, '编辑')).toBeVisible()
    await expect(taroButton(page, '撤销')).toBeVisible()

    await page.reload()
    await expect(page.locator('.smoking-hero__count')).toContainText('1 支')
    await tabLink(page, '记录').click()
    await expect(page.locator('.records-summary__count')).toContainText('1 支')
    const recordsPage = page.locator('.records-page:visible')
    await expect(recordsPage.getByText('拉屎', { exact: true }).first()).toBeVisible()
    await expect(recordsPage.getByText('烟瘾 4/5', { exact: true })).toBeVisible()
    await expect(recordsPage.getByText('北京时间', { exact: true })).toBeVisible()
    await expect(page.getByText('今天共吸了多少支？', { exact: true })).toHaveCount(0)

    const accessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(accessibility.violations).toEqual([])
  })

  test('横屏首屏核心记烟入口固定在底部导航上方且无需滚动', async ({ page }) => {
    await page.setViewportSize({ width: 812, height: 375 })
    await page.evaluate(() => window.scrollTo(0, 0))

    const entry = page.locator('.smoke-log-primary')
    const tabbar = page.locator('taro-tabbar .weui-tabbar')
    await expect(entry).toBeVisible()
    await expect(tabbar).toBeVisible()
    const entryBox = await entry.boundingBox()
    const tabbarBox = await tabbar.boundingBox()

    expect(entryBox).not.toBeNull()
    expect(tabbarBox).not.toBeNull()
    expect(entryBox!.y).toBeGreaterThanOrEqual(0)
    expect(entryBox!.y + entryBox!.height).toBeLessThanOrEqual(tabbarBox!.y - 8)
  })

  test('延迟打开记烟弹层期间切栏不会隐藏目标页导航', async ({ page }) => {
    await page.locator('.smoke-log-primary').click()
    await tabLink(page, '记录').click()
    await page.waitForTimeout(650)

    await expect(page.locator('.records-page:visible')).toBeVisible()
    await expect(page.getByRole('dialog', { name: '记录这一支烟', exact: true })).toHaveCount(0)
    await expect(page.locator('taro-tabbar .weui-tabbar')).toBeVisible()
    for (const tab of ['今日', '记录', '进展', '我的'] as const) {
      await expect(tabLink(page, tab)).toBeVisible()
    }
  })

  test('弹层刚出现时底部旧坐标不会误触烟瘾急救', async ({ page }) => {
    const recordsTab = await tabLink(page, '记录').boundingBox()
    expect(recordsTab).not.toBeNull()

    await page.locator('.smoke-log-primary').click()
    await page.waitForTimeout(470)
    await page.mouse.click(
      recordsTab!.x + recordsTab!.width / 2,
      recordsTab!.y + recordsTab!.height / 2,
    )

    await expect(page.getByRole('dialog', { name: '记录这一支烟', exact: true })).toBeVisible()
    await expect(page.locator('.sos-page:visible')).toHaveCount(0)
    await page.waitForTimeout(350)
    await page.getByRole('button', { name: '关闭吸烟记录面板', exact: true }).click()
  })

  for (const intervalMs of [150, 200, 300, 500]) {
    test(`首页主按钮 ${intervalMs}ms 五连点不会误选原因或启用保存`, async ({ page }) => {
      const entry = page.locator('.smoke-log-primary')
      const entryBox = await entry.boundingBox()
      expect(entryBox).not.toBeNull()
      const x = entryBox!.x + entryBox!.width / 2
      const y = entryBox!.y + entryBox!.height / 2

      for (let index = 0; index < 5; index += 1) {
        await page.mouse.click(x, y)
        if (index < 4) await page.waitForTimeout(intervalMs)
      }

      const dialog = page.getByRole('dialog', { name: '记录这一支烟', exact: true })
      await expect(dialog).toBeVisible()
      await page.waitForTimeout(700)

      const reasons = page.locator('input[name="smoking-trigger"]')
      const intensities = page.locator('input[name="smoking-intensity"]')
      await expect(reasons).toHaveCount(SMOKING_TRIGGER_OPTIONS.length)
      await expect(intensities).toHaveCount(5)
      for (let index = 0; index < await reasons.count(); index += 1) {
        await expect(reasons.nth(index)).not.toBeChecked()
      }
      for (let index = 0; index < await intensities.count(); index += 1) {
        await expect(intensities.nth(index)).not.toBeChecked()
      }
      await expect(taroButton(page, '保存')).toBeDisabled()
      expect((await readStoredState(page))?.cigarettes).toHaveLength(0)
    })
  }

  test('横屏已有刚刚记录操作行时整组入口仍完整位于导航上方', async ({ page }) => {
    await page.locator('.smoke-log-primary').click()
    await page.getByRole('radio', { name: '吸烟原因：工作疲惫', exact: true }).click()
    await page.getByRole('radio', { name: '烟瘾强度 4，很强', exact: true }).click()
    await taroButton(page, '保存').click()
    await page.setViewportSize({ width: 812, height: 375 })

    const action = await page.locator('.smoke-log-action').boundingBox()
    const tabbar = await page.locator('taro-tabbar .weui-tabbar').boundingBox()
    expect(action).not.toBeNull()
    expect(tabbar).not.toBeNull()
    expect(action!.y).toBeGreaterThanOrEqual(0)
    expect(action!.y + action!.height).toBeLessThanOrEqual(tabbar!.y - 8)
    await expect(page.getByText('刚刚记录', { exact: true })).toBeVisible()
    await expect(taroButton(page, '编辑')).toBeVisible()
    await expect(taroButton(page, '撤销')).toBeVisible()
  })

  test('撤销误记后时间线和本机数据同步删除', async ({ page }) => {
    await page.locator('.smoke-log-primary').click()
    await page.getByRole('radio', { name: '吸烟原因：刚吃完饭', exact: true }).click()
    await page.getByRole('radio', { name: '烟瘾强度 3，明显', exact: true }).click()
    await taroButton(page, '保存').click()
    await tabLink(page, '记录').click()

    await page.getByRole('button', { name: /撤销 .* 的吸烟记录/ }).click()
    await page.locator('.taro-model__confirm').click()
    await expect.poll(async () => (await readStoredState(page))?.cigarettes.length).toBe(0)
    await expect(page.locator('.records-summary__count')).toContainText('0 支')
    await expect(page.locator('.activity-list:visible')).toHaveCount(0)
    await expect(page.locator('.reason-summary:visible')).toHaveCount(0)
  })

  test('SOS 无引用复盘抗 0/150/300/450ms 重复保存，撤销关联记录后完整恢复', async ({ page }) => {
    const seeded = await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key)
      if (!raw) throw new Error('缺少本机状态')
      const wrapped = JSON.parse(raw) as {
        data: {
          plan?: { id: string; quitDate: string }
          cigarettes: unknown[]
          checkIns: unknown[]
          lapses: unknown[]
          lastCigaretteAt?: string
        }
      }
      if (!wrapped.data.plan) throw new Error('缺少戒烟计划')
      const now = new Date()
      const older = new Date(now.getTime() - 36 * 3_600_000)
      const quitDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(now.getTime() - 3 * 86_400_000))
      const olderId = '22222222-2222-4222-8222-222222222222'
      wrapped.data.plan.quitDate = quitDate
      wrapped.data.cigarettes = [{
        id: olderId,
        createdAt: older.toISOString(),
        loggedAt: older.toISOString(),
        count: 1,
        trigger: 'meal',
        cravingIntensity: 3,
        attemptId: wrapped.data.plan.id,
        source: 'QUICK_LOG',
      }]
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(now)
      wrapped.data.checkIns = [{
        id: '33333333-3333-4333-8333-333333333333',
        date: today,
        cigarettesSmoked: 0,
        cravingPeak: 3,
        smokeFree: true,
        createdAt: now.toISOString(),
        attemptId: wrapped.data.plan.id,
      }]
      wrapped.data.lapses = []
      wrapped.data.lastCigaretteAt = older.toISOString()
      window.localStorage.setItem(key, JSON.stringify(wrapped))
      return { olderId, olderAt: older.toISOString() }
    }, 'wuyan-tongxing/client-state/v1')
    await page.reload()

    await tabLink(page, '进展').click()
    await expect(page.locator('.progress-hero__label')).toHaveText('已确认无烟')

    await sosButton(page).click()
    await page.getByRole('button', { name: '已经吸烟，记录并复盘', exact: true }).click()
    await expect(page.getByText('复盘这次吸烟', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '吸烟原因，原因未记录', exact: true }).click()
    await page.locator('.weui-picker__action').filter({ hasText: '确定' }).click()
    await expect(page.getByRole('radio', { name: '烟瘾强度 3，明显，已选', exact: true })).toBeChecked()
    const countGroup = page.getByRole('group', { name: '这次吸烟 1 支', exact: true })
    await expect(countGroup).toBeVisible()
    expect((await countGroup.getByRole('button', { name: '增加一支' }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    const save = taroButton(page, '保留进展并重新出发')
    await save.evaluate((element) => {
      for (const delay of [0, 150, 300, 450]) {
        window.setTimeout(() => {
          element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        }, delay)
      }
    })
    await expect(page.getByText('将记录 1 支烟；将撤销 1 条受影响日期的日终确认。', { exact: true })).toBeVisible()
    await page.waitForTimeout(550)
    const beforeConfirm = (await readStoredState(page))!
    expect(beforeConfirm.cigarettes).toHaveLength(1)
    expect(beforeConfirm.lapses).toHaveLength(0)
    expect(beforeConfirm.checkIns).toHaveLength(1)
    await page.locator('.taro-model__cancel').click()
    await expect(save).toBeEnabled()
    expect(await readStoredState(page)).toEqual(beforeConfirm)
    await save.click()
    await expect(page.getByText('将记录 1 支烟；将撤销 1 条受影响日期的日终确认。', { exact: true })).toBeVisible()
    await page.locator('.taro-model__confirm').click()
    await expect(page.getByRole('button', { name: '正在保存…', exact: true })).toBeDisabled()
    await expect(page).toHaveURL(/#\/pages\/progress\/index/)

    const afterSave = (await readStoredState(page))!
    expect(afterSave.cigarettes).toHaveLength(2)
    expect(afterSave.lapses).toHaveLength(1)
    const lapse = afterSave.lapses[0]!
    const lapseCigarette = afterSave.cigarettes.find((item) => item.id === lapse.cigaretteLogId)
    expect(lapseCigarette).toMatchObject({ count: 1, trigger: 'work', cravingIntensity: 3, source: 'LAPSE_FLOW' })
    expect(afterSave.checkIns).toHaveLength(0)
    expect(afterSave.lastCigaretteAt).toBe(lapseCigarette?.createdAt)

    await page.reload()
    const afterReload = (await readStoredState(page))!
    expect(afterReload.cigarettes.map((item) => item.id)).toEqual(afterSave.cigarettes.map((item) => item.id))
    expect(afterReload.lapses).toEqual(afterSave.lapses)

    await tabLink(page, '记录').click()
    await expect(page.locator('.records-summary__count')).toContainText('1 支')
    await expect(page.getByText('已复盘', { exact: true })).toBeVisible()
    await expect(page.getByText('离开吸烟场景并处理剩余烟', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /编辑 .* 的复盘动作/ }).click()
    await expect(page.getByRole('heading', { name: '编辑复盘', exact: true })).toBeVisible()
    await page.getByRole('radio', { name: '恢复动作：联系可信赖的支持者', exact: true }).click()
    await taroButton(page, '保存复盘修改').click()
    await expect(page).toHaveURL(/#\/pages\/records\/index/)
    await expect(page.getByText('联系可信赖的支持者', { exact: true })).toBeVisible()

    await tabLink(page, '今日').click()
    await taroButton(page, '确认今日 1 支').click()
    await page.locator('.taro-model__confirm').click()
    await tabLink(page, '记录').click()
    await page.getByRole('button', { name: /撤销 .* 的吸烟记录/ }).click()
    await expect(page.getByText(/撤销 1 条相关日终确认/).last()).toBeVisible()
    await expect(page.getByText(/删除 1 条关联复盘/).last()).toBeVisible()
    await page.locator('.taro-model__confirm').click()
    await expect.poll(async () => (await readStoredState(page))?.lapses.length).toBe(0)

    const afterUndo = (await readStoredState(page))!
    expect(afterUndo.cigarettes.map((item) => item.id)).toEqual([seeded.olderId])
    expect(afterUndo.lastCigaretteAt).toBe(seeded.olderAt)
    await page.reload()
    const finalReload = (await readStoredState(page))!
    expect(finalReload.cigarettes.map((item) => item.id)).toEqual([seeded.olderId])
    expect(finalReload.lapses).toEqual([])
    expect(finalReload.lastCigaretteAt).toBe(seeded.olderAt)

    await tabLink(page, '进展').click()
    await expect(page.locator('.progress-hero__label')).toHaveText('距已记录上支')
  })

  test('刚保存后可在首页直接撤销，不必先进入时间线', async ({ page }) => {
    await page.locator('.smoke-log-primary').click()
    await page.getByRole('radio', { name: '吸烟原因：刚吃完饭', exact: true }).click()
    await page.getByRole('radio', { name: '烟瘾强度 3，明显', exact: true }).click()
    await taroButton(page, '保存').click()

    await taroButton(page, '撤销').click()
    await page.locator('.taro-model__confirm').click()
    await expect.poll(async () => (await readStoredState(page))?.cigarettes.length).toBe(0)
    await expect(page.locator('.smoking-hero__count')).toContainText('0 支')
    await expect(page.getByText('刚刚记录', { exact: true })).toHaveCount(0)
  })

  test('两条记录时最新一条编辑与撤销入口在记录页首屏内', async ({ page }) => {
    for (const [reason, intensity] of [
      ['吸烟原因：工作疲惫', '烟瘾强度 4，很强'],
      ['吸烟原因：刚吃完饭', '烟瘾强度 3，明显'],
    ] as const) {
      await page.locator('.smoke-log-primary').click()
      await page.getByRole('radio', { name: reason, exact: true }).click()
      await page.getByRole('radio', { name: intensity, exact: true }).click()
      await taroButton(page, '保存').click()
    }

    await tabLink(page, '记录').click()
    const latestActions = page.locator('.activity-row').first().locator('.activity-row__actions')
    await expect(latestActions).toBeVisible()
    const box = await latestActions.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  })

  test('日终确认显示明确支数，新增一支后必须重新确认', async ({ page }) => {
    await page.locator('.smoke-log-primary').click()
    await page.getByRole('radio', { name: '吸烟原因：工作疲惫', exact: true }).click()
    await page.getByRole('radio', { name: '烟瘾强度 4，很强', exact: true }).click()
    await taroButton(page, '保存').click()

    await taroButton(page, '确认今日 1 支').click()
    await page.locator('.taro-model__confirm').click()
    await expect(page.getByText('今日已确认 1 支', { exact: true })).toBeVisible()
    expect((await readStoredState(page))?.checkIns).toHaveLength(1)

    await taroButton(page, '编辑').click()
    await page.getByRole('radio', { name: '吸烟原因：刚吃完饭', exact: true }).click()
    await taroButton(page, '保存').click()
    await expect(page.getByText(/撤销 1 条受影响日期的日终确认/).last()).toBeVisible()
    await page.locator('.taro-model__cancel').click()
    await page.getByRole('button', { name: '关闭吸烟记录面板', exact: true }).click()

    await taroButton(page, '撤销').click()
    await expect(page.getByText(/同时撤销 1 条日终确认/).last()).toBeVisible()
    await page.locator('.taro-model__cancel').click()

    await page.getByRole('button', { name: '撤销今日确认', exact: true }).click()
    await page.locator('.taro-model__confirm').click()
    await expect(taroButton(page, '确认今日 1 支')).toBeEnabled()
    expect((await readStoredState(page))?.checkIns).toHaveLength(0)

    await taroButton(page, '确认今日 1 支').click()
    await page.locator('.taro-model__confirm').click()
    expect((await readStoredState(page))?.checkIns).toHaveLength(1)

    await page.locator('.smoke-log-primary').click()
    await page.getByRole('radio', { name: '吸烟原因：刚吃完饭', exact: true }).click()
    await page.getByRole('radio', { name: '烟瘾强度 3，明显', exact: true }).click()
    await taroButton(page, '保存').click()
    await expect(page.getByText(/撤销 1 条受影响日期的日终确认/).last()).toBeVisible()
    expect((await readStoredState(page))?.checkIns).toHaveLength(1)
    await page.locator('.taro-model__confirm').click()
    await expect(taroButton(page, '确认今日 2 支')).toBeEnabled()
    expect((await readStoredState(page))?.checkIns).toHaveLength(0)
  })

  test('横屏记录页在尺寸与左右安全区矩阵中不溢出且首条可操作', async ({ page }) => {
    for (const reason of ['吸烟原因：工作疲惫', '吸烟原因：刚吃完饭']) {
      await page.locator('.smoke-log-primary').click()
      await page.getByRole('radio', { name: reason, exact: true }).click()
      await page.getByRole('radio', { name: '烟瘾强度 4，很强', exact: true }).click()
      await taroButton(page, '保存').click()
    }
    await tabLink(page, '记录').click()

    const scenarios = [
      { label: '720×360', width: 720, height: 360, safeLeft: 0, safeRight: 0 },
      { label: '720×360 + safe-area', width: 720, height: 360, safeLeft: 24, safeRight: 24 },
      { label: '812×375', width: 812, height: 375, safeLeft: 0, safeRight: 0 },
      { label: '812×375 + safe-area', width: 812, height: 375, safeLeft: 32, safeRight: 24 },
      { label: '900×420', width: 900, height: 420, safeLeft: 0, safeRight: 0 },
      { label: '900×420 + safe-area', width: 900, height: 420, safeLeft: 32, safeRight: 32 },
    ] as const

    for (const scenario of scenarios) {
      await test.step(scenario.label, async () => {
        await page.setViewportSize({ width: scenario.width, height: scenario.height })
        await page.evaluate(({ safeLeft, safeRight }) => {
          document.documentElement.style.setProperty('--safe-area-inset-left', `${safeLeft}px`)
          document.documentElement.style.setProperty('--safe-area-inset-right', `${safeRight}px`)
        }, scenario)

        const screen = await page.locator('.records-page:visible').boundingBox()
        const summary = await page.locator('.records-summary:visible').boundingBox()
        const timeline = await page.locator('.records-timeline-title:visible').boundingBox()
        const firstActions = page.locator('.activity-row:visible').first().locator('.activity-action')
        const actionBoxes = await firstActions.evaluateAll((elements) => elements.map((element) => {
          const rect = element.getBoundingClientRect()
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        }))
        const tabbar = await page.locator('taro-tabbar .weui-tabbar').boundingBox()
        const overflow = await page.evaluate(() => ({
          viewportWidth: document.documentElement.clientWidth,
          documentWidth: document.documentElement.scrollWidth,
          bodyWidth: document.body.scrollWidth,
        }))

        expect(screen, `${scenario.label} 应渲染记录页`).not.toBeNull()
        expect(summary, `${scenario.label} 应渲染统计卡`).not.toBeNull()
        expect(timeline, `${scenario.label} 应渲染时间线`).not.toBeNull()
        expect(tabbar, `${scenario.label} 应渲染底部导航`).not.toBeNull()
        expect(overflow.documentWidth, `${scenario.label} 文档不得横向溢出`).toBeLessThanOrEqual(overflow.viewportWidth + 1)
        expect(overflow.bodyWidth, `${scenario.label} body 不得横向溢出`).toBeLessThanOrEqual(overflow.viewportWidth + 1)
        expect(screen!.x + screen!.width, `${scenario.label} 记录页不得越过右侧视口`).toBeLessThanOrEqual(scenario.width + 1)

        const usableAction = actionBoxes.find((box) => (
          box.x >= scenario.safeLeft
          && box.x + box.width <= scenario.width - scenario.safeRight
          && box.y + box.height <= tabbar!.y
        ))
        expect(usableAction, `${scenario.label} 首条记录至少一个操作按钮应位于左右安全区内且高于底部导航`).toBeDefined()

        if (scenario.width === 900 && scenario.safeLeft === 0) {
          const actionGroup = await page.locator('.activity-row:visible').first().locator('.activity-row__actions').boundingBox()
          expect(actionGroup).not.toBeNull()
          expect(screen!.width).toBeGreaterThan(700)
          expect(timeline!.x).toBeGreaterThan(summary!.x + summary!.width)
          expect(Math.abs(timeline!.y - summary!.y)).toBeLessThan(12)
          expect(actionGroup!.y + actionGroup!.height).toBeLessThanOrEqual(tabbar!.y)
        }
      })
    }
  })

  test('未修改的编辑不会重写原始秒数或谎报已修改', async ({ page }) => {
    await page.locator('.smoke-log-primary').click()
    await page.getByRole('radio', { name: '吸烟原因：工作疲惫', exact: true }).click()
    await page.getByRole('radio', { name: '烟瘾强度 4，很强', exact: true }).click()
    await taroButton(page, '保存').click()
    const before = (await readStoredState(page))!.cigarettes[0]!

    await tabLink(page, '记录').click()
    await page.locator('.records-page:visible').getByRole('button', { name: /编辑 .* 的吸烟记录/ }).first().click()
    await taroButton(page, '保存').click()
    await expect(page.getByText('没有更改', { exact: true })).toBeVisible()
    expect((await readStoredState(page))!.cigarettes[0]).toEqual(before)
  })
})
