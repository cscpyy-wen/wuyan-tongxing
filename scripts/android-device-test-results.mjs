import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const ANDROID_DEVICE_TEST_COUNT = 40

function filesRecursively(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const pathname = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...filesRecursively(pathname))
    else if (entry.isFile()) files.push(pathname)
  }
  return files
}

function integerAttribute(tag, name, pathname) {
  const match = new RegExp(`\\b${name}="(\\d+)"`).exec(tag)
  if (!match) throw new Error(`instrumentation JUnit 缺少 ${name}：${pathname}`)
  const value = Number(match[1])
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`instrumentation JUnit 的 ${name} 无效：${pathname}`)
  return value
}

function textprotoString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

export function verifyAndroidDeviceTestResults(
  resultsRoot,
  expectedSerial,
  expectedTests = ANDROID_DEVICE_TEST_COUNT,
) {
  if (!/^[A-Za-z0-9._:-]+$/.test(expectedSerial ?? '')) throw new Error('必须提供合法的目标 ANDROID_SERIAL')
  if (!Number.isSafeInteger(expectedTests) || expectedTests < 1) throw new Error('设备测试期望数量无效')

  let files
  try {
    files = filesRecursively(resultsRoot)
  } catch (error) {
    throw new Error(`未找到本次 instrumentation 结果目录：${resultsRoot}`, { cause: error })
  }
  const junitFiles = files.filter((pathname) => /^TEST-.*\.xml$/i.test(path.basename(pathname)))
  if (junitFiles.length === 0) throw new Error('本次 instrumentation 未产生 JUnit XML；不得仅凭 Gradle 退出码宣称设备通过')

  const totals = { tests: 0, failures: 0, errors: 0, skipped: 0 }
  for (const pathname of junitFiles) {
    const xml = readFileSync(pathname, 'utf8')
    const suite = /<testsuite\b[^>]*>/i.exec(xml)?.[0]
    if (!suite) throw new Error(`instrumentation JUnit 缺少 testsuite：${pathname}`)
    for (const name of Object.keys(totals)) totals[name] += integerAttribute(suite, name, pathname)
  }

  const textprotoFiles = files.filter((pathname) => path.basename(pathname) === 'test-result.textproto')
  const expectedId = `id: "${textprotoString(expectedSerial)}"`
  if (!textprotoFiles.some((pathname) => readFileSync(pathname, 'utf8').includes(expectedId))) {
    throw new Error(`instrumentation 结果未绑定目标 ANDROID_SERIAL：${expectedSerial}`)
  }
  if (totals.tests !== expectedTests || totals.failures !== 0 || totals.errors !== 0 || totals.skipped !== 0) {
    throw new Error(
      `指定设备验收必须精确通过 ${expectedTests}/${expectedTests}；实际 tests=${totals.tests}, failures=${totals.failures}, errors=${totals.errors}, skipped=${totals.skipped}`,
    )
  }
  return { ...totals, serial: expectedSerial, junitFiles: junitFiles.length }
}
