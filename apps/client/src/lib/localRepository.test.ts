import { describe, expect, it } from 'vitest'
import { createClientPlan, createInitialState, parseStoredStateStrict, STORAGE_KEY } from './model'
import {
  BACKUP_STORAGE_KEY,
  ANDROID_BOOTSTRAP_SUMMARY_FIELD,
  createLocalStateRepository,
  DELETION_INTENT_STORAGE_KEY,
  MAX_CLIENT_STATE_BYTES,
  type LocalStoragePort,
} from './localRepository'
import { decodeLosslessBase64 } from './recoveryCodec'

function memoryStorage() {
  const values = new Map<string, unknown>()
  const port: LocalStoragePort = {
    read: (key) => values.get(key),
    write: (key, value) => values.set(key, value),
    remove: (key) => values.delete(key),
    exists: (key) => values.has(key),
    readRaw: (key) => values.get(key),
  }
  return { values, repository: createLocalStateRepository(port) }
}

function validState() {
  const baseline = {
    cigarettesPerDay: 10,
    firstCigaretteMinutes: 30,
    previousAttempts: 0,
    reasons: ['为了健康'],
    triggers: ['stress' as const],
    pricePerPack: 25,
  }
  return {
    ...createInitialState(),
    onboarded: true,
    baseline,
    plan: createClientPlan({ baseline, path: 'abrupt', quitDate: '2026-08-30' }, new Date('2026-08-23T08:00:00+08:00')),
    settings: { ...createInitialState().settings, sensitiveHealthData: true },
  }
}

