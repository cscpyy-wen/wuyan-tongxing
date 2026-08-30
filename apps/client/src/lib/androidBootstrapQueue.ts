import type { CravingLevel, Trigger } from '../types'
import { validTimestamp } from './model'
import { decodeLosslessBase64, encodeLosslessBase64, type LosslessBase64String } from './recoveryCodec'

export const ANDROID_BOOTSTRAP_QUEUE_KEY = 'wuyan-tongxing/android-bootstrap-cigarettes/v1'
export const ANDROID_BOOTSTRAP_QUARANTINE_KEY = 'wuyan-tongxing/android-bootstrap-cigarettes-quarantine/v1'
export const ANDROID_BOOTSTRAP_CORRUPT_KEY = 'wuyan-tongxing/android-bootstrap-cigarettes-corrupt/v1'
export const ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY = 'wuyan-tongxing/android-bootstrap-import-journal/v1'
export const ANDROID_BOOTSTRAP_IMPORT_MARKER_FIELD = '_androidBootstrapImportTransactionId'
export const ANDROID_BACKUP_RESTORE_INTENT_KEY = 'wuyan-tongxing/android-backup-restore-intent/v1'
export const ANDROID_BOOTSTRAP_QUEUE_EVENT = 'wuyan:bootstrap-cigarette'

const triggers = new Set<Trigger>([
  'work', 'meal', 'toilet', 'stress', 'social', 'alcohol',
  'exercise', 'boredom', 'morning', 'coffee', 'habit',
])
const MAX_PENDING_EVENTS = 20
const MAX_QUARANTINED_EVENTS = 100
// One byte-for-byte snapshot is enough to preserve evidence until the user
// exports/rotates it, and keeps the H5 origin's two core slots within quota.
const MAX_CORRUPT_SNAPSHOTS = 1
const MAX_CORRUPT_RAW_CHARACTERS = 65_536
const MAX_CORRUPT_ARCHIVE_RAW_CHARACTERS = (MAX_CORRUPT_RAW_CHARACTERS * 6 + 512) * MAX_CORRUPT_SNAPSHOTS
const MAX_IMPORT_JOURNAL_RAW_CHARACTERS = 4 * 1024 * 1024
const SAFE_DOM_STORAGE_OPERATIONAL_BYTES = 9 * 1024 * 1024
export const ANDROID_BOOTSTRAP_RAW_CHARACTER_LIMITS: Readonly<Record<string, number>> = {
  [ANDROID_BOOTSTRAP_QUEUE_KEY]: MAX_CORRUPT_RAW_CHARACTERS,
  [ANDROID_BOOTSTRAP_QUARANTINE_KEY]: MAX_CORRUPT_RAW_CHARACTERS,
  [ANDROID_BOOTSTRAP_CORRUPT_KEY]: MAX_CORRUPT_ARCHIVE_RAW_CHARACTERS,
  [ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY]: MAX_IMPORT_JOURNAL_RAW_CHARACTERS,
  [ANDROID_BACKUP_RESTORE_INTENT_KEY]: 512,
}
const ANDROID_BOOTSTRAP_DATA_KEYS = [
  ANDROID_BOOTSTRAP_QUEUE_KEY,
  ANDROID_BOOTSTRAP_QUARANTINE_KEY,
  ANDROID_BOOTSTRAP_CORRUPT_KEY,
] as const

const MAX_RECOVERY_RAW_CHARACTERS_BY_KEY: Record<(typeof ANDROID_BOOTSTRAP_DATA_KEYS)[number], number> = {
  [ANDROID_BOOTSTRAP_QUEUE_KEY]: MAX_CORRUPT_RAW_CHARACTERS,
  [ANDROID_BOOTSTRAP_QUARANTINE_KEY]: MAX_CORRUPT_RAW_CHARACTERS,
  [ANDROID_BOOTSTRAP_CORRUPT_KEY]: MAX_CORRUPT_ARCHIVE_RAW_CHARACTERS,
}

export interface AndroidBootstrapCigarette {
  id: string
  smokedAt: string
  attemptId?: string
  trigger: Trigger
  cravingIntensity: CravingLevel
}

export interface AndroidBootstrapStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  readonly length?: number
  key?(index: number): string | null
}

export type AndroidBootstrapRecoverySnapshot = Partial<Record<(typeof ANDROID_BOOTSTRAP_DATA_KEYS)[number], string>>

export interface AndroidBootstrapRecoveryExport {
  version: 2
  encoding: 'lossless-base64-map'
  values: Partial<Record<(typeof ANDROID_BOOTSTRAP_DATA_KEYS)[number], LosslessBase64String>>
}

export interface AndroidBootstrapImportJournal {
  version: 1
  id: string
  mode: 'replace' | 'overlay'
  snapshot: AndroidBootstrapRecoverySnapshot
}

export class AndroidBootstrapRecoveryBlockedError extends Error {
  constructor(
    public readonly reason: 'archive-full' | 'archive-unreadable' | 'archive-write-failed' | 'source-oversized',
    message: string,
  ) {
    super(message)
    this.name = 'AndroidBootstrapRecoveryBlockedError'
  }
}

