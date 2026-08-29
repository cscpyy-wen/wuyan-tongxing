import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { verifyAndroidDeviceTestResults } from './android-device-test-results.mjs'

async function fixture(attributes, serial = 'device-123') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'android-device-results-'))
  const device = path.join(root, 'debug', 'device')
  await fs.mkdir(device, { recursive: true })
  await fs.writeFile(path.join(root, 'debug', 'TEST-app.xml'), `<testsuite ${attributes}></testsuite>\n`)
  await fs.writeFile(path.join(device, 'test-result.textproto'), `test_suite_meta_data {\n  device {\n    id: "${serial}"\n  }\n}\n`)
  return root
}

test('accepts exactly 26 passing tests bound to the requested serial', async (context) => {
  const root = await fixture('tests="26" failures="0" errors="0" skipped="0"')
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  assert.deepEqual(verifyAndroidDeviceTestResults(root, 'device-123'), {
    tests: 26,
    failures: 0,
    errors: 0,
    skipped: 0,
    serial: 'device-123',
    junitFiles: 1,
  })
})

test('rejects failures, skips, wrong totals, and results from another serial', async (context) => {
  const failed = await fixture('tests="26" failures="1" errors="0" skipped="0"')
  const skipped = await fixture('tests="26" failures="0" errors="0" skipped="1"')
  const short = await fixture('tests="25" failures="0" errors="0" skipped="0"')
  const wrongDevice = await fixture('tests="26" failures="0" errors="0" skipped="0"', 'device-other')
  context.after(() => Promise.all([failed, skipped, short, wrongDevice].map((root) => fs.rm(root, { recursive: true, force: true }))))
  assert.throws(() => verifyAndroidDeviceTestResults(failed, 'device-123'), /实际 tests=26, failures=1/)
  assert.throws(() => verifyAndroidDeviceTestResults(skipped, 'device-123'), /skipped=1/)
  assert.throws(() => verifyAndroidDeviceTestResults(short, 'device-123'), /实际 tests=25/)
  assert.throws(() => verifyAndroidDeviceTestResults(wrongDevice, 'device-123'), /未绑定目标 ANDROID_SERIAL/)
})

test('rejects absent or malformed result evidence', async (context) => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'android-device-results-empty-'))
  const malformed = await fixture('tests="26" failures="0" errors="0"')
  context.after(() => Promise.all([empty, malformed].map((root) => fs.rm(root, { recursive: true, force: true }))))
  assert.throws(() => verifyAndroidDeviceTestResults(empty, 'device-123'), /未产生 JUnit XML/)
  assert.throws(() => verifyAndroidDeviceTestResults(malformed, 'device-123'), /缺少 skipped/)
  assert.throws(() => verifyAndroidDeviceTestResults(empty, ''), /合法的目标 ANDROID_SERIAL/)
})
