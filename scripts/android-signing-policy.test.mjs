import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')

test('Android release signing is fail-closed and pinned in versioned policy', async () => {
  const script = await fs.readFile(path.join(root, 'scripts/build-android.mjs'), 'utf8')
  const verifier = await fs.readFile(path.join(root, 'scripts/verify-android-apk.mjs'), 'utf8')
  const releaseStore = await fs.readFile(path.join(root, 'scripts/android-release-store.mjs'), 'utf8')
  const snapshotPolicy = await fs.readFile(path.join(root, 'scripts/source-snapshot-policy.mjs'), 'utf8')
  const policy = JSON.parse(await fs.readFile(path.join(root, 'apps/android-shell/personal-signing-policy.json'), 'utf8'))
  const version = JSON.parse(await fs.readFile(path.join(root, 'apps/android-shell/personal-version.json'), 'utf8'))

  assert.equal(policy.schemaVersion, 1)
  assert.equal(policy.packageName, version.packageName)
  assert.equal(policy.policy, 'fail-closed-upgrade-signing')
  assert.match(policy.allowedCertificateSha256, /^[a-f0-9]{64}$/)
  assert.match(script, /个人签名材料缺失或不完整；为保护已安装应用的升级链，构建已终止/)
  assert.doesNotMatch(script, /-genkeypair|randomBytes|已生成个人专用 Android 签名/)
  assert.match(script, /signingPolicy\.allowedCertificateSha256/)
  assert.match(script, /source-snapshot\.json/)
  assert.match(script, /inventorySha256/)
  assert.match(script, /files\.push\(\{/)
  assert.match(verifier, /sourceInventory\.files/)
  assert.match(verifier, /describeSourceDrift/)
  assert.match(verifier, /构建后新增/)
  assert.match(verifier, /内容或状态变化/)
  assert.match(script, /publishAndroidRelease/)
  assert.doesNotMatch(script, /async function publishDirectory/)
  assert.match(releaseStore, /crash-recoverable-append-only-pointer-journal/)
  assert.match(releaseStore, /before-immutable-verification/)
  assert.match(releaseStore, /!name\.startsWith\('\.'\)/)
  assert.match(verifier, /源码归档整体签名有效/)
  assert.match(verifier, /个 JAR 条目，其中/)
  assert.match(verifier, /TSA 时间戳/)
  assert.match(snapshotPolicy, /\.kotlin\\\/sessions\\\/\[\^\/\]\+\\\.salive/)
})