export class AndroidBootstrapImportRollbackError extends Error {
  constructor() {
    super('快速记录恢复数据写入及回滚均失败')
    this.name = 'AndroidBootstrapImportRollbackError'
  }
}

const BACKUP_RESTORE_INTENT_VALUE = JSON.stringify({ version: 1, intent: 'restore-backup' })
const BACKUP_RESTORE_ACCEPTED_VALUE = JSON.stringify({
  version: 1,
  intent: 'restore-backup',
  phase: 'result-accepted',
})
const BACKUP_RESTORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const BACKUP_RESTORE_SHA256 = /^[0-9a-f]{64}$/u

export interface AndroidBackupRestoreSelectionIdentity {
  id: string
  byteLength: number
  sha256: string
}

export type AndroidBackupRestoreIntentState =
  | { phase: 'waiting' }
  | ({ phase: 'selected'; selectedAt: string } & AndroidBackupRestoreSelectionIdentity)
  | { phase: 'accepted'; id?: string }
  | { phase: 'committed'; id: string }

export function readAndroidBackupRestoreIntentState(
  storage: AndroidBootstrapStorage,
): AndroidBackupRestoreIntentState | undefined {
  const raw = storage.getItem(ANDROID_BACKUP_RESTORE_INTENT_KEY)
  if (raw === null) return undefined
  if (raw === BACKUP_RESTORE_INTENT_VALUE) return { phase: 'waiting' }
  if (raw === BACKUP_RESTORE_ACCEPTED_VALUE) return { phase: 'accepted' }
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (value.version === 2
      && value.intent === 'restore-backup'
      && value.phase === 'selected-waiting-confirmation'
      && typeof value.id === 'string'
      && BACKUP_RESTORE_ID.test(value.id)
      && Number.isSafeInteger(value.byteLength)
      && Number(value.byteLength) > 0
      && Number(value.byteLength) <= 12 * 1024 * 1024
      && typeof value.sha256 === 'string'
      && BACKUP_RESTORE_SHA256.test(value.sha256)
      && validTimestamp(value.selectedAt)) {
      return {
        phase: 'selected',
        id: value.id,
        byteLength: Number(value.byteLength),
        sha256: value.sha256,
        selectedAt: value.selectedAt,
      }
    }
    if (value.version !== 1 || value.intent !== 'restore-backup' || typeof value.id !== 'string'
      || !BACKUP_RESTORE_ID.test(value.id)) throw new Error('invalid')
    if (value.phase === 'result-accepted') return { phase: 'accepted', id: value.id }
    if (value.phase === 'result-committed') return { phase: 'committed', id: value.id }
  } catch {
    // A malformed non-null value remains a fail-closed restore intent. Callers
    // must not silently interpret it as idle or clear it without user action.
  }
  throw new Error('备份恢复状态无法读取')
}

export function markAndroidBackupRestoreSelection(
  storage: AndroidBootstrapStorage,
  selection: AndroidBackupRestoreSelectionIdentity,
  selectedAt = new Date().toISOString(),
): void {
  if (!BACKUP_RESTORE_ID.test(selection.id)
    || !Number.isSafeInteger(selection.byteLength)
    || selection.byteLength <= 0
    || selection.byteLength > 12 * 1024 * 1024
    || !BACKUP_RESTORE_SHA256.test(selection.sha256)
    || !validTimestamp(selectedAt)) {
    throw new Error('备份恢复文件标识无效')
  }
  const current = readAndroidBackupRestoreIntentState(storage)
  if (current?.phase === 'selected') {
    if (current.id === selection.id
      && current.byteLength === selection.byteLength
      && current.sha256 === selection.sha256) return
    throw new Error('备份恢复文件与当前状态不匹配')
  }
  if (current?.phase !== 'waiting') throw new Error('备份恢复状态不允许选择文件')
  const selected = JSON.stringify({
    version: 2,
    intent: 'restore-backup',
    phase: 'selected-waiting-confirmation',
    id: selection.id,
    byteLength: selection.byteLength,
    sha256: selection.sha256,
    selectedAt,
  })
  storage.setItem(ANDROID_BACKUP_RESTORE_INTENT_KEY, selected)
  if (storage.getItem(ANDROID_BACKUP_RESTORE_INTENT_KEY) !== selected) {
    throw new Error('备份恢复文件状态写入后校验失败')
  }
}

export function beginAndroidBackupRestoreIntent(storage: AndroidBootstrapStorage): void {
  storage.setItem(ANDROID_BACKUP_RESTORE_INTENT_KEY, BACKUP_RESTORE_INTENT_VALUE)
  if (storage.getItem(ANDROID_BACKUP_RESTORE_INTENT_KEY) !== BACKUP_RESTORE_INTENT_VALUE) {
    throw new Error('备份恢复状态写入后校验失败')
  }
}

export function clearAndroidBackupRestoreIntent(storage: AndroidBootstrapStorage): void {
  storage.removeItem(ANDROID_BACKUP_RESTORE_INTENT_KEY)
  if (storage.getItem(ANDROID_BACKUP_RESTORE_INTENT_KEY) !== null) {
    throw new Error('备份恢复状态无法释放')
  }
}

