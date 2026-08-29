import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANDROID_RELEASE_PROTOCOL, resolveCurrentAndroidRelease } from './android-release-store.mjs'
import {
  assertBinaryManifestSecurity,
  assertCapacitorRuntimeSecurity,
  assertStrictAndroidCsp,
} from './android-apk-security-policy.mjs'
import { verifyAndroidReleaseRootInventory } from './android-release-root-inventory.mjs'
import { isSourceSnapshotExcluded } from './source-snapshot-policy.mjs'
import { verifyGradleWrapper } from './verify-gradle-wrapper.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const toolchainsRoot = resolve(repositoryRoot, '.toolchains')
const releaseContainerRoot = resolve(repositoryRoot, 'release', 'android')
const releaseRootArgumentIndex = process.argv.indexOf('--release-root')
const explicitReleaseRoot = releaseRootArgumentIndex >= 0 ? process.argv[releaseRootArgumentIndex + 1] : null
if (releaseRootArgumentIndex >= 0 && !explicitReleaseRoot) throw new Error('--release-root 缺少路径')
const releaseRoot = explicitReleaseRoot
  ? resolve(explicitReleaseRoot)
  : (await resolveCurrentAndroidRelease(releaseContainerRoot)).releaseRoot
if (!releaseRoot.startsWith(`${releaseContainerRoot}${sep}`) && releaseRoot !== releaseContainerRoot) {
  throw new Error('Android release 验证路径必须位于 release/android 容器内')
}
const resolvedCurrent = explicitReleaseRoot ? null : await resolveCurrentAndroidRelease(releaseContainerRoot)
const versionSourcePath = resolve(repositoryRoot, 'apps', 'android-shell', 'personal-version.json')
const signingPolicyPath = resolve(repositoryRoot, 'apps', 'android-shell', 'personal-signing-policy.json')
const sourceSbomPath = resolve(repositoryRoot, 'docs', 'sbom.cdx.json')
const releaseSbomPath = resolve(releaseRoot, 'sbom.cdx.json')
const sourceOsvReportPath = resolve(repositoryRoot, 'docs', 'osv-audit.json')
const releaseOsvReportPath = resolve(releaseRoot, 'osv-audit.json')
const sourceInventoryPath = resolve(releaseRoot, 'source-snapshot.json')
const lockfilePath = resolve(repositoryRoot, 'pnpm-lock.yaml')
const androidRoot = resolve(repositoryRoot, 'apps', 'android-shell', 'android')
const gradleVerificationMetadataPath = resolve(androidRoot, 'gradle', 'verification-metadata.xml')
const gradleAppLockPath = resolve(androidRoot, 'app', 'gradle.lockfile')
const gradleBuildscriptLockPath = resolve(androidRoot, 'buildscript-gradle.lockfile')
const gradleWrapperPropertiesPath = resolve(androidRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties')
const gradleWrapperJarPath = resolve(androidRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar')
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
) throw new Error('Android 签名策略格式错误')
const artifactName = `wuyan-tongxing-personal-${versionConfig.versionName}.apk`
const artifactPath = resolve(releaseRoot, artifactName)
const sourceArchiveName = `wuyan-tongxing-source-${versionConfig.versionName}.jar`
const sourceArchivePath = resolve(releaseRoot, sourceArchiveName)
const expectedPackage = versionConfig.packageName
const expectedVersionCode = String(versionConfig.versionCode)
const expectedVersionName = versionConfig.versionName
const expectedMinSdk = versionConfig.minSdk
const expectedTargetSdk = versionConfig.targetSdk
const executableSuffix = process.platform === 'win32' ? '.exe' : ''
await verifyGradleWrapper(repositoryRoot)

const dangerousPermissions = new Set([
  'android.permission.ACCEPT_HANDOVER',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_MEDIA_LOCATION',
  'android.permission.ACTIVITY_RECOGNITION',
  'android.permission.ADD_VOICEMAIL',
  'android.permission.ANSWER_PHONE_CALLS',
  'android.permission.BLUETOOTH_ADVERTISE',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BODY_SENSORS',
  'android.permission.BODY_SENSORS_BACKGROUND',
  'android.permission.CALL_PHONE',
  'android.permission.CAMERA',
  'android.permission.GET_ACCOUNTS',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
  'android.permission.NEARBY_WIFI_DEVICES',
  'android.permission.PROCESS_OUTGOING_CALLS',
  'android.permission.READ_BASIC_PHONE_STATE',
  'android.permission.READ_CALENDAR',
  'android.permission.READ_CALL_LOG',
  'android.permission.READ_CONTACTS',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
  'android.permission.READ_PHONE_NUMBERS',
  'android.permission.READ_PHONE_STATE',
  'android.permission.READ_SMS',
  'android.permission.RECEIVE_MMS',
  'android.permission.RECEIVE_SMS',
  'android.permission.RECEIVE_WAP_PUSH',
  'android.permission.RECORD_AUDIO',
  'android.permission.REQUEST_INSTALL_PACKAGES',
  'android.permission.SEND_SMS',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.USE_SIP',
  'android.permission.UWB_RANGING',
  'android.permission.WRITE_CALENDAR',
  'android.permission.WRITE_CALL_LOG',
  'android.permission.WRITE_CONTACTS',
  'android.permission.WRITE_EXTERNAL_STORAGE',
])

const requiredNotificationPermissions = new Set([
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.WAKE_LOCK',
])

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
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
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
  const directories = await collectDirectories(toolchainsRoot)
  const candidates = uniquePaths([
    resolve(toolchainsRoot, 'jdk-21'),
    resolve(toolchainsRoot, 'jdk21'),
    process.env.JAVA_HOME,
    ...directories,
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
      // Continue searching for a valid repository-local JDK.
    }
  }
  throw new Error('未找到 JDK 21。请将 JDK 21 解压到 .toolchains/jdk-21，或设置 JAVA_HOME。')
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
  const root = resolve(sdkRoot, 'build-tools')
  if (!await isDirectory(root)) return null
  const versions = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^36(?:\.|$)/.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersionNames)
  for (const version of versions) {
    const directory = resolve(root, version)
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
  const directories = await collectDirectories(toolchainsRoot)
  const candidates = uniquePaths([
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    resolve(toolchainsRoot, 'android-sdk'),
    resolve(toolchainsRoot, 'android_sdk'),
    ...directories.filter((directory) => basename(directory).toLowerCase().includes('android')),
    ...directories,
  ])
  for (const root of candidates) {
    const buildTools = await findBuildTools36(root)
    if (buildTools) return { root, buildTools }
  }
  throw new Error('未找到 Android build-tools 36。请设置 ANDROID_HOME，或安装到 .toolchains/android-sdk。')
}

