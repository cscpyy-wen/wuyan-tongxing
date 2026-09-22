import { describe, expect, it } from 'vitest'
import {
  acknowledgeAndroidBootstrapQueue,
  acknowledgeAndroidSystemShortcutQueue,
  applyAndroidBootstrapImportJournal,
  beginAndroidBackupRestoreIntent,
  ANDROID_BOOTSTRAP_CORRUPT_KEY,
  ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY,
  ANDROID_BACKUP_RESTORE_INTENT_KEY,
  ANDROID_BOOTSTRAP_QUARANTINE_KEY,
  ANDROID_BOOTSTRAP_QUEUE_KEY,
  ANDROID_SYSTEM_SHORTCUT_QUEUE_KEY,
  clearAndroidBootstrapData,
  clearAndroidBootstrapImportJournal,
  clearAndroidBackupRestoreIntent,
  exportAndroidBootstrapRecoveryData,
  isolateAndroidBootstrapQuarantineCorruption,
  isolateAndroidBootstrapQueueCorruption,
  isolateAndroidSystemShortcutQueueCorruption,
  markAndroidBackupRestoreResultAccepted,
  markAndroidBackupRestoreResultCommitted,
  markAndroidBackupRestoreSelection,
  moveAndroidBootstrapEventsToQuarantine,
  readAndroidBootstrapQuarantine,
  readAndroidBootstrapQueue,
  readAndroidSystemShortcutQueue,
  readAndroidBootstrapImportJournal,
  readAndroidBackupRestoreIntentState,
  replaceAndroidBootstrapData,
  rotateAndroidBootstrapCorruptArchiveAfterExport,
  sanitizeAndroidBootstrapRecoveryData,
  hasAndroidBootstrapRecoveryToRotate,
  snapshotAndroidBootstrapData,
  stageAndroidBootstrapImportJournal,
  type AndroidBootstrapStorage,
  AndroidBootstrapImportRollbackError,
} from './androidBootstrapQueue'
import { encodeLosslessBase64 } from './recoveryCodec'

function memoryStorage(initial?: string): AndroidBootstrapStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(ANDROID_BOOTSTRAP_QUEUE_KEY, initial)
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

const first = {
  id: '11111111-1111-4111-8111-111111111111',
  smokedAt: '2026-08-28T10:00:00.000Z',
  attemptId: 'plan-current',
  trigger: 'work' as const,
  cravingIntensity: 4 as const,
}
const second = {
  id: '22222222-2222-4222-8222-222222222222',
  smokedAt: '2026-08-28T11:00:00.000Z',
  attemptId: 'plan-current',
  trigger: 'meal' as const,
  cravingIntensity: 2 as const,
}
const legacy = {
  id: '66666666-6666-4666-8666-666666666666',
  smokedAt: '2026-08-28T12:00:00.000Z',
  trigger: 'coffee' as const,
  cravingIntensity: 3 as const,
}
const systemShortcut = {
  id: '77777777-7777-4777-8777-777777777777',
  smokedAt: '2026-08-28T12:30:00.000Z',
  attemptId: 'plan-current',
  entryPoint: 'APP_WIDGET' as const,
}

