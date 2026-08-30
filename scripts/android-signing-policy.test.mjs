import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  resolveConfiguredSigningStore,
  resolveExternalAndroidSigningMaterial,
} from './android-signing-material.mjs'

const root = path.resolve(import.meta.dirname, '..')

test('Android release signing is fail-closed and pinned in versioned policy', async () => {
  const script = await fs.readFile(path.join(root, 'scripts/build-android.mjs'), 'utf8')
  const materialResolver = await fs.readFile(path.join(root, 'scripts/android-signing-material.mjs'), 'utf8')
  const gradleBuild = await fs.readFile(path.join(root, 'apps/android-shell/android/app/build.gradle'), 'utf8')
  const verifier = await fs.readFile(path.join(root, 'scripts/verify-android-apk.mjs'), 'utf8')
  const releaseStore = await fs.readFile(path.join(root, 'scripts/android-release-store.mjs'), 'utf8')
  const snapshotPolicy = await fs.readFile(path.join(root, 'scripts/source-snapshot-policy.mjs'), 'utf8')
  const policy = JSON.parse(await fs.readFile(path.join(root, 'apps/android-shell/personal-signing-policy.json'), 'utf8'))
  const version = JSON.parse(await fs.readFile(path.join(root, 'apps/android-shell/personal-version.json'), 'utf8'))

  assert.equal(policy.schemaVersion, 1)
  assert.equal(policy.packageName, version.packageName)
  assert.equal(policy.policy, 'fail-closed-upgrade-signing')
  assert.match(policy.allowedCertificateSha256, /^[a-f0-9]{64}$/)
  assert.match(materialResolver, /WUYAN_ANDROID_SIGNING_ROOT/)
  assert.match(materialResolver, /签名材料不得位于公开仓库内/)
  assert.match(materialResolver, /personal-release\.p12/)
  assert.match(materialResolver, /证书指纹与版本化 Android 签名策略不一致/)
  assert.doesNotMatch(script, /\.private[\\/]+android-signing/)
  assert.match(gradleBuild, /new File\(signingPropertiesFile\.parentFile, signingProperties\.getProperty\('storeFile'\)\)/)
  assert.match(gradleBuild, /signingProperties\.setProperty\('storeFile', resolvedStoreFile\.canonicalPath\)/)
  assert.ok(
    script.indexOf('const signingConfiguration = await readSigningConfiguration()')
      < script.indexOf('const gradleResult = spawnSync'),
    '签名配置必须在 Gradle 启动前完成固定密钥库校验',
  )
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

const testFingerprint = 'a'.repeat(64)

async function createSigningFixture(directory, fingerprint = testFingerprint) {
  await fs.mkdir(directory, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(directory, 'personal-release.p12'), 'test-only-keystore'),
    fs.writeFile(path.join(directory, 'signing.properties'), 'storeFile=personal-release.p12\n'),
    fs.writeFile(path.join(directory, 'certificate.sha256'), `${fingerprint}\n`),
  ])
}

test('external Android signing material rejects missing, relative, and repository-local roots', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wuyan-signing-boundary-'))
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const repository = path.join(temporary, 'repository')
  const inside = path.join(repository, 'private-signing')
  await fs.mkdir(repository, { recursive: true })
  await createSigningFixture(inside)

  const common = { repositoryRoot: repository, expectedCertificateSha256: testFingerprint }
  await assert.rejects(
    resolveExternalAndroidSigningMaterial({ ...common, environment: {} }),
    /必须设置 WUYAN_ANDROID_SIGNING_ROOT/,
  )
  await assert.rejects(
    resolveExternalAndroidSigningMaterial({
      ...common,
      environment: { WUYAN_ANDROID_SIGNING_ROOT: 'relative/signing' },
    }),
    /必须是绝对路径/,
  )
  await assert.rejects(
    resolveExternalAndroidSigningMaterial({
      ...common,
      environment: { WUYAN_ANDROID_SIGNING_ROOT: inside },
    }),
    /不得位于公开仓库内/,
  )
  await assert.rejects(
    resolveExternalAndroidSigningMaterial({
      ...common,
      environment: {
        WUYAN_ANDROID_SIGNING_ROOT: path.join(temporary, 'outside', '..', 'repository', 'private-signing'),
      },
    }),
    /不得位于公开仓库内/,
  )
})

test('external Android signing material rejects missing files and untrusted fingerprints', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wuyan-signing-fingerprint-'))
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const repository = path.join(temporary, 'repository')
  const signing = path.join(temporary, 'signing')
  await fs.mkdir(repository, { recursive: true })
  await fs.mkdir(signing, { recursive: true })
  const resolveFixture = () => resolveExternalAndroidSigningMaterial({
    repositoryRoot: repository,
    environment: { WUYAN_ANDROID_SIGNING_ROOT: signing },
    expectedCertificateSha256: testFingerprint,
  })

  await assert.rejects(resolveFixture(), /缺少固定密钥库/)
  await createSigningFixture(signing, testFingerprint.toUpperCase())
  await assert.rejects(resolveFixture(), /必须只包含 64 位小写 SHA-256/)
  await fs.writeFile(path.join(signing, 'certificate.sha256'), `${'b'.repeat(64)}\n`)
  await assert.rejects(resolveFixture(), /与版本化 Android 签名策略不一致/)
  await fs.writeFile(path.join(signing, 'certificate.sha256'), `${testFingerprint}\n`)
  const resolved = await resolveFixture()
  assert.equal(resolved.fingerprint, testFingerprint)
  assert.equal(path.basename(resolved.storePath), 'personal-release.p12')
})

test('external Android signing material resolves symlinks before enforcing repository boundary', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wuyan-signing-symlink-'))
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const repository = path.join(temporary, 'repository')
  const inside = path.join(repository, 'private-signing')
  const apparentExternal = path.join(temporary, 'apparent-external')
  await fs.mkdir(repository, { recursive: true })
  await createSigningFixture(inside)
  try {
    await fs.symlink(inside, apparentExternal, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('当前 Windows 主机未授予创建目录联接或符号链接的权限')
      return
    }
    throw error
  }
  await assert.rejects(
    resolveExternalAndroidSigningMaterial({
      repositoryRoot: repository,
      environment: { WUYAN_ANDROID_SIGNING_ROOT: apparentExternal },
      expectedCertificateSha256: testFingerprint,
    }),
    /不得位于公开仓库内/,
  )
})

test('signing.properties must resolve to the fixed keystore in the external root', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wuyan-signing-store-'))
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const signing = path.join(temporary, 'signing')
  const outsideStore = path.join(temporary, 'unexpected.p12')
  await createSigningFixture(signing)
  await fs.writeFile(outsideStore, 'other-test-keystore')
  const propertiesPath = path.join(signing, 'signing.properties')
  const expectedStorePath = path.join(signing, 'personal-release.p12')

  assert.equal(
    await resolveConfiguredSigningStore({
      propertiesPath,
      configuredStore: 'personal-release.p12',
      expectedStorePath,
    }),
    await fs.realpath(expectedStorePath),
  )
  await assert.rejects(
    resolveConfiguredSigningStore({
      propertiesPath,
      configuredStore: outsideStore,
      expectedStorePath,
    }),
    /必须精确指向/,
  )
})
