import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFile,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ANDROID_RELEASE_PROTOCOL,
  androidReleaseId,
  createAndroidReleaseStaging,
  publishAndroidRelease,
  recoverAndroidReleaseStore,
  recoverLegacyAndroidPublication,
} from './android-release-store.mjs'
import { createAndroidReleaseRootInventory } from './android-release-root-inventory.mjs'
import { isSourceSnapshotExcluded } from './source-snapshot-policy.mjs'
import { verifyGradleWrapper } from './verify-gradle-wrapper.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const toolchainsRoot = resolve(repositoryRoot, '.toolchains')
const androidRoot = resolve(repositoryRoot, 'apps', 'android-shell', 'android')
const gradleWrapper = resolve(androidRoot, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
const gradleApkRoot = resolve(androidRoot, 'app', 'build', 'outputs', 'apk', 'release')
const releaseParent = resolve(repositoryRoot, 'release')
const releaseRoot = resolve(releaseParent, 'android')
const sourceSbomPath = resolve(repositoryRoot, 'docs', 'sbom.cdx.json')
const sourceOsvReportPath = resolve(repositoryRoot, 'docs', 'osv-audit.json')
const lockfilePath = resolve(repositoryRoot, 'pnpm-lock.yaml')
const gradleVerificationMetadataPath = resolve(androidRoot, 'gradle', 'verification-metadata.xml')
const gradleAppLockPath = resolve(androidRoot, 'app', 'gradle.lockfile')
const gradleBuildscriptLockPath = resolve(androidRoot, 'buildscript-gradle.lockfile')
const gradleWrapperPropertiesPath = resolve(androidRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties')
const gradleWrapperJarPath = resolve(androidRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar')
const versionSourcePath = resolve(repositoryRoot, 'apps', 'android-shell', 'personal-version.json')
const signingPolicyPath = resolve(repositoryRoot, 'apps', 'android-shell', 'personal-signing-policy.json')
const versionConfig = JSON.parse(await readFile(versionSourcePath, 'utf8'))
const signingPolicy = JSON.parse(await readFile(signingPolicyPath, 'utf8'))
if (
  typeof versionConfig.packageName !== 'string'
  || !Number.isSafeInteger(versionConfig.versionCode)
  || versionConfig.versionCode < 1
  || typeof versionConfig.versionName !== 'string'
  || !Number.isSafeInteger(versionConfig.minSdk)
  || !Number.isSafeInteger(versionConfig.targetSdk)
) {
  throw new Error(`Android 版本源格式错误：${versionSourcePath}`)
}
if (
  signingPolicy.schemaVersion !== 1
  || signingPolicy.packageName !== versionConfig.packageName
  || !/^[a-f0-9]{64}$/.test(signingPolicy.allowedCertificateSha256 ?? '')
  || signingPolicy.policy !== 'fail-closed-upgrade-signing'
) {
  throw new Error(`Android 签名策略格式错误：${signingPolicyPath}`)
}
const artifactName = `wuyan-tongxing-personal-${versionConfig.versionName}.apk`
const sourceArchiveName = `wuyan-tongxing-source-${versionConfig.versionName}.jar`
const expectedPackage = versionConfig.packageName
const expectedVersionCode = String(versionConfig.versionCode)
const expectedVersionName = versionConfig.versionName
const expectedMinSdk = versionConfig.minSdk
const expectedTargetSdk = versionConfig.targetSdk
const signingRoot = resolve(repositoryRoot, '.private', 'android-signing')
const signingStorePath = resolve(signingRoot, 'personal-release.p12')
const signingPropertiesPath = resolve(signingRoot, 'signing.properties')
const signingFingerprintPath = resolve(signingRoot, 'certificate.sha256')
await verifyGradleWrapper(repositoryRoot)

const executableSuffix = process.platform === 'win32' ? '.exe' : ''

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

async function collectDirectories(root, maximumDepth = 4) {
  if (!await isDirectory(root)) return []
  const directories = []

  async function visit(directory, depth) {
    directories.push(directory)
    if (depth >= maximumDepth) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(resolve(directory, entry.name), depth + 1)
    }
  }

  await visit(root, 0)
  return directories
}

function uniquePaths(paths) {
  const seen = new Set()
  return paths.filter((pathname) => {
    if (!pathname) return false
    const normalized = resolve(String(pathname).replace(/^['"]|['"]$/g, ''))
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function commandInvocation(executable, args) {
  if (process.platform !== 'win32' || !/\.(?:bat|cmd)$/i.test(executable)) {
    return { executable, args, shell: false }
  }
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`
  const command = [quote(executable), ...args.map(quote)].join(' ')
  return { executable: command, args: [], shell: true }
}

function runCapture(executable, args, options = {}) {
  const invocation = commandInvocation(executable, args)
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    shell: invocation.shell,
    windowsHide: true,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error) throw new Error(`无法执行 ${basename(executable)}：${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${basename(executable)} 执行失败（退出码 ${result.status}）\n${output.trim()}`)
  }
  return output
}

function javaMajor(versionOutput) {
  return Number(/version\s+"(?:1\.)?(\d+)/i.exec(versionOutput)?.[1] ?? 0)
}

async function discoverJdk21() {
  const toolchainDirectories = await collectDirectories(toolchainsRoot)
  const candidates = uniquePaths([
    resolve(toolchainsRoot, 'jdk-21'),
    resolve(toolchainsRoot, 'jdk21'),
    process.env.JAVA_HOME,
    ...toolchainDirectories,
  ])

  for (const home of candidates) {
    const java = resolve(home, 'bin', `java${executableSuffix}`)
    const jar = resolve(home, 'bin', `jar${executableSuffix}`)
    const keytool = resolve(home, 'bin', `keytool${executableSuffix}`)
    const jarsigner = resolve(home, 'bin', `jarsigner${executableSuffix}`)
    if (!await exists(java) || !await exists(jar) || !await exists(keytool) || !await exists(jarsigner)) continue
    try {
      const version = runCapture(java, ['-version'])
      if (javaMajor(version) === 21) return {
        home,
        java,
        jar,
        keytool,
        jarsigner,
        version: version.trim().split(/\r?\n/)[0],
      }
    } catch {
      // Continue searching: an environment variable may point to a stale installation.
    }
  }

  throw new Error(
    '未找到 JDK 21。请将 JDK 21 解压到仓库 .toolchains/jdk-21，或设置 JAVA_HOME。',
  )
}

function compareVersionNames(left, right) {
  const numbers = (value) => value.split(/[^0-9]+/).filter(Boolean).map(Number)
  const leftParts = numbers(left)
  const rightParts = numbers(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return left.localeCompare(right)
}

async function findBuildTools36(sdkRoot) {
  const buildToolsRoot = resolve(sdkRoot, 'build-tools')
  if (!await isDirectory(buildToolsRoot)) return null
  const versions = (await readdir(buildToolsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^36(?:\.|$)/.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersionNames)

  for (const version of versions) {
    const directory = resolve(buildToolsRoot, version)
    const tools = {
      aapt2: resolve(directory, `aapt2${executableSuffix}`),
      apksigner: resolve(directory, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner'),
      zipalign: resolve(directory, `zipalign${executableSuffix}`),
    }
    if (await exists(tools.aapt2) && await exists(tools.apksigner) && await exists(tools.zipalign)) {
      return { version, directory, ...tools }
    }
  }
  return null
}

async function discoverAndroidSdk() {
  const toolchainDirectories = await collectDirectories(toolchainsRoot)
  const candidates = uniquePaths([
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    resolve(toolchainsRoot, 'android-sdk'),
    resolve(toolchainsRoot, 'android_sdk'),
    ...toolchainDirectories.filter((directory) => basename(directory).toLowerCase().includes('android')),
    ...toolchainDirectories,
  ])

  for (const root of candidates) {
    const buildTools = await findBuildTools36(root)
    const androidPlatform = resolve(root, 'platforms', 'android-36', 'android.jar')
    if (buildTools && await exists(androidPlatform)) return { root, buildTools }
  }

  throw new Error(
    '未找到包含 platforms/android-36 与 build-tools/36.x 的 Android SDK。请设置 ANDROID_HOME，或安装到仓库 .toolchains/android-sdk。',
  )
}

async function listFiles(directory) {
  const files = []
  if (!await isDirectory(directory)) return files
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const pathname = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(pathname))
    else if (entry.isFile()) files.push(pathname)
  }
  return files
}

async function selectSignedApk(apksigner, environment) {
  const candidates = (await listFiles(gradleApkRoot))
    .filter((pathname) => pathname.toLowerCase().endsWith('.apk'))
    .filter((pathname) => !/-unsigned\.apk$/i.test(pathname))
  const conventional = candidates.find((pathname) => basename(pathname).toLowerCase() === 'app-release.apk')
  const selected = conventional ?? (candidates.length === 1 ? candidates[0] : null)
  if (!selected) {
    const found = (await listFiles(gradleApkRoot)).map((pathname) => relative(repositoryRoot, pathname))
    throw new Error(`未找到唯一的已签名 release APK。构建目录内容：${found.join(', ') || '空'}`)
  }
  runCapture(apksigner, ['verify', '--verbose', '--print-certs', selected], { env: environment })
  return selected
}

function parseBadging(output) {
  const packageName = /package:\s+name='([^']+)'/.exec(output)?.[1]
  const versionCode = /package:[^\r\n]*\bversionCode='([^']+)'/.exec(output)?.[1]
  const versionName = /package:[^\r\n]*\bversionName='([^']+)'/.exec(output)?.[1]
  const minSdk = Number(/(?:^|\r?\n)(?:minSdkVersion|sdkVersion):'(\d+)'/.exec(output)?.[1] ?? 0)
  const targetSdk = Number(/(?:^|\r?\n)targetSdkVersion:'(\d+)'/.exec(output)?.[1] ?? 0)
  return { packageName, versionCode, versionName, minSdk, targetSdk }
}

function parseSigningCertificate(output) {
  const digest = /Signer #1 certificate SHA-256 digest:\s*([0-9a-f:]+)/i.exec(output)?.[1]
  const distinguishedName = /Signer #1 certificate DN:\s*([^\r\n]+)/i.exec(output)?.[1]?.trim()
  return {
    sha256: digest?.replaceAll(':', '').toLowerCase() ?? null,
    distinguishedName: distinguishedName ?? null,
  }
}

async function sha256(pathname) {
  return createHash('sha256').update(await readFile(pathname)).digest('hex')
}

async function writeAtomic(pathname, contents) {
  const temporary = `${pathname}.tmp-${process.pid}`
  await writeFile(temporary, contents)
  await rm(pathname, { force: true })
  await rename(temporary, pathname)
}

async function apkPayloadSummary(jdk, apkPath, environment) {
  const archiveEntries = runCapture(jdk.jar, ['tf', apkPath], {
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
  }).split(/\r?\n/).filter(Boolean)
  const extractionRoot = await mkdtemp(resolve(tmpdir(), 'wuyan-android-payload-'))
  try {
    runCapture(jdk.jar, ['xf', apkPath], {
      cwd: extractionRoot,
      env: environment,
      maxBuffer: 64 * 1024 * 1024,
    })
    const files = (await listFiles(extractionRoot)).sort((left, right) => (
      relative(extractionRoot, left).localeCompare(relative(extractionRoot, right))
    ))
    const digest = createHash('sha256')
    for (const pathname of files) {
      const normalized = relative(extractionRoot, pathname).split(sep).join('/')
      digest.update(normalized)
      digest.update('\0')
      digest.update(await readFile(pathname))
      digest.update('\0')
    }
    return {
      sha256: digest.digest('hex'),
      fileCount: files.length,
      archiveEntryCount: archiveEntries.length,
      algorithm: 'sha256(path\\0uncompressed-bytes\\0), sorted UTF-8 paths',
    }
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }
}

async function ensurePersonalSigning() {
  const storeExists = await exists(signingStorePath)
  const propertiesExist = await exists(signingPropertiesPath)
  if (!storeExists || !propertiesExist) {
    throw new Error(
      `个人签名材料缺失或不完整；为保护已安装应用的升级链，构建已终止。请从离线备份恢复整个目录：${relative(repositoryRoot, signingRoot)}`,
    )
  }
}

async function pinSigningFingerprint(actualFingerprint) {
  if (!/^[a-f0-9]{64}$/.test(actualFingerprint)) throw new Error('无法读取有效的签名证书 SHA-256')
  const policyFingerprint = signingPolicy.allowedCertificateSha256.toLowerCase()
  if (actualFingerprint !== policyFingerprint) {
    throw new Error(`签名证书违反升级策略：期望 ${policyFingerprint}，实际 ${actualFingerprint}`)
  }
  if (await exists(signingFingerprintPath)) {
    const expectedFingerprint = (await readFile(signingFingerprintPath, 'utf8')).trim().toLowerCase()
    if (expectedFingerprint !== actualFingerprint) {
      throw new Error(`签名证书发生变化：期望 ${expectedFingerprint}，实际 ${actualFingerprint}`)
    }
  }
}

async function gitMetadata() {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  const sourceFiles = listed.status === 0
    ? listed.stdout.split('\0').filter(Boolean).filter((pathname) => !isSourceSnapshotExcluded(pathname)).sort()
    : []
  const snapshot = createHash('sha256')
  const files = []
  for (const pathname of sourceFiles) {
    const normalizedPath = pathname.split(sep).join('/')
    const absolutePath = resolve(repositoryRoot, pathname)
    const present = await exists(absolutePath)
    const bytes = present ? await readFile(absolutePath) : Buffer.from('<deleted>')
    snapshot.update(pathname)
    snapshot.update('\0')
    snapshot.update(bytes)
    snapshot.update('\0')
    files.push({
      path: normalizedPath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
      ...(present ? {} : { deleted: true }),
    })
  }
  return {
    commit: revision.status === 0 ? revision.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
    snapshotSha256: listed.status === 0 ? snapshot.digest('hex') : null,
    snapshotFileCount: listed.status === 0 ? sourceFiles.length : null,
    files,
  }
}

function decodeProperty(value) {
  return value.replace(/\\u([0-9a-f]{4})|\\(.)/gi, (_match, unicode, escaped) => {
    if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16))
    return ({ n: '\n', r: '\r', t: '\t', f: '\f' })[escaped] ?? escaped
  })
}

async function readSigningConfiguration() {
  const properties = new Map()
  const contents = await readFile(signingPropertiesPath, 'utf8')
  contents.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return
    const separator = line.search(/(?<!\\)[=:]/)
    if (separator < 1) return
    properties.set(
      decodeProperty(line.slice(0, separator).trim()),
      decodeProperty(line.slice(separator + 1).trim()),
    )
  })
  for (const key of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword']) {
    if (!properties.get(key)) throw new Error(`个人签名配置缺少 ${key}`)
  }
  const configuredStore = properties.get('storeFile')
  const storeFile = resolve(dirname(signingPropertiesPath), configuredStore)
  if (!await exists(storeFile)) throw new Error('个人签名配置指向的密钥库不存在')
  return {
    storeFile,
    storePassword: properties.get('storePassword'),
    keyAlias: properties.get('keyAlias'),
    keyPassword: properties.get('keyPassword'),
  }
}

async function createSignedSourceArchive(
  jdk,
  publicationRoot,
  gitSnapshot,
  inventoryContents,
  expectedCertificate,
  environment,
) {
  const stagingRoot = await mkdtemp(resolve(tmpdir(), 'wuyan-source-archive-'))
  const publicationArchive = resolve(publicationRoot, sourceArchiveName)
  const temporaryArchive = resolve(publicationRoot, `.${sourceArchiveName}.tmp-${process.pid}`)
  try {
    for (const item of gitSnapshot.files) {
      if (item.deleted) continue
      if (
        item.path.split('/').some((segment) => ['.private', '.toolchains', 'node_modules'].includes(segment))
        || /\.(?:jks|keystore|p12|pfx|pem|key)$/i.test(item.path)
      ) throw new Error(`源码归档拒绝潜在敏感文件：${item.path}`)
      const sourcePath = resolve(repositoryRoot, item.path)
      const destination = resolve(stagingRoot, item.path)
      if (!sourcePath.startsWith(`${repositoryRoot}${sep}`) || !destination.startsWith(`${stagingRoot}${sep}`)) {
        throw new Error(`源码归档路径越界：${item.path}`)
      }
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(sourcePath, destination)
    }
    await writeFile(resolve(stagingRoot, 'WUYAN-SOURCE-SNAPSHOT.json'), inventoryContents, 'utf8')
    await rm(temporaryArchive, { force: true })
    runCapture(jdk.jar, ['--create', '--file', temporaryArchive, '-C', stagingRoot, '.'], {
      env: environment,
      maxBuffer: 64 * 1024 * 1024,
    })

    const signing = await readSigningConfiguration()
    const signingEnvironment = {
      ...environment,
      WUYAN_SOURCE_STORE_PASSWORD: signing.storePassword,
      WUYAN_SOURCE_KEY_PASSWORD: signing.keyPassword,
    }
    runCapture(jdk.jarsigner, [
      '-keystore',
      signing.storeFile,
      '-storetype',
      'PKCS12',
      '-storepass:env',
      'WUYAN_SOURCE_STORE_PASSWORD',
      '-keypass:env',
      'WUYAN_SOURCE_KEY_PASSWORD',
      '-digestalg',
      'SHA-256',
      '-sigalg',
      'SHA256withRSA',
      temporaryArchive,
      signing.keyAlias,
    ], { env: signingEnvironment })
    const verification = runCapture(jdk.jarsigner, [
      '-J-Duser.language=en',
      '-verify',
      '-verbose',
      '-certs',
      temporaryArchive,
    ], {
      env: environment,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (!/jar verified/i.test(verification)) throw new Error('源码归档 JAR 签名校验失败')
    const archiveEntries = runCapture(jdk.jar, ['tf', temporaryArchive], {
      env: environment,
      maxBuffer: 64 * 1024 * 1024,
    }).split(/\r?\n/).filter(Boolean)
    const signedContentEntryCount = (verification.match(/^\s*sm\s+\d+/gm) ?? []).length
    const certificate = runCapture(jdk.keytool, [
      '-J-Duser.language=en',
      '-printcert',
      '-jarfile',
      temporaryArchive,
    ], { env: environment })
    const archiveCertificate = /SHA256:\s*([0-9A-F:]{64,})/i.exec(certificate)?.[1]
      ?.replaceAll(':', '')
      .toLowerCase()
    if (archiveCertificate !== expectedCertificate) throw new Error('源码归档与 APK 的签名证书不一致')
    await rm(publicationArchive, { force: true })
    await rename(temporaryArchive, publicationArchive)
    const archiveStat = await stat(publicationArchive)
    return {
      pathname: sourceArchiveName,
      sha256: await sha256(publicationArchive),
      sizeBytes: archiveStat.size,
      signed: true,
      signingCertificateSha256: archiveCertificate,
      embeddedInventoryPath: 'WUYAN-SOURCE-SNAPSHOT.json',
      jarEntryCount: archiveEntries.length,
      signedContentEntryCount,
      certificateSelfSigned: /signer certificate is self-signed/i.test(verification),
      signatureTimestampPresent: !/signatures that do not include a timestamp/i.test(verification),
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
    await rm(temporaryArchive, { force: true })
  }
}

if (!await exists(gradleWrapper)) throw new Error(`缺少 Gradle Wrapper：${gradleWrapper}`)

const legacyRecovery = await recoverLegacyAndroidPublication(releaseParent)
const startupRecovery = await recoverAndroidReleaseStore(releaseRoot)
if (legacyRecovery.restoredFrom) {
  console.warn(`已从中断的旧发布恢复 Android release：${relative(repositoryRoot, legacyRecovery.restoredFrom)}`)
}
if (legacyRecovery.previousResidues.length > 0 || legacyRecovery.interruptedPublicationResidues.length > 0) {
  console.warn('检测到旧两次-rename 协议残留；当前版本可解析，但残留需人工审阅后处理。')
}
if (startupRecovery.removed.length > 0) {
  console.warn(`已清理 ${startupRecovery.removed.length} 个未提交的 Android staging/pointer 临时项。`)
}

const jdk = await discoverJdk21()
const androidSdk = await discoverAndroidSdk()
await ensurePersonalSigning()
const buildEnvironment = {
  ...process.env,
  JAVA_HOME: jdk.home,
  ANDROID_HOME: androidSdk.root,
  ANDROID_SDK_ROOT: androidSdk.root,
  WUYAN_ANDROID_SIGNING_PROPERTIES: signingPropertiesPath,
  PATH: [resolve(jdk.home, 'bin'), androidSdk.buildTools.directory, process.env.PATH ?? ''].join(
    process.platform === 'win32' ? ';' : ':',
  ),
}

console.log(`使用 JDK 21：${jdk.version}`)
console.log(`使用 Android Build Tools：${androidSdk.buildTools.version}`)
console.log('执行 Android release 构建：clean lintRelease assembleRelease')

const gradleInvocation = commandInvocation(
  gradleWrapper,
  ['--no-daemon', '--dependency-verification', 'strict', 'clean', 'lintRelease', 'assembleRelease'],
)
const gradleResult = spawnSync(
  gradleInvocation.executable,
  gradleInvocation.args,
  {
    cwd: androidRoot,
    env: buildEnvironment,
    stdio: 'inherit',
    shell: gradleInvocation.shell,
    windowsHide: true,
  },
)
if (gradleResult.error) throw new Error(`Gradle 启动失败：${gradleResult.error.message}`)
if (gradleResult.status !== 0) throw new Error(`Gradle 构建失败（退出码 ${gradleResult.status}）`)

const sourceApk = await selectSignedApk(androidSdk.buildTools.apksigner, buildEnvironment)
const badging = parseBadging(runCapture(androidSdk.buildTools.aapt2, ['dump', 'badging', sourceApk], {
  env: buildEnvironment,
}))
if (badging.packageName !== expectedPackage) {
  throw new Error(`APK 包名错误：期望 ${expectedPackage}，实际 ${badging.packageName ?? '未知'}`)
}
if (badging.versionCode !== expectedVersionCode || badging.versionName !== expectedVersionName) {
  throw new Error(
    `APK 版本错误：期望 ${expectedVersionCode}/${expectedVersionName}，实际 ${badging.versionCode ?? '未知'}/${badging.versionName ?? '未知'}`,
  )
}
if (badging.minSdk !== expectedMinSdk || badging.targetSdk !== expectedTargetSdk) {
  throw new Error(
    `APK SDK 边界错误：期望 minSdk ${expectedMinSdk}/targetSdk ${expectedTargetSdk}，实际 ${badging.minSdk}/${badging.targetSdk}`,
  )
}

const signatureOutput = runCapture(
  androidSdk.buildTools.apksigner,
  ['verify', '--verbose', '--print-certs', sourceApk],
  { env: buildEnvironment },
)
const signingCertificate = parseSigningCertificate(signatureOutput)
if (!signingCertificate.sha256 || !signingCertificate.distinguishedName) {
  throw new Error('无法从已签名 APK 读取证书信息')
}
if (/CN=Android Debug/i.test(signingCertificate.distinguishedName)) {
  throw new Error('release APK 不得使用 Android Debug 证书')
}
await pinSigningFingerprint(signingCertificate.sha256)

await mkdir(releaseParent, { recursive: true })
const publicationRoot = await createAndroidReleaseStaging(releaseRoot)
let publicationCommitted = false
try {
const publicationArtifactPath = resolve(publicationRoot, artifactName)
const temporaryArtifact = resolve(publicationRoot, `.${artifactName}.tmp-${process.pid}`)
await rm(temporaryArtifact, { force: true })
await copyFile(sourceApk, temporaryArtifact)
await rm(publicationArtifactPath, { force: true })
await rename(temporaryArtifact, publicationArtifactPath)

const checksum = await sha256(publicationArtifactPath)
const artifactStat = await stat(publicationArtifactPath)
const payload = await apkPayloadSummary(jdk, publicationArtifactPath, buildEnvironment)
if (!await exists(sourceSbomPath)) throw new Error('缺少当前 Android release SBOM，请先运行 pnpm supply-chain')
const sbomBytes = await readFile(sourceSbomPath)
const sbom = JSON.parse(sbomBytes.toString('utf8'))
if (
  sbom.metadata?.component?.version !== expectedVersionName
  || !Array.isArray(sbom.components)
  || sbom.components.some((component) => !Array.isArray(component.hashes) || component.hashes.length === 0)
  || sbom.components.some((component) => !Array.isArray(component.licenses) || component.licenses.length === 0)
) {
  throw new Error('SBOM 不是当前 Android 版本的完整 release 清单')
}
await writeAtomic(resolve(publicationRoot, 'sbom.cdx.json'), sbomBytes)
const sbomSha256 = createHash('sha256').update(sbomBytes).digest('hex')
if (!await exists(sourceOsvReportPath)) throw new Error('缺少当前 SBOM 的 OSV 审计报告')
const osvReportBytes = await readFile(sourceOsvReportPath)
const osvReport = JSON.parse(osvReportBytes.toString('utf8'))
if (
  osvReport.schemaVersion !== 1
  || osvReport.sbomSha256 !== sbomSha256
  || osvReport.componentCount !== sbom.components.length
  || osvReport.ecosystems?.maven !== sbom.components.filter((item) => item.purl?.startsWith('pkg:maven/')).length
  || osvReport.findingCount !== 0
  || !Array.isArray(osvReport.findings)
  || osvReport.findings.length !== 0
) throw new Error('OSV 审计报告与当前 SBOM 不一致或含已知漏洞')
await writeAtomic(resolve(publicationRoot, 'osv-audit.json'), osvReportBytes)
const osvReportSha256 = createHash('sha256').update(osvReportBytes).digest('hex')
const lockfileSha256 = await sha256(lockfilePath)
const gradleIntegrity = {
  verificationMetadataSha256: await sha256(gradleVerificationMetadataPath),
  appLockSha256: await sha256(gradleAppLockPath),
  buildscriptLockSha256: await sha256(gradleBuildscriptLockPath),
  wrapperPropertiesSha256: await sha256(gradleWrapperPropertiesPath),
  wrapperJarSha256: await sha256(gradleWrapperJarPath),
}
const signingPolicySha256 = await sha256(signingPolicyPath)
const aapt2Version = runCapture(androidSdk.buildTools.aapt2, ['version'], { env: buildEnvironment }).trim()
const gitSnapshot = await gitMetadata()
const sourceInventory = {
  schemaVersion: 1,
  algorithm: 'sha256(path\\0bytes\\0), sorted Git tracked and unignored paths; per-file sha256(bytes)',
  snapshotSha256: gitSnapshot.snapshotSha256,
  fileCount: gitSnapshot.snapshotFileCount,
  files: gitSnapshot.files,
}
const sourceInventoryContents = `${JSON.stringify(sourceInventory, null, 2)}\n`
const sourceInventorySha256 = createHash('sha256').update(sourceInventoryContents).digest('hex')
const releaseId = androidReleaseId({
  versionCode: versionConfig.versionCode,
  apkSha256: checksum,
  sourceSnapshotSha256: gitSnapshot.snapshotSha256,
})
const sourceArchive = await createSignedSourceArchive(
  jdk,
  publicationRoot,
  gitSnapshot,
  sourceInventoryContents,
  signingCertificate.sha256,
  buildEnvironment,
)
const git = {
  commit: gitSnapshot.commit,
  dirty: gitSnapshot.dirty,
  snapshotSha256: gitSnapshot.snapshotSha256,
  snapshotFileCount: gitSnapshot.snapshotFileCount,
  inventoryPath: 'source-snapshot.json',
  inventorySha256: sourceInventorySha256,
  archive: sourceArchive,
}
const builtAt = new Date().toISOString()
const buildInfo = {
  schemaVersion: 6,
  releaseId,
  artifact: artifactName,
  sha256: checksum,
  sizeBytes: artifactStat.size,
  packageName: badging.packageName,
  versionCode: badging.versionCode ?? null,
  versionName: badging.versionName ?? null,
  minSdk: badging.minSdk,
  targetSdk: badging.targetSdk,
  signed: true,
  signingCertificateSha256: signingCertificate.sha256,
  signingCertificateDn: signingCertificate.distinguishedName,
  payload,
  sbomSha256,
  osvReportSha256,
  lockfileSha256,
  gradleIntegrity,
  buildTasks: ['clean', 'lintRelease', 'assembleRelease'],
  builtAt,
  source: git,
  toolchain: {
    java: jdk.version,
    androidBuildTools: androidSdk.buildTools.version,
    aapt2: aapt2Version,
  },
}

const manifest = {
  schemaVersion: 5,
  releaseId,
  releaseKind: 'android-personal-side-load',
  authoritativeFor: 'release/android/CURRENT',
  releaseRelativePath: `releases/${releaseId}`,
  publication: {
    protocol: ANDROID_RELEASE_PROTOCOL,
    pointerDirectory: 'CURRENT',
    immutableReleaseDirectory: `releases/${releaseId}`,
    semantics: 'crash-recoverable; each pointer record is atomically made visible, directory exchange is not claimed',
  },
  generatedAt: builtAt,
  artifact: {
    pathname: artifactName,
    sha256: checksum,
    sizeBytes: artifactStat.size,
    payload,
  },
  application: {
    packageName: badging.packageName,
    versionCode: badging.versionCode,
    versionName: badging.versionName,
    minSdk: badging.minSdk,
    targetSdk: badging.targetSdk,
  },
  signing: {
    certificateSha256: signingCertificate.sha256,
    certificateDn: signingCertificate.distinguishedName,
    policyPath: relative(repositoryRoot, signingPolicyPath).split(sep).join('/'),
    policySha256: signingPolicySha256,
    failClosed: true,
  },
  source: git,
  toolchain: buildInfo.toolchain,
  dependencyInventory: {
    pnpmLockPath: 'pnpm-lock.yaml',
    pnpmLockSha256: lockfileSha256,
    sbomPath: 'sbom.cdx.json',
    sbomSha256,
    componentCount: sbom.components.length,
    scope: sbom.metadata.component.properties.find((item) => item.name === 'wuyan:inventory-scope')?.value ?? null,
    osvReportPath: 'osv-audit.json',
    osvReportSha256,
    osvCheckedAt: osvReport.generatedAt,
    osvFindingCount: osvReport.findingCount,
    gradleIntegrity,
  },
}

await writeAtomic(
  resolve(publicationRoot, 'SHA256SUMS.txt'),
  `${checksum}  ${artifactName}\n${sourceArchive.sha256}  ${sourceArchive.pathname}\n`,
)
await writeAtomic(resolve(publicationRoot, 'source-snapshot.json'), sourceInventoryContents)
await writeAtomic(resolve(publicationRoot, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`)
manifest.publication.releaseRoot = await createAndroidReleaseRootInventory(publicationRoot, [
  artifactName,
  sourceArchive.pathname,
  'sbom.cdx.json',
  'osv-audit.json',
  'SHA256SUMS.txt',
  'source-snapshot.json',
  'build-info.json',
])
await writeAtomic(resolve(publicationRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
const verifierPath = resolve(scriptDirectory, 'verify-android-apk.mjs')
const publication = await publishAndroidRelease({
  containerRoot: releaseRoot,
  stagingDirectory: publicationRoot,
  releaseId,
  verifyRelease: async (candidateRoot) => {
    const result = spawnSync(process.execPath, [verifierPath, '--release-root', candidateRoot], {
      cwd: repositoryRoot,
      env: buildEnvironment,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    })
    if (result.error) throw new Error(`Android 候选发布验证启动失败：${result.error.message}`)
    if (result.status !== 0) throw new Error(`Android 候选发布验证失败（退出码 ${result.status}）`)
  },
})
publicationCommitted = true
console.log(`Android release 已通过不可变目录 + CURRENT 指针日志发布：${releaseId}`)
console.log(`协议语义：${ANDROID_RELEASE_PROTOCOL}；不宣称 Windows 目录交换为 crash-atomic。`)
console.log(`Android release APK 已生成：${relative(repositoryRoot, resolve(publication.current.releaseRoot, artifactName))}`)
console.log(`SHA-256：${checksum}`)
} finally {
  if (!publicationCommitted) await rm(publicationRoot, { recursive: true, force: true })
}
