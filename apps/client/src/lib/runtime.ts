import { validTimestamp } from './model'

type CapacitorRuntime = {
  getPlatform?: () => string
  isNativePlatform?: () => boolean
  Plugins?: {
    PersonalExport?: PersonalExportPlugin
    QuickRecord?: QuickRecordPlugin
  }
}

declare global {
  interface Window {
    Capacitor?: CapacitorRuntime
  }
}

type PersonalExportPlugin = {
  saveJson: (options: { json: string; filename: string; recovery?: true }) => Promise<{ saved: boolean }>
  openJson: () => Promise<NativeOpenJsonSelection>
  probePendingOpenJson: () => Promise<NativePendingOpenJsonProbe>
  readPendingOpenJsonChunk: (options: { id: string; offset: number }) => Promise<unknown>
  acknowledgePendingOpenJson: (options: { id: string }) => Promise<{
    acknowledged: boolean
    alreadyAcknowledged?: boolean
  }>
  openNotificationSettings: () => Promise<{ opened: boolean }>
  purgePendingExports: () => Promise<void>
  purgeAppPrivatePendingExports: () => Promise<void>
  acknowledgeSelectedDocumentCleanup: () => Promise<void>
  getCleanupWarning: () => Promise<{ pending: boolean; issue?: NativeExportCleanupIssue; filename?: string }>
  forgetCorruptExportOutcome: () => Promise<void>
  getLastExportOutcome: () => Promise<{ available: boolean; saved?: boolean; id?: string; filename?: string }>
  acknowledgeLastExportOutcome: (options: { id: string }) => Promise<void>
}

type QuickRecordPlugin = {
  requestPinWidget: () => Promise<{ supported: boolean; requested: boolean }>
  requestAddTile: () => Promise<{ result: 'added' | 'already-added' | 'not-added' | 'unavailable' }>
  addListener: (
    eventName: 'recordCommitted',
    listener: (event: { id?: unknown; smokedAt?: unknown }) => void,
  ) => Promise<{ remove: () => Promise<void> }>
}

export interface NativePendingOpenJsonMetadata {
  id: string
  byteLength: number
  sha256: string
  displayName?: string
  lastModifiedEpochMillis?: number
}

export type NativeOpenJsonSelection =
  | { selected: false }
  | ({ selected: true } & NativePendingOpenJsonMetadata)

export type NativePendingOpenJsonProbe =
  | { available: false }
  | ({ available: true } & NativePendingOpenJsonMetadata)

export interface VerifiedNativeOpenJson extends NativePendingOpenJsonMetadata {
  json: string
}

export const MAX_NATIVE_OPEN_JSON_BYTES = 12 * 1024 * 1024
export const MAX_NATIVE_OPEN_JSON_CHUNK_BYTES = 256 * 1024
export const MAX_NATIVE_ORDINARY_SAVE_BYTES = 4 * 1024 * 1024
export const MAX_NATIVE_RECOVERY_SAVE_BYTES = 12 * 1024 * 1024
export const MAX_NATIVE_SAVE_ESCAPED_BYTES = 13 * 1024 * 1024
export const MAX_NATIVE_RECOVERY_ESCAPE_OVERHEAD_BYTES = 1024 * 1024

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const MAX_CHUNK_BASE64_CHARACTERS = Math.ceil(MAX_NATIVE_OPEN_JSON_CHUNK_BYTES / 3) * 4
export const NATIVE_OPEN_JSON_READY_EVENT = 'wuyan:native-open-json-ready'
export const NATIVE_OPEN_JSON_RETRY_EVENT = 'wuyan:native-open-json-retry'

export class NativeOpenJsonReadError extends Error {
  readonly terminal = true

  constructor(message: string) {
    super(message)
    this.name = 'NativeOpenJsonReadError'
  }
}

export function isTerminalNativeOpenJsonReadError(error: unknown): error is NativeOpenJsonReadError {
  return error instanceof NativeOpenJsonReadError && error.terminal === true
}

export type NativeExportCleanupIssue =
  | 'selected-document'
  | 'local-temporary'
  | 'both'
  | 'saved-local-temporary'
  | 'export-outcome'
  | 'pending-export-outcome'

export interface NativeExportCleanupNotice {
  issue: NativeExportCleanupIssue
  filename?: string
}

export interface NativeExportOutcome {
  id: string
  saved: true
  filename?: string
}

