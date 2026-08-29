import { describe, expect, it, vi } from 'vitest'
import { createClientPlan, createInitialState } from './model'
import {
  consumeRestoredOpenJson,
  formatNativeBackupRestoreConfirmation,
  runRestoredOpenJsonProcessingSafely,
  shouldRetainNativeRestorePayload,
  summarizeNativeBackupRestore,
  type NativeBackupRestoreDependencies,
} from './nativeBackupRestore'
import type { ClientState } from '../types'

function validState(overrides?: { reminder?: boolean; hour?: number }): ClientState {
  const baseline = {
    cigarettesPerDay: 10,
    firstCigaretteMinutes: 30,
    previousAttempts: 0,
    reasons: ['为了健康'],
    triggers: ['stress' as const],
    pricePerPack: 25,
  }
  const initial = createInitialState()
  return {
    ...initial,
    onboarded: true,
    baseline,
    plan: createClientPlan(
      { baseline, path: 'abrupt', quitDate: '2026-09-01' },
      new Date('2026-08-28T08:00:00+08:00'),
    ),
    settings: {
      ...initial.settings,
      sensitiveHealthData: true,
      inAppReminder: overrides?.reminder ?? false,
      reminderHour: overrides?.hour ?? 20,
    },
  }
}

function dependencies(
  currentState = validState({ reminder: true, hour: 9 }),
): NativeBackupRestoreDependencies & {
  importData: ReturnType<typeof vi.fn>
  isCurrent: ReturnType<typeof vi.fn>
  isReminderScheduled: ReturnType<typeof vi.fn>
  scheduleReminder: ReturnType<typeof vi.fn>
  cancelReminder: ReturnType<typeof vi.fn>
} {
  return {
    currentState,
    isCurrent: vi.fn(() => true),
    importData: vi.fn(() => ({ bootstrapRecoverySkipped: false })),
    isReminderScheduled: vi.fn(async () => true),
    scheduleReminder: vi.fn(async () => 'scheduled' as const),
    cancelReminder: vi.fn(async () => undefined),
  }
}

