import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ANDROID_DEVICE_TEST_COUNT,
  verifyAndroidDeviceTestResults,
} from './android-device-test-results.mjs'
import { verifyGradleWrapper } from './verify-gradle-wrapper.mjs'
import {
  validateGradleDistributionEntries,
  verifyLocalGradleDistribution,
} from './verified-gradle-distribution.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const androidRoot = resolve(repositoryRoot, 'apps', 'android-shell', 'android')
const gradleWrapper = resolve(androidRoot, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
const localJdk = resolve(repositoryRoot, '.toolchains', 'jdk-21')
const localSdk = resolve(repositoryRoot, '.toolchains', 'android-sdk')
const androidTestResults = resolve(androidRoot, 'app', 'build', 'outputs', 'androidTest-results', 'connected')
const version = JSON.parse(readFileSync(resolve(repositoryRoot, 'apps', 'android-shell', 'personal-version.json'), 'utf8'))
const wrapperIntegrity = await verifyGradleWrapper(repositoryRoot)
const runDeviceTests = process.argv.includes('--device')
const cleanGradleCache = process.argv.includes('--clean-gradle-cache')
const serial = process.env.ANDROID_SERIAL?.trim()
// Keep this exact count in lock-step with app/src/androidTest. The gate must
// fail if an instrumentation class is silently skipped or not discovered.
const expectedDeviceTests = ANDROID_DEVICE_TEST_COUNT
if (cleanGradleCache && runDeviceTests) throw new Error('空 Gradle 缓存门禁不得与设备测试合并执行')

function commandInvocation(executable, args) {
  if (process.platform !== 'win32' || !/\.(?:bat|cmd)$/i.test(executable)) {
    return { executable, args, shell: false }
  }
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`
  return { executable: [quote(executable), ...args.map(quote)].join(' '), args: [], shell: true }
}

function run(executable, args, options = {}) {
  const invocation = commandInvocation(executable, args)
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : 'inherit',
    shell: invocation.shell,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (!options.allowFailure && result.status !== 0) {
    const output = options.quiet ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : ''
    throw new Error(`命令失败（退出码 ${result.status}）：${executable} ${args.join(' ')}${output ? `\n${output}` : ''}`)
  }
  return result
}

const javaHome = process.env.JAVA_HOME?.trim() || localJdk
const androidHome = process.env.ANDROID_HOME?.trim() || process.env.ANDROID_SDK_ROOT?.trim() || localSdk
const adb = resolve(androidHome, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
if (!existsSync(resolve(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) {
  throw new Error(`未找到 JDK 21：${javaHome}`)
}
if (!existsSync(gradleWrapper)) throw new Error(`未找到 Gradle Wrapper：${gradleWrapper}`)

const environment = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  ANDROID_SDK_ROOT: androidHome,
  ...(serial ? { ANDROID_SERIAL: serial } : {}),
}

let gradleExecutable = gradleWrapper
let cleanCacheRoot = null
if (cleanGradleCache) {
  const optionIndex = process.argv.indexOf('--gradle-distribution')
  const optionPath = optionIndex >= 0 ? process.argv[optionIndex + 1] : null
  if (optionIndex >= 0 && !optionPath) throw new Error('--gradle-distribution 缺少 ZIP 路径')
  const distributionZip = optionPath || process.env.WUYAN_GRADLE_DISTRIBUTION_ZIP?.trim()
  if (!distributionZip) {
    throw new Error('空缓存门禁要求 --gradle-distribution <ZIP> 或 WUYAN_GRADLE_DISTRIBUTION_ZIP；脚本不会静默下载 Gradle 分发。')
  }
  const verifiedDistribution = await verifyLocalGradleDistribution(resolve(distributionZip), wrapperIntegrity.distributionHash)
  const distributionArchive = basename(new URL(wrapperIntegrity.distributionUrl).pathname)
  const distributionRootName = distributionArchive.replace(/-bin\.zip$/, '')
  if (!distributionRootName || distributionRootName === distributionArchive) throw new Error('无法从 Wrapper URL 推导 Gradle 分发根目录')
  const jar = resolve(javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar')
  if (!existsSync(jar)) throw new Error(`JDK 缺少 jar 工具：${jar}`)
  cleanCacheRoot = mkdtempSync(resolve(tmpdir(), 'wuyan-gradle-clean-'))
  const distributionDirectory = resolve(cleanCacheRoot, 'distribution')
  const gradleUserHome = resolve(cleanCacheRoot, 'user-home')
  mkdirSync(distributionDirectory)
  mkdirSync(gradleUserHome)
  const listing = run(jar, ['tf', verifiedDistribution.pathname], { env: environment, quiet: true }).stdout
  const distributionEntries = validateGradleDistributionEntries(listing, distributionRootName)
  run(jar, ['xf', verifiedDistribution.pathname], { cwd: distributionDirectory, env: environment, quiet: true })
  gradleExecutable = resolve(distributionDirectory, ...distributionEntries.executable.split('/'))
  if (!existsSync(gradleExecutable)) throw new Error(`已校验 Gradle 分发解压后缺少入口：${gradleExecutable}`)
  environment.GRADLE_USER_HOME = gradleUserHome
  console.log(`空缓存门禁：GRADLE_USER_HOME=${gradleUserHome}（新建空目录）；Gradle ZIP ${verifiedDistribution.sha256} 已与 Wrapper 固定哈希独立比对。`)
  console.log('边界：Gradle 分发已本地预热且脚本不会下载它；Maven/Google 依赖未随仓库封装，空依赖缓存首次解析仍需要网络。成功仅证明当时网络可用条件下的 strict 冷缓存解析，不代表离线可复现。')
}

if (runDeviceTests) {
  if (!serial || !/^[A-Za-z0-9._:-]+$/.test(serial)) {
    throw new Error('设备测试必须显式设置合法的 ANDROID_SERIAL；禁止自动选择模拟器或真机。')
  }
  if (!existsSync(adb)) throw new Error(`ANDROID_HOME 缺少 ADB：${adb}`)
  const devices = run(adb, ['devices'], { env: environment, quiet: true }).stdout
  if (!new RegExp(`^${serial.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+device$`, 'm').test(devices)) {
    throw new Error(`目标设备未处于 device 状态：${serial}`)
  }
  rmSync(androidTestResults, { recursive: true, force: true })
}

const tasks = [
  'testReleaseUnitTest',
  'assembleDebug',
  'assembleDebugAndroidTest',
  ...(runDeviceTests ? [':app:connectedDebugAndroidTest'] : []),
  '--no-daemon',
  '--dependency-verification',
  'strict',
  '--console=plain',
]

let deviceResult = null
try {
  run(gradleExecutable, tasks, { cwd: androidRoot, env: environment })
  if (runDeviceTests) deviceResult = verifyAndroidDeviceTestResults(
    androidTestResults,
    serial,
    expectedDeviceTests,
  )
} finally {
  if (runDeviceTests) {
    run(adb, ['-s', serial, 'uninstall', `${version.packageName}.debug.test`], { env: environment, quiet: true, allowFailure: true })
    run(adb, ['-s', serial, 'uninstall', `${version.packageName}.debug`], { env: environment, quiet: true, allowFailure: true })
  }
  if (cleanCacheRoot) {
    try {
      rmSync(cleanCacheRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    } catch (error) {
      console.warn(`警告：空缓存门禁临时目录清理失败，原始门禁结果保持不变：${cleanCacheRoot}（${error.message}）`)
    }
  }
}

console.log(runDeviceTests
  ? `Android 原生聚合门禁与指定设备 instrumentation 精确通过 ${deviceResult.tests}/${expectedDeviceTests}：${serial}`
  : `Android 原生 JVM/构建门禁通过${cleanGradleCache ? '（空 GRADLE_USER_HOME + 已校验本地 Gradle 分发 + strict 依赖校验）' : ''}；未执行设备 ${expectedDeviceTests}/${expectedDeviceTests}，不能宣称完整设备验收。设备测试需显式设置 ANDROID_SERIAL 并追加 --device。`)