function getPersonalExport(): PersonalExportPlugin {
  // Capacitor injects native plugin proxies before the app bundle runs. Using
  // that proxy also avoids a WebView-only deadlock observed when the H5
  // webpack runtime dynamically imported a second @capacitor/core instance.
  const plugin = window.Capacitor?.Plugins?.PersonalExport
  if (!plugin) throw new Error('PersonalExport native plugin is unavailable')
  return plugin
}

function getQuickRecord(): QuickRecordPlugin {
  const plugin = window.Capacitor?.Plugins?.QuickRecord
  if (!plugin) throw new Error('QuickRecord native plugin is unavailable')
  return plugin
}

export async function requestNativeQuickRecordWidget(): Promise<{
  supported: boolean
  requested: boolean
}> {
  if (!isNativeAndroidApp()) throw new Error('Native Android quick record is unavailable')
  const result = await getQuickRecord().requestPinWidget()
  if (typeof result?.supported !== 'boolean' || typeof result.requested !== 'boolean') {
    throw new Error('Native widget request returned invalid data')
  }
  return result
}

export async function requestNativeQuickRecordTile(): Promise<
  'added' | 'already-added' | 'not-added' | 'unavailable'
> {
  if (!isNativeAndroidApp()) throw new Error('Native Android quick record is unavailable')
  const result = await getQuickRecord().requestAddTile()
  if (!['added', 'already-added', 'not-added', 'unavailable'].includes(result?.result)) {
    throw new Error('Native tile request returned invalid data')
  }
  return result.result
}

export async function addNativeQuickRecordListener(
  listener: () => void,
): Promise<{ remove: () => Promise<void> }> {
  if (!isNativeAndroidApp()) throw new Error('Native Android quick record is unavailable')
  return getQuickRecord().addListener('recordCommitted', (event) => {
    if (typeof event?.id !== 'string' || !UUID_PATTERN.test(event.id)
      || !validTimestamp(event.smokedAt)) return
    listener()
  })
}

function strictUtf8AndJsonEscapedLengths(value: string, stopAfter: number): {
  byteLength: number
  escapedByteLength: number
} {
  let byteLength = 0
  let escapedByteLength = 0
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index)
    let encoded = 0
    let escaped = 0
    if (current === 0x22 || current === 0x5c
      || current === 0x08 || current === 0x09 || current === 0x0a
      || current === 0x0c || current === 0x0d) {
      encoded = 1
      escaped = 2
    } else if (current <= 0x1f) {
      encoded = 1
      escaped = 6
    } else if (current <= 0x7f) {
      encoded = escaped = 1
    } else if (current <= 0x7ff) {
      encoded = escaped = 2
    } else if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) throw new Error('导出数据包含无效 UTF-16 字符')
      index += 1
      encoded = escaped = 4
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      throw new Error('导出数据包含无效 UTF-16 字符')
    } else {
      encoded = escaped = 3
    }
    byteLength += encoded
    escapedByteLength += escaped
    if (byteLength > stopAfter || escapedByteLength > MAX_NATIVE_SAVE_ESCAPED_BYTES) break
  }
  return { byteLength, escapedByteLength }
}

export function assessNativeSaveJsonPayload(
  json: string,
  recovery = false,
): { byteLength: number; escapedByteLength: number } {
  if (typeof json !== 'string') throw new Error('导出数据无效')
  const maximum = recovery ? MAX_NATIVE_RECOVERY_SAVE_BYTES : MAX_NATIVE_ORDINARY_SAVE_BYTES
  const lengths = strictUtf8AndJsonEscapedLengths(json, maximum)
  if (lengths.byteLength > maximum) {
    throw new Error(recovery ? '恢复副本超过 12 MiB 安全上限' : '数据副本超过 4 MiB 安全上限')
  }
  if (lengths.escapedByteLength > MAX_NATIVE_SAVE_ESCAPED_BYTES) {
    throw new Error('导出数据的桥接封装超过安全上限')
  }
  if (recovery) {
    const lowEscape = lengths.escapedByteLength - lengths.byteLength <= MAX_NATIVE_RECOVERY_ESCAPE_OVERHEAD_BYTES
      && json.startsWith('{')
      && json.endsWith('}')
      && json.includes('"readStatus"')
      && json.includes('"primary"')
      && json.includes('"lastKnownGood"')
      && json.includes('"_recoveryIntegrity"')
    if (!lowEscape) throw new Error('恢复副本不是可安全桥接的低转义格式')
  }
  return lengths
}

