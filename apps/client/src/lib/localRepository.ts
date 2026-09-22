import type { ClientState } from '../types'
import { parseStoredStateStrict, STORAGE_KEY, StoredStateCorruptionError } from './model'
import { toShanghaiDate } from './smokingLogs'
import { encodeLosslessBase64, utf8ByteLength } from './recoveryCodec'

export const BACKUP_STORAGE_KEY = `${STORAGE_KEY}/last-known-good`
export const DELETION_INTENT_STORAGE_KEY = `${STORAGE_KEY}/deletion-in-progress`
export const ANDROID_BOOTSTRAP_SUMMARY_FIELD = '_androidBootstrapSummary'
// H5 keeps two core slots in one Blink DOM-storage area. Blink quota accounting
// charges two bytes per UTF-16 code unit, so 1.75 MiB per canonical state leaves
// room for both slots plus the bounded quick-log recovery records. The Android
// durable adapter declares its larger independent file limit through the port.
export const MAX_CLIENT_STATE_BYTES = Math.floor(1.75 * 1024 * 1024)
export const MAX_LEGACY_CLIENT_STATE_READ_BYTES = 8 * 1024 * 1024
export const MAX_TARO_STORAGE_WRAPPER_CHARACTERS = 3 * 1024 * 1024
const DELETION_INTENT_VALUE = {
  version: 1,
  intent: 'delete-all-local-health-data',
} as const

export interface LocalStoragePort {
  read(key: string): unknown
  write(key: string, value: unknown): void
  remove(key: string): void
  exists?(key: string): boolean
  readRaw?(key: string): unknown
  maxStateBytes?: number | (() => number) | undefined
  maxReadStateBytes?: number | (() => number) | undefined
  supportsDedicatedDeletionIntent?: boolean | (() => boolean) | undefined
  readLegacyDeletionFallback?: (() => unknown) | undefined
  clearLegacyDeletionFallback?: (() => void) | undefined
}

