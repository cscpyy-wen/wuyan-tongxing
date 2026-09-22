import fileIo from '@ohos.file.fs'
import util from '@ohos.util'
import { context } from '@tarojs/runtime'

import {
  NATIVE_DURABLE_STATE_MAX_BYTES,
  nativeDurableFileName,
  nativeDurableUtf8Fits,
  parseNativeDurableValue,
  type WuyanDurableStoreBridge,
} from './nativeDurableStoreCore'

export * from './nativeDurableStoreCore'

const STORE_DIRECTORY_NAME = 'wuyan-durable-store-v1'
const UTF8_ENCODER = util.TextEncoder.create('utf-8')

interface HarmonyApplicationContext {
  filesDir: string
}

function applicationFilesDir(): string {
  const applicationContext = context.value as HarmonyApplicationContext | null
  if (!applicationContext || typeof applicationContext.filesDir !== 'string'
    || applicationContext.filesDir.length === 0) {
    throw new Error('Harmony 本机持久存储尚未初始化')
  }
  return applicationContext.filesDir
}

function ensureStorageRoot(): string {
  const filesDir = applicationFilesDir()
  const root = `${filesDir}/${STORE_DIRECTORY_NAME}`
  if (!fileIo.accessSync(root)) {
    fileIo.mkdirSync(root)
    syncDirectory(filesDir)
  }
  return root
}

function pathsForKey(key: string): { root: string; target: string; pending: string } {
  const root = ensureStorageRoot()
  const filename = nativeDurableFileName(key)
  return {
    root,
    target: `${root}/${filename}`,
    pending: `${root}/${filename}.new`,
  }
}

function syncDirectory(root: string): void {
  const directory = fileIo.openSync(root, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.DIR)
  try {
    fileIo.fsyncSync(directory.fd)
  } finally {
    fileIo.closeSync(directory)
  }
}

function readRawFile(path: string): string | null {
  if (!fileIo.accessSync(path)) return null
  const stat = fileIo.statSync(path)
  if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0
    || stat.size > NATIVE_DURABLE_STATE_MAX_BYTES) {
    throw new Error('本机持久数据超过安全读取上限')
  }
  const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW)
  try {
    if (stat.size === 0) return ''
    const buffer = new ArrayBuffer(stat.size)
    const bytesRead = fileIo.readSync(file.fd, buffer, { length: stat.size })
    if (bytesRead !== stat.size) throw new Error('本机持久数据读取不完整')
    const decoder = util.TextDecoder.create('utf-8', { fatal: true, ignoreBOM: true })
    return decoder.decodeToString(new Uint8Array(buffer))
  } finally {
    fileIo.closeSync(file)
  }
}

function assertWritableJson(json: string): Uint8Array {
  if (!nativeDurableUtf8Fits(json)) throw new Error('本机持久数据超过安全写入上限')
  try {
    JSON.parse(json)
  } catch {
    throw new Error('拒绝写入无效的本机持久数据')
  }
  const encoded = UTF8_ENCODER.encodeInto(json)
  if (encoded.byteLength > NATIVE_DURABLE_STATE_MAX_BYTES) {
    throw new Error('本机持久数据超过安全写入上限')
  }
  // fileIo.writeSync receives the backing ArrayBuffer from offset zero, so
  // return an exact view rather than relying on TextEncoder allocation details.
  const exact = new Uint8Array(encoded.byteLength)
  exact.set(encoded)
  return exact
}

function unlinkIfPresent(path: string): void {
  if (fileIo.accessSync(path)) fileIo.unlinkSync(path)
}

const harmonyDurableStore: WuyanDurableStoreBridge = {
  authoritativeWhenMissing: true,
  hasValue(key) {
    const { target } = pathsForKey(key)
    return fileIo.accessSync(target)
  },
  readRawValue(key) {
    const { target } = pathsForKey(key)
    return readRawFile(target)
  },
  readValue(key) {
    const { target } = pathsForKey(key)
    const raw = readRawFile(target)
    if (raw !== null) parseNativeDurableValue(raw)
    return raw
  },
  writeValue(key, json) {
    const encoded = assertWritableJson(json)
    const { root, target, pending } = pathsForKey(key)
    unlinkIfPresent(pending)
    const pendingFile = fileIo.openSync(
      pending,
      fileIo.OpenMode.WRITE_ONLY
        | fileIo.OpenMode.CREATE
        | fileIo.OpenMode.TRUNC
        | fileIo.OpenMode.SYNC
        | fileIo.OpenMode.NOFOLLOW,
    )
    try {
      const bytesWritten = fileIo.writeSync(pendingFile.fd, encoded.buffer, { length: encoded.byteLength })
      if (bytesWritten !== encoded.byteLength) throw new Error('本机持久数据写入不完整')
      fileIo.fsyncSync(pendingFile.fd)
    } finally {
      fileIo.closeSync(pendingFile)
    }
    fileIo.renameSync(pending, target)
    syncDirectory(root)
    if (readRawFile(target) !== json) throw new Error('本机持久数据写入后校验失败')
  },
  removeValue(key) {
    const { root, target, pending } = pathsForKey(key)
    unlinkIfPresent(pending)
    unlinkIfPresent(target)
    syncDirectory(root)
    if (fileIo.accessSync(target)) throw new Error('本机持久数据删除后仍存在')
  },
}

export function getNativeDurableStore(): WuyanDurableStoreBridge {
  return harmonyDurableStore
}
