import { createHash, randomBytes } from 'node:crypto'
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import path from 'node:path'

export const ANDROID_RELEASE_POINTER_SCHEMA = 1
export const ANDROID_RELEASE_PROTOCOL = 'crash-recoverable-append-only-pointer-journal'

async function exists(pathname) {
  try {
    await stat(pathname)
    return true
  } catch {
    return false
  }
}

async function isDirectory(pathname) {
  try {
    return (await stat(pathname)).isDirectory()
  } catch {
    return false
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertReleaseId(releaseId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId ?? '')) {
    throw new Error(`Android release id 非法：${releaseId ?? '<missing>'}`)
  }
}

async function inject(faultInjector, point, context = {}) {
  if (faultInjector) await faultInjector(point, context)
}

async function syncDirectoryBestEffort(directory) {
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
    return true
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function syncTree(root) {
  const directories = [root]
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const pathname = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        directories.push(pathname)
        continue
      }
      if (!entry.isFile()) throw new Error(`发布候选包含非常规文件：${pathname}`)
      const handle = await open(pathname, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
  }
  const results = []
  for (const directory of directories.reverse()) results.push(await syncDirectoryBestEffort(directory))
  return { directorySyncSupported: results.every(Boolean) }
}

function pointerSort(left, right) {
  return right.pointer.sequence - left.pointer.sequence || right.filename.localeCompare(left.filename)
}

async function pointerCandidates(containerRoot) {
  const currentRoot = path.join(containerRoot, 'CURRENT')
  if (!await isDirectory(currentRoot)) return { valid: [], invalid: [] }
  const releasesRoot = path.join(containerRoot, 'releases')
  const valid = []
  const invalid = []
  for (const filename of (await readdir(currentRoot))
    .filter((name) => !name.startsWith('.') && name.endsWith('.json'))
    .sort()) {
    const pathname = path.join(currentRoot, filename)
    try {
      const pointer = JSON.parse(await readFile(pathname, 'utf8'))
      assertReleaseId(pointer.releaseId)
      if (
        pointer.schemaVersion !== ANDROID_RELEASE_POINTER_SCHEMA
        || !Number.isSafeInteger(pointer.sequence)
        || pointer.sequence < 1
        || pointer.protocol !== ANDROID_RELEASE_PROTOCOL
        || pointer.releaseRelativePath !== `releases/${pointer.releaseId}`
        || !/^[a-f0-9]{64}$/.test(pointer.manifestSha256 ?? '')
      ) throw new Error('pointer schema invalid')
      const expectedFilenamePrefix = `${String(pointer.sequence).padStart(20, '0')}-${pointer.releaseId}-`
      const filenameNonce = filename.slice(expectedFilenamePrefix.length, -'.json'.length)
      if (!filename.startsWith(expectedFilenamePrefix) || !/^[a-f0-9]{16}$/.test(filenameNonce)) {
        throw new Error('pointer filename does not bind sequence and release id')
      }
      const releaseRoot = path.resolve(containerRoot, ...pointer.releaseRelativePath.split('/'))
      if (!releaseRoot.startsWith(`${path.resolve(releasesRoot)}${path.sep}`)) throw new Error('pointer escaped releases root')
      const manifestBytes = await readFile(path.join(releaseRoot, 'manifest.json'))
      if (sha256(manifestBytes) !== pointer.manifestSha256) throw new Error('manifest hash mismatch')
      const manifest = JSON.parse(manifestBytes.toString('utf8'))
      if (manifest.releaseId !== pointer.releaseId) throw new Error('manifest release id mismatch')
      valid.push({ filename, pathname, pointer, releaseRoot, manifest })
    } catch (error) {
      invalid.push({ filename, pathname, reason: error.message })
    }
  }
  valid.sort(pointerSort)
  return { valid, invalid }
}

export async function resolveCurrentAndroidRelease(containerRoot, options = {}) {
  const { valid, invalid } = await pointerCandidates(containerRoot)
  if (valid.length > 0) {
    return {
      mode: 'pointer-journal',
      releaseRoot: valid[0].releaseRoot,
      pointer: valid[0].pointer,
      pointerPath: valid[0].pathname,
      invalidPointers: invalid,
    }
  }
  if (options.allowLegacy !== false && await exists(path.join(containerRoot, 'manifest.json'))) {
    return {
      mode: 'legacy-flat-directory',
      releaseRoot: containerRoot,
      pointer: null,
      pointerPath: null,
      invalidPointers: invalid,
    }
  }
  if (options.required === false) return null
  const detail = invalid.length > 0 ? `；${invalid.length} 个指针无效` : ''
  throw new Error(`没有可解析的 Android current release${detail}`)
}

