import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addNativeQuickRecordListener,
  cancelDailyReminder,
  acknowledgeNativeLastExportOutcome,
  acknowledgeNativePendingOpenJson,
  acknowledgePendingNativeExportOutcome,
  acknowledgeNativeSelectedDocumentCleanup,
  consumeNativeBackHandler,
  consumeTaroOverlayBack,
  dispatchNativeOpenJsonRetry,
  formatBeijingBackupTimestamp,
  forgetNativeCorruptExportOutcome,
  getNativeExportCleanupWarning,
  getNativeLastExportOutcome,
  getDailyReminderMutationRevision,
  isDailyReminderScheduled,
  isNativeAndroidApp,
  isTerminalNativeOpenJsonReadError,
  MAX_NATIVE_OPEN_JSON_BYTES,
  nativeExportCleanupIssue,
  nativeExportCleanupFilename,
  openNativeJsonFile,
  openNativeNotificationSettings,
  parseNativePendingOpenJsonMetadata,
  purgeNativePendingExports,
  purgeNativeAppPrivatePendingExports,
  reconcileDailyReminderAfterSystemChange,
  requestNativeQuickRecordTile,
  requestNativeQuickRecordWidget,
  readAndVerifyNativePendingOpenJson,
  registerNativeBackHandler,
  rescheduleDailyReminderForLocalTime,
  saveNativeJsonFile,
  saveNativeRecoveryJsonFile,
  assessNativeSaveJsonPayload,
  scheduleDailyReminder,
  shareNativeText,
} from './runtime'

const nativeMocks = vi.hoisted(() => ({
  share: vi.fn(),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  cancel: vi.fn(),
  schedule: vi.fn(),
  getPending: vi.fn(),
  saveJson: vi.fn(),
  openJson: vi.fn(),
  probePendingOpenJson: vi.fn(),
  readPendingOpenJsonChunk: vi.fn(),
  acknowledgePendingOpenJson: vi.fn(),
  openNotificationSettings: vi.fn(),
  purgePendingExports: vi.fn(),
  purgeAppPrivatePendingExports: vi.fn(),
  getCleanupWarning: vi.fn(),
  acknowledgeSelectedDocumentCleanup: vi.fn(),
  getLastExportOutcome: vi.fn(),
  acknowledgeLastExportOutcome: vi.fn(),
  forgetCorruptExportOutcome: vi.fn(),
  requestPinWidget: vi.fn(),
  requestAddTile: vi.fn(),
  addQuickRecordListener: vi.fn(),
}))

vi.mock('@capacitor/share', () => ({ Share: { share: nativeMocks.share } }))
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: nativeMocks.checkPermissions,
    requestPermissions: nativeMocks.requestPermissions,
    cancel: nativeMocks.cancel,
    schedule: nativeMocks.schedule,
    getPending: nativeMocks.getPending,
  },
}))
function useAndroidRuntime() {
  window.Capacitor = {
    getPlatform: () => 'android',
    isNativePlatform: () => true,
    Plugins: {
      PersonalExport: {
        saveJson: nativeMocks.saveJson,
        openJson: nativeMocks.openJson,
        probePendingOpenJson: nativeMocks.probePendingOpenJson,
        readPendingOpenJsonChunk: nativeMocks.readPendingOpenJsonChunk,
        acknowledgePendingOpenJson: nativeMocks.acknowledgePendingOpenJson,
        openNotificationSettings: nativeMocks.openNotificationSettings,
        purgePendingExports: nativeMocks.purgePendingExports,
        purgeAppPrivatePendingExports: nativeMocks.purgeAppPrivatePendingExports,
        getCleanupWarning: nativeMocks.getCleanupWarning,
        acknowledgeSelectedDocumentCleanup: nativeMocks.acknowledgeSelectedDocumentCleanup,
        getLastExportOutcome: nativeMocks.getLastExportOutcome,
        acknowledgeLastExportOutcome: nativeMocks.acknowledgeLastExportOutcome,
        forgetCorruptExportOutcome: nativeMocks.forgetCorruptExportOutcome,
      },
      QuickRecord: {
        requestPinWidget: nativeMocks.requestPinWidget,
        requestAddTile: nativeMocks.requestAddTile,
        addListener: nativeMocks.addQuickRecordListener,
      },
    },
  }
}