function parseBadging(output) {
  const packageName = /package:\s+name='([^']+)'/.exec(output)?.[1]
  const versionCode = /package:[^\r\n]*\bversionCode='([^']+)'/.exec(output)?.[1]
  const versionName = /package:[^\r\n]*\bversionName='([^']+)'/.exec(output)?.[1]
  const minSdk = Number(/(?:^|\r?\n)(?:minSdkVersion|sdkVersion):'(\d+)'/.exec(output)?.[1] ?? 0)
  const targetSdk = Number(/(?:^|\r?\n)targetSdkVersion:'(\d+)'/.exec(output)?.[1] ?? 0)
  const permissions = new Set(
    [...output.matchAll(/uses-permission(?:-sdk-\d+)?:\s+name='([^']+)'/g)].map((match) => match[1]),
  )
  return { packageName, versionCode, versionName, minSdk, targetSdk, permissions }
}

function parseSigningCertificate(output) {
  const digest = /Signer #1 certificate SHA-256 digest:\s*([0-9a-f:]+)/i.exec(output)?.[1]
  const distinguishedName = /Signer #1 certificate DN:\s*([^\r\n]+)/i.exec(output)?.[1]?.trim()
  return {
    sha256: digest?.replaceAll(':', '').toLowerCase() ?? null,
    distinguishedName: distinguishedName ?? null,
  }
}

async function listFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const pathname = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(pathname))
    else if (entry.isFile()) files.push(pathname)
  }
  return files
}

function validateArchiveEntry(entry) {
  const normalized = entry.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`APK 包含绝对路径：${entry}`)
  }
  if (normalized.split('/').includes('..')) throw new Error(`APK 包含路径穿越条目：${entry}`)
  return normalized
}

async function sha256(pathname) {
  return createHash('sha256').update(await readFile(pathname)).digest('hex')
}

async function payloadSummary(extractionRoot, archiveEntryCount) {
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
    archiveEntryCount,
    algorithm: 'sha256(path\\0uncompressed-bytes\\0), sorted UTF-8 paths',
  }
}

async function currentSourceSnapshot() {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  if (listed.status !== 0) throw new Error('无法读取 Git 源文件清单以核验构建快照')
  const sourceFiles = listed.stdout
    .split('\0')
    .filter(Boolean)
    .filter((pathname) => !isSourceSnapshotExcluded(pathname))
    .sort()
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
  return { sha256: snapshot.digest('hex'), fileCount: sourceFiles.length, files }
}

