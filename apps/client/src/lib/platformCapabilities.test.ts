import { afterEach, describe, expect, it, vi } from 'vitest'

const taroMocks = vi.hoisted(() => ({ runtimeEnvironment: 'WEB' }))
vi.mock('@tarojs/taro', () => ({
  default: { getEnv: () => taroMocks.runtimeEnvironment },
}))

import {
  capabilitiesForPlatform,
  getAppCapabilities,
  getAppPlatform,
  isHarmonyApp,
  resolveAppPlatform,
} from './platformCapabilities'

afterEach(() => {
  taroMocks.runtimeEnvironment = 'WEB'
  delete process.env.TARO_ENV
  delete window.Capacitor
})

describe('platform detection', () => {
  it('gives the Harmony compile target precedence over WebView-like runtime markers', () => {
    expect(resolveAppPlatform({
      buildTarget: 'harmony_cpp',
      runtimeEnvironment: 'WEB',
      nativeAndroid: true,
    })).toBe('harmony')
  })

  it('recognizes Harmony runtime environments when build metadata is unavailable', () => {
    expect(resolveAppPlatform({ nativeAndroid: false, runtimeEnvironment: 'HARMONY' })).toBe('harmony')
    expect(resolveAppPlatform({ nativeAndroid: false, runtimeEnvironment: 'HARMONYHYBRID' })).toBe('harmony')
  })

  it('preserves Android, WeChat mini-program, and web detection', () => {
    expect(resolveAppPlatform({ nativeAndroid: true, runtimeEnvironment: 'WEB' })).toBe('android')
    expect(resolveAppPlatform({ nativeAndroid: false, runtimeEnvironment: 'WEAPP' })).toBe('weapp')
    expect(resolveAppPlatform({ nativeAndroid: false, runtimeEnvironment: 'WEB' })).toBe('web')
  })

  it('exposes the build-target decision through the public Harmony predicate and matrix', () => {
    process.env.TARO_ENV = 'harmony_cpp'
    window.Capacitor = {
      getPlatform: () => 'android',
      isNativePlatform: () => true,
    }

    expect(isHarmonyApp()).toBe(true)
    expect(getAppPlatform()).toBe('harmony')
    expect(getAppCapabilities()).toBe(capabilitiesForPlatform('harmony'))
  })
})

describe('platform capability matrix', () => {
  it('keeps the first Harmony release local-only and blocks unsupported sensitive-data paths', () => {
    expect(capabilitiesForPlatform('harmony')).toEqual({
      platform: 'harmony',
      healthContentEnabled: false,
      reminder: 'none',
      cloudSyncControls: false,
      outcomeAnalyticsControls: false,
      backupExport: 'none',
      backupRestore: 'none',
      partnerShare: 'clipboard-only',
      miniProgramPaths: false,
    })
  })

  it('preserves the existing Android native capability boundary', () => {
    expect(capabilitiesForPlatform('android')).toMatchObject({
      healthContentEnabled: true,
      reminder: 'android-system',
      cloudSyncControls: false,
      outcomeAnalyticsControls: false,
      backupExport: 'native-file',
      backupRestore: 'native-file',
      partnerShare: 'android-system',
    })
  })

  it('preserves existing WeChat and web controls', () => {
    expect(capabilitiesForPlatform('weapp')).toMatchObject({
      healthContentEnabled: true,
      reminder: 'wechat-subscription',
      cloudSyncControls: true,
      outcomeAnalyticsControls: true,
      backupExport: 'clipboard',
      partnerShare: 'wechat-card',
      miniProgramPaths: true,
    })
    expect(capabilitiesForPlatform('web')).toMatchObject({
      healthContentEnabled: true,
      reminder: 'wechat-subscription',
      cloudSyncControls: true,
      outcomeAnalyticsControls: true,
      backupExport: 'clipboard',
      partnerShare: 'clipboard-only',
    })
  })

  it('exposes frozen capability records so a page cannot widen them at runtime', () => {
    expect(Object.isFrozen(capabilitiesForPlatform('harmony'))).toBe(true)
  })

  it('withholds every unreviewed health-content surface from the first Harmony release', () => {
    expect(capabilitiesForPlatform('harmony').healthContentEnabled).toBe(false)
    for (const platform of ['android', 'weapp', 'web'] as const) {
      expect(capabilitiesForPlatform(platform).healthContentEnabled).toBe(true)
    }
  })
})