export function markAndroidBackupRestoreResultAccepted(
  storage: AndroidBootstrapStorage,
  id?: string,
): void {
  if (storage.getItem(ANDROID_BACKUP_RESTORE_INTENT_KEY) === null) {
    throw new Error('备份恢复状态不存在')
  }
  if (id !== undefined && !BACKUP_RESTORE_ID.test(id)) throw new Error('备份恢复结果标识无效')
  if (id !== undefined) {
    const current = readAndroidBackupRestoreIntentState(storage)
    if ((current?.phase === 'accepted' || current?.phase === 'committed') && current.id === id) return
    // v20 could persist result-accepted without the native payload UUID. Once
    // the single authenticated native slot is probed, bind that legacy lock to
    // its exact UUID instead of leaving the app permanently fail-closed.
    const migratesLegacyAccepted = current?.phase === 'accepted' && current.id === undefined
    const matchesSelected = current?.phase === 'selected' && current.id === id
    if (current?.phase !== 'waiting' && !matchesSelected && !migratesLegacyAccepted) {
      throw new Error('备份恢复结果标识与当前状态不匹配')
    }
  }
  const accepted = id === undefined ? BACKUP_RESTORE_ACCEPTED_VALUE : JSON.stringify({
    version: 1,
    intent: 'restore-backup',
    phase: 'result-accepted',
    id,
  })
  storage.setItem(ANDROID_BACKUP_RESTORE_INTENT_KEY, accepted)
  if (storage.getItem(ANDROID_BACKUP_RESTORE_INTENT_KEY) !== accepted) {
    throw new Error('备份恢复结果状态写入后校验失败')
  }
}

export function markAndroidBackupRestoreResultCommitted(
  storage: AndroidBootstrapStorage,
  id: string,
): void {
  if (!BACKUP_RESTORE_ID.test(id)) throw new Error('备份恢复结果标识无效')
  const current = readAndroidBackupRestoreIntentState(storage)
  if (current?.phase === 'committed' && current.id === id) return
  if (current?.phase !== 'accepted' || current.id !== id) {
    throw new Error('备份恢复结果状态与暂存标识不匹配')
  }
  const committed = JSON.stringify({
    version: 1,
    intent: 'restore-backup',
    phase: 'result-committed',
    id,
  })
  storage.setItem(ANDROID_BACKUP_RESTORE_INTENT_KEY, committed)
  if (storage.getItem(ANDROID_BACKUP_RESTORE_INTENT_KEY) !== committed) {
    throw new Error('备份恢复提交状态写入后校验失败')
  }
}

export function isAndroidBackupRestoreResultAccepted(storage: AndroidBootstrapStorage): boolean {
  const state = readAndroidBackupRestoreIntentState(storage)
  return state?.phase === 'accepted' || state?.phase === 'committed'
}

export function hasAndroidBackupRestoreIntent(storage: AndroidBootstrapStorage): boolean {
  return storage.getItem(ANDROID_BACKUP_RESTORE_INTENT_KEY) !== null
}

function validEvent(value: unknown): value is AndroidBootstrapCigarette {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<AndroidBootstrapCigarette>
  return typeof event.id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(event.id)
    && validTimestamp(event.smokedAt)
    && typeof event.attemptId === 'string'
    && event.attemptId.length > 0
    && event.attemptId.length <= 128
    && triggers.has(event.trigger as Trigger)
    && Number.isInteger(event.cravingIntensity)
    && Number(event.cravingIntensity) >= 1
    && Number(event.cravingIntensity) <= 5
}

function normalizeEvent(value: unknown): AndroidBootstrapCigarette | undefined {
  if (validEvent(value)) {
    return {
      id: value.id,
      smokedAt: value.smokedAt,
      attemptId: value.attemptId as string,
      trigger: value.trigger,
      cravingIntensity: value.cravingIntensity,
    }
  }
  if (!value || typeof value !== 'object' || Object.prototype.hasOwnProperty.call(value, 'attemptId')) return undefined
  const legacy = value as Partial<Omit<AndroidBootstrapCigarette, 'attemptId'>>
  if (typeof legacy.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(legacy.id)
    || !validTimestamp(legacy.smokedAt)
    || !triggers.has(legacy.trigger as Trigger)
    || !Number.isInteger(legacy.cravingIntensity)
    || Number(legacy.cravingIntensity) < 1
    || Number(legacy.cravingIntensity) > 5) return undefined
  return {
    id: legacy.id,
    smokedAt: legacy.smokedAt!,
    trigger: legacy.trigger as Trigger,
    cravingIntensity: legacy.cravingIntensity as CravingLevel,
  }
}