export function parseNativePendingOpenJsonMetadata(value: unknown): NativePendingOpenJsonMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Native pending openJson metadata is invalid')
  }
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string'
    || !UUID_PATTERN.test(record.id)
    || !Number.isSafeInteger(record.byteLength)
    || Number(record.byteLength) <= 0
    || Number(record.byteLength) > MAX_NATIVE_OPEN_JSON_BYTES
    || typeof record.sha256 !== 'string'
    || !SHA256_PATTERN.test(record.sha256)) {
    throw new Error('Native pending openJson metadata is invalid')
  }
  const displayName = typeof record.displayName === 'string'
    && record.displayName === record.displayName.trim()
    && record.displayName.length > 0
    && record.displayName.length <= 120
    && !/[\u0000-\u001f\u007f/\\]/u.test(record.displayName)
    ? record.displayName
    : undefined
  if (record.displayName !== undefined && displayName === undefined) {
    throw new Error('Native pending openJson metadata is invalid')
  }
  const lastModifiedEpochMillis = record.lastModifiedEpochMillis === undefined
    ? undefined
    : typeof record.lastModifiedEpochMillis === 'number'
      ? record.lastModifiedEpochMillis
      : Number.NaN
  if (lastModifiedEpochMillis !== undefined
    && (!Number.isSafeInteger(lastModifiedEpochMillis)
      || lastModifiedEpochMillis <= 0
      || lastModifiedEpochMillis > 253_402_300_799_999)) {
    throw new Error('Native pending openJson metadata is invalid')
  }
  return {
    id: record.id,
    byteLength: Number(record.byteLength),
    sha256: record.sha256,
    ...(displayName ? { displayName } : {}),
    ...(lastModifiedEpochMillis ? { lastModifiedEpochMillis } : {}),
  }
}

export function dispatchNativeOpenJsonReady(metadata: NativePendingOpenJsonMetadata): void {
  const verified = parseNativePendingOpenJsonMetadata(metadata)
  window.dispatchEvent(new CustomEvent(NATIVE_OPEN_JSON_READY_EVENT, { detail: verified }))
}

export function dispatchNativeOpenJsonRetry(): void {
  window.dispatchEvent(new Event(NATIVE_OPEN_JSON_RETRY_EVENT))
}

function decodeCanonicalBase64Chunk(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string'
    || value.length > MAX_CHUNK_BASE64_CHARACTERS
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new NativeOpenJsonReadError('Native pending openJson chunk base64 is invalid')
  }
  let decoded: string
  try {
    decoded = globalThis.atob(value)
  } catch {
    throw new NativeOpenJsonReadError('Native pending openJson chunk base64 is invalid')
  }
  if (decoded.length > MAX_NATIVE_OPEN_JSON_CHUNK_BYTES) {
    throw new NativeOpenJsonReadError('Native pending openJson chunk is too large')
  }
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index)
  // atob accepts non-canonical trailing pad bits. Round-trip the bounded chunk
  // so two textual encodings cannot authenticate as the same bridge message.
  let canonical = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    canonical += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  if (globalThis.btoa(canonical) !== value) {
    throw new NativeOpenJsonReadError('Native pending openJson chunk base64 is not canonical')
  }
  return bytes
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('当前系统不支持备份完整性校验')
  const digest = await subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
const DAILY_REMINDER_ID = 932_001
let dailyReminderMutationRevision = 0

const nativeBackHandlers: Array<() => void> = []

export function registerNativeBackHandler(handler: () => void): () => void {
  nativeBackHandlers.push(handler)
  let active = true
  return () => {
    if (!active) return
    active = false
    const index = nativeBackHandlers.lastIndexOf(handler)
    if (index >= 0) nativeBackHandlers.splice(index, 1)
  }
}

export function consumeNativeBackHandler(): boolean {
  const handler = nativeBackHandlers.at(-1)
  if (!handler) return false
  try {
    handler()
  } catch {
    // The overlay still owns this press even if its close callback fails.
  }
  return true
}

function isDisplayed(element: HTMLElement): boolean {
  if (element.hidden || element.style.display === 'none' || element.style.visibility === 'hidden') return false
  const view = element.ownerDocument.defaultView
  if (!view) return true
  const computed = view.getComputedStyle(element)
  return computed.display !== 'none' && computed.visibility !== 'hidden'
}

