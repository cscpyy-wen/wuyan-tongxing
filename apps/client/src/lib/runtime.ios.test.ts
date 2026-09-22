import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAppCapabilities } from './platformCapabilities'
import {
  isNativeAndroidApp, isNativeIOSApp, isNativeMobileApp,
  requestNativeQuickRecordWidget, saveNativeJsonFile, scheduleDailyReminder, shareNativeText,
} from './runtime'

const native = vi.hoisted(() => ({
  checkPermissions: vi.fn(async () => ({ display: 'granted' })),
  requestPermissions: vi.fn(async () => ({ display: 'granted' })),
  cancel: vi.fn(async () => undefined),
  schedule: vi.fn(async () => undefined),
  getPending: vi.fn(async () => ({ notifications: [{ id: 932001 }] })),
  share: vi.fn(async () => ({})),
  saveJson: vi.fn(async () => ({ saved: true })),
}))
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: native }))
vi.mock('@capacitor/share', () => ({ Share: { share: native.share } }))
vi.mock('@tarojs/taro', () => ({ default: { getEnv: () => 'WEB' } }))

beforeEach(() => {
  delete process.env.TARO_ENV
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    Plugins: { PersonalExport: { saveJson: native.saveJson } },
  } as unknown as NonNullable<Window['Capacitor']>
})
afterEach(() => { delete window.Capacitor; vi.clearAllMocks() })

describe('iPhone native routing', () => {
  it('uses offline iOS capabilities while keeping Android shortcuts unavailable', async () => {
    expect(isNativeIOSApp()).toBe(true)
    expect(isNativeMobileApp()).toBe(true)
    expect(isNativeAndroidApp()).toBe(false)
    expect(getAppCapabilities()).toMatchObject({
      platform: 'ios', reminder: 'ios-system', partnerShare: 'ios-system',
      cloudSyncControls: false, outcomeAnalyticsControls: false,
      backupExport: 'native-file', backupRestore: 'native-file',
    })
    await expect(requestNativeQuickRecordWidget()).rejects.toThrow('Native Android')
  })

  it('uses the file picker and propagates cancellation rather than copying health data', async () => {
    expect(await saveNativeJsonFile('{"record":"中文"}')).toBe(true)
    expect(native.saveJson).toHaveBeenCalledWith(expect.objectContaining({ json: '{"record":"中文"}' }))
    native.saveJson.mockResolvedValueOnce({ saved: false })
    expect(await saveNativeJsonFile('{}')).toBe(false)
  })

  it('schedules a local calendar reminder and shares only on explicit invocation', async () => {
    expect(await scheduleDailyReminder(20)).toBe('scheduled')
    expect(native.schedule).toHaveBeenCalledWith({ notifications: [expect.objectContaining({
      id: 932001, schedule: { on: { hour: 20, minute: 0 }, allowWhileIdle: false },
    })] })
    await shareNativeText('支持卡', '请支持我')
    expect(native.share).toHaveBeenCalledWith(expect.objectContaining({ title: '支持卡', text: '请支持我' }))
  })

  it('a Safari user agent alone never enables native file access', () => {
    window.Capacitor = { isNativePlatform: () => false, getPlatform: () => 'ios' }
    expect(isNativeIOSApp()).toBe(false)
    expect(getAppCapabilities().platform).toBe('web')
  })
})
