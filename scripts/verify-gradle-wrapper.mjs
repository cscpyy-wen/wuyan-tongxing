import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const EXPECTED_DISTRIBUTION = 'gradle-8.14.3-bin.zip'
const EXPECTED_DISTRIBUTION_SHA256 = 'bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531'

export async function verifyGradleWrapper(repositoryRoot = path.resolve(import.meta.dirname, '..')) {
  const wrapperRoot = path.join(repositoryRoot, 'apps', 'android-shell', 'android', 'gradle', 'wrapper')
  const jarPath = path.join(wrapperRoot, 'gradle-wrapper.jar')
  const checksumPath = path.join(wrapperRoot, 'gradle-wrapper.jar.sha256')
  const propertiesPath = path.join(wrapperRoot, 'gradle-wrapper.properties')
  const expectedJarHash = (await fs.readFile(checksumPath, 'utf8')).trim().split(/\s+/)[0]?.toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expectedJarHash ?? '')) throw new Error('Gradle Wrapper JAR 固定哈希格式错误')
  const actualJarHash = createHash('sha256').update(await fs.readFile(jarPath)).digest('hex')
  if (actualJarHash !== expectedJarHash) throw new Error('Gradle Wrapper JAR 与固定哈希不一致')

  const properties = await fs.readFile(propertiesPath, 'utf8')
  const distributionUrl = /^distributionUrl=(.+)$/m.exec(properties)?.[1]?.replaceAll('\\:', ':')
  const distributionHash = /^distributionSha256Sum=([a-f0-9]{64})$/m.exec(properties)?.[1]
  if (
    !distributionUrl?.endsWith(`/${EXPECTED_DISTRIBUTION}`)
    || distributionHash !== EXPECTED_DISTRIBUTION_SHA256
  ) {
    throw new Error('Gradle 分发 URL 或 distributionSha256Sum 与固定 8.14.3 策略不一致')
  }
  return { actualJarHash, distributionUrl, distributionHash }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  const result = await verifyGradleWrapper()
  console.log(`Gradle Wrapper 预检通过：JAR ${result.actualJarHash}，分发 ${path.basename(result.distributionUrl)} ${result.distributionHash}。`)
}
