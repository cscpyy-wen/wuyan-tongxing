import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const requiredFiles = {
  storePath: 'personal-release.p12',
  propertiesPath: 'signing.properties',
  fingerprintPath: 'certificate.sha256',
}

function comparablePath(pathname) {
  const normalized = resolve(pathname)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function isSamePath(left, right) {
  return comparablePath(left) === comparablePath(right)
}

export function isPathInside(parent, candidate) {
  const parentPath = comparablePath(parent)
  const candidatePath = comparablePath(candidate)
  const relation = relative(parentPath, candidatePath)
  return relation.length > 0 && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

async function requireRealFile(root, filename, label) {
  const requestedPath = resolve(root, filename)
  let resolvedPath
  try {
    resolvedPath = await realpath(requestedPath)
  } catch {
    throw new Error(`外部 Android 签名目录缺少${label}`)
  }
  if (!isPathInside(root, resolvedPath)) {
    throw new Error(`${label}必须是外部 Android 签名目录内的真实文件，禁止符号链接越界`)
  }
  if (!(await stat(resolvedPath)).isFile()) throw new Error(`${label}不是普通文件`)
  return resolvedPath
}

export async function resolveExternalAndroidSigningMaterial({
  repositoryRoot,
  environment = process.env,
  expectedCertificateSha256,
} = {}) {
  if (!repositoryRoot) throw new Error('缺少仓库根目录，无法验证 Android 签名边界')
  if (!/^[a-f0-9]{64}$/.test(expectedCertificateSha256 ?? '')) {
    throw new Error('缺少版本化的 Android 签名证书 SHA-256 策略')
  }
  const configuredRoot = environment.WUYAN_ANDROID_SIGNING_ROOT?.trim()
  if (!configuredRoot) {
    throw new Error(
      '维护者 release 构建必须设置 WUYAN_ANDROID_SIGNING_ROOT，且签名材料必须位于公开仓库之外',
    )
  }
  if (!isAbsolute(configuredRoot)) {
    throw new Error('WUYAN_ANDROID_SIGNING_ROOT 必须是绝对路径')
  }

  let repositoryRealPath
  let signingRoot
  try {
    ;[repositoryRealPath, signingRoot] = await Promise.all([
      realpath(repositoryRoot),
      realpath(configuredRoot),
    ])
  } catch {
    throw new Error('WUYAN_ANDROID_SIGNING_ROOT 不存在或无法解析')
  }
  if (!(await stat(signingRoot)).isDirectory()) {
    throw new Error('WUYAN_ANDROID_SIGNING_ROOT 必须指向目录')
  }
  if (isSamePath(repositoryRealPath, signingRoot) || isPathInside(repositoryRealPath, signingRoot)) {
    throw new Error('Android 签名材料不得位于公开仓库内')
  }

  const storePath = await requireRealFile(signingRoot, requiredFiles.storePath, '固定密钥库')
  const propertiesPath = await requireRealFile(signingRoot, requiredFiles.propertiesPath, '签名配置')
  const fingerprintPath = await requireRealFile(signingRoot, requiredFiles.fingerprintPath, '证书指纹文件')
  const fingerprint = (await readFile(fingerprintPath, 'utf8')).trim()
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error('外部证书指纹文件必须只包含 64 位小写 SHA-256')
  }
  if (fingerprint !== expectedCertificateSha256) {
    throw new Error('外部证书指纹与版本化 Android 签名策略不一致')
  }

  return {
    root: signingRoot,
    storePath,
    propertiesPath,
    fingerprintPath,
    fingerprint,
  }
}

export async function resolveConfiguredSigningStore({
  propertiesPath,
  configuredStore,
  expectedStorePath,
} = {}) {
  if (!propertiesPath || !configuredStore || !expectedStorePath) {
    throw new Error('个人签名配置缺少固定密钥库路径')
  }
  let storeFile
  try {
    storeFile = await realpath(resolve(propertiesPath, '..', configuredStore))
  } catch {
    throw new Error('个人签名配置指向的密钥库不存在')
  }
  if (!isSamePath(storeFile, expectedStorePath)) {
    throw new Error('个人签名配置必须精确指向外部签名目录内的 personal-release.p12')
  }
  return storeFile
}