function inspectQueue(
  storage: AndroidBootstrapStorage,
  key: string,
  maximumEvents: number,
): { events: AndroidBootstrapCigarette[]; raw: string | null; corrupted: boolean } {
  const raw = storage.getItem(key)
  if (raw === null) return { events: [], raw, corrupted: false }
  // Reject before JSON.parse: a damaged multi-megabyte value must not allocate
  // an equally large object graph on the WebView main thread during startup.
  // The untouched raw string remains available for the explicit export path.
  if (raw.length > MAX_CORRUPT_RAW_CHARACTERS) {
    return { events: [], raw, corrupted: true }
  }
  let wrapper: { data?: unknown }
  try {
    wrapper = JSON.parse(raw) as { data?: unknown }
  } catch {
    return { events: [], raw, corrupted: true }
  }
  if (!wrapper || !Array.isArray(wrapper.data) || wrapper.data.length > maximumEvents) {
    return { events: [], raw, corrupted: true }
  }

  const ids = new Set<string>()
  const events: AndroidBootstrapCigarette[] = []
  let corrupted = false
  for (const item of wrapper.data) {
    const normalized = normalizeEvent(item)
    if (!normalized || ids.has(normalized.id)) {
      corrupted = true
      continue
    }
    const expectedKeys = normalized.attemptId === undefined
      ? ['cravingIntensity', 'id', 'smokedAt', 'trigger']
      : ['attemptId', 'cravingIntensity', 'id', 'smokedAt', 'trigger']
    const actualKeys = Object.keys(item as Record<string, unknown>).sort()
    if (actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])) {
      // Preserve the byte-for-byte source in the corruption archive, but only
      // carry the five bounded fields into the live queue. This prevents a
      // parseable event from becoming an unbounded storage smuggling channel.
      corrupted = true
    }
    ids.add(normalized.id)
    events.push(normalized)
  }
  return { events, raw, corrupted }
}

function readQueue(
  storage: AndroidBootstrapStorage,
  key: string,
  maximumEvents: number,
): AndroidBootstrapCigarette[] {
  return inspectQueue(storage, key, maximumEvents).events
}

function isolateQueueCorruption(
  storage: AndroidBootstrapStorage,
  key: string,
  maximumEvents: number,
): boolean {
  const inspected = inspectQueue(storage, key, maximumEvents)
  if (!inspected.corrupted || inspected.raw === null) return false
  if (inspected.raw.length > MAX_CORRUPT_RAW_CHARACTERS) {
    throw new AndroidBootstrapRecoveryBlockedError(
      'source-oversized',
      '快速记录异常数据过大，已保留原值等待导出恢复',
    )
  }

  let snapshots: Array<{ capturedAt: string; sourceKey: string; raw: string }> = []
  const archiveRaw = storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)
  if (archiveRaw !== null) {
    if (archiveRaw.length > MAX_CORRUPT_ARCHIVE_RAW_CHARACTERS) {
      throw new AndroidBootstrapRecoveryBlockedError(
        'archive-unreadable',
        '快速记录异常恢复区超过安全读取上限，原值保持不变',
      )
    }
    try {
      const archive = JSON.parse(archiveRaw) as { data?: unknown }
      if (!Array.isArray(archive.data) || archive.data.length > MAX_CORRUPT_SNAPSHOTS) throw new Error('invalid archive')
      snapshots = archive.data.map((item) => {
        if (!item || typeof item !== 'object') throw new Error('invalid archive item')
        const snapshot = item as { capturedAt?: unknown; sourceKey?: unknown; raw?: unknown }
        if (typeof snapshot.capturedAt !== 'string'
          || !validTimestamp(snapshot.capturedAt)
          || (snapshot.sourceKey !== ANDROID_BOOTSTRAP_QUEUE_KEY
            && snapshot.sourceKey !== ANDROID_BOOTSTRAP_QUARANTINE_KEY)
          || typeof snapshot.raw !== 'string'
          || snapshot.raw.length > MAX_CORRUPT_RAW_CHARACTERS) throw new Error('invalid archive item')
        return snapshot as { capturedAt: string; sourceKey: string; raw: string }
      })
    } catch {
      throw new AndroidBootstrapRecoveryBlockedError(
        'archive-unreadable',
        '快速记录异常恢复区无法读取，原值保持不变',
      )
    }
  }
  const alreadyArchived = snapshots.some((snapshot) => snapshot.sourceKey === key && snapshot.raw === inspected.raw)
  if (!alreadyArchived) {
    if (snapshots.length >= MAX_CORRUPT_SNAPSHOTS) {
      throw new AndroidBootstrapRecoveryBlockedError(
        'archive-full',
        '快速记录异常恢复区已满，请先导出数据副本',
      )
    }
    snapshots.push({ capturedAt: new Date().toISOString(), sourceKey: key, raw: inspected.raw })
    try {
      storage.setItem(ANDROID_BOOTSTRAP_CORRUPT_KEY, JSON.stringify({ data: snapshots }))
    } catch {
      throw new AndroidBootstrapRecoveryBlockedError(
        'archive-write-failed',
        '快速记录异常恢复区写入失败，原值保持不变',
      )
    }
  }
  const verifiedArchive = storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)
  let archived = false
  try {
    const parsed = JSON.parse(verifiedArchive ?? '') as { data?: Array<{ sourceKey?: unknown; raw?: unknown }> }
    archived = Array.isArray(parsed.data)
      && parsed.data.some((snapshot) => snapshot.sourceKey === key && snapshot.raw === inspected.raw)
  } catch {
    archived = false
  }
  if (!archived) {
    throw new AndroidBootstrapRecoveryBlockedError(
      'archive-write-failed',
      '快速记录异常恢复区写入失败，原值保持不变',
    )
  }

  if (inspected.events.length === 0) storage.removeItem(key)
  else storage.setItem(key, JSON.stringify({ data: inspected.events }))
  const repaired = inspectQueue(storage, key, maximumEvents)
  if (repaired.corrupted || repaired.events.length !== inspected.events.length) {
    throw new Error('快速记录异常数据隔离后校验失败')
  }
  return true
}

