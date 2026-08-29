import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const ANDROID_RELEASE_ROOT_INVENTORY_SCHEMA = 1
export const ANDROID_RELEASE_ROOT_INVENTORY_ALGORITHM = 'sha256(path\\0sha256(bytes)\\0sizeBytes\\0), sorted UTF-8 root filenames; manifest.json excluded and bound by CURRENT manifestSha256'

function validateRootFilename(name) {
  if (
    typeof name !== 'string'
    || name.length === 0
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || path.basename(name) !== name
  ) throw new Error(`Android release 根文件名非法：${name}`)
  return name
}

function sortUtf8(values) {
  return [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
}

function normalizeAllowed(allowedPaths, manifestName) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) throw new Error('Android release 根文件白名单不能为空')
  const allowed = sortUtf8(allowedPaths.map(validateRootFilename))
  if (new Set(allowed).size !== allowed.length || allowed.includes(manifestName)) {
    throw new Error('Android release 根文件白名单重复或错误包含 manifest')
  }
  return allowed
}

async function hashRootFile(root, name) {
  const pathname = path.join(root, name)
  const fileStat = await fs.lstat(pathname)
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`Android release 根条目不是普通文件：${name}`)
  const bytes = await fs.readFile(pathname)
  return { pathname: name, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length }
}

export function androidReleaseRootTreeSha256(files) {
  const digest = createHash('sha256')
  for (const entry of [...files].sort((left, right) => Buffer.compare(Buffer.from(left.pathname), Buffer.from(right.pathname)))) {
    digest.update(entry.pathname, 'utf8')
    digest.update('\0')
    digest.update(entry.sha256, 'ascii')
    digest.update('\0')
    digest.update(String(entry.sizeBytes), 'ascii')
    digest.update('\0')
  }
  return digest.digest('hex')
}

async function exactRootEntries(root, expectedNames) {
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Android release 根目录包含非普通文件：${entry.name}`)
  }
  const actual = sortUtf8(entries.map((entry) => entry.name))
  const expected = sortUtf8(expectedNames)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const extra = actual.filter((name) => !expected.includes(name))
    const missing = expected.filter((name) => !actual.includes(name))
    throw new Error(`Android release 根文件集合不一致：多余 ${extra.join(', ') || '无'}；缺少 ${missing.join(', ') || '无'}`)
  }
}

export async function createAndroidReleaseRootInventory(root, allowedPaths, options = {}) {
  const manifestName = validateRootFilename(options.manifestName ?? 'manifest.json')
  const allowed = normalizeAllowed(allowedPaths, manifestName)
  await exactRootEntries(root, allowed)
  const files = await Promise.all(allowed.map((name) => hashRootFile(root, name)))
  return {
    schemaVersion: ANDROID_RELEASE_ROOT_INVENTORY_SCHEMA,
    algorithm: ANDROID_RELEASE_ROOT_INVENTORY_ALGORITHM,
    manifestPath: manifestName,
    manifestBinding: 'CURRENT pointer manifestSha256',
    fileCount: files.length,
    files,
    treeSha256: androidReleaseRootTreeSha256(files),
  }
}

export async function verifyAndroidReleaseRootInventory(root, inventory, allowedPaths, options = {}) {
  const manifestName = validateRootFilename(options.manifestName ?? 'manifest.json')
  const allowed = normalizeAllowed(allowedPaths, manifestName)
  if (
    inventory?.schemaVersion !== ANDROID_RELEASE_ROOT_INVENTORY_SCHEMA
    || inventory.algorithm !== ANDROID_RELEASE_ROOT_INVENTORY_ALGORITHM
    || inventory.manifestPath !== manifestName
    || inventory.manifestBinding !== 'CURRENT pointer manifestSha256'
    || inventory.fileCount !== allowed.length
    || !Array.isArray(inventory.files)
    || inventory.files.length !== allowed.length
    || !/^[a-f0-9]{64}$/.test(inventory.treeSha256 ?? '')
  ) throw new Error('Android release 根目录封印格式错误')
  await exactRootEntries(root, [...allowed, manifestName])
  const inventoryNames = sortUtf8(inventory.files.map((entry) => entry?.pathname))
  if (JSON.stringify(inventoryNames) !== JSON.stringify(allowed)) throw new Error('Android release 根目录封印白名单不匹配')
  const actualFiles = await Promise.all(allowed.map((name) => hashRootFile(root, name)))
  const expectedByName = new Map(inventory.files.map((entry) => [entry.pathname, entry]))
  for (const actual of actualFiles) {
    const expected = expectedByName.get(actual.pathname)
    if (
      !expected
      || expected.sha256 !== actual.sha256
      || expected.sizeBytes !== actual.sizeBytes
      || !/^[a-f0-9]{64}$/.test(expected.sha256 ?? '')
    ) throw new Error(`Android release 根文件摘要不匹配：${actual.pathname}`)
  }
  if (androidReleaseRootTreeSha256(actualFiles) !== inventory.treeSha256) {
    throw new Error('Android release 整树摘要不匹配')
  }
  return { fileCount: actualFiles.length, treeSha256: inventory.treeSha256 }
}
