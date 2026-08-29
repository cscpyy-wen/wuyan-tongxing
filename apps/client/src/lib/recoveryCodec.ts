const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export type LosslessBase64String =
  | { encoding: 'base64-utf8'; data: string }
  | { encoding: 'base64-utf16le'; data: string }

// Native read/write and recovery use one shared bridge-safe ceiling. Two
// base64-framed 4 MiB core slots fit; optional bootstrap evidence is included
// only when the bounded recovery composer proves the final JSON also fits.
export const MAX_SINGLE_NATIVE_RECOVERY_BYTES = 12 * 1024 * 1024
export const RECOVERY_CHUNK_SOURCE_CHARACTERS = 2 * 1024 * 1024
export const RECOVERY_CHUNK_FORMAT = 'wuyan-tongxing-recovery-chunk'

export interface RecoveryChunkDocument {
  format: typeof RECOVERY_CHUNK_FORMAT
  version: 1
  setId: string
  partNumber: number
  partCount: number
  sourceCharacters: number
  payloadSha256: string
  payload: LosslessBase64String
}

function encodeBytes(bytes: Uint8Array): string {
  let encoded = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    encoded += BASE64_ALPHABET[first >> 2]
    encoded += BASE64_ALPHABET[((first & 3) << 4) | ((second ?? 0) >> 4)]
    encoded += second === undefined ? '=' : BASE64_ALPHABET[((second & 15) << 2) | ((third ?? 0) >> 6)]
    encoded += third === undefined ? '=' : BASE64_ALPHABET[third & 63]
  }
  return encoded
}

function decodeBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string'
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error('恢复编码无效')
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const bytes = new Uint8Array((value.length / 4) * 3 - padding)
  let offset = 0
  for (let index = 0; index < value.length; index += 4) {
    const first = BASE64_ALPHABET.indexOf(value[index]!)
    const second = BASE64_ALPHABET.indexOf(value[index + 1]!)
    const third = value[index + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[index + 2]!)
    const fourth = value[index + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[index + 3]!)
    const packed = (first << 18) | (second << 12) | (third << 6) | fourth
    if (offset < bytes.length) bytes[offset++] = packed >> 16
    if (offset < bytes.length) bytes[offset++] = (packed >> 8) & 0xff
    if (offset < bytes.length) bytes[offset++] = packed & 0xff
  }
  return bytes
}

/** Lossless for every JavaScript DOMString, including lone UTF-16 surrogates. */
export function encodeBase64Utf16(value: string): string {
  const bytes = new Uint8Array(value.length * 2)
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    bytes[index * 2] = codeUnit & 0xff
    bytes[index * 2 + 1] = codeUnit >> 8
  }
  return encodeBytes(bytes)
}

export function decodeBase64Utf16(value: unknown): string {
  const bytes = decodeBytes(value)
  if (bytes.length % 2 !== 0) throw new Error('恢复编码无效')
  const chunks: string[] = []
  const units = new Uint16Array(Math.min(8_192, bytes.length / 2))
  for (let byteOffset = 0; byteOffset < bytes.length;) {
    const unitCount = Math.min(units.length, (bytes.length - byteOffset) / 2)
    for (let index = 0; index < unitCount; index += 1) {
      units[index] = bytes[byteOffset++]! | (bytes[byteOffset++]! << 8)
    }
    chunks.push(String.fromCharCode(...units.subarray(0, unitCount)))
  }
  const decoded = chunks.join('')
  if (encodeBase64Utf16(decoded) !== value) throw new Error('恢复编码无效')
  return decoded
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) index += 1
      else return true
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

export function encodeLosslessBase64(value: string): LosslessBase64String {
  if (containsLoneSurrogate(value)) {
    return { encoding: 'base64-utf16le', data: encodeBase64Utf16(value) }
  }
  return { encoding: 'base64-utf8', data: encodeBytes(new TextEncoder().encode(value)) }
}

export function decodeLosslessBase64(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('恢复编码无效')
  const entry = value as Record<string, unknown>
  if (Object.keys(entry).sort().join('|') !== 'data|encoding') throw new Error('恢复编码无效')
  if (entry.encoding === 'base64-utf16le') return decodeBase64Utf16(entry.data)
  if (entry.encoding !== 'base64-utf8') throw new Error('恢复编码无效')
  const bytes = decodeBytes(entry.data)
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (encodeBytes(new TextEncoder().encode(decoded)) !== entry.data) throw new Error('恢复编码无效')
  return decoded
}

export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index)
    if (current <= 0x7f) bytes += 1
    else if (current <= 0x7ff) bytes += 2
    else if (current >= 0xd800 && current <= 0xdbff
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4
      index += 1
    } else bytes += 3 // TextEncoder replaces an unpaired surrogate with U+FFFD.
  }
  return bytes
}

export function recoveryChunkCount(value: string): number {
  return Math.max(1, Math.ceil(value.length / RECOVERY_CHUNK_SOURCE_CHARACTERS))
}

async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('当前系统不支持恢复分片校验')
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function createRecoveryChunkDocument(
  source: string,
  setId: string,
  partNumber: number,
  partCount: number,
): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(setId)
    || !Number.isInteger(partNumber)
    || !Number.isInteger(partCount)
    || partNumber < 1
    || partCount < 1
    || partNumber > partCount
    || source.length > RECOVERY_CHUNK_SOURCE_CHARACTERS) throw new Error('恢复分片参数无效')
  const payload = encodeLosslessBase64(source)
  const document: RecoveryChunkDocument = {
    format: RECOVERY_CHUNK_FORMAT,
    version: 1,
    setId,
    partNumber,
    partCount,
    sourceCharacters: source.length,
    payloadSha256: await sha256Hex(payload.data),
    payload,
  }
  return JSON.stringify(document, null, 2)
}

export async function decodeRecoveryChunkDocument(value: unknown): Promise<{
  metadata: Omit<RecoveryChunkDocument, 'payload'>
  source: string
}> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('恢复分片无效')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join('|') !== [
    'format', 'partCount', 'partNumber', 'payload', 'payloadSha256',
    'setId', 'sourceCharacters', 'version',
  ].sort().join('|')
    || record.format !== RECOVERY_CHUNK_FORMAT
    || record.version !== 1
    || typeof record.setId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record.setId)
    || !Number.isInteger(record.partNumber)
    || !Number.isInteger(record.partCount)
    || Number(record.partNumber) < 1
    || Number(record.partCount) < 1
    || Number(record.partNumber) > Number(record.partCount)
    || !Number.isInteger(record.sourceCharacters)
    || Number(record.sourceCharacters) < 0
    || Number(record.sourceCharacters) > RECOVERY_CHUNK_SOURCE_CHARACTERS
    || typeof record.payloadSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(record.payloadSha256)) throw new Error('恢复分片无效')
  const payload = record.payload as LosslessBase64String
  if (!payload || typeof payload !== 'object' || typeof payload.data !== 'string'
    || await sha256Hex(payload.data) !== record.payloadSha256) throw new Error('恢复分片校验失败')
  const source = decodeLosslessBase64(payload)
  if (source.length !== record.sourceCharacters) throw new Error('恢复分片校验失败')
  const { payload: _payload, ...metadata } = record as unknown as RecoveryChunkDocument
  return { metadata, source }
}
