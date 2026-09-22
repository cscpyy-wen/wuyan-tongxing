import Taro from '@tarojs/taro'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { openProgressAfterLapseSave, openTodayAsRoot } from './navigation'

vi.mock('@tarojs/taro', () => ({
  default: {
    redirectTo: vi.fn(() => Promise.resolve()),
    reLaunch: vi.fn(() => Promise.resolve()),
    navigateBack: vi.fn(() => Promise.resolve()),
    switchTab: vi.fn(() => Promise.resolve()),
    eventCenter: {
      trigger: vi.fn(),
    },
  },
}))

const originalTaroEnv = process.env.TARO_ENV

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  if (originalTaroEnv === undefined) delete process.env.TARO_ENV
  else process.env.TARO_ENV = originalTaroEnv
})

describe('root navigation', () => {
  it('replaces onboarding with the generated Harmony tab-bar root', async () => {
    process.env.TARO_ENV = 'harmony_cpp'

    await openTodayAsRoot()

    expect(Taro.redirectTo).toHaveBeenCalledWith({ url: '/taro_tabbar' })
    expect(Taro.switchTab).not.toHaveBeenCalled()
    expect(Taro.reLaunch).not.toHaveBeenCalled()
  })

  it('keeps reLaunch for non-Harmony builds', async () => {
    process.env.TARO_ENV = 'h5'

    await openTodayAsRoot()

    expect(Taro.reLaunch).toHaveBeenCalledWith({ url: '/pages/today/index' })
    expect(Taro.switchTab).not.toHaveBeenCalled()
  })

  it('selects Progress before returning to the known Harmony tab root', async () => {
    process.env.TARO_ENV = 'harmony_cpp'

    await openProgressAfterLapseSave()

    expect(Taro.navigateBack).toHaveBeenCalledOnce()
    expect(Taro.navigateBack).toHaveBeenCalledWith({ url: '/taro_tabbar' })
    expect(Taro.eventCenter.trigger).toHaveBeenCalledWith('__taroSwitchTab', {
      url: '/taro_tabbar',
      params: { $page: 'pages/progress/index' },
    })
    expect(vi.mocked(Taro.eventCenter.trigger).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(Taro.navigateBack).mock.invocationCallOrder[0]!)
    expect(Taro.switchTab).not.toHaveBeenCalled()
  })

  it('keeps the normal tab API for non-Harmony lapse saves', async () => {
    process.env.TARO_ENV = 'weapp'

    await openProgressAfterLapseSave()

    expect(Taro.switchTab).toHaveBeenCalledWith({ url: '/pages/progress/index' })
    expect(Taro.navigateBack).not.toHaveBeenCalled()
    expect(Taro.eventCenter.trigger).not.toHaveBeenCalled()
  })

  it('lets the onboarded-state effect own the only post-save root transition', () => {
    const onboardingSource = readFileSync(
      resolve(process.cwd(), 'src/pages/onboarding/index.tsx'),
      'utf8',
    )

    expect(onboardingSource).not.toContain('if (saved) openTodayAsRoot()')
    expect(onboardingSource).toContain('if (state.onboarded)')
  })
})