export function readAndroidBootstrapQueue(storage: AndroidBootstrapStorage): AndroidBootstrapCigarette[] {
  return readQueue(storage, ANDROID_BOOTSTRAP_QUEUE_KEY, MAX_PENDING_EVENTS)
}

export function readAndroidBootstrapQuarantine(storage: AndroidBootstrapStorage): AndroidBootstrapCigarette[] {
  return readQueue(storage, ANDROID_BOOTSTRAP_QUARANTINE_KEY, MAX_QUARANTINED_EVENTS)
}

export function isolateAndroidBootstrapQueueCorruption(storage: AndroidBootstrapStorage): boolean {
  return isolateQueueCorruption(storage, ANDROID_BOOTSTRAP_QUEUE_KEY, MAX_PENDING_EVENTS)
}

export function isolateAndroidBootstrapQuarantineCorruption(storage: AndroidBootstrapStorage): boolean {
  return isolateQueueCorruption(storage, ANDROID_BOOTSTRAP_QUARANTINE_KEY, MAX_QUARANTINED_EVENTS)
}

export function snapshotAndroidBootstrapData(storage: AndroidBootstrapStorage): AndroidBootstrapRecoverySnapshot {
  return Object.fromEntries(ANDROID_BOOTSTRAP_DATA_KEYS
    .map((key) => [key, storage.getItem(key)] as const)
    .filter((entry): entry is readonly [(typeof ANDROID_BOOTSTRAP_DATA_KEYS)[number], string] => entry[1] !== null))
}

/**
 * External backup framing. Encoding each raw storage value directly avoids
 * JSON's sixfold expansion for NUL/control-character corruption while keeping
 * the app's internal transaction snapshot as plain byte-for-byte strings.
 */
export function exportAndroidBootstrapRecoveryData(
  storage: AndroidBootstrapStorage,
): AndroidBootstrapRecoveryExport {
  const snapshot = snapshotAndroidBootstrapData(storage)
  return {
    version: 2,
    encoding: 'lossless-base64-map',
    values: Object.fromEntries(Object.entries(snapshot).map(([key, raw]) => [key, {
      ...encodeLosslessBase64(raw),
    }])) as AndroidBootstrapRecoveryExport['values'],
  }
}

function decodeRecoveryExport(value: unknown, tolerateInvalidEntries: boolean): {
  record: Record<string, unknown>
  skippedInvalidData: boolean
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('快速记录恢复数据格式无效')
  }
  const outer = value as Record<string, unknown>
  const encoded = Object.prototype.hasOwnProperty.call(outer, 'version')
    || Object.prototype.hasOwnProperty.call(outer, 'encoding')
    || Object.prototype.hasOwnProperty.call(outer, 'values')
  if (!encoded) return { record: outer, skippedInvalidData: false }
  const envelopeValid = Object.keys(outer).sort().join('|') === 'encoding|values|version'
    && outer.version === 2
    && outer.encoding === 'lossless-base64-map'
  if (!outer.values || typeof outer.values !== 'object' || Array.isArray(outer.values)) {
    if (tolerateInvalidEntries) return { record: {}, skippedInvalidData: true }
    throw new Error('快速记录恢复编码无效')
  }
  if (!envelopeValid && !tolerateInvalidEntries) throw new Error('快速记录恢复编码无效')
  const values = outer.values as Record<string, unknown>
  let skippedInvalidData = !envelopeValid
  const record: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(values)) {
    if (!ANDROID_BOOTSTRAP_DATA_KEYS.includes(key as (typeof ANDROID_BOOTSTRAP_DATA_KEYS)[number])) {
      if (!tolerateInvalidEntries) throw new Error('快速记录恢复数据包含未知字段')
      skippedInvalidData = true
      continue
    }
    try {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid')
      const encodedEntry = entry as Record<string, unknown>
      const maximumRawCharacters = MAX_RECOVERY_RAW_CHARACTERS_BY_KEY[
        key as (typeof ANDROID_BOOTSTRAP_DATA_KEYS)[number]
      ]
      const maximumEncodedCharacters = encodedEntry.encoding === 'base64-utf16le'
        ? 4 * Math.ceil((maximumRawCharacters * 2) / 3)
        : encodedEntry.encoding === 'base64-utf8'
          // A well-formed JavaScript string needs at most three UTF-8 bytes
          // per UTF-16 code unit. Reject before regex/byte/string allocation;
          // the decoded character limit is still checked below.
          ? 4 * maximumRawCharacters
          : -1
      if (Object.keys(encodedEntry).sort().join('|') !== 'data|encoding'
        || typeof encodedEntry.data !== 'string'
        || encodedEntry.data.length > maximumEncodedCharacters) throw new Error('invalid')
      record[key] = decodeLosslessBase64(entry)
    } catch {
      if (!tolerateInvalidEntries) throw new Error('快速记录恢复编码无效')
      skippedInvalidData = true
    }
  }
  return { record, skippedInvalidData }
}

