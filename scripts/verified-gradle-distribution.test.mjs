import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  validateGradleDistributionEntries,
  verifyLocalGradleDistribution,
} from './verified-gradle-distribution.mjs'

const temporaryRoots = []
test.after(async () => Promise.all(temporaryRoots.map((root) => fs.rm(root, { recursive: true, force: true }))))

test('accepts only an ordinary local distribution with the pinned byte hash', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wuyan-gradle-dist-'))
  temporaryRoots.push(root)
  const pathname = path.join(root, 'gradle.zip')
  const bytes = Buffer.from('fixture distribution')
  await fs.writeFile(pathname, bytes)
  const hash = createHash('sha256').update(bytes).digest('hex')
  assert.equal((await verifyLocalGradleDistribution(pathname, hash)).sha256, hash)
  await assert.rejects(verifyLocalGradleDistribution(pathname, '0'.repeat(64)), /SHA-256 不匹配/)
})

test('rejects path traversal, unexpected roots and a missing Gradle entry', () => {
  const executable = process.platform === 'win32' ? 'gradle.bat' : 'gradle'
  assert.equal(
    validateGradleDistributionEntries(`gradle-8.14.3/\ngradle-8.14.3/bin/${executable}\n`, 'gradle-8.14.3').entryCount,
    2,
  )
  assert.throws(() => validateGradleDistributionEntries(`../escape\ngradle-8.14.3/bin/${executable}\n`, 'gradle-8.14.3'), /路径越界/)
  assert.throws(() => validateGradleDistributionEntries(`other/bin/${executable}\n`, 'gradle-8.14.3'), /路径越界/)
  assert.throws(() => validateGradleDistributionEntries('gradle-8.14.3/README\n', 'gradle-8.14.3'), /缺少入口/)
})
