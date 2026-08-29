import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { releaseGatePlan, runReleaseGate, validateAndroidSerial } from './release-gate.mjs'

const root = path.resolve('release-gate-fixture-root')
const base = { root, pnpmCli: 'fixture-pnpm.cjs', nodeExecutable: 'fixture-node' }

test('default gate chains workspace, full audit, APK build/verify and JVM without any device step', () => {
  const plan = releaseGatePlan(base)
  assert.deepEqual(plan.map(({ script }) => script), [
    'verify',
    'verify:licenses',
    'audit:all',
    'build:android:maintainer-release',
    'verify:android',
    'test:android:native',
    'release:license-pack',
  ])
  assert.equal(plan.some(({ script }) => script.includes('device')), false)
  assert.ok(plan.every(({ args }) => args[0] === 'fixture-pnpm.cjs'))
})

test('device gate fails before any command without explicit valid ANDROID_SERIAL', () => {
  assert.throws(() => releaseGatePlan({ ...base, device: true, serial: '' }), /必须显式设置合法的 ANDROID_SERIAL/)
  assert.throws(() => validateAndroidSerial('bad serial'), /必须显式设置合法的 ANDROID_SERIAL/)
})

test('device gate adds the explicit 26/26 stage and passes serial only after validation', () => {
  const plan = releaseGatePlan({ ...base, device: true, serial: 'emulator-explicit-1234' })
  assert.equal(plan.at(-2).script, 'test:android:native:device')
  assert.equal(plan.at(-2).name, '指定设备 instrumentation 26/26 门禁')
  assert.equal(plan.at(-1).script, 'release:license-pack')
  assert.ok(plan.every(({ env }) => env.ANDROID_SERIAL === 'emulator-explicit-1234'))
})

test('runner executes the complete build-side plan in order', () => {
  const calls = []
  const result = runReleaseGate({
    ...base,
    captureOutput: true,
    log() {},
    spawn(executable, args, options) {
      calls.push({ executable, args, options })
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  assert.deepEqual(calls.map(({ args }) => args[1]), [
    'verify',
    'verify:licenses',
    'audit:all',
    'build:android:maintainer-release',
    'verify:android',
    'test:android:native',
    'release:license-pack',
  ])
  assert.equal(result.deviceAcceptance, false)
  assert.equal(result.serial, null)
})

test('runner fails closed and does not execute later stages', () => {
  const calls = []
  assert.throws(() => runReleaseGate({
    ...base,
    captureOutput: true,
    log() {},
    spawn(_executable, args) {
      calls.push(args[1])
      return args[1] === 'audit:all'
        ? { status: 2, stdout: '', stderr: 'audit failed' }
        : { status: 0, stdout: '', stderr: '' }
    },
  }), /全依赖 low 阈值审计失败（退出码 2）/)
  assert.deepEqual(calls, ['verify', 'verify:licenses', 'audit:all'])
})

test('runner fails closed when a stage cannot start', () => {
  assert.throws(() => runReleaseGate({
    ...base,
    captureOutput: true,
    log() {},
    spawn() { return { error: new Error('ENOENT'), status: null, stdout: '', stderr: '' } },
  }), /工作区验证无法启动：ENOENT/)
})