describe('Android bootstrap cigarette queue', () => {
  it('reads the same Taro localStorage wrapper written by the static runtime', () => {
    const storage = memoryStorage(JSON.stringify({ data: [first, second] }))
    expect(readAndroidBootstrapQueue(storage)).toEqual([first, second])
  })

  it('accepts a reasonless native system shortcut and acknowledges only its UUID', () => {
    const storage = memoryStorage()
    storage.setItem(ANDROID_SYSTEM_SHORTCUT_QUEUE_KEY, JSON.stringify({ data: [systemShortcut, {
      ...systemShortcut,
      id: '88888888-8888-4888-8888-888888888888',
      entryPoint: 'QUICK_SETTINGS_TILE',
    }] }))

    expect(readAndroidSystemShortcutQueue(storage)).toHaveLength(2)
    acknowledgeAndroidSystemShortcutQueue(storage, new Set([systemShortcut.id]))
    expect(readAndroidSystemShortcutQueue(storage)).toEqual([expect.objectContaining({
      id: '88888888-8888-4888-8888-888888888888',
      entryPoint: 'QUICK_SETTINGS_TILE',
    })])
  })

  it('isolates a system shortcut that smuggles reason or intensity fields', () => {
    const poisoned = { ...systemShortcut, trigger: 'work', cravingIntensity: 4 }
    const raw = JSON.stringify({ data: [poisoned] })
    const storage = memoryStorage()
    storage.setItem(ANDROID_SYSTEM_SHORTCUT_QUEUE_KEY, raw)

    expect(readAndroidSystemShortcutQueue(storage)).toEqual([])
    expect(isolateAndroidSystemShortcutQueueCorruption(storage)).toBe(true)
    expect(storage.getItem(ANDROID_SYSTEM_SHORTCUT_QUEUE_KEY)).toBeNull()
    expect(JSON.parse(storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)!).data[0]).toMatchObject({
      sourceKey: ANDROID_SYSTEM_SHORTCUT_QUEUE_KEY,
      raw,
    })
  })

  it('keeps detailed bootstrap and reasonless system queue schemas source-bound', () => {
    const detailedInSystem = JSON.stringify({ data: [first] })
    const systemStorage = memoryStorage()
    systemStorage.setItem(ANDROID_SYSTEM_SHORTCUT_QUEUE_KEY, detailedInSystem)
    expect(readAndroidSystemShortcutQueue(systemStorage)).toEqual([])
    expect(isolateAndroidSystemShortcutQueueCorruption(systemStorage)).toBe(true)

    const shortcutInBootstrap = JSON.stringify({ data: [systemShortcut] })
    const bootstrapStorage = memoryStorage(shortcutInBootstrap)
    expect(readAndroidBootstrapQueue(bootstrapStorage)).toEqual([])
    expect(isolateAndroidBootstrapQueueCorruption(bootstrapStorage)).toBe(true)
  })

  it('archives the original raw queue before removing a damaged item', () => {
    const raw = JSON.stringify({ data: [first, { ...second, cravingIntensity: 9 }] })
    const storage = memoryStorage(raw)
    expect(readAndroidBootstrapQueue(storage)).toEqual([first])
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(raw)
    expect(isolateAndroidBootstrapQueueCorruption(storage)).toBe(true)
    expect(JSON.parse(storage.values.get(ANDROID_BOOTSTRAP_QUEUE_KEY)!).data).toEqual([first])
    const archive = JSON.parse(storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)!)
    expect(archive.data).toEqual([expect.objectContaining({
      sourceKey: ANDROID_BOOTSTRAP_QUEUE_KEY,
      raw,
    })])
  })

  it('archives unknown event fields and rewrites only the bounded canonical projection', () => {
    const extended = { ...first, ignoredPayload: 'x'.repeat(32_000) }
    const raw = JSON.stringify({ data: [extended] })
    const storage = memoryStorage(raw)

    expect(readAndroidBootstrapQueue(storage)).toEqual([first])
    expect(isolateAndroidBootstrapQueueCorruption(storage)).toBe(true)
    expect(JSON.parse(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)!).data).toEqual([first])
    expect(JSON.parse(storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)!).data[0].raw).toBe(raw)
  })

  it('rejects parseable but non-RFC3339 or impossible timestamps before they can poison state saves', () => {
    const poisoned = { ...first, smokedAt: '2026-02-30T10:00:00Z' }
    const raw = JSON.stringify({ data: [poisoned, second] })
    const storage = memoryStorage(raw)

    expect(readAndroidBootstrapQueue(storage)).toEqual([second])
    expect(isolateAndroidBootstrapQueueCorruption(storage)).toBe(true)
    expect(readAndroidBootstrapQueue(storage)).toEqual([second])
    expect(JSON.parse(storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)!).data[0].raw).toBe(raw)
  })

  it('archives empty-string active and quarantine values instead of treating them as missing', () => {
    const storage = memoryStorage('')
    expect(isolateAndroidBootstrapQueueCorruption(storage)).toBe(true)
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull()

    storage.setItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY, '')
    expect(() => isolateAndroidBootstrapQuarantineCorruption(storage)).toThrow('恢复区已满')
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY)).toBe('')
    expect(JSON.parse(storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)!).data).toHaveLength(1)
  })

  it('acknowledges only committed ids so a concurrently queued event is retained', () => {
    const storage = memoryStorage(JSON.stringify({ data: [first, second] }))
    acknowledgeAndroidBootstrapQueue(storage, new Set([first.id]))
    expect(readAndroidBootstrapQueue(storage)).toEqual([second])
    acknowledgeAndroidBootstrapQueue(storage, new Set([second.id]))
    expect(storage.values.has(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(false)
  })

  it('moves unmatched events to a separate bounded quarantine before acknowledging the active queue', () => {
    const storage = memoryStorage(JSON.stringify({ data: [first, second] }))
    moveAndroidBootstrapEventsToQuarantine(storage, [first, second])
    expect(readAndroidBootstrapQueue(storage)).toEqual([])
    expect(readAndroidBootstrapQuarantine(storage)).toEqual([first, second])

    storage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, JSON.stringify({ data: [first] }))
    moveAndroidBootstrapEventsToQuarantine(storage, [first])
    expect(readAndroidBootstrapQueue(storage)).toEqual([])
    expect(readAndroidBootstrapQuarantine(storage)).toEqual([first, second])
  })

  it('migrates a legacy v1 event without attemptId into quarantine for explicit assignment', () => {
    const legacyRaw = JSON.stringify({ data: [legacy] })
    const storage = memoryStorage(legacyRaw)
    const migrated = readAndroidBootstrapQueue(storage)
    expect(migrated).toEqual([legacy])
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(legacyRaw)

    moveAndroidBootstrapEventsToQuarantine(storage, migrated)
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull()
    expect(readAndroidBootstrapQuarantine(storage)).toEqual(migrated)
  })

  it('keeps the untouched legacy queue when quarantine storage fails', () => {
    const legacyRaw = JSON.stringify({ data: [legacy] })
    const storage = memoryStorage(legacyRaw)
    const migrated = readAndroidBootstrapQueue(storage)
    const normalSet = storage.setItem
    storage.setItem = (key, value) => {
      if (key === ANDROID_BOOTSTRAP_QUARANTINE_KEY) throw new Error('quota')
      normalSet(key, value)
    }

    expect(() => moveAndroidBootstrapEventsToQuarantine(storage, migrated)).toThrow('quota')
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(legacyRaw)
  })

  it('keeps a full corruption archive byte-for-byte when the same raw value is isolated again', () => {
    const duplicateRaw = '{broken-0'
    const snapshots = Array.from({ length: 1 }, (_, index) => ({
      capturedAt: `2026-08-28T12:0${index}:00.000Z`,
      sourceKey: ANDROID_BOOTSTRAP_QUEUE_KEY,
      raw: `{broken-${index}`,
    }))
    const archiveRaw = JSON.stringify({ data: snapshots })
    const storage = memoryStorage(duplicateRaw)
    storage.setItem(ANDROID_BOOTSTRAP_CORRUPT_KEY, archiveRaw)

    expect(isolateAndroidBootstrapQueueCorruption(storage)).toBe(true)
    expect(storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)).toBe(archiveRaw)
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull()
  })

  it('fails closed when a full corruption archive receives a new raw value', () => {
    const newRaw = '{brand-new-broken'
    const archiveRaw = JSON.stringify({
      data: Array.from({ length: 1 }, (_, index) => ({
        capturedAt: `2026-08-28T12:1${index}:00.000Z`,
        sourceKey: ANDROID_BOOTSTRAP_QUEUE_KEY,
        raw: `{older-broken-${index}`,
      })),
    })
    const storage = memoryStorage(newRaw)
    storage.setItem(ANDROID_BOOTSTRAP_CORRUPT_KEY, archiveRaw)

    expect(() => isolateAndroidBootstrapQueueCorruption(storage)).toThrow('恢复区已满')
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(newRaw)
    expect(storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)).toBe(archiveRaw)
  })

  it('does not overwrite a malformed corruption archive or the source queue', () => {
    const sourceRaw = '{another-broken'
    const archiveRaw = JSON.stringify({ data: [{ capturedAt: 'not-a-date', sourceKey: 'wrong', raw: 'x' }] })
    const storage = memoryStorage(sourceRaw)
    storage.setItem(ANDROID_BOOTSTRAP_CORRUPT_KEY, archiveRaw)

    expect(() => isolateAndroidBootstrapQueueCorruption(storage)).toThrow('恢复区无法读取')
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(sourceRaw)
    expect(storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)).toBe(archiveRaw)
  })

  it('rejects an oversized corruption archive before JSON parsing and preserves both sources', () => {
    const sourceRaw = '{current-broken'
    const archiveRaw = 'x'.repeat(2 * 1024 * 1024)
    const storage = memoryStorage(sourceRaw)
    storage.setItem(ANDROID_BOOTSTRAP_CORRUPT_KEY, archiveRaw)
    const originalParse = JSON.parse
    let parsedArchive = false
    JSON.parse = ((value: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      if (value === archiveRaw) parsedArchive = true
      return originalParse(value, reviver)
    }) as typeof JSON.parse
    try {
      expect(() => isolateAndroidBootstrapQueueCorruption(storage)).toThrow('超过安全读取上限')
      expect(parsedArchive).toBe(false)
      expect(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(sourceRaw)
      expect(storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)).toBe(archiveRaw)
    } finally {
      JSON.parse = originalParse
    }
  })

  it('treats an empty corruption archive as malformed instead of overwriting it', () => {
    const sourceRaw = '{broken-with-empty-archive'
    const storage = memoryStorage(sourceRaw)
    storage.setItem(ANDROID_BOOTSTRAP_CORRUPT_KEY, '')

    expect(() => isolateAndroidBootstrapQueueCorruption(storage)).toThrow('恢复区无法读取')
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(sourceRaw)
    expect(storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)).toBe('')
    expect(() => replaceAndroidBootstrapData(storage, {
      [ANDROID_BOOTSTRAP_CORRUPT_KEY]: '',
    })).toThrow('恢复区格式无效')
  })

  it('round-trips a maximally escaped corruption snapshot without truncating a byte', () => {
    const raw = '"'.repeat(65_536)
    const storage = memoryStorage(raw)

    expect(isolateAndroidBootstrapQueueCorruption(storage)).toBe(true)
    const exported = snapshotAndroidBootstrapData(storage)
    const archiveRaw = exported[ANDROID_BOOTSTRAP_CORRUPT_KEY]!
    expect(JSON.parse(archiveRaw).data[0].raw).toBe(raw)

    clearAndroidBootstrapData(storage)
    replaceAndroidBootstrapData(storage, exported)
    expect(storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)).toBe(archiveRaw)
  })

  it('round-trips the worst-case control-character archive produced by the app', () => {
    const raw = '\u0000'.repeat(65_536)
    const storage = memoryStorage(raw)

    expect(isolateAndroidBootstrapQueueCorruption(storage)).toBe(true)
    const exported = snapshotAndroidBootstrapData(storage)
    expect(JSON.parse(exported[ANDROID_BOOTSTRAP_CORRUPT_KEY]!).data[0].raw).toBe(raw)

    clearAndroidBootstrapData(storage)
    expect(() => replaceAndroidBootstrapData(storage, exported)).not.toThrow()
    expect(snapshotAndroidBootstrapData(storage)).toEqual(exported)
  })

  it('keeps an oversized corrupt quarantine until export then releases it explicitly', () => {
    const oversized = 'x'.repeat(65_537)
    const storage = memoryStorage()
    storage.setItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY, oversized)

    expect(() => isolateAndroidBootstrapQuarantineCorruption(storage)).toThrow('异常数据过大')
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY)).toBe(oversized)
    const exported = snapshotAndroidBootstrapData(storage)

    rotateAndroidBootstrapCorruptArchiveAfterExport(storage)
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY)).toBeNull()
    expect(() => replaceAndroidBootstrapData(storage, exported)).toThrow('超过安全边界')
  })

  it('exports control-character corruption with bounded lossless base64 framing', () => {
    const raw = '\u0000'.repeat(2 * 1024 * 1024)
    const storage = memoryStorage(raw)

    const exported = exportAndroidBootstrapRecoveryData(storage)
    const serialized = JSON.stringify(exported)

    expect(serialized.length).toBeLessThan(raw.length * 3)
    expect(exported.values[ANDROID_BOOTSTRAP_QUEUE_KEY]).toMatchObject({
      encoding: 'base64-utf8',
    })
    expect(() => replaceAndroidBootstrapData(storage, exported)).toThrow(/(?:超过安全边界|恢复编码无效)/u)
  })

  it('round-trips lone UTF-16 surrogates in external corruption evidence without replacement', () => {
    const raw = `before-${String.fromCharCode(0xd800)}-after`
    const storage = memoryStorage(raw)
    const exported = exportAndroidBootstrapRecoveryData(storage)
    expect(exported.values[ANDROID_BOOTSTRAP_QUEUE_KEY]?.encoding).toBe('base64-utf16le')
    const sanitized = sanitizeAndroidBootstrapRecoveryData(exported)

    expect(sanitized.skippedInvalidData).toBe(false)
    expect(sanitized.snapshot[ANDROID_BOOTSTRAP_QUEUE_KEY]).toBe(raw)
  })

  it('tolerant restore keeps valid encoded siblings when envelope metadata is damaged', () => {
    const storage = memoryStorage(JSON.stringify({ data: [first] }))
    const exported = exportAndroidBootstrapRecoveryData(storage) as unknown as Record<string, unknown>
    exported.unrecognisedMetadata = true

    const sanitized = sanitizeAndroidBootstrapRecoveryData(exported)

    expect(sanitized.skippedInvalidData).toBe(true)
    expect(sanitized.snapshot[ANDROID_BOOTSTRAP_QUEUE_KEY]).toBe(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY))
    expect(() => replaceAndroidBootstrapData(storage, exported)).toThrow('编码无效')
  })

  it('skips an oversized encoded sibling before decoding while retaining another valid key', () => {
    const quarantineRaw = JSON.stringify({ data: [second] })
    const exported = {
      version: 2,
      encoding: 'lossless-base64-map',
      values: {
        [ANDROID_BOOTSTRAP_QUEUE_KEY]: {
          encoding: 'base64-utf8',
          data: 'A'.repeat(4 * 65_536 + 4),
        },
        [ANDROID_BOOTSTRAP_QUARANTINE_KEY]: encodeLosslessBase64(quarantineRaw),
      },
    }

    const sanitized = sanitizeAndroidBootstrapRecoveryData(exported)

    expect(sanitized.skippedInvalidData).toBe(true)
    expect(sanitized.snapshot[ANDROID_BOOTSTRAP_QUEUE_KEY]).toBeUndefined()
    expect(sanitized.snapshot[ANDROID_BOOTSTRAP_QUARANTINE_KEY]).toBe(quarantineRaw)
  })

  it('rejects a multi-megabyte queue before JSON parsing on the startup path', () => {
    const oversized = JSON.stringify({ data: [{ payload: 'x'.repeat(2 * 1024 * 1024) }] })
    const storage = memoryStorage(oversized)
    const originalParse = JSON.parse
    let parsedOversizedSource = false
    JSON.parse = ((value: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      if (value === oversized) parsedOversizedSource = true
      return originalParse(value, reviver)
    }) as typeof JSON.parse
    try {
      expect(readAndroidBootstrapQueue(storage)).toEqual([])
      expect(parsedOversizedSource).toBe(false)
    } finally {
      JSON.parse = originalParse
    }
  })

  it('round-trips all bootstrap recovery keys through a validated replacement', () => {
    const storage = memoryStorage(JSON.stringify({ data: [first] }))
    storage.setItem(ANDROID_SYSTEM_SHORTCUT_QUEUE_KEY, JSON.stringify({ data: [systemShortcut] }))
    storage.setItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY, JSON.stringify({ data: [second] }))
    const archiveRaw = JSON.stringify({ data: [{
      capturedAt: '2026-08-28T12:30:00.000Z',
      sourceKey: ANDROID_BOOTSTRAP_QUEUE_KEY,
      raw: '{broken',
    }] })
    storage.setItem(ANDROID_BOOTSTRAP_CORRUPT_KEY, archiveRaw)
    const exported = snapshotAndroidBootstrapData(storage)

    clearAndroidBootstrapData(storage)
    expect(storage.values.size).toBe(0)
    replaceAndroidBootstrapData(storage, exported)
    expect(snapshotAndroidBootstrapData(storage)).toEqual(exported)
    expect(readAndroidSystemShortcutQueue(storage)).toEqual([systemShortcut])
  })

  it('applies a partial import per key without validating or changing an untouched damaged archive', () => {
    const damagedArchive = '{unreadable-archive'
    const restoredQueue = JSON.stringify({ data: [first] })
    const storage = memoryStorage(JSON.stringify({ data: [second] }))
    storage.setItem(ANDROID_BOOTSTRAP_CORRUPT_KEY, damagedArchive)
    const journal = stageAndroidBootstrapImportJournal(
      storage,
      '11111111-1111-4111-8111-111111111111',
      'overlay',
      { [ANDROID_BOOTSTRAP_QUEUE_KEY]: restoredQueue },
    )

    applyAndroidBootstrapImportJournal(storage, journal)

    expect(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(restoredQueue)
    expect(storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)).toBe(damagedArchive)
    expect(readAndroidBootstrapImportJournal(storage)).toEqual(journal)
    clearAndroidBootstrapImportJournal(storage)
    expect(storage.getItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY)).toBeNull()
  })

  it('treats a complete empty import snapshot as authoritative and clears every bootstrap key', () => {
    const storage = memoryStorage(JSON.stringify({ data: [first] }))
    storage.setItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY, JSON.stringify({ data: [second] }))
    const journal = stageAndroidBootstrapImportJournal(
      storage,
      '22222222-2222-4222-8222-222222222222',
      'replace',
      {},
    )

    applyAndroidBootstrapImportJournal(storage, journal)

    expect(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull()
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY)).toBeNull()
  })

  it('distinguishes an unverified rollback failure so callers keep the durable transaction', () => {
    const originalQueue = JSON.stringify({ data: [second] })
    const restoredQueue = JSON.stringify({ data: [first] })
    const storage = memoryStorage(originalQueue)
    const journal = stageAndroidBootstrapImportJournal(
      storage,
      '33333333-3333-4333-8333-333333333333',
      'overlay',
      { [ANDROID_BOOTSTRAP_QUEUE_KEY]: restoredQueue },
    )
    const normalSet = storage.setItem
    storage.setItem = (key, value) => {
      if (key === ANDROID_BOOTSTRAP_QUEUE_KEY) throw new Error('storage unavailable')
      normalSet(key, value)
    }

    expect(() => applyAndroidBootstrapImportJournal(storage, journal))
      .toThrow(AndroidBootstrapImportRollbackError)
    expect(readAndroidBootstrapImportJournal(storage)).toEqual(journal)
  })

  it('rotates a full archive only after export and then isolates the currently blocked raw queue', () => {
    const currentRaw = '{current-broken'
    const storage = memoryStorage(currentRaw)
    storage.setItem(ANDROID_BOOTSTRAP_CORRUPT_KEY, JSON.stringify({
      data: Array.from({ length: 1 }, (_, index) => ({
        capturedAt: `2026-08-28T12:4${index}:00.000Z`,
        sourceKey: ANDROID_BOOTSTRAP_QUEUE_KEY,
        raw: `{older-${index}`,
      })),
    }))
    const exported = snapshotAndroidBootstrapData(storage)

    rotateAndroidBootstrapCorruptArchiveAfterExport(storage)
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull()
    expect(storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)).toBeNull()
    expect(hasAndroidBootstrapRecoveryToRotate(storage)).toBe(false)

    replaceAndroidBootstrapData(storage, exported)
    expect(snapshotAndroidBootstrapData(storage)).toEqual(exported)
  })

  it('allows post-export release when a small corrupt source could not be archived because quota was full', () => {
    const sourceRaw = '{small-broken'
    const storage = memoryStorage(sourceRaw)
    const normalSet = storage.setItem
    storage.setItem = (key, value) => {
      if (key === ANDROID_BOOTSTRAP_CORRUPT_KEY) throw new DOMException('quota', 'QuotaExceededError')
      normalSet(key, value)
    }

    expect(() => isolateAndroidBootstrapQueueCorruption(storage)).toThrow('恢复区写入失败')
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBe(sourceRaw)
    expect(hasAndroidBootstrapRecoveryToRotate(storage)).toBe(true)

    rotateAndroidBootstrapCorruptArchiveAfterExport(storage)
    expect(storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)).toBeNull()
    expect(hasAndroidBootstrapRecoveryToRotate(storage)).toBe(false)
  })

  it('deletes both active and quarantined health events', () => {
    const storage = memoryStorage(JSON.stringify({ data: [first] }))
    storage.setItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY, JSON.stringify({ data: [second] }))
    storage.setItem(ANDROID_BOOTSTRAP_CORRUPT_KEY, JSON.stringify({ data: [{ raw: 'damaged' }] }))
    clearAndroidBootstrapData(storage)
    expect(storage.values.size).toBe(0)
  })

  it('persists and explicitly releases the cross-process backup restore lock', () => {
    const storage = memoryStorage()
    beginAndroidBackupRestoreIntent(storage)
    expect(storage.getItem(ANDROID_BACKUP_RESTORE_INTENT_KEY)).toBe(JSON.stringify({
      version: 1,
      intent: 'restore-backup',
    }))
    clearAndroidBackupRestoreIntent(storage)
    expect(storage.getItem(ANDROID_BACKUP_RESTORE_INTENT_KEY)).toBeNull()
  })

  it('binds accepted and committed restore phases to one immutable native payload id', () => {
    const storage = memoryStorage()
    const id = '11111111-1111-4111-8111-111111111111'
    beginAndroidBackupRestoreIntent(storage)
    expect(readAndroidBackupRestoreIntentState(storage)).toEqual({ phase: 'waiting' })
    markAndroidBackupRestoreResultAccepted(storage, id)
    expect(readAndroidBackupRestoreIntentState(storage)).toEqual({ phase: 'accepted', id })
    expect(() => markAndroidBackupRestoreResultCommitted(
      storage,
      '22222222-2222-4222-8222-222222222222',
    )).toThrow('不匹配')
    markAndroidBackupRestoreResultCommitted(storage, id)
    expect(readAndroidBackupRestoreIntentState(storage)).toEqual({ phase: 'committed', id })
    // A duplicate picker wake must never downgrade committed back to accepted.
    markAndroidBackupRestoreResultAccepted(storage, id)
    expect(readAndroidBackupRestoreIntentState(storage)).toEqual({ phase: 'committed', id })
  })

  it('durably binds the selected file fingerprint before final confirmation', () => {
    const storage = memoryStorage()
    const selection = {
      id: '41414141-4141-4141-8141-414141414141',
      byteLength: 1190,
      sha256: '9'.repeat(64),
    }
    beginAndroidBackupRestoreIntent(storage)
    markAndroidBackupRestoreSelection(storage, selection, '2026-08-29T01:02:03.000Z')

    expect(readAndroidBackupRestoreIntentState(storage)).toEqual({
      phase: 'selected',
      ...selection,
      selectedAt: '2026-08-29T01:02:03.000Z',
    })
    expect(() => markAndroidBackupRestoreSelection(
      storage,
      selection,
      '2026-08-29T02:03:04.000Z',
    )).not.toThrow()
    expect(() => markAndroidBackupRestoreSelection(storage, {
      ...selection,
      sha256: '8'.repeat(64),
    })).toThrow(/不匹配/u)

    markAndroidBackupRestoreResultAccepted(storage, selection.id)
    expect(readAndroidBackupRestoreIntentState(storage)).toEqual({ phase: 'accepted', id: selection.id })
  })

  it('atomically migrates the v20 accepted-without-id lock to the authenticated native slot id', () => {
    const storage = memoryStorage()
    const id = '33333333-3333-4333-8333-333333333333'
    storage.setItem(ANDROID_BACKUP_RESTORE_INTENT_KEY, JSON.stringify({
      version: 1,
      intent: 'restore-backup',
      phase: 'result-accepted',
    }))

    expect(readAndroidBackupRestoreIntentState(storage)).toEqual({ phase: 'accepted' })
    markAndroidBackupRestoreResultAccepted(storage, id)
    expect(readAndroidBackupRestoreIntentState(storage)).toEqual({ phase: 'accepted', id })
    markAndroidBackupRestoreResultCommitted(storage, id)
    expect(readAndroidBackupRestoreIntentState(storage)).toEqual({ phase: 'committed', id })
  })

  it('fails closed when deletion cannot remove the transient health event', () => {
    const storage = memoryStorage(JSON.stringify({ data: [first] }))
    storage.removeItem = () => undefined
    expect(() => clearAndroidBootstrapData(storage)).toThrow('快速记录暂存删除失败')
  })
})
