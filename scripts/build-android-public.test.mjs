import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  assertPublicDebugIdentity,
  packageManagerCommand,
  parseBadging,
  publicBuildPlan,
} from './build-android-public.mjs'

test('public build plan only runs debug tasks and keeps APK under Gradle debug output', () => {
  const root = path.resolve('fixture-public-root')
  const plan = publicBuildPlan(root)
  assert.deepEqual(plan.syncCommand, ['sync:android'])
  assert.deepEqual(plan.gradleTasks.slice(-3), ['clean', 'lintDebug', 'assembleDebug'])
  assert.equal(plan.gradleTasks.some((item) => /release/i.test(item)), false)
  assert.equal(plan.apkRoot, path.join(root, 'apps', 'android-shell', 'android', 'app', 'build', 'outputs', 'apk', 'debug'))
  assert.equal(plan.apkRoot.startsWith(path.join(root, 'release')), false)
})

test('public build reuses the active pnpm JavaScript runner when available', () => {
  assert.deepEqual(packageManagerCommand({
    env: { npm_execpath: 'C:\\tooling path\\pnpm.cjs' },
    platform: 'win32',
  }), {
    executable: process.execPath,
    prefixArgs: ['C:\\tooling path\\pnpm.cjs'],
  })
  assert.deepEqual(packageManagerCommand({ env: {}, platform: 'win32' }), {
    executable: 'pnpm.cmd',
    prefixArgs: [],
  })
})

test('public APK identity requires debug suffix and Android Debug certificate', () => {
  const badging = parseBadging("package: name='cn.wuyantongxing.personal.debug' versionCode='31' versionName='0.1.0-personal.31-debug'\n")
  assert.deepEqual(badging, {
    packageName: 'cn.wuyantongxing.personal.debug',
    versionName: '0.1.0-personal.31-debug',
  })
  assert.doesNotThrow(() => assertPublicDebugIdentity({
    ...badging,
    signerOutput: 'Signer #1 certificate DN: C=US, O=Android, CN=Android Debug\n',
  }, '0.1.0-personal.31'))
  assert.throws(() => assertPublicDebugIdentity({
    ...badging,
    packageName: 'cn.wuyantongxing.personal',
    signerOutput: 'Signer #1 certificate DN: CN=Maintainer\n',
  }, '0.1.0-personal.31'), /包名错误/)
  assert.throws(() => assertPublicDebugIdentity({
    ...badging,
    signerOutput: 'Signer #1 certificate DN: CN=Maintainer\n',
  }, '0.1.0-personal.31'), /Android Debug 证书/)
})