function validateRecoverySnapshot(value: unknown): AndroidBootstrapRecoverySnapshot {
  if (value === undefined) return {}
  const { record } = decodeRecoveryExport(value, false)
  if (Object.keys(record).some((key) => !ANDROID_BOOTSTRAP_DATA_KEYS.includes(
    key as (typeof ANDROID_BOOTSTRAP_DATA_KEYS)[number],
  ))) throw new Error('快速记录恢复数据包含未知字段')

  const snapshot: AndroidBootstrapRecoverySnapshot = {}
  for (const key of ANDROID_BOOTSTRAP_DATA_KEYS) {
    const raw = record[key]
    if (raw === undefined) continue
    if (typeof raw !== 'string' || raw.length > MAX_RECOVERY_RAW_CHARACTERS_BY_KEY[key]) {
      throw new Error('快速记录恢复数据超过安全边界')
    }
    snapshot[key] = raw
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, ANDROID_BOOTSTRAP_CORRUPT_KEY)) {
    try {
      const archive = JSON.parse(snapshot[ANDROID_BOOTSTRAP_CORRUPT_KEY]!) as { data?: unknown }
      if (!Array.isArray(archive.data) || archive.data.length > MAX_CORRUPT_SNAPSHOTS) throw new Error('invalid')
      for (const item of archive.data) {
        if (!item || typeof item !== 'object') throw new Error('invalid')
        const candidate = item as { capturedAt?: unknown; sourceKey?: unknown; raw?: unknown }
        if (typeof candidate.capturedAt !== 'string'
          || !validTimestamp(candidate.capturedAt)
          || (candidate.sourceKey !== ANDROID_BOOTSTRAP_QUEUE_KEY
            && candidate.sourceKey !== ANDROID_BOOTSTRAP_QUARANTINE_KEY)
          || typeof candidate.raw !== 'string'
          || candidate.raw.length > MAX_CORRUPT_RAW_CHARACTERS) throw new Error('invalid')
      }
    } catch {
      throw new Error('快速记录异常恢复区格式无效')
    }
  }
  return snapshot
}

/** Pure validation for restore workflows that must run before platform effects. */
export function validateAndroidBootstrapRecoveryData(value: unknown): AndroidBootstrapRecoverySnapshot {
  return validateRecoverySnapshot(value)
}

export function sanitizeAndroidBootstrapRecoveryData(value: unknown): {
  snapshot: AndroidBootstrapRecoverySnapshot
  skippedInvalidData: boolean
} {
  if (value === undefined) return { snapshot: {}, skippedInvalidData: false }
  let record: Record<string, unknown>
  let skippedInvalidData: boolean
  try {
    const decoded = decodeRecoveryExport(value, true)
    record = decoded.record
    skippedInvalidData = decoded.skippedInvalidData
  } catch {
    return { snapshot: {}, skippedInvalidData: true }
  }
  skippedInvalidData ||= Object.keys(record).some((key) => !ANDROID_BOOTSTRAP_DATA_KEYS.includes(
    key as (typeof ANDROID_BOOTSTRAP_DATA_KEYS)[number],
  ))
  const snapshot: AndroidBootstrapRecoverySnapshot = {}
  for (const key of ANDROID_BOOTSTRAP_DATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    try {
      Object.assign(snapshot, validateRecoverySnapshot({ [key]: record[key] }))
    } catch {
      skippedInvalidData = true
    }
  }
  return { snapshot, skippedInvalidData }
}

function validImportTransactionId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function validateImportJournal(value: unknown): AndroidBootstrapImportJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('快速记录导入事务格式无效')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !['version', 'id', 'mode', 'snapshot'].includes(key))
    || record.version !== 1
    || !validImportTransactionId(record.id)
    || (record.mode !== 'replace' && record.mode !== 'overlay')) {
    throw new Error('快速记录导入事务格式无效')
  }
  return {
    version: 1,
    id: record.id,
    mode: record.mode,
    snapshot: validateRecoverySnapshot(record.snapshot),
  }
}

export function stageAndroidBootstrapImportJournal(
  storage: AndroidBootstrapStorage,
  id: string,
  mode: AndroidBootstrapImportJournal['mode'],
  snapshot: AndroidBootstrapRecoverySnapshot,
): AndroidBootstrapImportJournal {
  const journal = validateImportJournal({ version: 1, id, mode, snapshot })
  const serialized = JSON.stringify(journal)
  if (serialized.length > MAX_IMPORT_JOURNAL_RAW_CHARACTERS) {
    throw new Error('快速记录导入事务超过安全写入上限')
  }
  // Real Blink quota accounting charges two bytes per UTF-16 code unit. The
  // journal temporarily coexists with the source quick-log records, so check
  // the whole origin before relying on setItem's generic QuotaExceeded error.
  if (typeof storage.length === 'number' && typeof storage.key === 'function') {
    let projected = (ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY.length + serialized.length) * 2
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key === null || key === ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY) continue
      const value = storage.getItem(key)
      if (value !== null) projected += (key.length + value.length) * 2
      if (projected > SAFE_DOM_STORAGE_OPERATIONAL_BYTES) break
    }
    if (projected > SAFE_DOM_STORAGE_OPERATIONAL_BYTES) {
      throw new Error('快速记录导入事务超过本机安全容量')
    }
  }
  storage.setItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY, serialized)
  const verified = storage.getItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY)
  if (verified !== serialized) throw new Error('快速记录导入事务写入后校验失败')
  return journal
}