/**
 * Taro H5 renders showModal and Picker outside React's component tree. The
 * Capacitor back-button listener therefore has to dismiss those overlays
 * before applying route/root navigation. Programmatic clicks intentionally
 * use Taro's own cancel handlers so pending promises and Picker cancel events
 * resolve exactly as they do after a visible tap.
 */
export function consumeTaroOverlayBack(ownerDocument: Document = document): boolean {
  const pickerOverlays = Array.from(ownerDocument.querySelectorAll<HTMLElement>('.weui-picker__overlay'))
  const picker = pickerOverlays.reverse().find(isDisplayed)
  if (picker) {
    const cancel = picker.querySelector<HTMLElement>('.weui-picker__action')
      ?? picker.querySelector<HTMLElement>('.weui-mask')
    cancel?.click()
    return true
  }

  const modals = Array.from(ownerDocument.querySelectorAll<HTMLElement>('.taro__modal'))
  const modal = modals.reverse().find(isDisplayed)
  if (modal) {
    // Taro keeps the cancel node and handler even for one-button modals; a
    // synthetic cancel cleanly dismisses without accidentally confirming.
    modal.querySelector<HTMLElement>('.taro-model__cancel')?.click()
    return true
  }

  return false
}

export function isNativeAndroidApp(): boolean {
  if (typeof window === 'undefined') return false
  const capacitor = window.Capacitor
  if (!capacitor?.isNativePlatform?.()) return false
  return capacitor.getPlatform?.() === 'android'
}

export function isNativeIOSApp(): boolean {
  if (typeof window === 'undefined') return false
  const capacitor = window.Capacitor
  return capacitor?.isNativePlatform?.() === true && capacitor.getPlatform?.() === 'ios'
}

export function isNativeMobileApp(): boolean {
  return isNativeAndroidApp() || isNativeIOSApp()
}

export async function shareNativeText(title: string, text: string): Promise<void> {
  if (!isNativeMobileApp()) throw new Error('Native mobile share is unavailable')
  const { Share } = await import('@capacitor/share')
  await Share.share({ title, text, dialogTitle: '选择要发送到的应用' })
}

export type DailyReminderResult = 'scheduled' | 'denied' | 'unsupported'
export type DailyReminderReconciliationResult = 'active' | 'disabled' | 'stale' | 'unsupported'

export function getDailyReminderMutationRevision(): number {
  return dailyReminderMutationRevision
}

async function scheduleDailyReminderInternal(
  hour: number,
  requestPermission: boolean,
): Promise<DailyReminderResult> {
  if (!isNativeMobileApp()) return 'unsupported'
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('提醒时间无效')
  dailyReminderMutationRevision += 1

  const { LocalNotifications } = await import('@capacitor/local-notifications')
  let permission = await LocalNotifications.checkPermissions()
  if (permission.display !== 'granted' && requestPermission) {
    permission = await LocalNotifications.requestPermissions()
  }
  if (permission.display !== 'granted') return 'denied'

  await LocalNotifications.cancel({ notifications: [{ id: DAILY_REMINDER_ID }] })
  await LocalNotifications.schedule({
    notifications: [{
      id: DAILY_REMINDER_ID,
      title: '无烟同行',
      body: '今天的记录和任务还在这里。',
      schedule: { on: { hour, minute: 0 }, allowWhileIdle: false },
      isExactNotification: false,
      extra: { route: '/pages/today/index' },
    }],
  })
  const pending = await LocalNotifications.getPending()
  if (!pending.notifications.some((item) => item.id === DAILY_REMINDER_ID)) {
    throw new Error('系统未保留提醒计划')
  }
  return 'scheduled'
}

/** User-triggered scheduling may request notification permission. */
export async function scheduleDailyReminder(hour: number): Promise<DailyReminderResult> {
  return scheduleDailyReminderInternal(hour, true)
}

/**
 * Rebuild an already-authorised reminder against the current Android local
 * clock. This is used on every foreground transition so a timezone or DST
 * change cannot leave the notification pinned to the old absolute instant.
 * It deliberately never opens a permission prompt.
 */
export async function rescheduleDailyReminderForLocalTime(hour: number): Promise<DailyReminderResult> {
  return scheduleDailyReminderInternal(hour, false)
}