describe('Android 重建后的备份恢复', () => {
  it('builds a file-specific summary before any destructive import', () => {
    const imported = validState({ reminder: true, hour: 21 })
    const summary = summarizeNativeBackupRestore(JSON.stringify(imported))
    expect(summary).toMatchObject({
      planPath: 'abrupt',
      attemptNumber: 1,
      cigaretteCount: 0,
      reminderWillBeDisabled: true,
    })
    const confirmation = formatNativeBackupRestoreConfirmation(summary!, {
      byteLength: 1190,
      sha256: '9352e8b0828ea1995b0ab026da651464ea14823c04d6b8210da068ea200536ae',
      displayName: 'wuyan-tongxing-backup-2026-08-29_08-00-00_Beijing.json',
      lastModifiedEpochMillis: Date.parse('2026-08-29T08:01:02+08:00'),
    })
    expect(confirmation).toContain('文件：wuyan-tongxing-backup-2026-08-29_08-00-00_Beijing.json')
    expect(confirmation).toContain('导出时间：2026-08-29 08:00:00')
    expect(confirmation).toContain('文件修改：2026/08/29 08:01:02')
    expect(confirmation).toContain('大小：1.2 KiB · 校验码：9352E8B0828E')
    expect(confirmation).toContain('\n\n直接戒断')
    expect(confirmation).toContain('\n\n大小：')
    expect(confirmation).toContain('每日提醒将保持关闭')
    expect(summarizeNativeBackupRestore('{"invalid":true}')).toBeUndefined()
  })

  it('shows an independent Beijing export time for legacy UTC backup filenames', () => {
    const summary = summarizeNativeBackupRestore(JSON.stringify(validState()))
    const confirmation = formatNativeBackupRestoreConfirmation(summary!, {
      byteLength: 3443,
      sha256: '2639c8acdc425d1ba0d5879f467be02df10a9241995665f6e0c38cb62dfb89f8',
      displayName: 'wuyan-tongxing-backup-2026-08-28T05-34-03-980Z.json',
      lastModifiedEpochMillis: Date.parse('2026-08-28T13:34:10+08:00'),
    })
    expect(confirmation).toContain('导出时间：2026-08-28 13:34:03（由旧版 UTC 文件名换算，北京时间）')
    expect(confirmation).toContain('文件修改：2026/08/28 13:34:10（系统元数据，北京时间）')

    const invalidCalendar = formatNativeBackupRestoreConfirmation(summary!, {
      byteLength: 1,
      sha256: '00',
      displayName: 'wuyan-tongxing-backup-2026-02-31T05-34-03-980Z.json',
    })
    expect(invalidCalendar).not.toContain('导出时间：')
  })

  it('严格校验成功后先以关闭提醒的状态执行本地原子导入', async () => {
    const deps = dependencies()
    const imported = validState({ reminder: true, hour: 21 })

    const outcome = await consumeRestoredOpenJson({
      success: true,
      data: { selected: true, json: JSON.stringify(imported) },
    }, deps)

    expect(outcome).toEqual({
      status: 'restored',
      reminderUnavailable: true,
      reminderScheduled: false,
      bootstrapRecoverySkipped: false,
    })
    expect(deps.scheduleReminder).not.toHaveBeenCalled()
    expect(deps.cancelReminder).not.toHaveBeenCalled()
    expect(deps.importData).toHaveBeenCalledTimes(1)
    expect(JSON.parse(deps.importData.mock.calls[0]![0] as string)).toMatchObject({
      onboarded: true,
      settings: { inAppReminder: false, reminderHour: 21 },
    })
  })

  it('preserves Android bootstrap recovery payload through the real reminder-adjusted restore path', async () => {
    const deps = dependencies()
    const imported = validState({ reminder: true, hour: 21 })
    const bootstrapRecovery = {
      'wuyan-tongxing/android-bootstrap-cigarettes/v1': JSON.stringify({ data: [] }),
      'wuyan-tongxing/android-bootstrap-cigarettes-corrupt/v1': JSON.stringify({ data: [] }),
    }

    const outcome = await consumeRestoredOpenJson({
      success: true,
      data: {
        selected: true,
        json: JSON.stringify({ ...imported, _androidBootstrapRecovery: bootstrapRecovery }),
      },
    }, deps)

    expect(outcome.status).toBe('restored')
    expect(JSON.parse(deps.importData.mock.calls[0]![0] as string)._androidBootstrapRecovery).toEqual(bootstrapRecovery)
  })

  it('preserves an explicitly empty bootstrap snapshot as an authoritative clear operation', async () => {
    const deps = dependencies()
    const imported = validState({ reminder: false, hour: 9 })

    const outcome = await consumeRestoredOpenJson({
      success: true,
      data: {
        selected: true,
        json: JSON.stringify({ ...imported, _androidBootstrapRecovery: {} }),
      },
    }, deps)

    expect(outcome.status).toBe('restored')
    expect(JSON.parse(deps.importData.mock.calls[0]![0] as string)._androidBootstrapRecovery).toEqual({})
  })

  it('drops a malformed auxiliary archive before any reminder side effect while preserving the main restore', async () => {
    const deps = dependencies()
    const imported = validState({ reminder: true, hour: 21 })
    const operation = consumeRestoredOpenJson({
      success: true,
      data: {
        selected: true,
        json: JSON.stringify({
          ...imported,
          _androidBootstrapRecovery: {
            'wuyan-tongxing/android-bootstrap-cigarettes-corrupt/v1': '',
          },
        }),
      },
    }, deps)

    await expect(operation).resolves.toMatchObject({ status: 'restored', bootstrapRecoverySkipped: true })
    const forwarded = JSON.parse(deps.importData.mock.calls[0]![0] as string)
    expect(forwarded._androidBootstrapRecovery).toEqual({})
    expect(forwarded._androidBootstrapRecoverySkipped).toBe(true)
    expect(deps.scheduleReminder).not.toHaveBeenCalled()
  })

  it('保留混合辅助区中的有效队列，只跳过损坏归档', async () => {
    const deps = dependencies()
    const imported = validState({ reminder: false, hour: 21 })
    const queueRaw = JSON.stringify({ data: [] })

    const outcome = await consumeRestoredOpenJson({
      success: true,
      data: {
        selected: true,
        json: JSON.stringify({
          ...imported,
          _androidBootstrapRecovery: {
            'wuyan-tongxing/android-bootstrap-cigarettes/v1': queueRaw,
            'wuyan-tongxing/android-bootstrap-cigarettes-corrupt/v1': '',
          },
        }),
      },
    }, deps)

    expect(outcome).toMatchObject({ status: 'restored', bootstrapRecoverySkipped: true })
    const forwarded = JSON.parse(deps.importData.mock.calls[0]![0] as string)
    expect(forwarded._androidBootstrapRecovery).toEqual({
      'wuyan-tongxing/android-bootstrap-cigarettes/v1': queueRaw,
    })
    expect(forwarded._androidBootstrapRecoverySkipped).toBe(true)
  })

  it('selected=false 明确视为取消且不触碰提醒或本地数据', async () => {
    const deps = dependencies()

    const outcome = await consumeRestoredOpenJson({
      success: true,
      data: { selected: false },
    }, deps)

    expect(outcome).toEqual({ status: 'cancelled' })
    expect(deps.isReminderScheduled).not.toHaveBeenCalled()
    expect(deps.scheduleReminder).not.toHaveBeenCalled()
    expect(deps.cancelReminder).not.toHaveBeenCalled()
    expect(deps.importData).not.toHaveBeenCalled()
  })

  it('拒绝空、畸形和不完整备份且不修改当前状态', async () => {
    for (const json of ['', '{bad json', JSON.stringify(createInitialState())]) {
      const deps = dependencies()
      const outcome = await consumeRestoredOpenJson({
        success: true,
        data: { selected: true, json },
      }, deps)

      expect(outcome).toEqual({ status: 'invalid' })
      expect(deps.scheduleReminder).not.toHaveBeenCalled()
      expect(deps.cancelReminder).not.toHaveBeenCalled()
      expect(deps.importData).not.toHaveBeenCalled()
    }

    const missingSelection = dependencies()
    expect(await consumeRestoredOpenJson({
      success: true,
      data: { json: JSON.stringify(validState()) },
    }, missingSelection)).toEqual({ status: 'invalid' })
    expect(missingSelection.importData).not.toHaveBeenCalled()
  })

  it('拒绝含重复事件身份的备份且不修改提醒或当前状态', async () => {
    const deps = dependencies()
    const imported = validState({ reminder: false, hour: 22 })
    const duplicate = {
      id: 'duplicate-cigarette',
      createdAt: '2026-08-28T13:00:00+08:00',
      count: 1,
      attemptId: imported.plan!.id,
      source: 'QUICK_LOG' as const,
    }

    const outcome = await consumeRestoredOpenJson({
      success: true,
      data: {
        selected: true,
        json: JSON.stringify({ ...imported, cigarettes: [duplicate, { ...duplicate }] }),
      },
    }, deps)

    expect(outcome).toEqual({ status: 'invalid' })
    expect(deps.isReminderScheduled).not.toHaveBeenCalled()
    expect(deps.scheduleReminder).not.toHaveBeenCalled()
    expect(deps.cancelReminder).not.toHaveBeenCalled()
    expect(deps.importData).not.toHaveBeenCalled()
  })

  it('本地保存失败时不触碰系统提醒并保持当前数据', async () => {
    const deps = dependencies(validState({ reminder: true, hour: 9 }))
    deps.importData.mockReturnValue(false)
    const imported = validState({ reminder: false, hour: 22 })

    const outcome = await consumeRestoredOpenJson({
      success: true,
      data: { selected: true, json: JSON.stringify(imported) },
    }, deps)

    expect(outcome).toEqual({ status: 'save-failed', reminderRollbackFailed: false })
    expect(deps.cancelReminder).not.toHaveBeenCalled()
    expect(deps.scheduleReminder).not.toHaveBeenCalled()
    expect(deps.importData).toHaveBeenCalledTimes(1)
  })

  it('does not reinterpret an unexpected import exception as terminal save-failed', async () => {
    const deps = dependencies()
    const unexpected = new Error('durable store unavailable')
    deps.importData.mockImplementation(() => { throw unexpected })
    await expect(consumeRestoredOpenJson({
      success: true,
      data: { selected: true, json: JSON.stringify(validState()) },
    }, deps)).rejects.toBe(unexpected)
  })

  it('系统提醒接口即使不可用也不参与导入事务', async () => {
    const deps = dependencies(validState({ reminder: false, hour: 7 }))
    deps.isReminderScheduled.mockRejectedValue(new Error('unavailable'))
    deps.cancelReminder.mockRejectedValue(new Error('unavailable'))
    deps.scheduleReminder.mockRejectedValue(new Error('unavailable'))
    const imported = validState({ reminder: true, hour: 22 })

    const outcome = await consumeRestoredOpenJson({
      success: true,
      data: { selected: true, json: JSON.stringify(imported) },
    }, deps)

    expect(outcome).toEqual({
      status: 'restored',
      reminderUnavailable: true,
      reminderScheduled: false,
      bootstrapRecoverySkipped: false,
    })
    expect(deps.isReminderScheduled).not.toHaveBeenCalled()
    expect(deps.cancelReminder).not.toHaveBeenCalled()
    expect(deps.scheduleReminder).not.toHaveBeenCalled()
    expect(deps.importData).toHaveBeenCalledTimes(1)
  })

  it('原生读取失败会明确失败且不触碰当前数据', async () => {
    const deps = dependencies()

    const outcome = await consumeRestoredOpenJson({ success: false }, deps)

    expect(outcome).toEqual({ status: 'read-failed' })
    expect(deps.importData).not.toHaveBeenCalled()
  })

  it('提交前已经被删除失效时不触碰提醒也不写回数据', async () => {
    const deps = dependencies()
    deps.isCurrent.mockReturnValue(false)
    const outcome = await consumeRestoredOpenJson({
      success: true,
      data: { selected: true, json: JSON.stringify(validState({ reminder: true, hour: 21 })) },
    }, deps)
    expect(outcome).toEqual({ status: 'stale', reminderRollbackFailed: false })
    expect(deps.isReminderScheduled).not.toHaveBeenCalled()
    expect(deps.scheduleReminder).not.toHaveBeenCalled()
    expect(deps.cancelReminder).not.toHaveBeenCalled()
    expect(deps.importData).not.toHaveBeenCalled()
  })

  it('导入事务不等待任何系统提醒副作用', async () => {
    const deps = dependencies(validState({ reminder: true, hour: 9 }))
    const outcome = await consumeRestoredOpenJson({
      success: true,
      data: { selected: true, json: JSON.stringify(validState({ reminder: true, hour: 21 })) },
    }, deps)
    expect(outcome).toEqual({
      status: 'restored',
      reminderUnavailable: true,
      reminderScheduled: false,
      bootstrapRecoverySkipped: false,
    })
    expect(deps.isReminderScheduled).not.toHaveBeenCalled()
    expect(deps.scheduleReminder).not.toHaveBeenCalled()
    expect(deps.cancelReminder).not.toHaveBeenCalled()
    expect(deps.importData).toHaveBeenCalledTimes(1)
  })
})