export function readAndroidBootstrapImportJournal(
  storage: AndroidBootstrapStorage,
): AndroidBootstrapImportJournal | undefined {
  const raw = storage.getItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY)
  if (raw === null) return undefined
  if (raw.length > MAX_IMPORT_JOURNAL_RAW_CHARACTERS) {
    throw new Error('快速记录导入事务超过安全读取上限')
  }
  try {
    return validateImportJournal(JSON.parse(raw) as unknown)
  } catch {
    throw new Error('快速记录导入事务无法读取')
  }
}

export function clearAndroidBootstrapImportJournal(storage: AndroidBootstrapStorage): void {
  storage.removeItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY)
  if (storage.getItem(ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY) !== null) {
    throw new Error('快速记录导入事务无法释放')
  }
}

export function readAndroidBootstrapImportMarker(value: unknown): string | undefined {
  let candidate = value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown
    } catch {
      return undefined
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || !Object.prototype.hasOwnProperty.call(candidate, ANDROID_BOOTSTRAP_IMPORT_MARKER_FIELD)) return undefined
  const id = (candidate as Record<string, unknown>)[ANDROID_BOOTSTRAP_IMPORT_MARKER_FIELD]
  if (!validImportTransactionId(id)) throw new Error('快速记录导入事务标记无效')
  return id
}

/**
 * Applies only the keys represented by an overlay, while a replace journal is
 * authoritative for all three bootstrap keys. Untouched destination values
 * are preserved byte-for-byte even when they are malformed; one damaged key
 * must not prevent a different valid key from being restored.
 */
export function applyAndroidBootstrapImportJournal(
  storage: AndroidBootstrapStorage,
  value: AndroidBootstrapImportJournal,
): () => void {
  const journal = validateImportJournal(value)
  const touchedKeys = journal.mode === 'replace'
    ? [...ANDROID_BOOTSTRAP_DATA_KEYS]
    : ANDROID_BOOTSTRAP_DATA_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(journal.snapshot, key))
  const previous = new Map(touchedKeys.map((key) => [key, storage.getItem(key)] as const))

  const write = (key: (typeof ANDROID_BOOTSTRAP_DATA_KEYS)[number], raw: string | null) => {
    if (raw === null) storage.removeItem(key)
    else storage.setItem(key, raw)
    if (storage.getItem(key) !== raw) throw new Error('快速记录恢复数据写入后校验失败')
  }
  const rollback = () => {
    for (const key of touchedKeys) write(key, previous.get(key) ?? null)
  }
  try {
    for (const key of touchedKeys) write(key, journal.snapshot[key] ?? null)
  } catch (error) {
    try {
      rollback()
    } catch {
      throw new AndroidBootstrapImportRollbackError()
    }
    throw error
  }
  return rollback
}

function writeRecoverySnapshot(
  storage: AndroidBootstrapStorage,
  snapshot: AndroidBootstrapRecoverySnapshot,
): void {
  for (const key of ANDROID_BOOTSTRAP_DATA_KEYS) {
    const raw = snapshot[key]
    if (raw === undefined) storage.removeItem(key)
    else storage.setItem(key, raw)
    if (storage.getItem(key) !== (raw ?? null)) throw new Error('快速记录恢复数据写入后校验失败')
  }
}

export function replaceAndroidBootstrapData(
  storage: AndroidBootstrapStorage,
  value: unknown,
): () => void {
  const replacement = validateRecoverySnapshot(value)
  const previous = snapshotAndroidBootstrapData(storage)
  try {
    writeRecoverySnapshot(storage, replacement)
  } catch (error) {
    writeRecoverySnapshot(storage, previous)
    throw error
  }
  return () => writeRecoverySnapshot(storage, previous)
}

