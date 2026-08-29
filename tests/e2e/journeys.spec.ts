import { expect, test } from '@playwright/test'
import {
  completeOnboarding,
  readStoredState,
  sosButton,
  tabLink,
  taroButton,
  taroButtonContaining,
} from './support'

test.describe('核心戒烟旅程', () => {
  test.beforeEach(async ({ page }) => {
    await completeOnboarding(page)
  })

  test('四个主 tab 可依次访问且始终提供烟瘾急救入口', async ({ page }) => {
    const destinations = [
      { tab: '今日' as const, route: 'today', selector: '.today-page' },
      { tab: '记录' as const, route: 'records', selector: '.records-page' },
      { tab: '进展' as const, route: 'progress', selector: '.progress-page' },
      { tab: '我的' as const, route: 'profile', selector: '.profile-page' },
    ]

    for (const destination of destinations) {
      await tabLink(page, destination.tab).click()
      await expect(page).toHaveURL(new RegExp(`#\\/pages\\/${destination.route}\\/index`))
      await expect(page.locator(`${destination.selector}:visible`)).toBeVisible()
      await expect(sosButton(page)).toBeVisible()
    }
  })

  test('四个主入口只保留短页头，不显示重复教学文案', async ({ page }) => {
    for (const tab of ['今日', '记录', '进展', '我的'] as const) {
      await tabLink(page, tab).click()
      await expect(page.locator('.page-header:visible .page-subtitle')).toHaveCount(0)
    }
    for (const copy of [
      '点一下，只需选择原因和烟瘾强度',
      '自动汇总，不用回忆',
      '逐支记录会自动进入柱状图',
      '拒绝任何可选权限，也能完整使用本地核心功能',
    ]) {
      await expect(page.getByText(copy, { exact: false })).toHaveCount(0)
    }
  })

  test('从主页面一击进入 SOS 并完成默认呼吸练习', async ({ page }) => {
    const sos = sosButton(page)
    await sos.click()

    await expect(page).toHaveURL(/#\/pages\/sos\/index/)
    await expect(page.getByText('这一阵会过去', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '已经吸烟，记录并复盘', exact: true })).toBeVisible()
    await expect(page.locator('.sos-practice')).toHaveAttribute('aria-live', 'polite')
    await expect(page.getByText('先把呼吸放慢', { exact: true })).toBeVisible()
    expect((await readStoredState(page))?.cravings).toHaveLength(0)
    await expect(page.getByRole('radio', { name: '烟瘾强度 5', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '调整烟瘾强度和练习方法', exact: true }).click()
    const strongestLevel = page.getByRole('radio', { name: '烟瘾强度 5', exact: true })
    await expect(strongestLevel).not.toBeChecked()
    await strongestLevel.click()
    await expect(page.getByRole('radio', { name: '烟瘾强度 5，已选', exact: true })).toBeChecked()
    await expect(page.getByText('5 / 5', { exact: true })).toBeVisible()
    await expect(page.getByText('准备开始', { exact: true })).toBeVisible()
    await expect(page.locator('.sos-practice__timer')).toHaveText('1:00')
    await page.waitForTimeout(1100)
    await expect(page.locator('.sos-practice__timer')).toHaveText('1:00')
    await taroButton(page, '开始练习').click()
    await expect(page.locator('.sos-practice__timer')).toHaveText('0:59', { timeout: 2500 })
    await taroButton(page, '我已经稳住一些了').click()
    await expect(page.getByText('你穿过了这一阵', { exact: true })).toBeVisible()

    await expect.poll(async () => {
      const state = await readStoredState(page)
      return state?.cravings[0]
    }).toMatchObject({ level: 5, resolved: true, technique: 'breathing' })
    expect((await readStoredState(page))?.cravings).toHaveLength(1)
  })

  test('如实记录和滑倒只重算连续时间，不清空累计行动', async ({ page }) => {
    await taroButton(page, '开始').click()
    await expect(page).toHaveURL(/#\/pages\/lesson\/index\?id=/)
    await expect(page.getByText('练习步骤', { exact: true })).toBeVisible()
    await expect(page.getByLabel('我的戒烟理由')).toBeVisible()
    await expect(page.getByText('这些理由已出现在 SOS 的“看理由”中。', { exact: true })).toBeVisible()
    await expect(page.locator('.lesson-evidence__item')).toHaveCount(0)
    const completeButton = taroButton(page, '完成练习并返回今日')
    const evidenceButton = taroButton(page, '查看依据')
    expect((await completeButton.boundingBox())!.y).toBeLessThan((await evidenceButton.boundingBox())!.y)
    await evidenceButton.click()
    await expect(page.locator('.lesson-evidence__item').first()).toBeVisible()
    await expect(page.locator('.lesson-evidence__item').first()).toHaveText(/· \d{4}$/)
    await completeButton.click()
    await expect(page).toHaveURL(/#\/pages\/today\/index/)
    await tabLink(page, '记录').click()
    await page.locator('.records-log-button').click()
    await page.getByRole('radio', { name: '吸烟原因：工作疲惫', exact: true }).click()
    await page.getByRole('radio', { name: '烟瘾强度 4，很强', exact: true }).click()
    await taroButton(page, '保存').click()
    await expect(page.locator('.records-page:visible')).toBeVisible()

    const beforeLapse = await readStoredState(page)
    expect(beforeLapse?.completedTasks).toHaveLength(1)
    expect(beforeLapse?.checkIns).toHaveLength(0)
    expect(beforeLapse?.cigarettes).toHaveLength(1)
    expect(beforeLapse?.cigarettes[0]).toMatchObject({ count: 1, trigger: 'work', cravingIntensity: 4, source: 'QUICK_LOG' })

    await page.goto(`/#/pages/lapse/index?cigaretteLogId=${beforeLapse!.cigarettes[0]!.id}`)
    await expect(page.getByText('复盘这次吸烟', { exact: true })).toBeVisible()
    await expect(page.getByText('任务 1 · 急救 0', { exact: true })).toBeVisible()
    await expect(page.getByText('不会重复增加烟支', { exact: false })).toBeVisible()
    await taroButton(page, '保留进展并重新出发').click()

    await expect(page).toHaveURL(/#\/pages\/progress\/index/)
    await expect(page.locator('.progress-page:visible')).toBeVisible()

    const afterLapse = await readStoredState(page)
    expect(afterLapse?.completedTasks).toEqual(beforeLapse?.completedTasks)
    expect(afterLapse?.checkIns).toEqual([])
    expect(afterLapse?.lapses).toHaveLength(1)
    expect(afterLapse?.lapses[0]?.cigaretteLogId).toBe(beforeLapse?.cigarettes[0]?.id)
    expect(afterLapse?.cigarettes).toHaveLength(1)
  })

  test('伙伴卡由用户预览发送且默认不泄露戒烟敏感字段', async ({ page }) => {
    await taroButtonContaining(page, '伙伴支持').click()
    await expect(page).toHaveURL(/#\/pages\/partner\/index/)

    const preview = page.locator('.share-preview')
    const copyPreview = page.locator('.copy-preview')
    await expect(preview).toHaveAttribute('aria-label', '微信分享卡标题预览')
    await expect(preview).toContainText('我在认真戒烟，想请你做我的支持伙伴')
    await expect(preview).not.toContainText('当我发消息说烟瘾来了')
    await expect(copyPreview).toContainText('当我发消息说烟瘾来了')
    await expect(page.getByText('微信分享卡只可靠发送上方标题和小程序页面路径', { exact: false })).toBeVisible()

    const visibleShareText = `${await preview.innerText()}\n${await copyPreview.innerText()}`
    expect(visibleShareText).not.toMatch(/\d+\s*支/)
    expect(visibleShareText).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(visibleShareText).not.toContain('药物')
    expect(visibleShareText).not.toContain('戒烟日期')
    expect(visibleShareText).not.toContain('账号')

    await taroButton(page, '现在帮我').click()
    await expect(preview).toContainText('我现在有一阵烟瘾，可以陪我三分钟吗？')
    await expect(copyPreview).toContainText('陪我聊点别的')
    await taroButton(page, '分享进展').click()
    await expect(preview).toContainText('我完成了今天的无烟行动')
    await taroButton(page, '告诉重启').click()
    await expect(preview).toContainText('我刚刚滑倒了，但正在继续计划')
    await expect(preview).not.toContainText('这不是清零')
    await expect(copyPreview).toContainText('这不是清零')
    await expect(page.getByText('不读取通讯录，不建立站内好友，也不会自动通知任何人。', { exact: true })).toBeVisible()
  })

  test('进展页提供 3/6/12 月随访，漏答按未知保存', async ({ page }) => {
    await tabLink(page, '进展').click()

    await expect(page.locator('.outcome-card')).toHaveCount(0)
    await expect(page.getByText('少吸', { exact: true })).toHaveCount(0)
    await expect(page.getByText('节省', { exact: true })).toHaveCount(0)
    await expect(page.locator('.followup-row')).toHaveCount(3)
    await expect(page.locator('.followup-row').nth(0)).toContainText('3月')
    await expect(page.locator('.followup-row').nth(1)).toContainText('6月')
    await expect(page.locator('.followup-row').nth(2)).toContainText('12月')

    await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key)
      if (!raw) throw new Error('缺少本地状态')
      const wrapped = JSON.parse(raw) as { data: { plan?: { quitDate: string } } }
      if (!wrapped.data.plan) throw new Error('缺少戒烟计划')
      const duePlanDate = new Date()
      duePlanDate.setHours(12, 0, 0, 0)
      duePlanDate.setMonth(duePlanDate.getMonth() - 4)
      wrapped.data.plan.quitDate = [
        duePlanDate.getFullYear(),
        String(duePlanDate.getMonth() + 1).padStart(2, '0'),
        String(duePlanDate.getDate()).padStart(2, '0'),
      ].join('-')
      window.localStorage.setItem(key, JSON.stringify(wrapped))
    }, 'wuyan-tongxing/client-state/v1')
    await page.reload()

    await expect(page.locator('.followup-row').nth(0)).toContainText('填写')
    await page.locator('.followup-row').nth(0).click()
    await expect(page).toHaveURL(/#\/pages\/followup\/index\?month=3/)
    await expect(page.getByText('不确定或不想回答时请选择“暂不回答”。', { exact: false })).toBeVisible()
    await expect(page.getByText('漏答保存为“未知”', { exact: false })).toBeVisible()
    await taroButton(page, '保存这次随访').click()

    await expect(page).toHaveURL(/#\/pages\/progress\/index/)
    await expect(page.locator('.followup-row').nth(0)).toContainText('已填')
    const state = await readStoredState(page)
    expect(state?.outcomes).toHaveLength(1)
    expect(state?.outcomes[0]).toMatchObject({
      dueMonth: 3,
      sevenDayAbstinent: null,
      thirtyDayAbstinent: null,
      continuouslyAbstinent: null,
      currentCigarettesPerDay: null,
      additionalQuitAttempts: null,
      confidence: null,
      usedProfessionalSupport: null,
      selfReported: true,
      biochemicallyVerified: false,
    })
  })

  test('重载记录页会恢复逐支时间、原因和烟瘾强度', async ({ page }) => {
    await tabLink(page, '记录').click()
    await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key)
      if (!raw) throw new Error('缺少本地状态')
      const wrapped = JSON.parse(raw) as { data: Record<string, unknown> }
      const now = new Date()
      wrapped.data.cigarettes = [{
        id: '11111111-1111-4111-8111-111111111111',
        createdAt: now.toISOString(),
        count: 1,
        trigger: 'work',
        cravingIntensity: 4,
        source: 'QUICK_LOG',
      }]
      window.localStorage.setItem(key, JSON.stringify(wrapped))
    }, 'wuyan-tongxing/client-state/v1')
    await page.reload()

    await expect(page.getByText('工作疲惫', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('烟瘾 4/5', { exact: true })).toBeVisible()
    await expect.poll(async () => (await readStoredState(page))?.cigarettes[0]?.cravingIntensity).toBe(4)
  })

  test('明确开启新尝试会归档当前计划并保留累计任务', async ({ page }) => {
    await taroButton(page, '开始').click()
    await taroButton(page, '完成练习并返回今日').click()
    await expect(page).toHaveURL(/#\/pages\/today\/index/)
    await expect(page.locator('.lesson-page:visible')).toHaveCount(0)
    await expect(page.locator('.today-page:visible')).toBeVisible()
    for (const reason of ['工作疲惫', '刚吃完饭', '压力或烦躁', '社交需要']) {
      await page.locator('.today-page:visible .smoke-log-primary').click()
      const dialog = page.getByRole('dialog', { name: '记录这一支烟', exact: true })
      await expect(dialog).toBeVisible()
      await page.getByRole('radio', { name: `吸烟原因：${reason}`, exact: true }).click()
      await page.getByRole('radio', { name: '烟瘾强度 4，很强', exact: true }).click()
      await taroButton(page, '保存').click()
      await expect(dialog).toBeHidden()
    }
    const oldAttemptId = (await readStoredState(page))!.plan!.id
    await tabLink(page, '记录').click()
    await expect(page.locator('.records-page:visible .records-metric__value').filter({ hasText: '4 种原因' })).toHaveText('4 种原因')
    const recordsPageScrollTop = (scrollToBottom = false) => page.locator('.records-page:visible').evaluate((pageElement, shouldScroll) => {
      let candidate: HTMLElement | null = pageElement
      while (candidate && candidate.scrollHeight <= candidate.clientHeight + 1) candidate = candidate.parentElement
      const scroller = candidate ?? document.scrollingElement
      if (!scroller) throw new Error('没有找到记录页滚动容器')
      if (shouldScroll) scroller.scrollTop = scroller.scrollHeight
      return scroller.scrollTop
    }, scrollToBottom)
    await expect.poll(() => recordsPageScrollTop(true)).toBeGreaterThan(0)
    await tabLink(page, '我的').click()
    await taroButton(page, '开始新计划').click()
    await page.locator('.new-attempt').getByRole('button', { name: '开始', exact: true }).click()
    await expect(page.locator('.taro-modal__title')).toContainText('开始第 2 次尝试')
    await page.locator('.taro-model__confirm').click()
    await expect(page).toHaveURL(/#\/pages\/today\/index/)

    const state = await readStoredState(page)
    expect(state?.plan?.attemptNumber).toBe(2)
    expect(state?.archivedPlans).toHaveLength(1)
    expect(state?.archivedPlans[0]?.attemptNumber).toBe(1)
    expect(state?.completedTasks).toHaveLength(1)
    expect(state?.cigarettes).toHaveLength(4)
    expect(state?.cigarettes.every((item) => item.attemptId === oldAttemptId)).toBe(true)
    await expect(page.locator('.smoking-hero__count')).toContainText('0 支')
    await tabLink(page, '记录').click()
    await expect(page.locator('.records-summary__count')).toContainText('0 支')
    await expect.poll(() => recordsPageScrollTop()).toBe(0)
    await expect(page.locator('.records-page:visible .page-title')).toHaveText('记录')
  })
})