export interface LocalStateRepository {
  load(): { state: ClientState; recoveredFromBackup: boolean }
  save(state: ClientState): void
  hasPendingDeletion(): boolean
  beginDeletion(): void
  clearCoreAfterDeletionIntent(): void
  finishDeletion(): void
  replaceCorruptedPrimaryFromVerifiedBackup(state: ClientState): void
  clear(): void
  recoverySnapshot(): Record<string, unknown>
  recoveryBundle(): string
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

type StorageEntry =
  | { present: false }
  | { present: true; value?: unknown; error?: Error }

function asReadError(error?: unknown): Error {
  return error instanceof Error ? error : new StoredStateCorruptionError()
}

function inspectStorage(storage: LocalStoragePort, key: string): StorageEntry {
  let knownPresent: boolean | undefined
  try {
    knownPresent = storage.exists?.(key)
  } catch (error) {
    return { present: true, error: asReadError(error) }
  }

  try {
    const value = storage.read(key)
    if (isAbsent(value)) {
      return knownPresent
        ? { present: true, error: new StoredStateCorruptionError() }
        : { present: false }
    }
    return { present: true, value }
  } catch (error) {
    return { present: true, error: asReadError(error) }
  }
}

function parseEntry(entry: StorageEntry, maxBytes = MAX_LEGACY_CLIENT_STATE_READ_BYTES): ClientState {
  if (!entry.present) throw new StoredStateCorruptionError()
  if (entry.error) throw entry.error
  const parsed = parseStoredStateStrict(entry.value)
  assertCanonicalStateFitsExportContract(parsed, maxBytes)
  return parsed
}

function recoveryValue(storage: LocalStoragePort, key: string, entry: StorageEntry): unknown {
  if (!entry.present) return null
  if (entryStatus(entry) === 'valid') return entry.value ?? null
  let raw: unknown
  try {
    raw = storage.readRaw?.(key) ?? entry.value ?? null
  } catch {
    raw = entry.value ?? null
  }
  let serialized: string
  try {
    serialized = typeof raw === 'string' ? raw : JSON.stringify(raw)
  } catch {
    serialized = String(raw ?? '')
  }
  return encodeLosslessBase64(serialized)
}

function entryStatus(entry: StorageEntry): 'missing' | 'valid' | 'unreadable' {
  if (!entry.present) return 'missing'
  try {
    parseEntry(entry)
    return 'valid'
  } catch {
    return 'unreadable'
  }
}

function serializedCanonicalState(
  state: ClientState,
  maxBytes: number,
): { state: ClientState; serialized: string } {
  const parsed = parseStoredStateStrict(state)
  const serialized = JSON.stringify(parsed)
  if (utf8ByteLength(serialized) > maxBytes) {
    throw new Error('本机记录已达到可安全备份的容量上限')
  }
  return { state: parsed, serialized }
}

function assertCanonicalStateFitsExportContract(state: ClientState, maxBytes: number): void {
  if (utf8ByteLength(JSON.stringify(state)) > maxBytes) {
    throw new Error('本机记录已达到可安全备份的容量上限')
  }
}

const WRITE_VERIFICATION_ATTEMPTS = 3

function stateWithAndroidBootstrapSummary(
  state: ClientState,
  canonical: ClientState,
): unknown {
  if (!canonical.onboarded || !canonical.plan || !canonical.settings.sensitiveHealthData) return state
  const date = toShanghaiDate(new Date())
  let count = 0
  // Keep this a single linear pass. Stored RFC3339 offsets may differ, so the
  // parser's ISO-text order is not a safe Shanghai-day early-exit condition.
  for (const item of canonical.cigarettes) {
    const itemDate = toShanghaiDate(item.createdAt)
    if (itemDate === date && item.attemptId === canonical.plan.id) count += item.count
  }
  return {
    ...state,
    [ANDROID_BOOTSTRAP_SUMMARY_FIELD]: {
      version: 1,
      planId: canonical.plan.id,
      date,
      count,
    },
  }
}

function writeAndVerify(storage: LocalStoragePort, key: string, state: ClientState): void {
  const maxBytes = typeof storage.maxStateBytes === 'function'
    ? storage.maxStateBytes()
    : storage.maxStateBytes ?? MAX_CLIENT_STATE_BYTES
  const canonical = serializedCanonicalState(state, maxBytes)
  const expected = canonical.serialized
  // The static Android shell cannot safely duplicate the full strict state
  // migration parser. Persist a tiny versioned summary in the same atomic
  // storage value, so its pre-React count is derived from the exact canonical
  // state that this write verified (including legacy attempt-id migration).
  let reportedWriteError: unknown
  try {
    storage.write(key, stateWithAndroidBootstrapSummary(state, canonical.state))
  } catch (error) {
    // A native bridge result can be lost after its atomic rename committed.
    // The exact canonical readback below decides the outcome, not the timing
    // of the exception delivered to JavaScript.
    reportedWriteError = error
  }
  // A storage bridge can transiently fail one synchronous read immediately
  // after a durable write. Re-read a small bounded number of times before
  // declaring the commit failed; otherwise the UI can report failure while a
  // valid new primary appears after restart (a ghost commit).
  for (let attempt = 0; attempt < WRITE_VERIFICATION_ATTEMPTS; attempt += 1) {
    try {
      const verified = parseEntry(inspectStorage(storage, key), maxBytes)
      if (JSON.stringify(verified) === expected) return
    } catch {
      // Retry synchronously. There is no network or unbounded wait here.
    }
  }
  throw reportedWriteError instanceof Error
    ? reportedWriteError
    : new Error('本机数据写入后校验失败')
}

function removeAndVerify(storage: LocalStoragePort, key: string): void {
  storage.remove(key)
  if (inspectStorage(storage, key).present) throw new Error('本机数据回滚失败')
}

function validDeletionIntent(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 2
    && record.version === DELETION_INTENT_VALUE.version
    && record.intent === DELETION_INTENT_VALUE.intent
}

function hasDeletionIntent(storage: LocalStoragePort): boolean {
  const dedicated = inspectStorage(storage, DELETION_INTENT_STORAGE_KEY)
  if (dedicated.present && !dedicated.error && validDeletionIntent(dedicated.value)) return true
  if (dedicated.present) {
    throw new StoredStateCorruptionError('本机删除状态无法验证')
  }
  // Native storage has an independent atomic marker and never sacrifices the
  // potentially multi-megabyte backup slot. Avoid reading/parsing that slot on
  // every ordinary save. H5 alone retains the quota-fallback contract.
  const supportsDedicated = typeof storage.supportsDedicatedDeletionIntent === 'function'
    ? storage.supportsDedicatedDeletionIntent()
    : storage.supportsDedicatedDeletionIntent
  if (supportsDedicated) {
    let legacyFallback: unknown
    try {
      legacyFallback = storage.readLegacyDeletionFallback?.()
    } catch {
      throw new StoredStateCorruptionError('旧版删除状态无法验证')
    }
    if (!validDeletionIntent(legacyFallback)) return false

    // Older WebView builds could persist the user's confirmed deletion intent
    // in the quota-safe backup slot. Promote that exact tiny marker to the
    // native atomic key before removing either legacy copy, so a crash during
    // upgrade can never revive health data the user already chose to delete.
    let reportedWriteError: unknown
    try {
      storage.write(DELETION_INTENT_STORAGE_KEY, DELETION_INTENT_VALUE)
    } catch (error) {
      reportedWriteError = error
    }
    const migrated = inspectStorage(storage, DELETION_INTENT_STORAGE_KEY)
    if (!migrated.present || migrated.error || !validDeletionIntent(migrated.value)) {
      throw reportedWriteError instanceof Error
        ? reportedWriteError
        : new Error('旧版删除状态无法迁移')
    }
    try { storage.clearLegacyDeletionFallback?.() } catch { /* dedicated marker is authoritative */ }
    return true
  }
  const fallback = inspectStorage(storage, BACKUP_STORAGE_KEY)
  if (fallback.present && !fallback.error && validDeletionIntent(fallback.value)) return true
  return false
}

function beginDeletion(storage: LocalStoragePort): void {
  let alreadyValid = false
  try {
    alreadyValid = hasDeletionIntent(storage)
  } catch {
    // This call is only reachable after the user explicitly confirms deletion
    // (or from a previously validated resume path), so it may replace a broken
    // non-authoritative marker. Startup discovery itself never infers consent.
  }
  if (alreadyValid) return
  let dedicatedWriteError: unknown
  try {
    storage.write(DELETION_INTENT_STORAGE_KEY, DELETION_INTENT_VALUE)
    const dedicated = inspectStorage(storage, DELETION_INTENT_STORAGE_KEY)
    if (dedicated.present && !dedicated.error && validDeletionIntent(dedicated.value)) return
  } catch (error) {
    dedicatedWriteError = error
    // A full WebView origin may not have room for a new key. The verified
    // last-known-good slot already exists and can be atomically replaced by a
    // much smaller deletion marker after explicit user confirmation.
  }
  const supportsDedicated = typeof storage.supportsDedicatedDeletionIntent === 'function'
    ? storage.supportsDedicatedDeletionIntent()
    : storage.supportsDedicatedDeletionIntent
  if (supportsDedicated) {
    throw dedicatedWriteError instanceof Error
      ? dedicatedWriteError
      : new Error('本机删除意图无法持久保存')
  }
  storage.write(BACKUP_STORAGE_KEY, DELETION_INTENT_VALUE)
  const fallback = inspectStorage(storage, BACKUP_STORAGE_KEY)
  if (!fallback.present || fallback.error || !validDeletionIntent(fallback.value)) {
    throw new Error('本机删除意图无法持久保存')
  }
}

function clearCoreAfterDeletionIntent(storage: LocalStoragePort): void {
  if (!hasDeletionIntent(storage)) throw new Error('本机删除意图缺失')
  const backup = inspectStorage(storage, BACKUP_STORAGE_KEY)
  const fallbackMarker = backup.present && !backup.error && validDeletionIntent(backup.value)
  // A normal backup disappears first so a missing primary can never resurrect
  // it. When the backup slot itself is the quota-safe marker it stays until
  // after the primary is gone, preserving crash-resumable authorisation.
  if (!fallbackMarker) {
    storage.remove(BACKUP_STORAGE_KEY)
    if (inspectStorage(storage, BACKUP_STORAGE_KEY).present) throw new Error('本机数据删除后仍可读取')
  }
  storage.remove(STORAGE_KEY)
  if (inspectStorage(storage, STORAGE_KEY).present) throw new Error('本机数据删除后仍可读取')
}

function finishDeletion(storage: LocalStoragePort): void {
  if (inspectStorage(storage, STORAGE_KEY).present) {
    throw new Error('本机核心数据删除后仍可读取')
  }
  const backup = inspectStorage(storage, BACKUP_STORAGE_KEY)
  if (backup.present) {
    if (backup.error || !validDeletionIntent(backup.value)) throw new Error('本机核心数据删除后仍可读取')
    removeAndVerify(storage, BACKUP_STORAGE_KEY)
  }
  if (inspectStorage(storage, DELETION_INTENT_STORAGE_KEY).present) {
    removeAndVerify(storage, DELETION_INTENT_STORAGE_KEY)
  }
}

function rollbackPrimary(storage: LocalStoragePort, previous?: ClientState): void {
  try {
    if (previous) writeAndVerify(storage, STORAGE_KEY, previous)
    else removeAndVerify(storage, STORAGE_KEY)
    return
  } catch {
    // When a previous committed state has already been verified in the backup
    // slot, removing an unverifiable primary forces the next load to use that
    // backup rather than exposing a failed update.
  }
  try {
    removeAndVerify(storage, STORAGE_KEY)
  } catch {
    // The original save failure remains the user-facing error. The verified
    // backup is kept untouched for recovery/error export on the next launch.
  }
}

function rollbackBackup(storage: LocalStoragePort, previous?: ClientState): void {
  try {
    if (previous) writeAndVerify(storage, BACKUP_STORAGE_KEY, previous)
    else removeAndVerify(storage, BACKUP_STORAGE_KEY)
  } catch {
    // The original failure remains authoritative. Startup will fail closed if
    // neither the old backup nor an absent slot can be established.
  }
}

function createRecoverySnapshot(storage: LocalStoragePort): Record<string, unknown> {
  const primary = inspectStorage(storage, STORAGE_KEY)
  const backup = inspectStorage(storage, BACKUP_STORAGE_KEY)
  return {
    exportedAt: new Date().toISOString(),
    readStatus: {
      primary: entryStatus(primary),
      lastKnownGood: entryStatus(backup),
    },
    primary: recoveryValue(storage, STORAGE_KEY, primary),
    lastKnownGood: recoveryValue(storage, BACKUP_STORAGE_KEY, backup),
  }
}

/** Synchronous by design: core flows remain available with no network and no account. */
export function createLocalStateRepository(storage: LocalStoragePort): LocalStateRepository {
  const readLimit = () => typeof storage.maxReadStateBytes === 'function'
    ? storage.maxReadStateBytes()
    : storage.maxReadStateBytes ?? MAX_LEGACY_CLIENT_STATE_READ_BYTES
  return {
    load() {
      if (hasDeletionIntent(storage)) {
        // Never expose old health state while a crash-interrupted deletion is
        // awaiting cross-store cleanup by AppState.
        return { state: parseStoredStateStrict(undefined), recoveredFromBackup: false }
      }
      const primary = inspectStorage(storage, STORAGE_KEY)
      if (!primary.present) {
        const backup = inspectStorage(storage, BACKUP_STORAGE_KEY)
        if (!backup.present) {
          return { state: parseStoredStateStrict(undefined), recoveredFromBackup: false }
        }
        try {
          return { state: parseEntry(backup, readLimit()), recoveredFromBackup: true }
        } catch (backupError) {
          throw backupError instanceof Error ? backupError : new StoredStateCorruptionError()
        }
      }
      try {
        return { state: parseEntry(primary, readLimit()), recoveredFromBackup: false }
      } catch (primaryError) {
        // A present but unreadable primary may be newer than the backup and is
        // still valuable forensic/recovery evidence. Never expose a writable
        // backup state while an ordinary mutation could overwrite those bytes.
        throw primaryError instanceof Error ? primaryError : new StoredStateCorruptionError()
      }
    },
    save(state) {
      if (hasDeletionIntent(storage)) throw new Error('本机数据删除仍在进行')
      const previous = inspectStorage(storage, STORAGE_KEY)
      let backupCandidate: ClientState | undefined
      try {
        const parsedPrevious = parseEntry(previous, readLimit())
        if (parsedPrevious.onboarded) backupCandidate = parsedPrevious
      } catch (error) {
        if (previous.present) {
          // A corrupt primary is immutable until the recovery UI obtains an
          // explicit user decision. This also protects callers that attempt a
          // write without first going through load().
          throw error instanceof Error ? error : new StoredStateCorruptionError()
        }
      }

      // A valid existing primary is the state the caller already observed as
      // committed. Preserve it before replacing the primary so a failed update
      // can still load the previous last-known-good value.
      if (backupCandidate) {
        writeAndVerify(storage, BACKUP_STORAGE_KEY, backupCandidate)
        try {
          writeAndVerify(storage, STORAGE_KEY, state)
        } catch (error) {
          rollbackPrimary(storage, backupCandidate)
          throw error
        }
        return
      }

      let previousBackup: ClientState | undefined
      const previousBackupEntry = inspectStorage(storage, BACKUP_STORAGE_KEY)
      try {
        const parsedBackup = parseEntry(previousBackupEntry, readLimit())
        if (parsedBackup.onboarded) previousBackup = parsedBackup
      } catch (error) {
        if (previousBackupEntry.present) {
          throw error instanceof Error ? error : new StoredStateCorruptionError()
        }
      }

      // With no valid committed primary, the new state must become durable in
      // the primary slot first. Otherwise a primary failure can leave only a
      // newly-written backup, making save report failure while load exposes the
      // failed change as a ghost commit.
      try {
        writeAndVerify(storage, STORAGE_KEY, state)
      } catch (error) {
        rollbackPrimary(storage)
        throw error
      }
      if (!state.onboarded) return
      try {
        writeAndVerify(storage, BACKUP_STORAGE_KEY, state)
      } catch (error) {
        // An onboarded state is not considered durable until both core slots
        // fit. Otherwise the next ordinary mutation can become permanently
        // blocked while the UI has already reported the first save as success.
        rollbackBackup(storage, previousBackup)
        rollbackPrimary(storage)
        throw error
      }
    },
    hasPendingDeletion() {
      return hasDeletionIntent(storage)
    },
    beginDeletion() {
      beginDeletion(storage)
    },
    clearCoreAfterDeletionIntent() {
      clearCoreAfterDeletionIntent(storage)
    },
    finishDeletion() {
      finishDeletion(storage)
    },
    replaceCorruptedPrimaryFromVerifiedBackup(state) {
      if (hasDeletionIntent(storage)) throw new Error('本机数据删除仍在进行')
      const primary = inspectStorage(storage, STORAGE_KEY)
      if (!primary.present) throw new Error('待恢复的主副本不存在')
      try {
        parseEntry(primary, readLimit())
        throw new Error('主副本仍然有效，拒绝恢复覆盖')
      } catch (error) {
        if (error instanceof Error && error.message === '主副本仍然有效，拒绝恢复覆盖') throw error
      }
      const verifiedBackup = parseEntry(inspectStorage(storage, BACKUP_STORAGE_KEY), readLimit())
      const canonical = parseStoredStateStrict(state)
      if (JSON.stringify(verifiedBackup) !== JSON.stringify(canonical)) {
        throw new Error('恢复副本与事务记录不一致')
      }
      // The matching import journal has already been applied at this point.
      // Removing the corrupt primary is therefore an explicit recovery action,
      // not an ordinary mutation that could silently destroy evidence.
      removeAndVerify(storage, STORAGE_KEY)
      writeAndVerify(storage, STORAGE_KEY, canonical)
      writeAndVerify(storage, BACKUP_STORAGE_KEY, canonical)
    },
    clear() {
      beginDeletion(storage)
      clearCoreAfterDeletionIntent(storage)
      finishDeletion(storage)
    },
    recoverySnapshot() {
      return createRecoverySnapshot(storage)
    },
    recoveryBundle() {
      return JSON.stringify(createRecoverySnapshot(storage), null, 2)
    },
  }
}
