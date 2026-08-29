import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { verifyGradleWrapper } from './verify-gradle-wrapper.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const temporaryRoots = []

after(async () => {
  await Promise.all(temporaryRoots.map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function wrapperFixture() {
  const fixtureRoot = await fs.mkdtemp(path.join(tmpdir(), 'wuyan-wrapper-test-'))
  temporaryRoots.push(fixtureRoot)
  const fixtureWrapper = path.join(fixtureRoot, 'apps', 'android-shell', 'android', 'gradle', 'wrapper')
  const realWrapper = path.join(repositoryRoot, 'apps', 'android-shell', 'android', 'gradle', 'wrapper')
  await fs.mkdir(fixtureWrapper, { recursive: true })
  await Promise.all([
    'gradle-wrapper.jar',
    'gradle-wrapper.jar.sha256',
    'gradle-wrapper.properties',
  ].map((name) => fs.copyFile(path.join(realWrapper, name), path.join(fixtureWrapper, name))))
  return { fixtureRoot, fixtureWrapper }
}

describe('Gradle Wrapper 供应链预检', () => {
  it('接受固定 JAR 与带分发 SHA 的版本', async () => {
    const { fixtureRoot } = await wrapperFixture()
    const result = await verifyGradleWrapper(fixtureRoot)
    assert.match(result.actualJarHash, /^[a-f0-9]{64}$/)
    assert.equal(result.distributionHash, 'bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531')
  })

  it('JAR 字节变化和缺失 distributionSha256Sum 均失败关闭', async () => {
    const damagedJar = await wrapperFixture()
    await fs.appendFile(path.join(damagedJar.fixtureWrapper, 'gradle-wrapper.jar'), 'damage')
    await assert.rejects(verifyGradleWrapper(damagedJar.fixtureRoot), /JAR 与固定哈希不一致/)

    const missingDistributionHash = await wrapperFixture()
    const propertiesPath = path.join(missingDistributionHash.fixtureWrapper, 'gradle-wrapper.properties')
    const properties = await fs.readFile(propertiesPath, 'utf8')
    await fs.writeFile(propertiesPath, properties.replace(/^distributionSha256Sum=.+\r?\n/m, ''), 'utf8')
    await assert.rejects(verifyGradleWrapper(missingDistributionHash.fixtureRoot), /固定 8\.14\.3 策略不一致/)

    const substitutedDistributionHash = await wrapperFixture()
    const substitutedPropertiesPath = path.join(substitutedDistributionHash.fixtureWrapper, 'gradle-wrapper.properties')
    const substitutedProperties = await fs.readFile(substitutedPropertiesPath, 'utf8')
    await fs.writeFile(
      substitutedPropertiesPath,
      substitutedProperties.replace(/^distributionSha256Sum=.+$/m, `distributionSha256Sum=${'0'.repeat(64)}`),
      'utf8',
    )
    await assert.rejects(verifyGradleWrapper(substitutedDistributionHash.fixtureRoot), /固定 8\.14\.3 策略不一致/)
  })
})
