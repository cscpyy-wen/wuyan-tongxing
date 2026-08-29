import { describe, expect, it, vi } from 'vitest'
import {
  consumeAndroidBootstrapBack,
  dismissAndroidBootstrap,
  shouldDismissAndroidBootstrap,
} from './androidBootstrap'

describe('Android 启动骨架', () => {
  it('本机状态已读取但等待恢复确认时释放静态遮罩', () => {
    expect(shouldDismissAndroidBootstrap(false, false, true)).toBe(true)
    expect(shouldDismissAndroidBootstrap(false, false, false)).toBe(false)
    expect(shouldDismissAndroidBootstrap(true, false, false)).toBe(true)
    expect(shouldDismissAndroidBootstrap(false, true, false)).toBe(true)
  })

  it('等待两帧后再移除，避免正确页面尚未绘制时露出空白', () => {
    const callbacks: FrameRequestCallback[] = []
    const remove = vi.fn()
    const mark = vi.fn()
    const dataset: DOMStringMap = {} as DOMStringMap
    const ownerDocument = {
      getElementById: vi.fn(() => ({ remove })),
      documentElement: { dataset },
      defaultView: {
        performance: { mark },
        requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
          callbacks.push(callback)
          return callbacks.length
        }),
      },
    } as unknown as Document

    dismissAndroidBootstrap(ownerDocument)
    expect(remove).not.toHaveBeenCalled()
    callbacks.shift()?.(0)
    expect(remove).not.toHaveBeenCalled()
    callbacks.shift()?.(16)
    expect(remove).toHaveBeenCalledOnce()
    expect(dataset.wuyanAppReady).toBe('true')
    expect(mark).toHaveBeenCalledWith('wuyan-app-interactive')
  })

  it('无 requestAnimationFrame 时仍安全移除', () => {
    const remove = vi.fn()
    const ownerDocument = {
      getElementById: vi.fn(() => ({ remove })),
      documentElement: { dataset: {} },
      defaultView: undefined,
    } as unknown as Document

    dismissAndroidBootstrap(ownerDocument)
    expect(remove).toHaveBeenCalledOnce()
  })

  it('静态快速记录进行中时等待其释放再移除', () => {
    const remove = vi.fn()
    const listeners = new Map<string, EventListener>()
    const bootstrap = {
      dataset: { wuyanBootstrapBusy: 'true' },
      remove,
      addEventListener: vi.fn((name: string, listener: EventListener) => listeners.set(name, listener)),
    }
    const ownerDocument = {
      getElementById: vi.fn(() => bootstrap),
      documentElement: { dataset: {} },
      defaultView: undefined,
    } as unknown as Document

    dismissAndroidBootstrap(ownerDocument)
    expect(remove).not.toHaveBeenCalled()
    expect(bootstrap.addEventListener).toHaveBeenCalledWith(
      'wuyan:bootstrap-release',
      expect.any(Function),
      { once: true },
    )
    listeners.get('wuyan:bootstrap-release')?.(new Event('wuyan:bootstrap-release'))
    expect(remove).toHaveBeenCalledOnce()
  })

  it('让硬件返回优先取消静态快速记录', () => {
    const dispatchEvent = vi.fn()
    const ownerDocument = {
      getElementById: vi.fn(() => ({
        dataset: { wuyanBootstrapBusy: 'true' },
        dispatchEvent,
      })),
    } as unknown as Document

    expect(consumeAndroidBootstrapBack(ownerDocument)).toBe(true)
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'wuyan:bootstrap-cancel' }))
  })

  it('只在实际移除遮罩时释放 React 根并转移一次焦点', () => {
    let bootstrapPresent = true
    const removeAttribute = vi.fn()
    const focus = vi.fn()
    const focusTarget = {
      hasAttribute: vi.fn(() => false),
      setAttribute: vi.fn(),
      dataset: {},
      addEventListener: vi.fn(),
      focus,
    }
    const bootstrap = { dataset: {}, remove: vi.fn(() => { bootstrapPresent = false }) }
    const application = {
      removeAttribute,
      querySelector: vi.fn(() => focusTarget),
    }
    const ownerDocument = {
      getElementById: vi.fn((id: string) => {
        if (id === 'wuyan-android-bootstrap') return bootstrapPresent ? bootstrap : null
        if (id === 'app') return application
        return null
      }),
      documentElement: { dataset: {} },
      defaultView: undefined,
    } as unknown as Document

    dismissAndroidBootstrap(ownerDocument)
    dismissAndroidBootstrap(ownerDocument)

    expect(bootstrap.remove).toHaveBeenCalledOnce()
    expect(removeAttribute).toHaveBeenCalledTimes(2)
    expect(focus).toHaveBeenCalledOnce()
  })
})
