import Taro from '@tarojs/taro'
import { isNativeAndroidApp, isNativeIOSApp } from './runtime'

export type AppPlatform = 'android' | 'ios' | 'harmony' | 'weapp' | 'web'

export interface AppCapabilities {
  readonly platform: AppPlatform
  /**
   * Whether this channel may expose the current health-education catalog.
   * This flag describes channel packaging only; it is not a medical-review
   * claim. The first Harmony store release fails closed until named review is
   * complete.
   */
  readonly healthContentEnabled: boolean
  readonly reminder: 'android-system' | 'ios-system' | 'wechat-subscription' | 'none'
  readonly cloudSyncControls: boolean
  readonly outcomeAnalyticsControls: boolean
  readonly backupExport: 'native-file' | 'clipboard' | 'none'
  readonly backupRestore: 'native-file' | 'none'
  readonly partnerShare: 'android-system' | 'ios-system' | 'wechat-card' | 'clipboard-only'
  readonly miniProgramPaths: boolean
}

const CAPABILITIES: Readonly<Record<AppPlatform, Readonly<AppCapabilities>>> = Object.freeze({
  ios: Object.freeze({
    platform: 'ios',
    healthContentEnabled: true,
    reminder: 'ios-system',
    cloudSyncControls: false,
    outcomeAnalyticsControls: false,
    backupExport: 'native-file',
    backupRestore: 'native-file',
    partnerShare: 'ios-system',
    miniProgramPaths: false,
  }),
  android: Object.freeze({
    platform: 'android',
    healthContentEnabled: true,
    reminder: 'android-system',
    cloudSyncControls: false,
    outcomeAnalyticsControls: false,
    backupExport: 'native-file',
    backupRestore: 'native-file',
    partnerShare: 'android-system',
    miniProgramPaths: false,
  }),
  harmony: Object.freeze({
    platform: 'harmony',
    healthContentEnabled: false,
    reminder: 'none',
    cloudSyncControls: false,
    outcomeAnalyticsControls: false,
    backupExport: 'none',
    backupRestore: 'none',
    partnerShare: 'clipboard-only',
    miniProgramPaths: false,
  }),
  weapp: Object.freeze({
    platform: 'weapp',
    healthContentEnabled: true,
    reminder: 'wechat-subscription',
    cloudSyncControls: true,
    outcomeAnalyticsControls: true,
    backupExport: 'clipboard',
    backupRestore: 'none',
    partnerShare: 'wechat-card',
    miniProgramPaths: true,
  }),
  web: Object.freeze({
    platform: 'web',
    healthContentEnabled: true,
    reminder: 'wechat-subscription',
    cloudSyncControls: true,
    outcomeAnalyticsControls: true,
    backupExport: 'clipboard',
    backupRestore: 'none',
    partnerShare: 'clipboard-only',
    miniProgramPaths: false,
  }),
})

export interface AppPlatformSignals {
  readonly buildTarget?: string | undefined
  readonly runtimeEnvironment?: string | undefined
  readonly nativeAndroid: boolean
  readonly nativeIOS?: boolean
}

/**
 * Resolve the platform from immutable build metadata first, then Taro's
 * runtime environment. Capacitor is intentionally last among native signals:
 * a stray WebView marker must never turn a Harmony build into Android.
 */
export function resolveAppPlatform(signals: AppPlatformSignals): AppPlatform {
  if (signals.buildTarget === 'harmony_cpp'
    || signals.runtimeEnvironment === 'HARMONY'
    || signals.runtimeEnvironment === 'HARMONYHYBRID') return 'harmony'
  if (signals.nativeAndroid) return 'android'
  if (signals.nativeIOS) return 'ios'
  if (signals.runtimeEnvironment === 'WEAPP') return 'weapp'
  return 'web'
}

export function getAppPlatform(): AppPlatform {
  let runtimeEnvironment: string | undefined
  try {
    runtimeEnvironment = Taro.getEnv()
  } catch {
    // Build metadata and Capacitor detection still provide a safe fallback.
  }
  return resolveAppPlatform({
    buildTarget: process.env.TARO_ENV,
    runtimeEnvironment,
    nativeAndroid: isNativeAndroidApp(),
    nativeIOS: isNativeIOSApp(),
  })
}

export function isHarmonyApp(): boolean {
  return getAppPlatform() === 'harmony'
}

export function capabilitiesForPlatform(platform: AppPlatform): Readonly<AppCapabilities> {
  return CAPABILITIES[platform]
}

export function getAppCapabilities(): Readonly<AppCapabilities> {
  return capabilitiesForPlatform(getAppPlatform())
}
