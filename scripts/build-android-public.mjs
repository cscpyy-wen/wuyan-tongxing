import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyGradleWrapper } from './verify-gradle-wrapper.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultRepositoryRoot = resolve(scriptDirectory, '..')

async function exists(pathname) {
  try {
    await stat(pathname)
    return true
  } catch {
    return false
  }
}

function uniquePaths(paths) {
  const seen = new Set()
  return paths.filter(Boolean).map((pathname) => resolve(String(pathname).replace(/^['"]|['"]$/g, '')))
    .filter((pathname) => {
      const key = process.platform === 'win32' ? pathname.toLowerCase() : pathname
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function commandInvocation(executable, args, platform = process.platform) {
  if (platform !== 'win32' || !/\.(?:bat|cmd)$/i.test(executable)) {
    return { executable, args, shell: false }
  }
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`
  return {
    executable: [quote(executable), ...args.map(quote)].join(' '),
    args: [],
    shell: true,
  }
}

function run(executable, args, options = {}) {
  const invocation = commandInvocation(executable, args, options.platform)
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: options.stdio === 'inherit' ? undefined : 'utf8',
    stdio: options.stdio,
    shell: invocation.shell,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw new Error(`无法执行 ${basename(executable)}：${result.error.message}`)
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    throw new Error(`${basename(executable)} 执行失败（退出码 ${result.status}）${output ? `\n${output}` : ''}`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function javaMajor(versionOutput) {
  return Number(/version\s+"(?:1\.)?(\d+)/i.exec(versionOutput)?.[1] ?? 0)
}

async function childDirectories(root) {
  if (!await exists(root)) return []
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, entry.name))
}

export async function discoverJavaHome({ repositoryRoot = defaultRepositoryRoot, env = process.env } = {}) {
  const toolchainsRoot = resolve(repositoryRoot, '.toolchains')
  const executable = process.platform === 'win32' ? 'java.exe' : 'java'
  const candidates = uniquePaths([
    env.JAVA_HOME,
    resolve(toolchainsRoot, 'jdk-21'),
    resolve(toolchainsRoot, 'jdk21'),
    ...await childDirectories(toolchainsRoot),
  ])
  for (const home of candidates) {
    const java = resolve(home, 'bin', executable)
    if (!await exists(java)) continue
    try {
      const version = run(java, ['-version'], { cwd: repositoryRoot, env })
      if (javaMajor(version) === 21) return { home, java, version: version.trim().split(/\r?\n/)[0] }
    } catch {
      // Continue after stale environment entries.
    }
  }
  throw new Error('未找到 JDK 21。请设置 JAVA_HOME，或安装到项目 .toolchains/jdk-21。')
}

function versionParts(value) {
  return value.split(/[^0-9]+/).filter(Boolean).map(Number)
}

function compareVersionsDescending(left, right) {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return right.localeCompare(left)
}

async function findBuildTools(sdkRoot) {
  const root = resolve(sdkRoot, 'build-tools')
  if (!await exists(root)) return null
  const versions = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersionsDescending)
  for (const version of versions) {
    const directory = resolve(root, version)
    const aapt2 = resolve(directory, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2')
    const apksigner = resolve(directory, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner')
    if (await exists(aapt2) && await exists(apksigner)) return { version, directory, aapt2, apksigner }
  }
  return null
}

export async function discoverAndroidSdk({ repositoryRoot = defaultRepositoryRoot, env = process.env } = {}) {
  const toolchainsRoot = resolve(repositoryRoot, '.toolchains')
  const candidates = uniquePaths([
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    resolve(toolchainsRoot, 'android-sdk'),
    resolve(toolchainsRoot, 'android_sdk'),
    ...await childDirectories(toolchainsRoot),
  ])
  for (const root of candidates) {
    const platform = resolve(root, 'platforms', 'android-36', 'android.jar')
    const buildTools = await findBuildTools(root)
    if (await exists(platform) && buildTools) return { root, buildTools }
  }
  throw new Error(
    '未找到包含 platforms/android-36、aapt2 与 apksigner 的 Android SDK。请设置 ANDROID_HOME/ANDROID_SDK_ROOT，或安装到项目 .toolchains/android-sdk。',
  )
}

export function parseBadging(output) {
  return {
    packageName: /package:\s+name='([^']+)'/.exec(output)?.[1] ?? null,
    versionName: /package:[^\r\n]*\bversionName='([^']+)'/.exec(output)?.[1] ?? null,
  }
}

export function assertPublicDebugIdentity({ packageName, versionName, signerOutput }, expectedBaseVersion) {
  if (packageName !== 'cn.wuyantongxing.personal.debug') {
    throw new Error(`公开 debug APK 包名错误：${packageName ?? '未知'}`)
  }
  if (versionName !== `${expectedBaseVersion}-debug`) {
    throw new Error(`公开 debug APK 版本名错误：${versionName ?? '未知'}`)
  }
  if (!/Signer #1 certificate DN:[^\r\n]*CN=Android Debug/i.test(signerOutput)) {
    throw new Error('公开构建必须使用 Android Debug 证书，不得伪装维护者签名制品')
  }
}

export function publicBuildPlan(repositoryRoot = defaultRepositoryRoot) {
  const androidRoot = resolve(repositoryRoot, 'apps', 'android-shell', 'android')
  return {
    androidRoot,
    gradleWrapper: resolve(androidRoot, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'),
    apkRoot: resolve(androidRoot, 'app', 'build', 'outputs', 'apk', 'debug'),
    gradleTasks: ['--no-daemon', '--dependency-verification', 'strict', 'clean', 'lintDebug', 'assembleDebug'],
    syncCommand: ['sync:android'],
  }
}

export function packageManagerCommand({ env = process.env, platform = process.platform } = {}) {
  const runner = env.npm_execpath
  if (runner && /\.(?:c?js|mjs)$/i.test(runner)) {
    return { executable: process.execPath, prefixArgs: [runner] }
  }
  return {
    executable: platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    prefixArgs: [],
  }
}

async function listApks(directory) {
  if (!await exists(directory)) return []
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.apk'))
    .map((entry) => resolve(directory, entry.name))
}

async function sha256(pathname) {
  return createHash('sha256').update(await readFile(pathname)).digest('hex')
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

export async function buildPublicAndroid(repositoryRoot = defaultRepositoryRoot) {
  const plan = publicBuildPlan(repositoryRoot)
  const versionSource = JSON.parse(await readFile(
    resolve(repositoryRoot, 'apps', 'android-shell', 'personal-version.json'),
    'utf8',
  ))
  const gradleBuild = await readFile(resolve(plan.androidRoot, 'app', 'build.gradle'), 'utf8')
  if (!/debug\s*\{[\s\S]*applicationIdSuffix\s+["']\.debug["'][\s\S]*versionNameSuffix\s+["']-debug["']/m.test(gradleBuild)) {
    throw new Error('Android debug buildType 必须声明 applicationIdSuffix ".debug" 与 versionNameSuffix "-debug"')
  }
  await verifyGradleWrapper(repositoryRoot)
  const [jdk, androidSdk] = await Promise.all([
    discoverJavaHome({ repositoryRoot }),
    discoverAndroidSdk({ repositoryRoot }),
  ])
  const environment = {
    ...process.env,
    JAVA_HOME: jdk.home,
    ANDROID_HOME: androidSdk.root,
    ANDROID_SDK_ROOT: androidSdk.root,
    PATH: [resolve(jdk.home, 'bin'), androidSdk.buildTools.directory, process.env.PATH ?? ''].join(
      process.platform === 'win32' ? ';' : ':',
    ),
  }

  const pnpm = packageManagerCommand()
  console.log('同步公开 Android Web 资源：pnpm sync:android')
  run(pnpm.executable, [...pnpm.prefixArgs, ...plan.syncCommand], {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
  })
  console.log(`使用 ${jdk.version}`)
  console.log(`使用 Android Build Tools ${androidSdk.buildTools.version}`)
  console.log('执行公开 debug 构建：clean lintDebug assembleDebug')
  run(plan.gradleWrapper, plan.gradleTasks, {
    cwd: plan.androidRoot,
    env: environment,
    stdio: 'inherit',
  })

  const apks = await listApks(plan.apkRoot)
  const conventional = apks.find((pathname) => basename(pathname).toLowerCase() === 'app-debug.apk')
  const apk = conventional ?? (apks.length === 1 ? apks[0] : null)
  if (!apk) throw new Error(`未在 ${plan.apkRoot} 找到唯一公开 debug APK`)
  const normalizedRelative = relative(plan.apkRoot, apk)
  if (normalizedRelative.startsWith('..') || normalizedRelative.split(sep).includes('..')) {
    throw new Error('拒绝使用 debug 输出目录以外的 APK')
  }
  const badging = parseBadging(run(androidSdk.buildTools.aapt2, ['dump', 'badging', apk], {
    cwd: repositoryRoot,
    env: environment,
  }))
  const signerOutput = run(androidSdk.buildTools.apksigner, ['verify', '--verbose', '--print-certs', apk], {
    cwd: repositoryRoot,
    env: environment,
  })
  assertPublicDebugIdentity({ ...badging, signerOutput }, versionSource.versionName)

  const digest = await sha256(apk)
  console.log(`公开 debug APK（非维护者发布制品）：${apk}`)
  console.log('包名：cn.wuyantongxing.personal.debug；签名：Android Debug；不会写入 release/')
  console.log(`SHA-256：${digest}`)
  return { apk, sha256: digest, packageName: badging.packageName, versionName: badging.versionName }
}

if (isMain()) await buildPublicAndroid()