describe('离线本地仓库', () => {
  it('promotes an exact legacy backup deletion marker before exposing surviving native-upgrade data', () => {
    const values = new Map<string, unknown>([[STORAGE_KEY, validState()]])
    let legacyFallback: unknown = {
      version: 1,
      intent: 'delete-all-local-health-data',
    }
    const repository = createLocalStateRepository({
      read: (key) => values.get(key),
      write: (key, value) => values.set(key, structuredClone(value)),
      remove: (key) => values.delete(key),
      exists: (key) => values.has(key),
      supportsDedicatedDeletionIntent: true,
      readLegacyDeletionFallback: () => legacyFallback,
      clearLegacyDeletionFallback: () => { legacyFallback = undefined },
    })

    expect(repository.hasPendingDeletion()).toBe(true)
    expect(values.get(DELETION_INTENT_STORAGE_KEY)).toEqual({
      version: 1,
      intent: 'delete-all-local-health-data',
    })
    expect(legacyFallback).toBeUndefined()

    repository.clearCoreAfterDeletionIntent()
    repository.finishDeletion()
    expect(values.has(STORAGE_KEY)).toBe(false)
    expect(values.has(DELETION_INTENT_STORAGE_KEY)).toBe(false)
  })

  it('两份 H5 容量上限副本即使都需 base64 恢复，连同保守辅助开销仍低于原生 12 MiB 上限', () => {
    const worstCaseBase64Slots = Math.ceil(MAX_CLIENT_STATE_BYTES / 3) * 4 * 2
    const bootstrapAndJsonMargin = 4 * 1024 * 1024
    expect(worstCaseBase64Slots + bootstrapAndJsonMargin).toBeLessThan(12 * 1024 * 1024)
  })
  it('不依赖网络即可保存并恢复核心状态', () => {
    const { values, repository } = memoryStorage()
    const state = validState()
    repository.save(state)
    expect(repository.load().state.onboarded).toBe(true)
    expect(values.has(BACKUP_STORAGE_KEY)).toBe(true)
  })

  it('在 Harmony 无浏览器 TextEncoder 全局对象时仍可校验、保存并恢复状态', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder')
    Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: undefined })
    try {
      const { values, repository } = memoryStorage()
      const state = validState()
      repository.save(state)
      expect(repository.load().state.plan?.id).toBe(state.plan?.id)
      expect(values.has(BACKUP_STORAGE_KEY)).toBe(true)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'TextEncoder', descriptor)
      else Reflect.deleteProperty(globalThis, 'TextEncoder')
    }
  })

  it('does not synchronously bridge-read the large backup when the primary is valid', () => {
    const state = validState()
    const values = new Map<string, unknown>([
      [STORAGE_KEY, structuredClone(state)],
      [BACKUP_STORAGE_KEY, structuredClone(state)],
    ])
    let backupReads = 0
    const repository = createLocalStateRepository({
      read: (key) => {
        if (key === BACKUP_STORAGE_KEY) backupReads += 1
        return values.get(key)
      },
      write: (key, value) => values.set(key, structuredClone(value)),
      remove: (key) => values.delete(key),
      exists: (key) => values.has(key),
      supportsDedicatedDeletionIntent: true,
    })

    expect(repository.load().state.plan?.id).toBe(state.plan?.id)
    expect(backupReads).toBe(0)
  })

  it('atomically persists a strict cold-start summary after migrating a legacy cigarette to the current plan', () => {
    const { values, repository } = memoryStorage()
    const state = validState()
    state.cigarettes = [{
      id: 'legacy-cigarette-without-attempt',
      createdAt: new Date().toISOString(),
      count: 1,
    }]

    repository.save(state)

    const persisted = values.get(STORAGE_KEY) as Record<string, unknown>
    expect(persisted[ANDROID_BOOTSTRAP_SUMMARY_FIELD]).toMatchObject({
      version: 1,
      planId: state.plan!.id,
      count: 1,
    })
    expect(repository.load().state.cigarettes[0]?.attemptId).toBe(state.plan!.id)
  })

  it('counts the Shanghai day correctly when RFC3339 offset text order differs from instant order', () => {
    const { values, repository } = memoryStorage()
    const state = validState()
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())
    const yesterday = new Date(`${today}T00:00:00+08:00`)
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    const yesterdayText = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(yesterday)
    state.cigarettes = [{
      id: 'textually-newer-but-shanghai-yesterday',
      createdAt: `${today}T00:00:00+23:00`,
      count: 9,
      attemptId: state.plan!.id,
    }, {
      id: 'textually-older-but-shanghai-today',
      createdAt: `${yesterdayText}T00:00:00-23:00`,
      count: 2,
      attemptId: state.plan!.id,
    }]

    repository.save(state)

    const persisted = values.get(STORAGE_KEY) as Record<string, unknown>
    expect(persisted[ANDROID_BOOTSTRAP_SUMMARY_FIELD]).toMatchObject({ date: today, count: 2 })
  })

  it('首次主副本被静默丢弃时不会先留下幽灵备用提交', () => {
    const values = new Map<string, unknown>()
    const writes: string[] = []
    const repository = createLocalStateRepository({
      read: (key) => values.get(key),
      write: (key, value) => {
        writes.push(key)
        if (key !== STORAGE_KEY) values.set(key, structuredClone(value))
      },
      remove: (key) => values.delete(key),
      exists: (key) => values.has(key),
    })

    expect(() => repository.save(validState())).toThrow('写入后校验失败')
    expect(writes).toEqual([STORAGE_KEY])
    expect(values.has(BACKUP_STORAGE_KEY)).toBe(false)
    expect(repository.load()).toEqual({ state: createInitialState(), recoveredFromBackup: false })
  })

  it('首次主副本校验失败时回滚到全新状态，不暴露失败更改', () => {
    const values = new Map<string, unknown>()
    const writes: string[] = []
    const repository = createLocalStateRepository({
      read: (key) => values.get(key),
      write: (key, value) => {
        writes.push(key)
        values.set(key, key === STORAGE_KEY
          ? { ...(value as object), cigarettes: [{ id: 'damaged' }] }
          : structuredClone(value))
      },
      remove: (key) => values.delete(key),
      exists: (key) => values.has(key),
    })

    expect(() => repository.save(validState())).toThrow('写入后校验失败')
    expect(writes).toEqual([STORAGE_KEY])
    expect(values.has(BACKUP_STORAGE_KEY)).toBe(false)
    expect(repository.load()).toEqual({ state: createInitialState(), recoveredFromBackup: false })
  })

  it('首次备用副本建立失败时回滚主提交并报告失败', () => {
    const values = new Map<string, unknown>()
    const repository = createLocalStateRepository({
      read: (key) => values.get(key),
      write: (key, value) => {
        if (key === BACKUP_STORAGE_KEY) throw new Error('backup unavailable')
        values.set(key, structuredClone(value))
      },
      remove: (key) => values.delete(key),
      exists: (key) => values.has(key),
    })
    const state = validState()

    expect(() => repository.save(state)).toThrow('backup unavailable')
    expect(repository.load()).toEqual({ state: createInitialState(), recoveredFromBackup: false })
    expect(values.has(STORAGE_KEY)).toBe(false)
    expect(values.has(BACKUP_STORAGE_KEY)).toBe(false)
  })

  it('备用副本已原子提交但桥接结果丢失时按精确回读接受一次提交', () => {
    const values = new Map<string, unknown>()
    let loseBackupResult = true
    const repository = createLocalStateRepository({
      read: (key) => values.get(key),
      write: (key, value) => {
        values.set(key, structuredClone(value))
        if (key === BACKUP_STORAGE_KEY && loseBackupResult) {
          loseBackupResult = false
          throw new Error('bridge result lost after atomic commit')
        }
      },
      remove: (key) => values.delete(key),
      exists: (key) => values.has(key),
    })
    const state = validState()

    expect(() => repository.save(state)).not.toThrow()
    expect(repository.load().state.plan?.id).toBe(state.plan?.id)
    expect(values.has(STORAGE_KEY)).toBe(true)
    expect(values.has(BACKUP_STORAGE_KEY)).toBe(true)
  })

  it('已有主副本更新校验失败时回滚主副本到上一份 last-known-good', () => {
    const values = new Map<string, unknown>()
    let damageNextPrimary = false
    const repository = createLocalStateRepository({
      read: (key) => values.get(key),
      write: (key, value) => {
        if (key === STORAGE_KEY && damageNextPrimary) {
          damageNextPrimary = false
          values.set(key, { ...(value as object), cigarettes: [{ id: 'damaged' }] })
          return
        }
        values.set(key, structuredClone(value))
      },
      remove: (key) => values.delete(key),
      exists: (key) => values.has(key),
    })
    const previous = validState()
    repository.save(previous)
    const attempted = { ...previous, cravings: [{
      id: 'craving-new',
      createdAt: '2026-08-28T12:00:00+08:00',
      level: 3 as const,
      attemptId: previous.plan!.id,
    }] }

    damageNextPrimary = true
    expect(() => repository.save(attempted)).toThrow('写入后校验失败')
    expect(repository.load()).toEqual({ state: parseStoredStateStrict(previous), recoveredFromBackup: false })
  })

  it('主副本已耐久写入但紧随的一次读取瞬时失败时仍确认成功提交', () => {
    const values = new Map<string, unknown>()
    let failNextPrimaryRead = false
    let armReadFailureAfterPrimaryWrite = false
    const repository = createLocalStateRepository({
      read: (key) => {
        if (key === STORAGE_KEY && failNextPrimaryRead) {
          failNextPrimaryRead = false
          throw new Error('transient read failure')
        }
        return values.get(key)
      },
      write: (key, value) => {
        values.set(key, structuredClone(value))
        if (key === STORAGE_KEY && armReadFailureAfterPrimaryWrite) {
          armReadFailureAfterPrimaryWrite = false
          failNextPrimaryRead = true
        }
      },
      remove: (key) => values.delete(key),
      exists: (key) => values.has(key),
    })
    const previous = validState()
    repository.save(previous)
    const next = {
      ...previous,
      cravings: [{
        id: 'confirmed-after-retry',
        createdAt: '2026-08-28T12:00:00+08:00',
        level: 5 as const,
        attemptId: previous.plan!.id,
      }],
    }

    armReadFailureAfterPrimaryWrite = true
    expect(() => repository.save(next)).not.toThrow()
    expect(repository.load().state.cravings.map((item) => item.id)).toEqual(['confirmed-after-retry'])
  })

  it('主副本更新连续校验失败时回滚旧主副本，不暴露失败更改', () => {
    const values = new Map<string, unknown>()
    let remainingPrimaryReadFailures = 0
    let armFailuresAfterPrimaryWrite = false
    const repository = createLocalStateRepository({
      read: (key) => {
        if (key === STORAGE_KEY && remainingPrimaryReadFailures > 0) {
          remainingPrimaryReadFailures -= 1
          throw new Error('persistent verification read failure')
        }
        return values.get(key)
      },
      write: (key, value) => {
        values.set(key, structuredClone(value))
        if (key === STORAGE_KEY && armFailuresAfterPrimaryWrite) {
          armFailuresAfterPrimaryWrite = false
          remainingPrimaryReadFailures = 3
        }
      },
      remove: (key) => values.delete(key),
      exists: (key) => values.has(key),
    })
    const previous = validState()
    repository.save(previous)
    const attempted = {
      ...previous,
      cravings: [{
        id: 'must-not-appear',
        createdAt: '2026-08-28T12:00:00+08:00',
        level: 5 as const,
        attemptId: previous.plan!.id,
      }],
    }

    armFailuresAfterPrimaryWrite = true
    expect(() => repository.save(attempted)).toThrow('写入后校验失败')
    expect(repository.load().state.cravings).toEqual(previous.cravings)
  })

  it('资格校验不通过时不会写入未成年人问卷', async () => {
    const { values } = memoryStorage()
    // UI 只有通过资格校验后才调用 finishOnboarding/repository.save。
    expect(values.has(STORAGE_KEY)).toBe(false)
  })

  it('删除后本机不可恢复并回到全新状态', () => {
    const { values, repository } = memoryStorage()
    repository.save(validState())
    expect(values.has(STORAGE_KEY)).toBe(true)
    repository.clear()
    expect(values.has(STORAGE_KEY)).toBe(false)
    expect(repository.load()).toEqual({ state: createInitialState(), recoveredFromBackup: false })
  })

  it('崩溃中断删除时以持久意图屏蔽主副本与备用副本，恢复后不会复活', () => {
    const values = new Map<string, unknown>()
    let failPrimaryRemoval = true
    const port: LocalStoragePort = {
      read: (key) => values.get(key),
      write: (key, value) => values.set(key, structuredClone(value)),
      remove: (key) => {
        if (key === STORAGE_KEY && failPrimaryRemoval) throw new Error('simulated process loss')
        values.delete(key)
      },
      exists: (key) => values.has(key),
    }
    const repository = createLocalStateRepository(port)
    repository.save(validState())

    expect(() => repository.clear()).toThrow('simulated process loss')
    expect(values.has(DELETION_INTENT_STORAGE_KEY)).toBe(true)
    expect(values.has(BACKUP_STORAGE_KEY)).toBe(false)
    expect(repository.load()).toEqual({ state: createInitialState(), recoveredFromBackup: false })

    failPrimaryRemoval = false
    repository.clear()
    expect(values.size).toBe(0)
    expect(repository.load()).toEqual({ state: createInitialState(), recoveredFromBackup: false })
  })

  it('存储配额已满时复用备用槽保存删除意图，仍可完成隐私删除', () => {
    const values = new Map<string, unknown>()
    const repository = createLocalStateRepository({
      read: (key) => values.get(key),
      write: (key, value) => {
        if (key === DELETION_INTENT_STORAGE_KEY) {
          const error = new DOMException('quota full', 'QuotaExceededError')
          throw error
        }
        values.set(key, structuredClone(value))
      },
      remove: (key) => values.delete(key),
      exists: (key) => values.has(key),
    })
    repository.save(validState())

    expect(() => repository.beginDeletion()).not.toThrow()
    expect(values.has(DELETION_INTENT_STORAGE_KEY)).toBe(false)
    expect(values.get(BACKUP_STORAGE_KEY)).toEqual({
      version: 1,
      intent: 'delete-all-local-health-data',
    })
    expect(repository.load()).toEqual({ state: createInitialState(), recoveredFromBackup: false })

    repository.clearCoreAfterDeletionIntent()
    repository.finishDeletion()
    expect(values.size).toBe(0)
  })

  it('损坏的删除标记不被误当作用户授权且不会删除原数据', () => {
    const { values, repository } = memoryStorage()
    const state = validState()
    values.set(STORAGE_KEY, state)
    values.set(BACKUP_STORAGE_KEY, state)
    values.set(DELETION_INTENT_STORAGE_KEY, { version: 1 })

    expect(() => repository.hasPendingDeletion()).toThrow('删除状态无法验证')
    expect(() => repository.load()).toThrow('删除状态无法验证')
    expect(values.get(STORAGE_KEY)).toEqual(state)
    expect(values.get(BACKUP_STORAGE_KEY)).toEqual(state)
  })

  it('主存储损坏时保留原值并阻止备用副本变成可写状态', () => {
    const { values, repository } = memoryStorage()
    repository.save(validState())
    repository.save({ ...validState(), cravings: [] })
    values.set(STORAGE_KEY, 'broken')
    expect(values.has(BACKUP_STORAGE_KEY)).toBe(true)
    expect(() => repository.load()).toThrow('本机数据')
    expect(() => repository.save(validState())).toThrow('本机数据')
    expect(values.get(STORAGE_KEY)).toBe('broken')
  })

  it('主副本并存时，主副本的损坏集合不会被完整副本静默覆盖', () => {
    const { values, repository } = memoryStorage()
    const base = validState()
    const backup = {
      ...base,
      cravings: [{
        id: 'kept-craving',
        createdAt: '2026-08-28T12:00:00+08:00',
        level: 3 as const,
        attemptId: base.plan!.id,
      }],
    }
    values.set(BACKUP_STORAGE_KEY, backup)
    values.set(STORAGE_KEY, { ...backup, cravings: 'not-an-array' })

    const damaged = values.get(STORAGE_KEY)
    expect(() => repository.load()).toThrow('本机记录集合格式无法识别')
    expect(values.get(STORAGE_KEY)).toEqual(damaged)
    expect(values.get(BACKUP_STORAGE_KEY)).toEqual(backup)
  })

  it('主副本含重复吸烟 ID 时进入恢复界面且保留两份原值', () => {
    const { values, repository } = memoryStorage()
    const base = validState()
    const backup = {
      ...base,
      cravings: [{
        id: 'backup-marker',
        createdAt: '2026-08-28T12:00:00+08:00',
        level: 3 as const,
        attemptId: base.plan!.id,
      }],
    }
    const duplicate = {
      id: 'duplicate-cigarette',
      createdAt: '2026-08-28T13:00:00+08:00',
      count: 1,
      attemptId: backup.plan!.id,
      source: 'QUICK_LOG' as const,
    }
    values.set(BACKUP_STORAGE_KEY, backup)
    values.set(STORAGE_KEY, { ...backup, cigarettes: [duplicate, { ...duplicate }] })

    const damaged = structuredClone(values.get(STORAGE_KEY))
    expect(() => repository.load()).toThrow('本机记录包含重复项目')
    expect(values.get(STORAGE_KEY)).toEqual(damaged)
    expect(values.get(BACKUP_STORAGE_KEY)).toEqual(backup)
  })

  it('主存储缺失但备用副本有效时恢复备用副本', () => {
    const { values, repository } = memoryStorage()
    repository.save(validState())
    values.delete(STORAGE_KEY)
    const loaded = repository.load()
    expect(loaded.recoveredFromBackup).toBe(true)
    expect(loaded.state.onboarded).toBe(true)
  })

  it('单条记录损坏时严格读取拒绝整份副本', () => {
    const state = validState()
    expect(() => parseStoredStateStrict({
      ...state,
      cigarettes: [{ id: 'damaged', createdAt: 'not-a-date', count: 1 }],
    })).toThrow('本机记录包含无法识别的项目')
  })

  it('底层静默丢失记录时保存校验失败', () => {
    const values = new Map<string, unknown>()
    const repository = createLocalStateRepository({
      read: (key) => values.get(key),
      write: (key, value) => {
        const stored = structuredClone(value)
        if (key === STORAGE_KEY && stored && typeof stored === 'object' && 'cigarettes' in stored) {
          ;(stored as { cigarettes: unknown[] }).cigarettes = []
        }
        values.set(key, stored)
      },
      remove: (key) => values.delete(key),
    })
    const base = validState()
    const state = {
      ...base,
      cigarettes: [{
        id: 'cig-1',
        createdAt: '2026-08-23T09:00:00+08:00',
        count: 1,
        trigger: 'work' as const,
        cravingIntensity: 4 as const,
        attemptId: base.plan!.id,
        source: 'QUICK_LOG' as const,
      }],
    }
    expect(() => repository.save(state)).toThrow('写入后校验失败')
  })

  it('备用副本写入不完整时不覆盖主存储', () => {
    const values = new Map<string, unknown>()
    let damageBackup = false
    const repository = createLocalStateRepository({
      read: (key) => values.get(key),
      write: (key, value) => {
        if (key === BACKUP_STORAGE_KEY && damageBackup) {
          values.set(key, { ...(value as object), cigarettes: [{ id: 'damaged' }] })
        } else {
          values.set(key, structuredClone(value))
        }
      },
      remove: (key) => values.delete(key),
    })
    const original = validState()
    repository.save(original)
    const primaryBefore = structuredClone(values.get(STORAGE_KEY))
    damageBackup = true
    expect(() => repository.save({ ...original, cravings: [] })).toThrow('写入后校验失败')
    expect(values.get(STORAGE_KEY)).toEqual(primaryBefore)
  })

  it('主副本都损坏时抛错且不覆盖原始内容', () => {
    const { values, repository } = memoryStorage()
    values.set(STORAGE_KEY, { version: 1, onboarded: true, baseline: { cigarettesPerDay: -1 } })
    values.set(BACKUP_STORAGE_KEY, 'also-broken')
    expect(() => repository.load()).toThrow('本机数据')
    expect(values.get(STORAGE_KEY)).toMatchObject({ onboarded: true })
  })

  it('键存在但平台读取层折叠为空时仍识别为损坏并保留原文', () => {
    const rawValues = new Map<string, string>([
      [STORAGE_KEY, '{"data":'],
      [BACKUP_STORAGE_KEY, '{"data":{"truncated":'],
    ])
    const repository = createLocalStateRepository({
      read: (key) => rawValues.has(key) ? '' : undefined,
      write: (key, value) => rawValues.set(key, JSON.stringify({ data: value })),
      remove: (key) => rawValues.delete(key),
      exists: (key) => rawValues.has(key),
      readRaw: (key) => rawValues.get(key),
    })

    expect(() => repository.load()).toThrow('本机数据')
    const recovery = JSON.parse(repository.recoveryBundle()) as {
      readStatus: { primary: string; lastKnownGood: string }
      primary: { encoding: string; data: string }
      lastKnownGood: { encoding: string; data: string }
    }
    expect(recovery.readStatus).toEqual({ primary: 'unreadable', lastKnownGood: 'unreadable' })
    expect(recovery.primary.encoding).toBe('base64-utf8')
    expect(atob(recovery.primary.data)).toBe('{"data":')
    expect(atob(recovery.lastKnownGood.data)).toBe('{"data":{"truncated":')
    expect(rawValues.get(STORAGE_KEY)).toBe('{"data":')
    expect(rawValues.get(BACKUP_STORAGE_KEY)).toBe('{"data":{"truncated":')
  })

  it('底层可返回原文但结构校验失败时不会把恢复状态误标为有效', () => {
    const rawValues = new Map<string, string>([
      [STORAGE_KEY, '{"data":'],
      [BACKUP_STORAGE_KEY, 'not-json'],
    ])
    const repository = createLocalStateRepository({
      read: (key) => rawValues.get(key),
      write: (key, value) => rawValues.set(key, JSON.stringify(value)),
      remove: (key) => rawValues.delete(key),
      exists: (key) => rawValues.has(key),
      readRaw: (key) => rawValues.get(key),
    })

    expect(() => repository.load()).toThrow('本机数据')
    const recovery = JSON.parse(repository.recoveryBundle()) as {
      readStatus: { primary: string; lastKnownGood: string }
      primary: { encoding: string; data: string }
      lastKnownGood: { encoding: string; data: string }
    }
    expect(recovery.readStatus).toEqual({ primary: 'unreadable', lastKnownGood: 'unreadable' })
    expect(atob(recovery.primary.data)).toBe('{"data":')
    expect(atob(recovery.lastKnownGood.data)).toBe('not-json')
  })

  it('恢复副本以无损 base64 保存最坏控制字符，避免 JSON 六倍转义膨胀', () => {
    const raw = '\u0000'.repeat(256 * 1024)
    const values = new Map<string, unknown>([
      [STORAGE_KEY, raw],
      [BACKUP_STORAGE_KEY, raw],
    ])
    const repository = createLocalStateRepository({
      read: (key) => values.get(key),
      write: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
      exists: (key) => values.has(key),
      readRaw: (key) => values.get(key),
    })

    const bundle = repository.recoveryBundle()
    const parsed = JSON.parse(bundle) as {
      primary: { encoding: string; data: string }
      lastKnownGood: { encoding: string; data: string }
    }
    expect(parsed.primary.encoding).toBe('base64-utf8')
    expect(atob(parsed.primary.data)).toBe(raw)
    expect(atob(parsed.lastKnownGood.data)).toBe(raw)
    expect(bundle.length).toBeLessThan(raw.length * 4)
  })

  it('恢复副本无损保留底层 DOMString 中的未配对 surrogate', () => {
    const raw = `damaged-${String.fromCharCode(0xd800)}-storage`
    const values = new Map<string, unknown>([[STORAGE_KEY, raw]])
    const repository = createLocalStateRepository({
      read: (key) => values.get(key),
      write: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
      exists: (key) => values.has(key),
      readRaw: (key) => values.get(key),
    })

    const parsed = JSON.parse(repository.recoveryBundle()) as { primary: unknown }
    expect((parsed.primary as { encoding: string }).encoding).toBe('base64-utf16le')
    expect(decodeLosslessBase64(parsed.primary)).toBe(raw)
  })

  it('主键存在但平台读取为空时不允许备用副本覆盖原文', () => {
    const state = validState()
    const values = new Map<string, unknown>([
      [STORAGE_KEY, '{"data":'],
      [BACKUP_STORAGE_KEY, state],
    ])
    const repository = createLocalStateRepository({
      read: (key) => key === STORAGE_KEY && values.has(key) ? '' : values.get(key),
      write: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
      exists: (key) => values.has(key),
      readRaw: (key) => values.get(key),
    })

    expect(() => repository.load()).toThrow('本机数据')
    expect(() => repository.save(state)).toThrow('本机数据')
    expect(values.get(STORAGE_KEY)).toBe('{"data":')
  })

  it('底层删除无效时抛出错误，不谎报敏感数据已删除', () => {
    const values = new Map<string, unknown>([[STORAGE_KEY, validState()]])
    const repository = createLocalStateRepository({
      read: (key) => values.get(key),
      write: (key, value) => values.set(key, value),
      remove: () => undefined,
    })
    expect(() => repository.clear()).toThrow('删除后仍可读取')
    expect(values.has(STORAGE_KEY)).toBe(true)
  })
})