export async function cancelDailyReminder(): Promise<void> {
  if (!isNativeMobileApp()) return
  dailyReminderMutationRevision += 1
  const { LocalNotifications } = await import('@capacitor/local-notifications')
  await LocalNotifications.cancel({ notifications: [{ id: DAILY_REMINDER_ID }] })
}

export async function isDailyReminderScheduled(): Promise<boolean> {
  if (!isNativeMobileApp()) return false
  const { LocalNotifications } = await import('@capacitor/local-notifications')
  const permission = await LocalNotifications.checkPermissions()
  if (permission.display !== 'granted') return false
  const pending = await LocalNotifications.getPending()
  return pending.notifications.some((item) => item.id === DAILY_REMINDER_ID)
}

/**
 * Reconciles a permission/pending-notification change with the persisted local
 * toggle. The mutation revision is captured before the asynchronous system
 * read. If the user starts a schedule/cancel action while that read or the
 * cleanup is in flight, the stale lifecycle result is not allowed to overwrite
 * the user's newer choice.
 */
export async function reconcileDailyReminderAfterSystemChange(
  onSystemDisabled: () => void,
): Promise<DailyReminderReconciliationResult> {
  if (!isNativeMobileApp()) return 'unsupported'
  const observedRevision = dailyReminderMutationRevision
  const scheduled = await isDailyReminderScheduled()
  if (dailyReminderMutationRevision !== observedRevision) return 'stale'
  if (scheduled) return 'active'

  // cancelDailyReminder increments synchronously before its first await, so a
  // concurrent reconciler becomes stale before it can issue another cleanup.
  await cancelDailyReminder()
  if (dailyReminderMutationRevision !== observedRevision + 1) return 'stale'
  onSystemDisabled()
  return 'disabled'
}