export function rotateAndroidBootstrapCorruptArchiveAfterExport(storage: AndroidBootstrapStorage): void {
  const previousArchive = storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)
  const previousQueue = storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY)
  const previousQuarantine = storage.getItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY)
  if (!hasAndroidBootstrapRecoveryToRotate(storage)) return
  if (previousArchive !== null) {
    storage.removeItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)
    if (storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY) !== null) {
      throw new Error('快速记录异常恢复区无法释放')
    }
  }
  try {
    // The just-exported recovery bundle is now the durable byte-for-byte copy.
    // Rotation is the user's explicit permission to normalize every damaged
    // source directly, including a small source that could not be archived
    // because storage quota was exhausted.
    for (const [key, maximumEvents] of [
      [ANDROID_BOOTSTRAP_QUEUE_KEY, MAX_PENDING_EVENTS],
      [ANDROID_BOOTSTRAP_QUARANTINE_KEY, MAX_QUARANTINED_EVENTS],
    ] as const) {
      const inspected = inspectQueue(storage, key, maximumEvents)
      if (inspected.corrupted && inspected.raw !== null) {
        if (inspected.events.length === 0) storage.removeItem(key)
        else storage.setItem(key, JSON.stringify({ data: inspected.events }))
        const repaired = inspectQueue(storage, key, maximumEvents)
        if (repaired.corrupted || repaired.events.length !== inspected.events.length) {
          throw new Error('超限快速记录恢复区无法释放')
        }
      }
    }
  } catch (error) {
    if (previousArchive === null) storage.removeItem(ANDROID_BOOTSTRAP_CORRUPT_KEY)
    else storage.setItem(ANDROID_BOOTSTRAP_CORRUPT_KEY, previousArchive)
    for (const [key, previous] of [
      [ANDROID_BOOTSTRAP_QUEUE_KEY, previousQueue],
      [ANDROID_BOOTSTRAP_QUARANTINE_KEY, previousQuarantine],
    ] as const) {
      if (previous === null) storage.removeItem(key)
      else storage.setItem(key, previous)
    }
    if (storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY) !== previousArchive
      || storage.getItem(ANDROID_BOOTSTRAP_QUEUE_KEY) !== previousQueue
      || storage.getItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY) !== previousQuarantine) {
      throw new Error('快速记录异常恢复区回滚失败')
    }
    throw error
  }
}

export function hasAndroidBootstrapRecoveryToRotate(storage: AndroidBootstrapStorage): boolean {
  if (storage.getItem(ANDROID_BOOTSTRAP_CORRUPT_KEY) !== null) return true
  return ([
    [ANDROID_BOOTSTRAP_QUEUE_KEY, MAX_PENDING_EVENTS],
    [ANDROID_BOOTSTRAP_QUARANTINE_KEY, MAX_QUARANTINED_EVENTS],
  ] as const).some(([key, maximumEvents]) => {
    const inspected = inspectQueue(storage, key, maximumEvents)
    return inspected.corrupted && inspected.raw !== null
  })
}

export function acknowledgeAndroidBootstrapQueue(
  storage: AndroidBootstrapStorage,
  acknowledgedIds: ReadonlySet<string>,
): void {
  isolateQueueCorruption(storage, ANDROID_BOOTSTRAP_QUEUE_KEY, MAX_PENDING_EVENTS)
  const current = readAndroidBootstrapQueue(storage)
  const remaining = current.filter((event) => !acknowledgedIds.has(event.id))
  if (remaining.length === 0) {
    storage.removeItem(ANDROID_BOOTSTRAP_QUEUE_KEY)
    return
  }
  storage.setItem(ANDROID_BOOTSTRAP_QUEUE_KEY, JSON.stringify({ data: remaining }))
}

export function acknowledgeAndroidBootstrapQuarantine(
  storage: AndroidBootstrapStorage,
  acknowledgedIds: ReadonlySet<string>,
): void {
  isolateQueueCorruption(storage, ANDROID_BOOTSTRAP_QUARANTINE_KEY, MAX_QUARANTINED_EVENTS)
  const current = readAndroidBootstrapQuarantine(storage)
  const remaining = current.filter((event) => !acknowledgedIds.has(event.id))
  if (remaining.length === 0) {
    storage.removeItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY)
    return
  }
  storage.setItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY, JSON.stringify({ data: remaining }))
}

export function moveAndroidBootstrapEventsToQuarantine(
  storage: AndroidBootstrapStorage,
  events: readonly AndroidBootstrapCigarette[],
): void {
  if (events.length === 0) return
  isolateQueueCorruption(storage, ANDROID_BOOTSTRAP_QUARANTINE_KEY, MAX_QUARANTINED_EVENTS)
  const existing = readAndroidBootstrapQuarantine(storage)
  const byId = new Map(existing.map((event) => [event.id, event]))
  for (const event of events) {
    const prior = byId.get(event.id)
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) {
      throw new Error('快速记录标识冲突，已保留原始记录')
    }
    if (!prior) byId.set(event.id, event)
  }
  const next = [...byId.values()]
  if (next.length > MAX_QUARANTINED_EVENTS) {
    throw new Error('待归类的快速记录过多，请先处理现有记录')
  }
  storage.setItem(ANDROID_BOOTSTRAP_QUARANTINE_KEY, JSON.stringify({ data: next }))
  const writtenIds = new Set(readAndroidBootstrapQuarantine(storage).map((event) => event.id))
  if (events.some((event) => !writtenIds.has(event.id))) {
    throw new Error('快速记录隔离保存失败')
  }
  acknowledgeAndroidBootstrapQueue(storage, new Set(events.map((event) => event.id)))
}

export function clearAndroidBootstrapData(storage: AndroidBootstrapStorage): void {
  for (const key of [
    ...ANDROID_BOOTSTRAP_DATA_KEYS,
    ANDROID_BOOTSTRAP_IMPORT_JOURNAL_KEY,
    ANDROID_BACKUP_RESTORE_INTENT_KEY,
  ]) {
    storage.removeItem(key)
    if (storage.getItem(key) !== null) {
      throw new Error('Android 快速记录暂存删除失败')
    }
  }
}
