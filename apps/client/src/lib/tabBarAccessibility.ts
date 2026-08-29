const TAB_BAR_SELECTOR = 'taro-tabbar .weui-tabbar'
const TAB_ITEM_SELECTOR = '.weui-tabbar__item'

export function synchronizeTabBarAccessibility(root: ParentNode = document): number {
  const tabBar = root.querySelector<HTMLElement>(TAB_BAR_SELECTOR)
  if (!tabBar) return 0

  tabBar.setAttribute('role', 'tablist')
  tabBar.setAttribute('aria-label', '主导航')

  const items = Array.from(tabBar.querySelectorAll<HTMLElement>(TAB_ITEM_SELECTOR))
  items.forEach((item) => {
    const selected = item.classList.contains('weui-bar__item_on')
    const visibleLabel = item.querySelector<HTMLElement>('.weui-tabbar__label')?.textContent?.trim() || '导航项'
    item.setAttribute('role', 'tab')
    item.setAttribute('aria-selected', String(selected))
    item.setAttribute('aria-label', `${visibleLabel}，${selected ? '当前页面' : '未选'}`)
    if (selected) item.setAttribute('aria-current', 'page')
    else item.removeAttribute('aria-current')
  })

  return items.length
}

export function installTabBarAccessibility(root: Document = document): () => void {
  if (typeof MutationObserver === 'undefined') return () => undefined

  synchronizeTabBarAccessibility(root)
  const observer = new MutationObserver(() => synchronizeTabBarAccessibility(root))
  observer.observe(root.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
    childList: true,
    subtree: true,
  })
  return () => observer.disconnect()
}