export function formatBeijingBackupTimestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error('备份时间无效')
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}_${values.hour}-${values.minute}-${values.second}_Beijing`
}

export async function saveNativeJsonFile(json: string, now = new Date(), filename?: string): Promise<boolean> {
  if (!isNativeMobileApp()) throw new Error('Native mobile file export is unavailable')
  const PersonalExport = getPersonalExport()
  assessNativeSaveJsonPayload(json, false)
  const requestedFilename = filename ?? `wuyan-tongxing-backup-${formatBeijingBackupTimestamp(now)}.json`
  if (safeNativeExportFilename(requestedFilename) !== requestedFilename) throw new Error('导出文件名无效')
  const result = await PersonalExport.saveJson({
    json,
    filename: requestedFilename,
  })
  return result.saved
}

export async function saveNativeRecoveryJsonFile(
  json: string,
  now = new Date(),
  filename?: string,
): Promise<boolean> {
  if (!isNativeMobileApp()) throw new Error('Native mobile file export is unavailable')
  const PersonalExport = getPersonalExport()
  assessNativeSaveJsonPayload(json, true)
  const requestedFilename = filename ?? `wuyan-tongxing-recovery-${formatBeijingBackupTimestamp(now)}.json`
  if (safeNativeExportFilename(requestedFilename) !== requestedFilename) throw new Error('导出文件名无效')
  return (await PersonalExport.saveJson({ json, filename: requestedFilename, recovery: true })).saved
}

export async function probeNativePendingOpenJson(): Promise<NativePendingOpenJsonMetadata | undefined> {
  if (!isNativeMobileApp()) return undefined
  const result = await getPersonalExport().probePendingOpenJson()
  if (result?.available === false) return undefined
  if (result?.available !== true) throw new Error('Native pending openJson probe is invalid')
  return parseNativePendingOpenJsonMetadata(result)
}

export async function readAndVerifyNativePendingOpenJson(
  descriptor: NativePendingOpenJsonMetadata,
): Promise<VerifiedNativeOpenJson> {
  if (!isNativeMobileApp()) throw new Error('Native mobile file import is unavailable')
  const expected = parseNativePendingOpenJsonMetadata(descriptor)
  // Validate the trusted upper bound before making the only payload-sized
  // allocation. Every later bridge envelope remains <= one 256 KiB chunk.
  const bytes = new Uint8Array(expected.byteLength)
  let offset = 0
  let reads = 0
  const maximumReads = Math.ceil(expected.byteLength / MAX_NATIVE_OPEN_JSON_CHUNK_BYTES)
  while (offset < expected.byteLength) {
    if (reads >= maximumReads) throw new NativeOpenJsonReadError('Native pending openJson made no bounded progress')
    reads += 1
    const raw = await getPersonalExport().readPendingOpenJsonChunk({ id: expected.id, offset })
    let current: NativePendingOpenJsonMetadata
    try {
      current = parseNativePendingOpenJsonMetadata(raw)
    } catch {
      throw new NativeOpenJsonReadError('Native pending openJson chunk metadata is invalid')
    }
    if (current.id !== expected.id
      || current.byteLength !== expected.byteLength
      || current.sha256 !== expected.sha256
      || current.displayName !== expected.displayName
      || current.lastModifiedEpochMillis !== expected.lastModifiedEpochMillis) {
      throw new NativeOpenJsonReadError('Native pending openJson metadata changed during reconstruction')
    }
    const record = raw as Record<string, unknown>
    if (record.offset !== offset
      || !Number.isSafeInteger(record.nextOffset)
      || Number(record.nextOffset) <= offset
      || Number(record.nextOffset) > expected.byteLength
      || typeof record.done !== 'boolean'
      || record.done !== (Number(record.nextOffset) === expected.byteLength)
      || typeof record.chunkSha256 !== 'string'
      || !SHA256_PATTERN.test(record.chunkSha256)) {
      throw new NativeOpenJsonReadError('Native pending openJson chunk offsets are invalid')
    }
    const chunk = decodeCanonicalBase64Chunk(record.chunkBase64)
    const nextOffset = Number(record.nextOffset)
    if (chunk.length !== nextOffset - offset || chunk.length > MAX_NATIVE_OPEN_JSON_CHUNK_BYTES) {
      throw new NativeOpenJsonReadError('Native pending openJson chunk length is invalid')
    }
    if (await sha256Hex(chunk) !== record.chunkSha256) {
      throw new NativeOpenJsonReadError('Native pending openJson chunk hash mismatch')
    }
    bytes.set(chunk, offset)
    offset = nextOffset
  }
  if (reads !== maximumReads && expected.byteLength > MAX_NATIVE_OPEN_JSON_CHUNK_BYTES * reads) {
    throw new NativeOpenJsonReadError('Native pending openJson ended early')
  }
  if (await sha256Hex(bytes) !== expected.sha256) {
    throw new NativeOpenJsonReadError('Native pending openJson final hash mismatch')
  }
  let json: string
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new NativeOpenJsonReadError('备份文件不是有效 UTF-8')
  }
  if (json.length === 0 || json.length > MAX_NATIVE_OPEN_JSON_BYTES) {
    throw new NativeOpenJsonReadError('备份文件为空或超过安全上限')
  }
  return { ...expected, json }
}

export async function acknowledgeNativePendingOpenJson(id: string): Promise<{
  acknowledged: true
  alreadyAcknowledged: boolean
}> {
  if (!isNativeMobileApp()) throw new Error('Native mobile file import is unavailable')
  if (!UUID_PATTERN.test(id)) throw new Error('Native pending openJson id is invalid')
  const response = await getPersonalExport().acknowledgePendingOpenJson({ id })
  if (response?.acknowledged !== true
    || (response.alreadyAcknowledged !== undefined && typeof response.alreadyAcknowledged !== 'boolean')) {
    throw new Error('Native pending openJson acknowledgement is invalid')
  }
  return { acknowledged: true, alreadyAcknowledged: response.alreadyAcknowledged === true }
}

export async function selectNativeOpenJson(): Promise<NativePendingOpenJsonMetadata | undefined> {
  if (!isNativeMobileApp()) throw new Error('Native mobile file import is unavailable')
  const PersonalExport = getPersonalExport()
  const result = await PersonalExport.openJson()
  if (!result.selected) return undefined
  return parseNativePendingOpenJsonMetadata(result)
}

export async function openNativeJsonFile(): Promise<VerifiedNativeOpenJson | undefined> {
  const selected = await selectNativeOpenJson()
  return selected ? readAndVerifyNativePendingOpenJson(selected) : undefined
}

export async function openNativeNotificationSettings(): Promise<boolean> {
  if (!isNativeMobileApp()) throw new Error('Native mobile notification settings are unavailable')
  return (await getPersonalExport().openNotificationSettings()).opened
}

export async function purgeNativePendingExports(): Promise<void> {
  if (!isNativeMobileApp()) return
  const PersonalExport = getPersonalExport()
  await PersonalExport.purgePendingExports()
}

export async function purgeNativeAppPrivatePendingExports(): Promise<void> {
  if (!isNativeMobileApp()) return
  await getPersonalExport().purgeAppPrivatePendingExports()
}

export async function acknowledgeNativeSelectedDocumentCleanup(): Promise<void> {
  if (!isNativeMobileApp()) return
  await getPersonalExport().acknowledgeSelectedDocumentCleanup()
}

export async function getNativeExportCleanupWarning(): Promise<NativeExportCleanupNotice | undefined> {
  if (!isNativeMobileApp()) return undefined
  const PersonalExport = getPersonalExport()
  const warning = await PersonalExport.getCleanupWarning()
  if (!warning.pending) return undefined
  const issue = warning.issue === 'selected-document'
    || warning.issue === 'local-temporary'
    || warning.issue === 'both'
    || warning.issue === 'saved-local-temporary'
    || warning.issue === 'export-outcome'
    ? warning.issue
    : 'local-temporary'
  const filename = typeof warning.filename === 'string'
    && warning.filename.length > 0
    && warning.filename.length <= 120
    && /^[A-Za-z0-9._-]+\.json$/iu.test(warning.filename)
    ? warning.filename
    : undefined
  return { issue, ...(filename ? { filename } : {}) }
}

export async function forgetNativeCorruptExportOutcome(): Promise<void> {
  if (!isNativeMobileApp()) return
  await getPersonalExport().forgetCorruptExportOutcome()
}

function safeNativeExportFilename(value: unknown): string | undefined {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 120
    && /^[A-Za-z0-9._-]+\.json$/iu.test(value)
    ? value
    : undefined
}

export async function getNativeLastExportOutcome(): Promise<NativeExportOutcome | undefined> {
  if (!isNativeMobileApp()) return undefined
  const result = await getPersonalExport().getLastExportOutcome()
  if (!result.available) return undefined
  if (result.saved !== true
    || typeof result.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result.id)) {
    throw new Error('Native export outcome is invalid')
  }
  const filename = safeNativeExportFilename(result.filename)
  return { id: result.id, saved: true, ...(filename ? { filename } : {}) }
}

export async function acknowledgeNativeLastExportOutcome(id: string): Promise<void> {
  if (!isNativeMobileApp()) return
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new Error('Native export outcome id is invalid')
  }
  await getPersonalExport().acknowledgeLastExportOutcome({ id })
}

/** Call only after the UI has made the successful save visible to the user. */
export async function acknowledgePendingNativeExportOutcome(): Promise<boolean> {
  const outcome = await getNativeLastExportOutcome()
  if (!outcome) return false
  await acknowledgeNativeLastExportOutcome(outcome.id)
  return true
}

export function nativeExportCleanupIssue(error: unknown): NativeExportCleanupIssue | undefined {
  const record = typeof error === 'object' && error !== null ? error as { code?: unknown; message?: unknown } : undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  const message = typeof record?.message === 'string' ? record.message : String(error ?? '')
  if (code === 'EXPORT_OUTCOME_PENDING') return 'pending-export-outcome'
  if (code === 'EXPORT_OUTCOME_CORRUPTED' || code === 'EXPORT_OUTCOME_READ_FAILED') return 'export-outcome'
  if (code === 'EXPORT_CLEANUP_FAILED' || (message.includes('刚才位置') && message.includes('本机私有导出暂存'))) {
    return 'both'
  }
  if (code === 'EXPORT_SAVED_LOCAL_TEMP_CLEANUP_FAILED' || message.includes('文件已经保存')) {
    return 'saved-local-temporary'
  }
  if (code === 'PARTIAL_DOCUMENT_CLEANUP_FAILED' || message.includes('刚才选择的位置')) {
    return 'selected-document'
  }
  if (code === 'LOCAL_TEMP_CLEANUP_FAILED' || message.includes('本机私有导出暂存')) {
    return 'local-temporary'
  }
  return undefined
}

export function nativeExportCleanupFilename(error: unknown): string | undefined {
  const message = typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : String(error ?? '')
  const match = message.match(/“([A-Za-z0-9._-]+\.json)”/iu)
  const filename = match?.[1]
  return filename && filename.length <= 120 ? filename : undefined
}
