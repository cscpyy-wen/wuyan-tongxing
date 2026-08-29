import { describe, expect, it } from 'vitest'
import { installTabBarAccessibility, synchronizeTabBarAccessibility } from './tabBarAccessibility'

function renderTabBar() {
  document.body.innerHTML = `
    <taro-tabbar>
      <nav class="weui-tabbar">
        <a class="weui-tabbar__item weui-bar__item_on"><span></span><p class="weui-tabbar__label">今日</p></a>
        <a class="weui-tabbar__item"><span></span><p class="weui-tabbar__label">记录</p></a>
      </nav>
    </taro-tabbar>
  `
}

describe('tab bar accessibility synchronization', () => {
  it('exposes the selected tab and a state-bearing accessible name', () => {
    renderTabBar()
    expect(synchronizeTabBarAccessibility()).toBe(2)

    const tabBar = document.querySelector('.weui-tabbar')
    const tabs = document.querySelectorAll('.weui-tabbar__item')
    expect(tabBar?.getAttribute('role')).toBe('tablist')
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[0]?.getAttribute('aria-current')).toBe('page')
    expect(tabs[0]?.getAttribute('aria-label')).toBe('今日，当前页面')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[1]?.hasAttribute('aria-current')).toBe(false)
  })

  it('tracks Taro class changes after navigation', async () => {
    renderTabBar()
    const uninstall = installTabBarAccessibility()
    const tabs = document.querySelectorAll<HTMLElement>('.weui-tabbar__item')
    tabs[0]?.classList.remove('weui-bar__item_on')
    tabs[1]?.classList.add('weui-bar__item_on')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(tabs[0]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-current')).toBe('page')
    uninstall()
  })
})
