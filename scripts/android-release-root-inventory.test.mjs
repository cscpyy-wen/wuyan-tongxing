import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createAndroidReleaseRootInventory,
  verifyAndroidReleaseRootInventory,
} from './android-release-root-inventory.mjs'

const temporaryRoots = []
test.after(async () => Promise.all(temporaryRoots.map((root) => fs.rm(root, { recursive: true, force: true }))))

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wuyan-release-inventory-'))
  temporaryRoots.push(root)
  await fs.writeFile(path.join(root, 'artifact.apk'), 'apk')
  await fs.writeFile(path.join(root, 'build-info.json'), '{}\n')
  const allowed = ['artifact.apk', 'build-info.json']
  const inventory = await createAndroidReleaseRootInventory(root, allowed)
  await fs.writeFile(path.join(root, 'manifest.json'), '{}\n')
  return { root, allowed, inventory }
}

test('binds the exact root whitelist and complete non-self-referential tree digest', async () => {
  const { root, allowed, inventory } = await fixture()
  const result = await verifyAndroidReleaseRootInventory(root, inventory, allowed)
  assert.equal(result.fileCount, 2)
  assert.match(result.treeSha256, /^[a-f0-9]{64}$/)
})

test('rejects an extra root file or nested directory', async () => {
  const extra = await fixture()
  await fs.writeFile(path.join(extra.root, 'surprise.txt'), 'unexpected')
  await assert.rejects(verifyAndroidReleaseRootInventory(extra.root, extra.inventory, extra.allowed), /根文件集合不一致/)

  const nested = await fixture()
  await fs.mkdir(path.join(nested.root, 'nested'))
  await assert.rejects(verifyAndroidReleaseRootInventory(nested.root, nested.inventory, nested.allowed), /非普通文件/)
})

test('rejects content mutation and a manifest-declared whitelist expansion', async () => {
  const changed = await fixture()
  await fs.writeFile(path.join(changed.root, 'artifact.apk'), 'mutated')
  await assert.rejects(verifyAndroidReleaseRootInventory(changed.root, changed.inventory, changed.allowed), /根文件摘要不匹配/)

  const expanded = await fixture()
  expanded.inventory.files[0].pathname = 'not-approved.apk'
  await assert.rejects(verifyAndroidReleaseRootInventory(expanded.root, expanded.inventory, expanded.allowed), /封印白名单不匹配/)
})