function describeSourceDrift(expectedFiles, currentFiles) {
  if (!Array.isArray(expectedFiles) || !Array.isArray(currentFiles)) return ['源码清单格式无效']
  const expected = new Map(expectedFiles.map((entry) => [entry.path, entry]))
  const current = new Map(currentFiles.map((entry) => [entry.path, entry]))
  const paths = [...new Set([...expected.keys(), ...current.keys()])].sort()
  return paths.flatMap((pathname) => {
    const before = expected.get(pathname)
    const after = current.get(pathname)
    if (!before) return [`${pathname}（构建后新增）`]
    if (!after) return [`${pathname}（构建后移除）`]
    if (
      before.sha256 !== after.sha256
      || before.sizeBytes !== after.sizeBytes
      || before.deleted !== after.deleted
    ) return [`${pathname}（内容或状态变化）`]
    return []
  })
}

function assertLocalRuntime(index) {
  const requiredMarkers = [
    'name="wuyan-runtime" content="android-local"',
    'http-equiv="Content-Security-Policy"',
    'src="/js/app.js"',
    'href="/css/app.css"',
  ]
  for (const marker of requiredMarkers) {
    if (!index.includes(marker)) throw new Error(`APK Android 入口缺少：${marker}`)
  }
  assertStrictAndroidCsp(index)
  if (/<(?:script|link|iframe)[^>]+(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(index)) {
    throw new Error('APK Android 入口包含远程脚本、样式或框架依赖')
  }
}

async function verifyPublicAssets(publicRoot) {
  const required = ['index.html', 'js/app.js', 'css/app.css', 'android-assets.json']
  for (const pathname of required) {
    if (!await exists(resolve(publicRoot, pathname))) throw new Error(`APK 缺少关键本地资源：assets/public/${pathname}`)
  }

  const files = await listFiles(publicRoot)
  const relativeFiles = files.map((pathname) => relative(publicRoot, pathname).split(sep).join('/'))
  const serviceWorkers = relativeFiles.filter((pathname) => /(^|\/)sw\.js$/i.test(pathname))
  if (serviceWorkers.length > 0) throw new Error(`APK 不得包含 Service Worker：${serviceWorkers.join(', ')}`)

  const manifestPath = resolve(publicRoot, 'android-assets.json')
  const assetManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (assetManifest.runtime !== 'capacitor-android-local' || assetManifest.serviceWorker !== false) {
    throw new Error('APK 的 Android 资源清单运行时边界错误')
  }
  if (!Array.isArray(assetManifest.files)) throw new Error('APK 的 Android 资源清单格式错误')

  const expected = new Map()
  for (const entry of assetManifest.files) {
    if (
      typeof entry?.pathname !== 'string'
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')
    ) {
      throw new Error('APK 的 Android 资源清单包含非法条目')
    }
    const normalized = validateArchiveEntry(entry.pathname)
    if (normalized !== entry.pathname || expected.has(normalized)) {
      throw new Error(`APK 的 Android 资源清单路径非法或重复：${entry.pathname}`)
    }
    expected.set(normalized, entry)
  }

  const capacitorBridgeFiles = new Set(['cordova.js', 'cordova_plugins.js'])
  const actualApplicationFiles = files.filter((pathname) => pathname !== manifestPath)
  const trackedApplicationFiles = actualApplicationFiles.filter((pathname) => {
    const relativePath = relative(publicRoot, pathname).split(sep).join('/')
    return !capacitorBridgeFiles.has(relativePath)
  })
  if (trackedApplicationFiles.length !== expected.size) throw new Error('APK 本地资源与资源清单数量不匹配')
  for (const pathname of trackedApplicationFiles) {
    const relativePath = relative(publicRoot, pathname).split(sep).join('/')
    const entry = expected.get(relativePath)
    if (!entry) throw new Error(`APK 包含未列入资源清单的文件：${relativePath}`)
    const fileStat = await stat(pathname)
    const checksum = await sha256(pathname)
    if (fileStat.size !== entry.bytes || checksum !== entry.sha256) {
      throw new Error(`APK 本地资源哈希或大小不匹配：${relativePath}`)
    }
  }

  const textExtensions = new Set(['.css', '.html', '.js', '.json', '.svg', '.txt'])
  const forbiddenContent = /chatgpt\.site|openai\.com|accounts\.google\.com|tcloudbaseapp\.com|data-wuyan-offline|navigator\.serviceWorker|serviceWorker\.register/i
  for (const pathname of files) {
    const extension = /\.[^.]+$/.exec(pathname)?.[0]?.toLowerCase()
    if (!textExtensions.has(extension)) continue
    const body = await readFile(pathname, 'utf8')
    if (forbiddenContent.test(body)) {
      throw new Error(`APK 本地资源包含 Service Worker 或远程运行依赖：${relative(publicRoot, pathname)}`)
    }
    if (/\bimportScripts\s*\(\s*["']https?:\/\//i.test(body) || /@import\s+(?:url\()?\s*["']?https?:\/\//i.test(body)) {
      throw new Error(`APK 本地资源包含远程加载语句：${relative(publicRoot, pathname)}`)
    }
  }

  assertLocalRuntime(await readFile(resolve(publicRoot, 'index.html'), 'utf8'))
  return { fileCount: files.length }
}

async function verifySignedSourceArchive(jdk, environment, sourceInventory, inventoryContents, expectedCertificate) {
  if (!await exists(sourceArchivePath)) throw new Error(`缺少可恢复源码归档：${sourceArchiveName}`)
  const verification = runCapture(jdk.jarsigner, [
    '-J-Duser.language=en',
    '-verify',
    '-verbose',
    '-certs',
    sourceArchivePath,
  ], {
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (!/jar verified/i.test(verification)) throw new Error('源码归档 JAR 签名无效')
  const certificate = runCapture(jdk.keytool, [
    '-J-Duser.language=en',
    '-printcert',
    '-jarfile',
    sourceArchivePath,
  ], { env: environment })
  const archiveCertificate = /SHA256:\s*([0-9A-F:]{64,})/i.exec(certificate)?.[1]
    ?.replaceAll(':', '')
    .toLowerCase()
  if (archiveCertificate !== expectedCertificate) throw new Error('源码归档与 APK 的签名证书不一致')

  const entries = runCapture(jdk.jar, ['tf', sourceArchivePath], {
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
  }).split(/\r?\n/).filter(Boolean).map(validateArchiveEntry)
  const signedContentEntryCount = (verification.match(/^\s*sm\s+\d+/gm) ?? []).length
  const extractionRoot = await mkdtemp(resolve(tmpdir(), 'wuyan-source-verify-'))
  try {
    runCapture(jdk.jar, ['xf', sourceArchivePath], {
      cwd: extractionRoot,
      env: environment,
      maxBuffer: 64 * 1024 * 1024,
    })
    const embeddedInventory = await readFile(resolve(extractionRoot, 'WUYAN-SOURCE-SNAPSHOT.json'), 'utf8')
    if (embeddedInventory !== inventoryContents) throw new Error('源码归档内嵌清单与发布清单不一致')

    const expectedFiles = new Set(['WUYAN-SOURCE-SNAPSHOT.json'])
    for (const item of sourceInventory.files) {
      const pathname = resolve(extractionRoot, item.path)
      if (!pathname.startsWith(`${extractionRoot}${sep}`)) throw new Error(`源码归档路径越界：${item.path}`)
      if (item.deleted) {
        if (await exists(pathname)) throw new Error(`源码归档错误包含已删除文件：${item.path}`)
        continue
      }
      expectedFiles.add(item.path)
      if (!await exists(pathname)) throw new Error(`源码归档缺少文件：${item.path}`)
      const fileStat = await stat(pathname)
      if (fileStat.size !== item.sizeBytes || await sha256(pathname) !== item.sha256) {
        throw new Error(`源码归档文件哈希或大小错误：${item.path}`)
      }
    }

    const actualFiles = (await listFiles(extractionRoot))
      .map((pathname) => relative(extractionRoot, pathname).split(sep).join('/'))
      .filter((pathname) => !pathname.startsWith('META-INF/'))
    const unexpected = actualFiles.filter((pathname) => !expectedFiles.has(pathname))
    const missing = [...expectedFiles].filter((pathname) => !actualFiles.includes(pathname))
    if (unexpected.length > 0 || missing.length > 0) {
      throw new Error(`源码归档文件集合不一致：多余 ${unexpected.length}，缺少 ${missing.length}`)
    }
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }

  const archiveStat = await stat(sourceArchivePath)
  return {
    pathname: sourceArchiveName,
    sha256: await sha256(sourceArchivePath),
    sizeBytes: archiveStat.size,
    signed: true,
    signingCertificateSha256: archiveCertificate,
    embeddedInventoryPath: 'WUYAN-SOURCE-SNAPSHOT.json',
    entryCount: entries.length,
    signedContentEntryCount,
    certificateSelfSigned: /signer certificate is self-signed/i.test(verification),
    signatureTimestampPresent: !/signatures that do not include a timestamp/i.test(verification),
  }
}

if (!await exists(artifactPath)) throw new Error(`缺少 Android release APK：${artifactPath}`)
const jdk = await discoverJdk21()
const androidSdk = await discoverAndroidSdk()
const environment = {
  ...process.env,
  JAVA_HOME: jdk.home,
  ANDROID_HOME: androidSdk.root,
  ANDROID_SDK_ROOT: androidSdk.root,
  PATH: [resolve(jdk.home, 'bin'), androidSdk.buildTools.directory, process.env.PATH ?? ''].join(
    process.platform === 'win32' ? ';' : ':',
  ),
}

const checksum = await sha256(artifactPath)
const checksumFile = await readFile(resolve(releaseRoot, 'SHA256SUMS.txt'), 'utf8')
const checksumEntries = new Map(
  checksumFile.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const match = /^([a-fA-F0-9]{64})\s{2}(.+)$/.exec(line)
    if (!match) throw new Error(`SHA256SUMS.txt 格式错误：${line}`)
    return [match[2], match[1].toLowerCase()]
  }),
)
if (checksumEntries.get(artifactName) !== checksum) throw new Error('APK SHA-256 与 SHA256SUMS.txt 不匹配')
const sourceArchiveChecksum = await sha256(sourceArchivePath)
if (checksumEntries.get(sourceArchiveName) !== sourceArchiveChecksum) {
  throw new Error('源码归档 SHA-256 与 SHA256SUMS.txt 不匹配')
}

const buildInfo = JSON.parse(await readFile(resolve(releaseRoot, 'build-info.json'), 'utf8'))
const artifactStat = await stat(artifactPath)
const sourceSbomSha256 = await sha256(sourceSbomPath)
const releaseSbomSha256 = await sha256(releaseSbomPath)
const sourceOsvReportSha256 = await sha256(sourceOsvReportPath)
const releaseOsvReportSha256 = await sha256(releaseOsvReportPath)
const lockfileSha256 = await sha256(lockfilePath)
const gradleIntegrity = {
  verificationMetadataSha256: await sha256(gradleVerificationMetadataPath),
  appLockSha256: await sha256(gradleAppLockPath),
  buildscriptLockSha256: await sha256(gradleBuildscriptLockPath),
  wrapperPropertiesSha256: await sha256(gradleWrapperPropertiesPath),
  wrapperJarSha256: await sha256(gradleWrapperJarPath),
}
if (
  ![5, 6].includes(buildInfo.schemaVersion)
  || buildInfo.artifact !== artifactName
  || buildInfo.sha256 !== checksum
  || buildInfo.sizeBytes !== artifactStat.size
  || buildInfo.packageName !== expectedPackage
  || buildInfo.versionCode !== expectedVersionCode
  || buildInfo.versionName !== expectedVersionName
  || buildInfo.minSdk !== expectedMinSdk
  || buildInfo.targetSdk !== expectedTargetSdk
  || buildInfo.signed !== true
  || buildInfo.sbomSha256 !== sourceSbomSha256
  || sourceSbomSha256 !== releaseSbomSha256
  || buildInfo.osvReportSha256 !== sourceOsvReportSha256
  || sourceOsvReportSha256 !== releaseOsvReportSha256
  || buildInfo.lockfileSha256 !== lockfileSha256
  || JSON.stringify(buildInfo.gradleIntegrity) !== JSON.stringify(gradleIntegrity)
) {
  throw new Error('build-info.json 与最终 APK 不一致')
}
const sourceSnapshot = await currentSourceSnapshot()
const sourceInventoryContents = await readFile(sourceInventoryPath, 'utf8')
const sourceInventorySha256 = createHash('sha256').update(sourceInventoryContents).digest('hex')
const sourceInventory = JSON.parse(sourceInventoryContents)
const sourceDrift = describeSourceDrift(sourceInventory.files, sourceSnapshot.files)
if (
  buildInfo.source?.snapshotSha256 !== sourceSnapshot.sha256
  || buildInfo.source?.snapshotFileCount !== sourceSnapshot.fileCount
  || buildInfo.source?.inventoryPath !== 'source-snapshot.json'
  || buildInfo.source?.inventorySha256 !== sourceInventorySha256
  || buildInfo.source?.archive?.pathname !== sourceArchiveName
  || buildInfo.source?.archive?.sha256 !== sourceArchiveChecksum
  || sourceInventory.schemaVersion !== 1
  || sourceInventory.snapshotSha256 !== sourceSnapshot.sha256
  || sourceInventory.fileCount !== sourceSnapshot.fileCount
  || sourceDrift.length > 0
) {
  const details = sourceDrift.length > 0
    ? `：${sourceDrift.slice(0, 20).join('；')}${sourceDrift.length > 20 ? `；另有 ${sourceDrift.length - 20} 项` : ''}`
    : ''
  throw new Error(`当前源码与逐文件构建快照不一致，请重新构建 APK${details}`)
}

const badgingOutput = runCapture(androidSdk.buildTools.aapt2, ['dump', 'badging', artifactPath], { env: environment })
const badging = parseBadging(badgingOutput)
const binaryManifestSecurity = assertBinaryManifestSecurity(runCapture(
  androidSdk.buildTools.aapt2,
  ['dump', 'xmltree', '--file', 'AndroidManifest.xml', artifactPath],
  { env: environment },
))
if (badging.packageName !== expectedPackage) {
  throw new Error(`APK 包名错误：期望 ${expectedPackage}，实际 ${badging.packageName ?? '未知'}`)
}
if (badging.versionCode !== expectedVersionCode || badging.versionName !== expectedVersionName) {
  throw new Error(
    `APK 版本错误：期望 ${expectedVersionCode}/${expectedVersionName}，实际 ${badging.versionCode ?? '未知'}/${badging.versionName ?? '未知'}`,
  )
}
if (badging.minSdk !== expectedMinSdk) {
  throw new Error(`APK minSdk 错误：期望 ${expectedMinSdk}，实际 ${badging.minSdk || '未知'}`)
}
if (badging.targetSdk !== expectedTargetSdk) {
  throw new Error(`APK targetSdk 错误：期望 ${expectedTargetSdk}，实际 ${badging.targetSdk || '未知'}`)
}
if (badging.permissions.has('android.permission.INTERNET')) throw new Error('APK 不得申请 INTERNET 权限')
if (badging.permissions.has('android.permission.SCHEDULE_EXACT_ALARM')) {
  throw new Error('APK 只使用非精确每日提醒，不得申请 SCHEDULE_EXACT_ALARM')
}
if (badging.permissions.has('android.permission.USE_EXACT_ALARM')) {
  throw new Error('APK 只使用非精确每日提醒，不得申请 USE_EXACT_ALARM')
}
for (const permission of requiredNotificationPermissions) {
  if (!badging.permissions.has(permission)) throw new Error(`APK 缺少提醒运行所需权限：${permission}`)
}
const forbiddenPermissions = [...badging.permissions].filter((permission) => (
  dangerousPermissions.has(permission) || /^android\.permission\.health\.(?:READ|WRITE)_/.test(permission)
))
if (forbiddenPermissions.length > 0) {
  throw new Error(`APK 申请了危险或高风险权限：${forbiddenPermissions.sort().join(', ')}`)
}

const signatureOutput = runCapture(
  androidSdk.buildTools.apksigner,
  ['verify', '--verbose', '--print-certs', artifactPath],
  { env: environment },
)
if (!/Verified using v(?:2|3|4) scheme[^\r\n]*:\s*true/i.test(signatureOutput)) {
  throw new Error('APK 虽通过基础签名检查，但未启用现代 APK v2/v3/v4 签名方案')
}
const signingCertificate = parseSigningCertificate(signatureOutput)
if (!signingCertificate.sha256 || !signingCertificate.distinguishedName) {
  throw new Error('无法从 APK 读取签名证书信息')
}
if (/CN=Android Debug/i.test(signingCertificate.distinguishedName)) {
  throw new Error('release APK 不得使用 Android Debug 证书')
}
const pinnedFingerprint = signingPolicy.allowedCertificateSha256.toLowerCase()
if (
  signingCertificate.sha256 !== pinnedFingerprint
  || buildInfo.signingCertificateSha256 !== pinnedFingerprint
  || buildInfo.signingCertificateDn !== signingCertificate.distinguishedName
) {
  throw new Error('APK 签名证书与固定指纹或 build-info.json 不一致')
}
const sourceArchiveVerification = await verifySignedSourceArchive(
  jdk,
  environment,
  sourceInventory,
  sourceInventoryContents,
  pinnedFingerprint,
)
const {
  entryCount: sourceArchiveEntryCount,
  signedContentEntryCount: sourceArchiveSignedContentEntryCount,
  certificateSelfSigned: sourceArchiveCertificateSelfSigned,
  signatureTimestampPresent: sourceArchiveSignatureTimestampPresent,
  ...legacySourceArchiveEvidence
} = sourceArchiveVerification
const sourceArchiveEvidence = buildInfo.source.archive?.jarEntryCount === undefined
  ? legacySourceArchiveEvidence
  : {
      ...legacySourceArchiveEvidence,
      jarEntryCount: sourceArchiveEntryCount,
      signedContentEntryCount: sourceArchiveSignedContentEntryCount,
      certificateSelfSigned: sourceArchiveCertificateSelfSigned,
      signatureTimestampPresent: sourceArchiveSignatureTimestampPresent,
    }
if (JSON.stringify(buildInfo.source.archive) !== JSON.stringify(sourceArchiveEvidence)) {
  throw new Error('build-info.json 未完整绑定已签名源码归档')
}
runCapture(androidSdk.buildTools.zipalign, ['-c', '-P', '16', '4', artifactPath], { env: environment })

const archiveEntries = runCapture(jdk.jar, ['tf', artifactPath], { env: environment, maxBuffer: 64 * 1024 * 1024 })
  .split(/\r?\n/)
  .filter(Boolean)
  .map(validateArchiveEntry)
const requiredArchiveEntries = [
  'assets/public/index.html',
  'assets/public/js/app.js',
  'assets/public/css/app.css',
  'assets/public/android-assets.json',
  'assets/capacitor.config.json',
]
for (const entry of requiredArchiveEntries) {
  if (!archiveEntries.includes(entry)) throw new Error(`APK 缺少关键归档条目：${entry}`)
}

const extractionRoot = await mkdtemp(resolve(tmpdir(), 'wuyan-android-apk-'))
let assetSummary
let payload
try {
  runCapture(jdk.jar, ['xf', artifactPath], { cwd: extractionRoot, env: environment, maxBuffer: 64 * 1024 * 1024 })
  payload = await payloadSummary(extractionRoot, archiveEntries.length)
  const publicRoot = resolve(extractionRoot, 'assets', 'public')
  assetSummary = await verifyPublicAssets(publicRoot)

  const capacitorConfig = JSON.parse(
    await readFile(resolve(extractionRoot, 'assets', 'capacitor.config.json'), 'utf8'),
  )
  if (capacitorConfig.appId !== expectedPackage) throw new Error('APK 内 Capacitor appId 与包名不一致')
  assertCapacitorRuntimeSecurity(capacitorConfig)
} finally {
  await rm(extractionRoot, { recursive: true, force: true })
}

if (JSON.stringify(payload) !== JSON.stringify(buildInfo.payload)) {
  throw new Error('APK 解包内容摘要与 build-info.json 不一致')
}

const sbom = JSON.parse(await readFile(releaseSbomPath, 'utf8'))
if (
  sbom.bomFormat !== 'CycloneDX'
  || sbom.specVersion !== '1.6'
  || sbom.metadata?.component?.version !== expectedVersionName
  || !Array.isArray(sbom.components)
  || sbom.components.some((component) => !Array.isArray(component.hashes) || component.hashes.length === 0)
  || sbom.components.some((component) => !Array.isArray(component.licenses) || component.licenses.length === 0)
  || !sbom.components.some((item) => item.purl?.startsWith('pkg:npm/%40capacitor/android@'))
  || !sbom.components.some((item) => item.purl?.startsWith('pkg:maven/androidx.appcompat/appcompat@'))
  || !sbom.components.some((item) => item.properties?.some((property) => property.value === 'gradle-releaseRuntimeClasspath'))
) throw new Error('Android SBOM 缺少当前版本或 Capacitor/Gradle release 依赖')

const osvReport = JSON.parse(await readFile(releaseOsvReportPath, 'utf8'))
if (
  osvReport.schemaVersion !== 1
  || osvReport.sbomSha256 !== releaseSbomSha256
  || osvReport.componentCount !== sbom.components.length
  || osvReport.ecosystems?.maven !== sbom.components.filter((item) => item.purl?.startsWith('pkg:maven/')).length
  || osvReport.findingCount !== 0
  || !Array.isArray(osvReport.findings)
  || osvReport.findings.length !== 0
) throw new Error('OSV 审计报告与当前 SBOM 不一致或含已知漏洞')

const manifest = JSON.parse(await readFile(resolve(releaseRoot, 'manifest.json'), 'utf8'))
const signingPolicySha256 = await sha256(signingPolicyPath)
const legacyManifest = manifest.schemaVersion === 3 && manifest.authoritativeFor === 'release/android'
const journalManifest = (
  [4, 5].includes(manifest.schemaVersion)
  && manifest.authoritativeFor === 'release/android/CURRENT'
  && manifest.releaseId === buildInfo.releaseId
  && manifest.releaseRelativePath === `releases/${manifest.releaseId}`
  && manifest.publication?.protocol === ANDROID_RELEASE_PROTOCOL
  && manifest.publication?.pointerDirectory === 'CURRENT'
  && manifest.publication?.immutableReleaseDirectory === manifest.releaseRelativePath
)
if (
  (!legacyManifest && !journalManifest)
  || manifest.releaseKind !== 'android-personal-side-load'
  || manifest.generatedAt !== buildInfo.builtAt
  || manifest.artifact?.pathname !== artifactName
  || manifest.artifact?.sha256 !== checksum
  || manifest.artifact?.sizeBytes !== artifactStat.size
  || JSON.stringify(manifest.artifact?.payload) !== JSON.stringify(payload)
  || manifest.application?.packageName !== expectedPackage
  || manifest.application?.versionCode !== expectedVersionCode
  || manifest.application?.versionName !== expectedVersionName
  || manifest.signing?.certificateSha256 !== pinnedFingerprint
  || manifest.signing?.certificateDn !== signingCertificate.distinguishedName
  || manifest.signing?.policyPath !== 'apps/android-shell/personal-signing-policy.json'
  || manifest.signing?.policySha256 !== signingPolicySha256
  || manifest.signing?.failClosed !== true
  || JSON.stringify(manifest.source) !== JSON.stringify(buildInfo.source)
  || JSON.stringify(manifest.toolchain) !== JSON.stringify(buildInfo.toolchain)
  || manifest.dependencyInventory?.pnpmLockSha256 !== lockfileSha256
  || manifest.dependencyInventory?.sbomSha256 !== releaseSbomSha256
  || manifest.dependencyInventory?.componentCount !== sbom.components.length
  || manifest.dependencyInventory?.osvReportSha256 !== releaseOsvReportSha256
  || manifest.dependencyInventory?.osvFindingCount !== 0
  || JSON.stringify(manifest.dependencyInventory?.gradleIntegrity) !== JSON.stringify(gradleIntegrity)
) throw new Error('Android manifest.json 未完整绑定 APK、签名、源码、工具链或 SBOM')
let releaseRootInventory = null
if (manifest.schemaVersion === 5) {
  releaseRootInventory = await verifyAndroidReleaseRootInventory(releaseRoot, manifest.publication?.releaseRoot, [
    artifactName,
    sourceArchiveName,
    'sbom.cdx.json',
    'osv-audit.json',
    'SHA256SUMS.txt',
    'source-snapshot.json',
    'build-info.json',
  ])
}
if (resolvedCurrent?.mode === 'pointer-journal') {
  if (!journalManifest || resolvedCurrent.pointer.releaseId !== manifest.releaseId) {
    throw new Error('CURRENT 指针未绑定当前 Android manifest/releaseId')
  }
}

console.log(`Android APK 验证通过：${relative(repositoryRoot, artifactPath)}`)
console.log(`包名 ${expectedPackage}，minSdk ${expectedMinSdk}，targetSdk ${expectedTargetSdk}`)
console.log(`版本 ${expectedVersionCode}/${expectedVersionName}，个人签名证书 ${pinnedFingerprint}`)
console.log(`源码归档整体签名有效：${sourceArchiveEntryCount} 个 JAR 条目，其中 ${sourceArchiveSignedContentEntryCount} 个内容条目标记为签名；自签名证书=${sourceArchiveCertificateSelfSigned}，TSA 时间戳=${sourceArchiveSignatureTimestampPresent}`)
console.log(`签名策略、SBOM/OSV、APK 内容摘要、16 KiB/4-byte 对齐、权限与 ${assetSummary.fileCount} 个本地资源均通过`)
console.log(`二进制 manifest debuggable=false（${binaryManifestSecurity.debuggableEvidence}）；Capacitor WebView debugging=false/logging=none；严格 CSP 通过。`)
console.log(releaseRootInventory
  ? `schema 5 根目录精确白名单与整树摘要通过：${releaseRootInventory.fileCount} 个非 manifest 文件，${releaseRootInventory.treeSha256}`
  : `历史 schema ${manifest.schemaVersion} 发布保持兼容；根目录精确白名单/整树摘要仅由 schema 5 起强制。`)
console.log(`发布解析模式：${resolvedCurrent?.mode ?? 'explicit-staging-root'}；CURRENT 协议仅声明 crash-recoverable，不声明 Windows 目录交换 crash-atomic。`)
console.log(`SHA-256：${checksum}`)