export async function recoverLegacyAndroidPublication(releaseParent) {
  await mkdir(releaseParent, { recursive: true })
  const containerRoot = path.join(releaseParent, 'android')
  const entries = await readdir(releaseParent, { withFileTypes: true })
  const previous = []
  const interrupted = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.android-previous-')) previous.push(path.join(releaseParent, entry.name))
    if (entry.name.startsWith('.android-publication-')) interrupted.push(path.join(releaseParent, entry.name))
  }
  let restoredFrom = null
  if (!await exists(containerRoot) && previous.length > 0) {
    const candidates = []
    for (const pathname of previous) {
      if (!await exists(path.join(pathname, 'manifest.json'))) continue
      candidates.push({ pathname, modified: (await stat(pathname)).mtimeMs })
    }
    candidates.sort((left, right) => right.modified - left.modified || right.pathname.localeCompare(left.pathname))
    if (candidates.length > 0) {
      restoredFrom = candidates[0].pathname
      await rename(restoredFrom, containerRoot)
    }
  }
  return {
    containerRoot,
    restoredFrom,
    previousResidues: previous.filter((pathname) => pathname !== restoredFrom),
    interruptedPublicationResidues: interrupted,
  }
}

export async function recoverAndroidReleaseStore(containerRoot, options = {}) {
  const preserve = new Set((options.preserve ?? []).map((pathname) => path.resolve(pathname)))
  await mkdir(containerRoot, { recursive: true })
  await mkdir(path.join(containerRoot, 'releases'), { recursive: true })
  await mkdir(path.join(containerRoot, 'CURRENT'), { recursive: true })
  const removed = []
  for (const entry of await readdir(containerRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith('.staging-')) continue
    const pathname = path.join(containerRoot, entry.name)
    if (preserve.has(path.resolve(pathname))) continue
    await rm(pathname, { recursive: true, force: true })
    removed.push(pathname)
  }
  const currentRoot = path.join(containerRoot, 'CURRENT')
  for (const entry of await readdir(currentRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith('.pending-')) continue
    const pathname = path.join(currentRoot, entry.name)
    await rm(pathname, { recursive: entry.isDirectory(), force: true })
    removed.push(pathname)
  }
  return {
    removed,
    current: await resolveCurrentAndroidRelease(containerRoot, { required: false }),
  }
}

export async function createAndroidReleaseStaging(containerRoot) {
  await mkdir(containerRoot, { recursive: true })
  const nonce = randomBytes(8).toString('hex')
  const stagingDirectory = path.join(containerRoot, `.staging-${process.pid}-${nonce}`)
  await mkdir(stagingDirectory, { recursive: false })
  return stagingDirectory
}

export function androidReleaseId({ versionCode, apkSha256, sourceSnapshotSha256 }) {
  if (!Number.isSafeInteger(Number(versionCode)) || Number(versionCode) < 1) throw new Error('versionCode invalid')
  if (!/^[a-f0-9]{64}$/.test(apkSha256 ?? '') || !/^[a-f0-9]{64}$/.test(sourceSnapshotSha256 ?? '')) {
    throw new Error('release id hashes invalid')
  }
  return `personal-${versionCode}-${apkSha256.slice(0, 16)}-${sourceSnapshotSha256.slice(0, 12)}`
}