afterEach(() => {
  vi.clearAllMocks()
  delete window.Capacitor
})

const OPEN_JSON_ID = '11111111-1111-4111-8111-111111111111'

describe('Android 备份文件元数据', () => {
  it('保留安全的文件名和修改时间并拒绝路径或错误类型', () => {
    const base = { id: OPEN_JSON_ID, byteLength: 1190, sha256: '9'.repeat(64) }
    expect(parseNativePendingOpenJsonMetadata({
      ...base,
      displayName: '戒烟备份.json',
      lastModifiedEpochMillis: 1_787_968_923_000,
    })).toEqual({
      ...base,
      displayName: '戒烟备份.json',
      lastModifiedEpochMillis: 1_787_968_923_000,
    })
    expect(() => parseNativePendingOpenJsonMetadata({
      ...base,
      displayName: '../备份.json',
    })).toThrow('metadata is invalid')
    expect(() => parseNativePendingOpenJsonMetadata({
      ...base,
      lastModifiedEpochMillis: '1787968923000',
    })).toThrow('metadata is invalid')
  })
})

async function bytesSha256(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function base64Bytes(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

async function installChunkReader(payload: Uint8Array, requestedFinalSha?: string) {
  const finalSha = requestedFinalSha ?? await bytesSha256(payload)
  nativeMocks.readPendingOpenJsonChunk.mockImplementation(async ({ id, offset }: { id: string; offset: number }) => {
    const chunk = payload.slice(offset, Math.min(payload.length, offset + 256 * 1024))
    const nextOffset = offset + chunk.length
    return {
      id,
      byteLength: payload.length,
      sha256: finalSha,
      offset,
      nextOffset,
      done: nextOffset === payload.length,
      chunkBase64: base64Bytes(chunk),
      chunkSha256: await bytesSha256(chunk),
    }
  })
  return finalSha
}

describe('Android back navigation', () => {
  it('lets the most recent overlay consume back before page navigation', () => {
    const calls: string[] = []
    const removePage = registerNativeBackHandler(() => calls.push('page'))
    const removeSheet = registerNativeBackHandler(() => calls.push('sheet'))

    expect(consumeNativeBackHandler()).toBe(true)
    expect(calls).toEqual(['sheet'])
    removeSheet()
    expect(consumeNativeBackHandler()).toBe(true)
    expect(calls).toEqual(['sheet', 'page'])
    removePage()
    expect(consumeNativeBackHandler()).toBe(false)
  })

  it('still consumes a back press when the close callback throws, and removal is idempotent', () => {
    const remove = registerNativeBackHandler(() => { throw new Error('close failed') })
    expect(consumeNativeBackHandler()).toBe(true)
    remove()
    remove()
    expect(consumeNativeBackHandler()).toBe(false)
  })

  it('cancels the visible Taro modal through its own handler', () => {
    const hiddenModal = document.createElement('div')
    hiddenModal.className = 'taro__modal'
    hiddenModal.style.display = 'none'
    const modal = document.createElement('div')
    modal.className = 'taro__modal'
    const cancel = document.createElement('div')
    cancel.className = 'taro-model__cancel'
    const onCancel = vi.fn()
    cancel.onclick = onCancel
    modal.append(cancel)
    document.body.append(hiddenModal, modal)

    expect(consumeTaroOverlayBack()).toBe(true)
    expect(onCancel).toHaveBeenCalledOnce()
    hiddenModal.remove()
    modal.remove()
    expect(consumeTaroOverlayBack()).toBe(false)
  })

  it('cancels a visible Taro picker before an underlying modal', () => {
    const modal = document.createElement('div')
    modal.className = 'taro__modal'
    const modalCancel = document.createElement('div')
    modalCancel.className = 'taro-model__cancel'
    const onModalCancel = vi.fn()
    modalCancel.onclick = onModalCancel
    modal.append(modalCancel)

    const picker = document.createElement('div')
    picker.className = 'weui-picker__overlay'
    const pickerCancel = document.createElement('div')
    pickerCancel.className = 'weui-picker__action'
    const onPickerCancel = vi.fn()
    pickerCancel.onclick = onPickerCancel
    picker.append(pickerCancel)
    document.body.append(modal, picker)

    expect(consumeTaroOverlayBack()).toBe(true)
    expect(onPickerCancel).toHaveBeenCalledOnce()
    expect(onModalCancel).not.toHaveBeenCalled()
    modal.remove()
    picker.remove()
  })

  it('consumes a one-button modal without confirming the destructive action', () => {
    const modal = document.createElement('div')
    modal.className = 'taro__modal'
    const cancel = document.createElement('div')
    cancel.className = 'taro-model__cancel'
    cancel.style.display = 'none'
    const confirm = document.createElement('div')
    confirm.className = 'taro-model__confirm'
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    cancel.onclick = onCancel
    confirm.onclick = onConfirm
    modal.append(cancel, confirm)
    document.body.append(modal)

    expect(consumeTaroOverlayBack()).toBe(true)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
    modal.remove()
  })
})

describe('Android runtime detection', () => {
  it('keeps ordinary H5 builds in web mode', () => {
    expect(isNativeAndroidApp()).toBe(false)
  })

  it('recognizes the Capacitor Android shell', () => {
    window.Capacitor = {
      getPlatform: () => 'android',
      isNativePlatform: () => true,
    }
    expect(isNativeAndroidApp()).toBe(true)
  })

  it('does not treat a native iOS runtime as Android', () => {
    window.Capacitor = {
      getPlatform: () => 'ios',
      isNativePlatform: () => true,
    }
    expect(isNativeAndroidApp()).toBe(false)
  })
})

describe('Android native capabilities', () => {
  it('requests quick entrances and accepts only authenticated commit wake events', async () => {
    useAndroidRuntime()
    nativeMocks.requestPinWidget.mockResolvedValue({ supported: true, requested: true })
    nativeMocks.requestAddTile.mockResolvedValue({ result: 'added' })
    const remove = vi.fn(async () => undefined)
    let nativeListener: ((event: { id?: unknown; smokedAt?: unknown }) => void) | undefined
    nativeMocks.addQuickRecordListener.mockImplementation(async (
      _name: string,
      listener: (event: { id?: unknown; smokedAt?: unknown }) => void,
    ) => {
      nativeListener = listener
      return { remove }
    })
    const wake = vi.fn()

    await expect(requestNativeQuickRecordWidget()).resolves.toEqual({ supported: true, requested: true })
    await expect(requestNativeQuickRecordTile()).resolves.toBe('added')
    const handle = await addNativeQuickRecordListener(wake)
    nativeListener?.({ id: 'bad', smokedAt: '2026-09-19T08:00:00.000Z' })
    nativeListener?.({
      id: '11111111-1111-4111-8111-111111111111',
      smokedAt: 'not-a-time',
    })
    nativeListener?.({
      id: '11111111-1111-4111-8111-111111111111',
      smokedAt: '2026-09-19T08:00:00.000Z',
    })

    expect(wake).toHaveBeenCalledOnce()
    expect(nativeMocks.addQuickRecordListener).toHaveBeenCalledWith('recordCommitted', expect.any(Function))
    await handle.remove()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('rejects malformed quick-entry plugin responses', async () => {
    useAndroidRuntime()
    nativeMocks.requestPinWidget.mockResolvedValue({ supported: 'yes', requested: true })
    nativeMocks.requestAddTile.mockResolvedValue({ result: 'unexpected' })

    await expect(requestNativeQuickRecordWidget()).rejects.toThrow('invalid data')
    await expect(requestNativeQuickRecordTile()).rejects.toThrow('invalid data')
  })

  it('dispatches an in-process retry signal without copying backup bytes into the event', () => {
    const listener = vi.fn()
    window.addEventListener('wuyan:native-open-json-retry', listener, { once: true })
    dispatchNativeOpenJsonRetry()
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'wuyan:native-open-json-retry' }))
  })

  it('rejects native-only sharing and invalid reminder hours outside Android', async () => {
    await expect(shareNativeText('标题', '内容')).rejects.toThrow('unavailable')
    await expect(scheduleDailyReminder(8)).resolves.toBe('unsupported')
    await expect(cancelDailyReminder()).resolves.toBeUndefined()
    await expect(isDailyReminderScheduled()).resolves.toBe(false)
    await expect(saveNativeJsonFile('{}')).rejects.toThrow('unavailable')
    await expect(openNativeJsonFile()).rejects.toThrow('unavailable')
    await expect(purgeNativePendingExports()).resolves.toBeUndefined()
    await expect(acknowledgeNativeSelectedDocumentCleanup()).resolves.toBeUndefined()
    await expect(getNativeExportCleanupWarning()).resolves.toBeUndefined()

    useAndroidRuntime()
    await expect(scheduleDailyReminder(24)).rejects.toThrow('提醒时间无效')
  })

  it('fails fast instead of hanging when the injected document bridge is missing', async () => {
    window.Capacitor = {
      getPlatform: () => 'android',
      isNativePlatform: () => true,
    }
    await expect(saveNativeJsonFile('{}')).rejects.toThrow('PersonalExport native plugin is unavailable')
    await expect(openNativeJsonFile()).rejects.toThrow('PersonalExport native plugin is unavailable')
  })

  it('shares through the Android chooser', async () => {
    useAndroidRuntime()
    nativeMocks.share.mockResolvedValue(undefined)
    await shareNativeText('伙伴卡', '今天继续无烟')
    expect(nativeMocks.share).toHaveBeenCalledWith({
      title: '伙伴卡',
      text: '今天继续无烟',
      dialogTitle: '选择要发送到的应用',
    })
  })

  it('handles denied and granted daily reminder permission and verifies scheduling', async () => {
    useAndroidRuntime()
    nativeMocks.checkPermissions.mockResolvedValueOnce({ display: 'prompt' })
    nativeMocks.requestPermissions.mockResolvedValueOnce({ display: 'denied' })
    await expect(scheduleDailyReminder(9)).resolves.toBe('denied')

    nativeMocks.checkPermissions.mockResolvedValueOnce({ display: 'granted' })
    nativeMocks.cancel.mockResolvedValue(undefined)
    nativeMocks.schedule.mockResolvedValue(undefined)
    nativeMocks.getPending.mockResolvedValueOnce({ notifications: [{ id: 932001 }] })
    await expect(scheduleDailyReminder(21)).resolves.toBe('scheduled')
    expect(nativeMocks.schedule).toHaveBeenCalledWith({
      notifications: [expect.objectContaining({
        id: 932001,
        schedule: { on: { hour: 21, minute: 0 }, allowWhileIdle: false },
        isExactNotification: false,
      })],
    })
  })

  it('前台时按当前本地时钟重建已授权提醒，且绝不弹出权限请求', async () => {
    useAndroidRuntime()
    nativeMocks.checkPermissions
      .mockResolvedValueOnce({ display: 'granted' })
      .mockResolvedValueOnce({ display: 'denied' })
    nativeMocks.cancel.mockResolvedValue(undefined)
    nativeMocks.schedule.mockResolvedValue(undefined)
    nativeMocks.getPending.mockResolvedValueOnce({ notifications: [{ id: 932001 }] })

    await expect(rescheduleDailyReminderForLocalTime(20)).resolves.toBe('scheduled')
    expect(nativeMocks.cancel).toHaveBeenCalledWith({ notifications: [{ id: 932001 }] })
    expect(nativeMocks.schedule).toHaveBeenCalledWith({
      notifications: [expect.objectContaining({
        id: 932001,
        schedule: { on: { hour: 20, minute: 0 }, allowWhileIdle: false },
      })],
    })
    expect(nativeMocks.requestPermissions).not.toHaveBeenCalled()

    await expect(rescheduleDailyReminderForLocalTime(20)).resolves.toBe('denied')
    expect(nativeMocks.requestPermissions).not.toHaveBeenCalled()
  })

  it('fails closed when Android does not retain a reminder, and reconciles pending state', async () => {
    useAndroidRuntime()
    nativeMocks.checkPermissions.mockResolvedValue({ display: 'granted' })
    nativeMocks.cancel.mockResolvedValue(undefined)
    nativeMocks.schedule.mockResolvedValue(undefined)
    nativeMocks.getPending.mockResolvedValueOnce({ notifications: [] })
    await expect(scheduleDailyReminder(7)).rejects.toThrow('系统未保留提醒计划')

    nativeMocks.getPending.mockResolvedValueOnce({ notifications: [{ id: 932001 }] })
    await expect(isDailyReminderScheduled()).resolves.toBe(true)
    nativeMocks.checkPermissions.mockResolvedValueOnce({ display: 'denied' })
    await expect(isDailyReminderScheduled()).resolves.toBe(false)
    await cancelDailyReminder()
    expect(nativeMocks.cancel).toHaveBeenCalled()
  })

  it('cancels a reminder left behind after permission revocation before disabling the local toggle', async () => {
    useAndroidRuntime()
    nativeMocks.checkPermissions.mockResolvedValueOnce({ display: 'denied' })
    nativeMocks.cancel.mockResolvedValueOnce(undefined)
    const disableLocal = vi.fn()

    await expect(reconcileDailyReminderAfterSystemChange(disableLocal)).resolves.toBe('disabled')
    expect(nativeMocks.cancel).toHaveBeenCalledWith({ notifications: [{ id: 932001 }] })
    expect(disableLocal).toHaveBeenCalledOnce()
  })

  it('does not apply a stale permission read after a newer reminder mutation starts', async () => {
    useAndroidRuntime()
    let resolvePermission!: (value: { display: string }) => void
    nativeMocks.checkPermissions.mockReturnValueOnce(new Promise((resolve) => { resolvePermission = resolve }))
    nativeMocks.cancel.mockResolvedValue(undefined)
    const disableLocal = vi.fn()
    const revisionBefore = getDailyReminderMutationRevision()
    const reconciliation = reconcileDailyReminderAfterSystemChange(disableLocal)

    await cancelDailyReminder()
    expect(getDailyReminderMutationRevision()).toBe(revisionBefore + 1)
    resolvePermission({ display: 'denied' })

    await expect(reconciliation).resolves.toBe('stale')
    expect(disableLocal).not.toHaveBeenCalled()
  })

  it('exports, imports and purges through the private Android document bridge', async () => {
    useAndroidRuntime()
    const payload = new TextEncoder().encode('{"version":1}')
    const pendingSha = await installChunkReader(payload)
    nativeMocks.saveJson.mockResolvedValue({ saved: true })
    nativeMocks.openJson
      .mockResolvedValueOnce({ selected: false })
      .mockResolvedValueOnce({
        selected: true,
        id: OPEN_JSON_ID,
        byteLength: payload.length,
        sha256: pendingSha,
      })
      .mockResolvedValueOnce({ selected: true, id: OPEN_JSON_ID, byteLength: 0, sha256: pendingSha })
    nativeMocks.purgePendingExports.mockResolvedValue(undefined)
    nativeMocks.purgeAppPrivatePendingExports.mockResolvedValue(undefined)
    nativeMocks.getCleanupWarning.mockResolvedValue({
      pending: true,
      issue: 'selected-document',
      filename: 'wuyan-tongxing-backup.json',
    })
    nativeMocks.acknowledgeSelectedDocumentCleanup.mockResolvedValue(undefined)
    nativeMocks.getLastExportOutcome.mockResolvedValue({
      available: true,
      saved: true,
      id: '11111111-1111-4111-8111-111111111111',
      filename: 'wuyan-tongxing-backup.json',
    })
    nativeMocks.acknowledgeLastExportOutcome.mockResolvedValue(undefined)
    nativeMocks.forgetCorruptExportOutcome.mockResolvedValue(undefined)
    nativeMocks.openNotificationSettings.mockResolvedValue({ opened: true })

    await expect(saveNativeJsonFile('{"version":1}', new Date('2026-08-28T06:43:10.826Z'))).resolves.toBe(true)
    expect(nativeMocks.saveJson).toHaveBeenCalledWith(expect.objectContaining({
      json: '{"version":1}',
      filename: 'wuyan-tongxing-backup-2026-08-28_14-43-10_Beijing.json',
    }))
    await expect(saveNativeJsonFile(
      '{"part":1}',
      new Date('2026-08-28T06:43:10.826Z'),
      'wuyan-recovery-11111111-001-of-003.json',
    )).resolves.toBe(true)
    expect(nativeMocks.saveJson).toHaveBeenCalledWith({
      json: '{"part":1}',
      filename: 'wuyan-recovery-11111111-001-of-003.json',
    })
    await expect(saveNativeJsonFile('{}', new Date(), '../unsafe.json')).rejects.toThrow('文件名无效')
    await expect(openNativeJsonFile()).resolves.toBeUndefined()
    await expect(openNativeJsonFile()).resolves.toEqual({
      id: OPEN_JSON_ID,
      byteLength: payload.length,
      sha256: pendingSha,
      json: '{"version":1}',
    })
    await expect(openNativeJsonFile()).rejects.toThrow('metadata is invalid')
    await purgeNativePendingExports()
    await purgeNativeAppPrivatePendingExports()
    await acknowledgeNativeSelectedDocumentCleanup()
    await expect(getNativeLastExportOutcome()).resolves.toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      saved: true,
      filename: 'wuyan-tongxing-backup.json',
    })
    await acknowledgeNativeLastExportOutcome('11111111-1111-4111-8111-111111111111')
    await forgetNativeCorruptExportOutcome()
    await expect(acknowledgePendingNativeExportOutcome()).resolves.toBe(true)
    await expect(getNativeExportCleanupWarning()).resolves.toEqual({
      issue: 'selected-document',
      filename: 'wuyan-tongxing-backup.json',
    })
    await expect(openNativeNotificationSettings()).resolves.toBe(true)
    expect(nativeMocks.purgePendingExports).toHaveBeenCalledOnce()
    expect(nativeMocks.purgeAppPrivatePendingExports).toHaveBeenCalledOnce()
    expect(nativeMocks.acknowledgeSelectedDocumentCleanup).toHaveBeenCalledOnce()
    expect(nativeMocks.acknowledgeLastExportOutcome).toHaveBeenCalledWith({
      id: '11111111-1111-4111-8111-111111111111',
    })
    expect(nativeMocks.acknowledgeLastExportOutcome).toHaveBeenCalledTimes(2)
    expect(nativeMocks.forgetCorruptExportOutcome).toHaveBeenCalledOnce()
    expect(nativeMocks.openNotificationSettings).toHaveBeenCalledOnce()
  })

  it('reconstructs authenticated UTF-8 across 256 KiB chunk boundaries', async () => {
    useAndroidRuntime()
    const source = JSON.stringify({ value: '戒😀'.repeat(60_000) })
    const payload = new TextEncoder().encode(source)
    const sha256 = await installChunkReader(payload)

    await expect(readAndVerifyNativePendingOpenJson({
      id: OPEN_JSON_ID,
      byteLength: payload.length,
      sha256,
    })).resolves.toEqual({ id: OPEN_JSON_ID, byteLength: payload.length, sha256, json: source })
    expect(nativeMocks.readPendingOpenJsonChunk.mock.calls.map((call) => call[0].offset))
      .toEqual([0, 256 * 1024])
  })

  it('classifies deterministic chunk tamper and fatal UTF-8 separately from transient plugin errors', async () => {
    useAndroidRuntime()
    const valid = new TextEncoder().encode('{"ok":true}')
    const finalSha = await bytesSha256(valid)
    nativeMocks.readPendingOpenJsonChunk.mockResolvedValueOnce({
      id: OPEN_JSON_ID,
      byteLength: valid.length,
      sha256: finalSha,
      offset: 0,
      nextOffset: valid.length,
      done: true,
      chunkBase64: base64Bytes(valid),
      chunkSha256: '0'.repeat(64),
    })
    const tampered = readAndVerifyNativePendingOpenJson({ id: OPEN_JSON_ID, byteLength: valid.length, sha256: finalSha })
    await expect(tampered).rejects.toMatchObject({ terminal: true })

    const invalidUtf8 = Uint8Array.of(0xc3, 0x28)
    const invalidSha = await installChunkReader(invalidUtf8)
    const invalid = readAndVerifyNativePendingOpenJson({
      id: OPEN_JSON_ID,
      byteLength: invalidUtf8.length,
      sha256: invalidSha,
    })
    await expect(invalid).rejects.toMatchObject({ terminal: true })

    nativeMocks.readPendingOpenJsonChunk.mockReset()
    const transientError = new Error('bridge unavailable')
    nativeMocks.readPendingOpenJsonChunk.mockRejectedValueOnce(transientError)
    const transient = readAndVerifyNativePendingOpenJson({
      id: OPEN_JSON_ID,
      byteLength: valid.length,
      sha256: finalSha,
    })
    await expect(transient).rejects.toBe(transientError)
    expect(isTerminalNativeOpenJsonReadError(transientError)).toBe(false)
  })

  it('rejects final-hash mismatch, non-progress offsets and cap+1 before another allocation/read', async () => {
    useAndroidRuntime()
    const payload = new TextEncoder().encode('{"ok":true}')
    const wrongFinal = 'f'.repeat(64)
    await installChunkReader(payload, wrongFinal)
    await expect(readAndVerifyNativePendingOpenJson({
      id: OPEN_JSON_ID,
      byteLength: payload.length,
      sha256: wrongFinal,
    })).rejects.toMatchObject({ terminal: true })

    nativeMocks.readPendingOpenJsonChunk.mockReset()
    const realSha = await bytesSha256(payload)
    nativeMocks.readPendingOpenJsonChunk.mockResolvedValueOnce({
      id: OPEN_JSON_ID,
      byteLength: payload.length,
      sha256: realSha,
      offset: 0,
      nextOffset: 0,
      done: false,
      chunkBase64: '',
      chunkSha256: await bytesSha256(new Uint8Array()),
    })
    await expect(readAndVerifyNativePendingOpenJson({
      id: OPEN_JSON_ID,
      byteLength: payload.length,
      sha256: realSha,
    })).rejects.toMatchObject({ terminal: true })

    nativeMocks.readPendingOpenJsonChunk.mockClear()
    await expect(readAndVerifyNativePendingOpenJson({
      id: OPEN_JSON_ID,
      byteLength: MAX_NATIVE_OPEN_JSON_BYTES + 1,
      sha256: realSha,
    })).rejects.toThrow('metadata is invalid')
    expect(nativeMocks.readPendingOpenJsonChunk).not.toHaveBeenCalled()
  })

  it('validates token-bound acknowledgement including lost-response idempotency', async () => {
    useAndroidRuntime()
    nativeMocks.acknowledgePendingOpenJson
      .mockResolvedValueOnce({ acknowledged: true, alreadyAcknowledged: false })
      .mockResolvedValueOnce({ acknowledged: true, alreadyAcknowledged: true })
    await expect(acknowledgeNativePendingOpenJson(OPEN_JSON_ID)).resolves.toEqual({
      acknowledged: true,
      alreadyAcknowledged: false,
    })
    await expect(acknowledgeNativePendingOpenJson(OPEN_JSON_ID)).resolves.toEqual({
      acknowledged: true,
      alreadyAcknowledged: true,
    })
    await expect(acknowledgeNativePendingOpenJson('../wrong')).rejects.toThrow('id is invalid')
  })

  it('guards ordinary, low-escape recovery and worst-escape bridge envelopes before native save', async () => {
    useAndroidRuntime()
    nativeMocks.saveJson.mockResolvedValue({ saved: true })
    expect(assessNativeSaveJsonPayload('a'.repeat(4 * 1024 * 1024))).toMatchObject({
      byteLength: 4 * 1024 * 1024,
    })
    expect(() => assessNativeSaveJsonPayload('a'.repeat(4 * 1024 * 1024 + 1))).toThrow('4 MiB')

    const prefix = '{"readStatus":{},"primary":"'
    const suffix = '","lastKnownGood":"B","_recoveryIntegrity":{}}'
    const exactRecovery = prefix + 'A'.repeat(12 * 1024 * 1024 - prefix.length - suffix.length) + suffix
    expect(assessNativeSaveJsonPayload(exactRecovery, true).byteLength).toBe(12 * 1024 * 1024)
    expect(() => assessNativeSaveJsonPayload(exactRecovery + 'A', true)).toThrow('12 MiB')

    const worstEscape = prefix + '\\'.repeat(1024 * 1024 + 1) + suffix
    expect(() => assessNativeSaveJsonPayload(worstEscape, true)).toThrow('低转义')
    await expect(saveNativeRecoveryJsonFile(prefix + 'QUJD' + suffix)).resolves.toBe(true)
    expect(nativeMocks.saveJson).toHaveBeenLastCalledWith(expect.objectContaining({ recovery: true }))
  }, 15_000)

  it('formats backup filenames in the same Beijing time used by smoking records', () => {
    expect(formatBeijingBackupTimestamp(new Date('2026-08-28T16:00:01.999Z')))
      .toBe('2026-08-29_00-00-01_Beijing')
    expect(() => formatBeijingBackupTimestamp(new Date('invalid'))).toThrow('备份时间无效')
  })
})

