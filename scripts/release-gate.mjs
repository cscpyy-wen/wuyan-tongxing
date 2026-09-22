import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANDROID_DEVICE_TEST_COUNT } from './android-device-test-results.mjs'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function validateAndroidSerial(serial) {
  const normalized = serial?.trim()
  if (!normalized || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error('完整设备发布门禁必须显式设置合法的 ANDROID_SERIAL；禁止自动选择模拟器或真机。')
  }
  return normalized
}

export function releaseGatePlan(options = {}) {
  const root = path.resolve(options.root ?? defaultRoot)
  const pnpmCli = options.pnpmCli ?? process.env.npm_execpath
  if (!pnpmCli) throw new Error('总发布门禁必须通过 pnpm 启动，以使用锁定的工作区包管理器')
  const nodeExecutable = options.nodeExecutable ?? process.execPath
  const device = options.device === true
  const serial = device ? validateAndroidSerial(options.serial ?? process.env.ANDROID_SERIAL) : null
  const scripts = [
    ['工作区验证', 'verify'],
    ['SBOM/许可证 purl 精确门禁', 'verify:licenses'],
    ['全依赖 low 阈值审计', 'audit:all'],
    ['维护者签名 Android APK 构建与供应链生成', 'build:android:maintainer-release'],
    ['Android APK/清单/源码归档验证', 'verify:android'],
    ['Android JVM 与无设备构建门禁', 'test:android:native'],
    ...(device ? [[`指定设备 instrumentation ${ANDROID_DEVICE_TEST_COUNT}/${ANDROID_DEVICE_TEST_COUNT} 门禁`, 'test:android:native:device']] : []),
    ['公开 Release 邻接许可证包', 'release:license-pack'],
  ]
  return scripts.map(([name, script]) => ({
    name,
    script,
    executable: nodeExecutable,
    args: [pnpmCli, script],
    cwd: root,
    env: {
      ...process.env,
      ...(serial ? { ANDROID_SERIAL: serial } : {}),
    },
  }))
}

export function runReleaseGate(options = {}) {
  const spawn = options.spawn ?? spawnSync
  const log = options.log ?? console.log
  const device = options.device === true
  const plan = releaseGatePlan(options)
  for (const stage of plan) {
    log(`[release-gate] ${stage.name}`)
    const result = spawn(stage.executable, stage.args, {
      cwd: stage.cwd,
      env: stage.env,
      encoding: 'utf8',
      stdio: options.captureOutput ? 'pipe' : 'inherit',
      shell: false,
      windowsHide: true,
    })
    if (result.error) throw new Error(`${stage.name}无法启动：${result.error.message}`, { cause: result.error })
    if (result.status !== 0) {
      const output = options.captureOutput ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : ''
      throw new Error(`${stage.name}失败（退出码 ${result.status ?? 'unknown'}）${output ? `\n${output}` : ''}`)
    }
  }
  return {
    deviceAcceptance: device,
    stages: plan.map(({ name }) => name),
    serial: device ? validateAndroidSerial(options.serial ?? process.env.ANDROID_SERIAL) : null,
  }
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  const unknown = process.argv.slice(2).filter((argument) => argument !== '--device')
  if (unknown.length > 0) throw new Error(`未知总发布门禁参数：${unknown.join(', ')}`)
  const result = runReleaseGate({ device: process.argv.includes('--device') })
  if (result.deviceAcceptance) {
    console.log(`总发布门禁通过，包含指定设备 instrumentation ${ANDROID_DEVICE_TEST_COUNT}/${ANDROID_DEVICE_TEST_COUNT}：${result.serial}`)
  } else {
    console.log(`构建侧发布门禁通过（工作区、许可证、全依赖审计、APK、JVM）；未执行设备 ${ANDROID_DEVICE_TEST_COUNT}/${ANDROID_DEVICE_TEST_COUNT}，不能宣称完整设备验收。`)
  }
}