export async function publishAndroidRelease(options) {
  const {
    containerRoot,
    stagingDirectory,
    releaseId,
    verifyRelease,
    faultInjector,
    now = () => new Date(),
  } = options
  assertReleaseId(releaseId)
  if (typeof verifyRelease !== 'function') throw new Error('发布必须提供完整 release 验证回调')
  if (!path.resolve(stagingDirectory).startsWith(`${path.resolve(containerRoot)}${path.sep}`)) {
    throw new Error('staging directory 必须位于 Android release 容器内')
  }
  if (!await isDirectory(stagingDirectory)) throw new Error('staging directory 不存在')

  await inject(faultInjector, 'before-recovery')
  await recoverAndroidReleaseStore(containerRoot, { preserve: [stagingDirectory] })
  await inject(faultInjector, 'after-recovery')
  const previous = await resolveCurrentAndroidRelease(containerRoot, { required: false })

  await inject(faultInjector, 'before-verification')
  await verifyRelease(stagingDirectory)
  await inject(faultInjector, 'after-verification')
  const durability = await syncTree(stagingDirectory)
  await inject(faultInjector, 'after-staging-sync', { durability })

  const manifestBytes = await readFile(path.join(stagingDirectory, 'manifest.json'))
  const manifestSha256 = sha256(manifestBytes)
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (manifest.releaseId !== releaseId) throw new Error('staging manifest releaseId 与发布目标不一致')

  const releasesRoot = path.join(containerRoot, 'releases')
  const immutableRoot = path.join(releasesRoot, releaseId)
  await inject(faultInjector, 'before-release-rename')
  if (await exists(immutableRoot)) {
    const existingManifest = await readFile(path.join(immutableRoot, 'manifest.json'))
    if (sha256(existingManifest) !== manifestSha256) throw new Error('不可变 release id 已存在但 manifest 不一致')
    await rm(stagingDirectory, { recursive: true, force: true })
  } else {
    await rename(stagingDirectory, immutableRoot)
  }
  await inject(faultInjector, 'after-release-rename', { immutableRoot })
  await inject(faultInjector, 'before-immutable-verification', { immutableRoot })
  await verifyRelease(immutableRoot)
  await inject(faultInjector, 'after-immutable-verification', { immutableRoot })
  const releaseDirectorySynced = await syncDirectoryBestEffort(releasesRoot)

  const currentRoot = path.join(containerRoot, 'CURRENT')
  const existingPointers = await pointerCandidates(containerRoot)
  const maxSequence = [...existingPointers.valid, ...existingPointers.invalid.map(() => null)]
    .filter(Boolean)
    .reduce((maximum, item) => Math.max(maximum, item.pointer.sequence), 0)
  let sequence = maxSequence + 1
  for (const filename of await readdir(currentRoot)) {
    const prefix = /^(\d+)-/.exec(filename)?.[1]
    const parsed = Number(prefix)
    if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed < Number.MAX_SAFE_INTEGER) {
      sequence = Math.max(sequence, parsed + 1)
    }
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('CURRENT pointer sequence 已耗尽或无效')
  const sequenceText = String(sequence).padStart(20, '0')
  const nonce = randomBytes(8).toString('hex')
  const pointer = {
    schemaVersion: ANDROID_RELEASE_POINTER_SCHEMA,
    protocol: ANDROID_RELEASE_PROTOCOL,
    sequence,
    releaseId,
    releaseRelativePath: `releases/${releaseId}`,
    manifestSha256,
    committedAt: now().toISOString(),
  }
  const pointerBytes = Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`)
  const pendingPath = path.join(currentRoot, `.pending-${process.pid}-${nonce}.json`)
  const finalPath = path.join(currentRoot, `${sequenceText}-${releaseId}-${nonce}.json`)
  let pointerVisible = false
  try {
    await inject(faultInjector, 'before-pointer-write', { pointer, immutableRoot })
    const handle = await open(pendingPath, 'wx')
    try {
      await handle.writeFile(pointerBytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await inject(faultInjector, 'after-pointer-fsync', { pendingPath, pointer })
    await rename(pendingPath, finalPath)
    pointerVisible = true
    await inject(faultInjector, 'after-pointer-rename', { finalPath, pointer })
    const pointerDirectorySynced = await syncDirectoryBestEffort(currentRoot)
    await inject(faultInjector, 'after-pointer-directory-sync', { pointerDirectorySynced, pointer })
    const current = await resolveCurrentAndroidRelease(containerRoot)
    if (current.pointer.releaseId !== releaseId) throw new Error('新 release 指针可见后未成为 current')
    return {
      previous,
      current,
      immutableRoot,
      pointerPath: finalPath,
      pointer,
      durability: {
        stagingDirectoriesSynced: durability.directorySyncSupported,
        releasesDirectorySynced: releaseDirectorySynced,
        pointerDirectorySynced,
      },
    }
  } finally {
    if (!pointerVisible) await rm(pendingPath, { force: true })
  }
}
