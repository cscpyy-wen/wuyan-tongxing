import type { ClientState } from '../types'
import { parseStoredStateStrict } from './model'
import {
  decodeLosslessBase64,
  MAX_SINGLE_NATIVE_RECOVERY_BYTES,
  utf8ByteLength,
} from './recoveryCodec'
import { NATIVE_DURABLE_STATE_MAX_BYTES } from './nativeDurableStore'

export const MAX_RECOVERY_IMPORT_CHARACTERS = MAX_SINGLE_NATIVE_RECOVERY_BYTES
// A corrupt import journal may be much larger on disk. Recovery export never
// base64-expands more than this before the bounded composer decides whether the
// optional evidence fits beside both authoritative core slots.
export const MAX_RECOVERY_PENDING_IMPORT_RAW_CHARACTERS = 256 * 1024

export interface BoundedNativeRecoveryOptions {
  core: Record<string, unknown>
  bootstrapRecovery?: unknown
  bootstrapAvailable?: boolean
  pendingBootstrapImport?: unknown
  pendingImportAvailable?: boolean
}

export interface RecoveryImportCandidate {
  state: ClientState
  bootstrapRecovery?: unknown
  bootstrapRecoverySkipped: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Keeps both core recovery slots mandatory and adds Android attachments only
 * when their exact compact-JSON UTF-8 size fits the one-shot native bridge.
 * No oversized candidate string or payload-sized TextEncoder byte[] is built.
 */
export function createBoundedNativeRecoveryBundle(options: BoundedNativeRecoveryOptions): string {
  const reserved = new Set([
    '_androidBootstrapRecovery',
    '_androidBootstrapPendingImport',
    '_recoveryIntegrity',
  ])
  if (Object.keys(options.core).some((key) => reserved.has(key))) {
    throw new Error('核心恢复副本包含保留字段')
  }
  const coreJson = JSON.stringify(options.core)
  if (!coreJson.startsWith('{') || !coreJson.endsWith('}')) throw new Error('核心恢复副本格式无效')
  const prefix = coreJson.slice(0, -1)
  const bootstrapAvailable = options.bootstrapAvailable ?? options.bootstrapRecovery !== undefined
  const pendingAvailable = options.pendingImportAvailable ?? options.pendingBootstrapImport !== undefined
  const bootstrapJson = options.bootstrapRecovery === undefined
    ? undefined
    : JSON.stringify(options.bootstrapRecovery)
  const pendingJson = options.pendingBootstrapImport === undefined
    ? undefined
    : JSON.stringify(options.pendingBootstrapImport)
  const bootstrapSegment = bootstrapJson === undefined
    ? undefined
    : `,"_androidBootstrapRecovery":${bootstrapJson}`
  const pendingSegment = pendingJson === undefined
    ? undefined
    : `,"_androidBootstrapPendingImport":${pendingJson}`

  const combinations = [
    { bootstrap: bootstrapSegment !== undefined, pending: pendingSegment !== undefined },
    { bootstrap: bootstrapSegment !== undefined, pending: false },
    { bootstrap: false, pending: pendingSegment !== undefined },
    { bootstrap: false, pending: false },
  ].filter((candidate, index, all) => all.findIndex((other) => (
    other.bootstrap === candidate.bootstrap && other.pending === candidate.pending
  )) === index)

  for (const selected of combinations) {
    const integrity = {
      version: 1,
      coreSlots: options.core.readStatus,
      bootstrapIncluded: selected.bootstrap,
      pendingImportIncluded: selected.pending,
      bootstrapOmittedForSize: bootstrapAvailable && !selected.bootstrap,
      pendingImportOmittedForSize: pendingAvailable && !selected.pending,
    }
    const integritySegment = `,"_recoveryIntegrity":${JSON.stringify(integrity)}`
    const pieces = [
      prefix,
      ...(selected.bootstrap && bootstrapSegment ? [bootstrapSegment] : []),
      ...(selected.pending && pendingSegment ? [pendingSegment] : []),
      integritySegment,
      '}',
    ]
    const byteLength = pieces.reduce((total, piece) => total + utf8ByteLength(piece), 0)
    if (byteLength > MAX_SINGLE_NATIVE_RECOVERY_BYTES) continue
    const bundle = pieces.join('')
    if (utf8ByteLength(bundle) !== byteLength) throw new Error('恢复副本长度校验失败')
    return bundle
  }
  throw new Error('核心恢复副本超过单文件安全上限')
}

function parseStateCandidate(value: unknown): ClientState | undefined {
  let candidate = value
  const encoded = record(candidate)
  if (encoded && (encoded.encoding === 'base64-utf8' || encoded.encoding === 'base64-utf16le')) {
    if (typeof encoded.data !== 'string' || encoded.data.length > MAX_RECOVERY_IMPORT_CHARACTERS) return undefined
    try {
      const raw = decodeLosslessBase64(encoded)
      if (raw.length > MAX_RECOVERY_IMPORT_CHARACTERS) return undefined
      candidate = JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  }

  const possibleWrapper = record(candidate)
  const candidates = possibleWrapper && Object.prototype.hasOwnProperty.call(possibleWrapper, 'data')
    ? [possibleWrapper.data, candidate]
    : [candidate]
  for (const current of candidates) {
    try {
      const state = parseStoredStateStrict(current)
      if (state.onboarded && state.plan && state.baseline && state.settings.sensitiveHealthData
        && utf8ByteLength(JSON.stringify(state)) <= NATIVE_DURABLE_STATE_MAX_BYTES) return state
    } catch {
      // A recovery bundle deliberately tries the other independently captured
      // slot; selecting the file is the user's explicit recovery decision.
    }
  }
  return undefined
}

/** Recognises the forensic recovery export and returns its first strict valid slot. */
export function parseRecoveryImportCandidate(value: unknown): RecoveryImportCandidate | undefined {
  const bundle = record(value)
  const statuses = record(bundle?.readStatus)
  if (!bundle || !statuses
    || !Object.prototype.hasOwnProperty.call(bundle, 'primary')
    || !Object.prototype.hasOwnProperty.call(bundle, 'lastKnownGood')
    || !['missing', 'valid', 'unreadable'].includes(String(statuses.primary))
    || !['missing', 'valid', 'unreadable'].includes(String(statuses.lastKnownGood))) return undefined

  const slots = [
    { status: String(statuses.primary), value: bundle.primary },
    { status: String(statuses.lastKnownGood), value: bundle.lastKnownGood },
  ].sort((left, right) => Number(right.status === 'valid') - Number(left.status === 'valid'))
  let state: ClientState | undefined
  for (const slot of slots) {
    state = parseStateCandidate(slot.value)
    if (state) break
  }
  if (!state) return undefined
  const bootstrapPresent = Object.prototype.hasOwnProperty.call(bundle, '_androidBootstrapRecovery')
  const integrity = record(bundle._recoveryIntegrity)
  return {
    state,
    bootstrapRecoverySkipped: bundle._androidBootstrapRecoverySkipped === true
      || integrity?.bootstrapOmittedForSize === true,
    ...(bootstrapPresent ? { bootstrapRecovery: bundle._androidBootstrapRecovery } : {}),
  }
}
