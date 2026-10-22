import { expect, test, type Page } from '@playwright/test'
import {
  completeOnboarding, readStoredState, selectAccessibleCheckbox, selectAccessibleRadio,
  startFresh, taroButton,
} from './support'

async function confirmPicker(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click()
  const picker = page.locator('.weui-picker:visible')
  await expect(picker).toBeVisible()
  await picker.locator('.weui-picker__action').filter({ hasText: '确定' }).click()
  await expect(picker).toHaveCount(0)
}

test('已戒烟新用户完成历史习惯后明确设置起点，不伪造戒烟日或日报', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-13T04:00:00.000Z'))
  await startFresh(page)
  await selectAccessibleRadio(page, '已停止吸纸烟')
  await expect(taroButton(page, '继续')).toBeDisabled()
  await selectAccessibleRadio(page, '我已满 18 岁')
  await expect(taroButton(page, '继续')).toBeDisabled()
  await selectAccessibleCheckbox(page, '接受产品与医疗边界')
  await expect(taroButton(page, '继续')).toBeDisabled()
  await selectAccessibleCheckbox(page, '单独同意本机处理敏感健康信息')
  await expect(taroButton(page, '继续')).toBeEnabled()
  await selectAccessibleRadio(page, '不是或不确定')
  await expect(taroButton(page, '继续')).toBeDisabled()
  await selectAccessibleRadio(page, '已停止吸纸烟')
  await taroButton(page, '继续').click()

  await expect(page.getByText('戒烟前的吸烟习惯', { exact: true })).toBeVisible()
  await expect(page.getByText('戒烟前通常每天吸多少支？', { exact: true })).toBeVisible()
  await confirmPicker(page, '戒烟前起床后多久吸第一支，尚未选择')
  await taroButton(page, '继续').click()
  await taroButton(page, '继续').click()
  await selectAccessibleCheckbox(page, '压力或烦躁')
  await taroButton(page, '继续').click()
  await expect(page.getByText('设置你的无烟起点', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^选择戒烟日/ })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: /直接戒断|限期减量/ })).toHaveCount(0)
  await taroButton(page, '设置无烟起点').click()
  await expect(page).toHaveURL(/#\/pages\/quit-settings\/index/)
  await expect(page.getByText('你的无烟起点', { exact: true })).toBeVisible()

  const beforeDeclaration = await readStoredState(page)
  expect(beforeDeclaration?.plan).toMatchObject({ path: 'abrupt', quitDate: '2026-10-13' })
  expect(beforeDeclaration?.checkIns).toEqual([])
  expect(beforeDeclaration?.cigarettes).toEqual([])
  expect(beforeDeclaration).not.toHaveProperty('quitJourney')
  await expect(page.getByRole('button', { name: '最后一支烟的日期', exact: true })).toHaveText('选择日期')
  await expect(page.getByRole('button', { name: '最后一支烟的时间', exact: true })).toHaveText('选择时间')
  await confirmPicker(page, '最后一支烟的日期')
  await confirmPicker(page, '最后一支烟的时间')
  await selectAccessibleCheckbox(page, '从这个时间起，我没有再吸烟')
  await taroButton(page, '保存并查看成就').click()
  await expect(page.locator('.quit-orbit__label')).toHaveText('持续无烟')
  await expect(page.locator('.quit-orbit__number')).toHaveText('0')
  expect((await readStoredState(page))?.checkIns).toEqual([])
  await page.reload()
  await expect(page.locator('.quit-orbit__number')).toHaveText('0')
})

for (const path of ['abrupt', 'reduction'] as const) {
  test(`当前吸烟新用户仍可完成原有 ${path} 路径`, async ({ page }) => {
    const state = await completeOnboarding(page, path)
    expect(state.plan?.path).toBe(path)
    expect(state).not.toHaveProperty('quitJourney')
    await expect(page.getByRole('button', { name: /我已戒烟/ })).toBeVisible()
  })
}