describe('Android export cleanup guidance', () => {
  it('recognizes a selected-document cleanup failure by stable native code', () => {
    expect(nativeExportCleanupIssue({ code: 'PARTIAL_DOCUMENT_CLEANUP_FAILED' })).toBe('selected-document')
  })

  it('recognizes a restored local-temporary cleanup message without a code', () => {
    expect(nativeExportCleanupIssue({ message: '本机私有导出暂存未能清理' })).toBe('local-temporary')
  })

  it('does not turn an ordinary write error into a cleanup warning', () => {
    expect(nativeExportCleanupIssue({ code: 'DOCUMENT_WRITE_FAILED', message: '无法保存数据副本' })).toBeUndefined()
  })

  it('distinguishes combined remote and local cleanup failures', () => {
    expect(nativeExportCleanupIssue({ code: 'EXPORT_CLEANUP_FAILED' })).toBe('both')
  })

  it('keeps successful export distinct from local temporary cleanup failure', () => {
    expect(nativeExportCleanupIssue({ code: 'EXPORT_SAVED_LOCAL_TEMP_CLEANUP_FAILED' })).toBe('saved-local-temporary')
  })

  it('maps pending and unreadable durable export outcomes to explicit guidance', () => {
    expect(nativeExportCleanupIssue({ code: 'EXPORT_OUTCOME_PENDING' })).toBe('pending-export-outcome')
    expect(nativeExportCleanupIssue({ code: 'EXPORT_OUTCOME_CORRUPTED' })).toBe('export-outcome')
    expect(nativeExportCleanupIssue({ code: 'EXPORT_OUTCOME_READ_FAILED' })).toBe('export-outcome')
  })

  it('recognizes all restored-message variants and primitive errors', () => {
    expect(nativeExportCleanupIssue({ message: '刚才位置与本机私有导出暂存都未清理' })).toBe('both')
    expect(nativeExportCleanupIssue({ message: '文件已经保存，但临时文件未清理' })).toBe('saved-local-temporary')
    expect(nativeExportCleanupIssue({ message: '刚才选择的位置未清理' })).toBe('selected-document')
    expect(nativeExportCleanupIssue('普通错误')).toBeUndefined()
    expect(nativeExportCleanupIssue(null)).toBeUndefined()
  })

  it('extracts only a bounded safe JSON filename from native cleanup guidance', () => {
    expect(nativeExportCleanupFilename({
      message: '请删除文件“wuyan-tongxing-backup-2026.json”',
    })).toBe('wuyan-tongxing-backup-2026.json')
    expect(nativeExportCleanupFilename({ message: '请删除文件“../secret.json”' })).toBeUndefined()
    expect(nativeExportCleanupFilename('普通错误')).toBeUndefined()
  })
})