describe('restored openJson rejection containment', () => {
  it('absorbs synchronous and asynchronous operation/notifier failures', async () => {
    const syncNotify = vi.fn(() => { throw new Error('notify sync') })
    await expect(runRestoredOpenJsonProcessingSafely(
      () => { throw new Error('operation sync') },
      syncNotify,
    )).resolves.toBeUndefined()
    expect(syncNotify).toHaveBeenCalledOnce()

    const rejectedNotify = vi.fn(async () => { throw new Error('notify async') })
    await expect(runRestoredOpenJsonProcessingSafely(
      async () => { throw new Error('operation async') },
      rejectedNotify,
    )).resolves.toBeUndefined()
    expect(rejectedNotify).toHaveBeenCalledOnce()
  })
})

describe('native restore payload lifetime', () => {
  it('retains authenticated bytes for transient save/stale outcomes and only finalizes terminal outcomes', () => {
    expect(shouldRetainNativeRestorePayload({
      status: 'save-failed',
      reminderRollbackFailed: false,
    })).toBe(true)
    expect(shouldRetainNativeRestorePayload({
      status: 'stale',
      reminderRollbackFailed: false,
    })).toBe(true)
    expect(shouldRetainNativeRestorePayload({ status: 'invalid' })).toBe(false)
    expect(shouldRetainNativeRestorePayload({ status: 'read-failed' })).toBe(false)
    expect(shouldRetainNativeRestorePayload({ status: 'cancelled' })).toBe(false)
    expect(shouldRetainNativeRestorePayload({
      status: 'restored',
      reminderUnavailable: false,
      reminderScheduled: false,
      bootstrapRecoverySkipped: false,
    })).toBe(false)
  })
})
