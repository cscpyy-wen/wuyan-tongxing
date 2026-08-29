import { parseStoredStateStrict } from './model'
import { sanitizeAndroidBootstrapRecoveryData } from './androidBootstrapQueue'
import type { ClientState } from '../types'
import { MAX_RECOVERY_IMPORT_CHARACTERS, parseRecoveryImportCandidate } from './recoveryBundle'

export interface RestoredOpenJsonEvent {
  success: boolean
  data?: {
    selected?: unknown
    json?: unknown
    id?: unknown
    byteLength?: unknown
    sha256?: unknown
    displayName?: unknown
    lastModifiedEpochMillis?: unknown
  } | null
}

/** Contains both synchronous setup errors and rejected restored-result work. */
export async function runRestoredOpenJsonProcessingSafely(
  operation: () => Promise<void>,
  notifyFailure: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation()
  } catch {
    try { await notifyFailure() } catch { /* never leak an unhandled restored-result rejection */ }
  }
}

export interface NativeBackupRestoreDependencies {
  currentState: ClientState
  isCurrent(): boolean
  importData(json: string): false | { bootstrapRecoverySkipped: boolean }
}

export type RestoredOpenJsonOutcome =
  | { status: 'cancelled' }
  | { status: 'invalid' }
  | { status: 'read-failed' }
  | { status: 'save-failed'; reminderRollbackFailed: false }
  | { status: 'stale'; reminderRollbackFailed: false }
  | {
    status: 'restored'
    reminderUnavailable: boolean
    reminderScheduled: boolean
    bootstrapRecoverySkipped: boolean
  }

export function shouldRetainNativeRestorePayload(
  outcome: RestoredOpenJsonOutcome,
): outcome is Extract<RestoredOpenJsonOutcome, { status: 'save-failed' | 'stale' }> {
  return outcome.status === 'save-failed' || outcome.status === 'stale'
}

interface ImportCandidate {
  state: ClientState
  bootstrapRecovery?: unknown
  bootstrapRecoverySkipped: boolean
}

export interface NativeBackupRestoreSummary {
  planPath: 'abrupt' | 'reduction'
  planCreatedAt: string
  quitDate: string
  attemptNumber: number
  cigaretteCount: number
  cravingCount: number
  checkInCount: number
  lapseCount: number
  reminderWillBeDisabled: boolean
}

function parseImportCandidate(json: unknown): ImportCandidate | undefined {
  if (typeof json !== 'string' || json.length === 0 || json.length > MAX_RECOVERY_IMPORT_CHARACTERS) return undefined
  try {
    const parsed = JSON.parse(json) as unknown
    const recovery = parseRecoveryImportCandidate(parsed)
    const imported = recovery?.state ?? parseStoredStateStrict(parsed)
    if (!imported.onboarded || !imported.plan || !imported.baseline || !imported.settings.sensitiveHealthData) {
      return undefined
    }
    const bootstrapRecoveryPresent = recovery?.bootstrapRecovery !== undefined || Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && Object.prototype.hasOwnProperty.call(parsed, '_androidBootstrapRecovery'))
    const rawBootstrapRecovery = recovery?.bootstrapRecovery ?? (bootstrapRecoveryPresent
      ? (parsed as { _androidBootstrapRecovery?: unknown })._androidBootstrapRecovery
      : undefined)
    const sanitized = sanitizeAndroidBootstrapRecoveryData(rawBootstrapRecovery)
    const bootstrapRecovery = sanitized.snapshot
    const bootstrapRecoverySkipped = Boolean(recovery?.bootstrapRecoverySkipped) || sanitized.skippedInvalidData
    return {
      state: imported,
      bootstrapRecoverySkipped,
      ...(bootstrapRecoveryPresent ? { bootstrapRecovery } : {}),
    }
  } catch {
    return undefined
  }
}

export function summarizeNativeBackupRestore(json: unknown): NativeBackupRestoreSummary | undefined {
  const candidate = parseImportCandidate(json)
  const plan = candidate?.state.plan
  if (!candidate || !plan) return undefined
  const { state } = candidate
  return {
    planPath: plan.path,
    planCreatedAt: plan.createdAt,
    quitDate: plan.quitDate,
    attemptNumber: plan.attemptNumber,
    cigaretteCount: state.cigarettes.length,
    cravingCount: state.cravings.length,
    checkInCount: state.checkIns.length,
    lapseCount: state.lapses.length,
    reminderWillBeDisabled: true,
  }
}

export function formatNativeBackupRestoreConfirmation(
  summary: NativeBackupRestoreSummary,
  file: {
    byteLength: number
    sha256: string
    displayName?: string
    lastModifiedEpochMillis?: number
  },
): string {
  const createdAt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(summary.planCreatedAt))
  const size = file.byteLength < 1024
    ? `${file.byteLength} B`
    : `${(file.byteLength / 1024).toFixed(1)} KiB`
  const fileModified = file.lastModifiedEpochMillis
    ? new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(file.lastModifiedEpochMillis))
    : undefined
  const beijingExportMatch = file.displayName?.match(
    /^wuyan-tongxing-backup-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_Beijing\.json$/u,
  )
  const beijingExportTime = beijingExportMatch
    ? `${beijingExportMatch[1]}-${beijingExportMatch[2]}-${beijingExportMatch[3]} ${beijingExportMatch[4]}:${beijingExportMatch[5]}:${beijingExportMatch[6]}`
    : undefined
  const validBeijingExportTime = beijingExportTime
    && formatBeijingExportTime(new Date(`${beijingExportTime.replace(' ', 'T')}+08:00`)) === beijingExportTime
    ? beijingExportTime
    : undefined
  const legacyUtcMatch = file.displayName?.match(
    /^wuyan-tongxing-backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/u,
  )
  const legacyUtcIso = legacyUtcMatch
    ? `${legacyUtcMatch[1]}-${legacyUtcMatch[2]}-${legacyUtcMatch[3]}T${legacyUtcMatch[4]}:${legacyUtcMatch[5]}:${legacyUtcMatch[6]}.${legacyUtcMatch[7]}Z`
    : undefined
  const legacyUtcDate = legacyUtcIso ? new Date(legacyUtcIso) : undefined
  const legacyExportTime = legacyUtcDate
    && Number.isFinite(legacyUtcDate.getTime())
    && legacyUtcDate.toISOString() === legacyUtcIso
    ? formatBeijingExportTime(legacyUtcDate)
    : undefined
  return [
    `文件：${file.displayName ?? '系统未提供名称'}`,
    ...(validBeijingExportTime
      ? [`导出时间：${validBeijingExportTime}（由文件名标注，北京时间）`]
      : legacyExportTime
        ? [`导出时间：${legacyExportTime}（由旧版 UTC 文件名换算，北京时间）`]
        : []),
    `文件修改：${fileModified ? `${fileModified}（系统元数据，北京时间）` : '系统未提供'}`,
    '',
    `${summary.planPath === 'abrupt' ? '直接戒断' : '限期减量'} · 第 ${summary.attemptNumber} 次尝试`,
    `计划创建：${createdAt}（北京时间） · 戒烟日 ${summary.quitDate}`,
    `烟支 ${summary.cigaretteCount} · 烟瘾 ${summary.cravingCount} · 打卡 ${summary.checkInCount} · 复盘 ${summary.lapseCount}`,
    '',
    `大小：${size} · 校验码：${file.sha256.slice(0, 12).toUpperCase()}`,
    '',
    '确认后替换当前数据。',
    '每日提醒将保持关闭，可在“我的”重新开启。',
  ].join('\n')
}

function formatBeijingExportTime(date: Date): string | undefined {
  if (!Number.isFinite(date.getTime())) return undefined
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value
  const year = value('year')
  const month = value('month')
  const day = value('day')
  const hour = value('hour')
  const minute = value('minute')
  const second = value('second')
  return year && month && day && hour && minute && second
    ? `${year}-${month}-${day} ${hour}:${minute}:${second}`
    : undefined
}

/**
 * Completes an openJson result delivered after Android recreated the process.
 * Parsing happens before local state is touched. Imported reminders are always
 * persisted disabled and can be re-enabled explicitly afterwards. This makes
 * the repository commit the only transaction boundary: a process death at any
 * instruction cannot leave a platform notification that disagrees with a
 * newly imported local toggle.
 */
export async function consumeRestoredOpenJson(
  event: RestoredOpenJsonEvent,
  dependencies: NativeBackupRestoreDependencies,
): Promise<RestoredOpenJsonOutcome> {
  if (!event.success) return { status: 'read-failed' }
  if (event.data?.selected === false) return { status: 'cancelled' }
  if (event.data?.selected !== true) return { status: 'invalid' }

  const candidate = parseImportCandidate(event.data?.json)
  if (!candidate) return { status: 'invalid' }
  const imported = candidate.state
  if (!dependencies.isCurrent()) return { status: 'stale', reminderRollbackFailed: false }

  const reminderRequested = imported.settings.inAppReminder
  const adjustedImport = reminderRequested
    ? { ...imported, settings: { ...imported.settings, inAppReminder: false } }
    : imported
  if (!dependencies.isCurrent()) return { status: 'stale', reminderRollbackFailed: false }
  const saved = dependencies.importData(JSON.stringify({
    ...adjustedImport,
    ...(candidate.bootstrapRecovery === undefined
      ? {}
      : { _androidBootstrapRecovery: candidate.bootstrapRecovery }),
    ...(candidate.bootstrapRecoverySkipped ? { _androidBootstrapRecoverySkipped: true } : {}),
  }))
  if (!saved) return { status: 'save-failed', reminderRollbackFailed: false }
  return {
    status: 'restored',
    reminderUnavailable: reminderRequested,
    reminderScheduled: false,
    bootstrapRecoverySkipped: candidate.bootstrapRecoverySkipped || saved.bootstrapRecoverySkipped,
  }
}
