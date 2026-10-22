import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { patchProperties, patchProvenance, safeRepositoryFile, upstreamNpmVersion } from './supply-chain-patch-policy.mjs'

test('scanner PURLs retain the upstream version, never the pnpm patch hash', () => {
  assert.equal(upstreamNpmVersion('3.0.3(patch_hash=abc123)'), '3.0.3')
  assert.equal(upstreamNpmVersion('1.0.0-rc.2'), '1.0.0-rc.2')
  assert.throws(() => upstreamNpmVersion('link:../safe'), /Unsupported/)
  assert.throws(() => upstreamNpmVersion('3.0.3(unknown=hidden)'), /Unsupported/)
})

test('patch provenance separately binds exact patch bytes and lock identity', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wuyan-patch-provenance-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'patches'))
  writeFileSync(path.join(root, 'patches', 'a.patch'), 'patch bytes\n')
  const lock = { patchedDependencies: { 'a@1.0.0': { path: 'patches/a.patch', hash: 'a'.repeat(64) } } }
  const value = patchProvenance(root, lock).get('a@1.0.0')
  assert.equal(value.sha256, createHash('sha256').update('patch bytes\n').digest('hex'))
  assert.equal(patchProperties(value).length, 4)
  assert.deepEqual(patchProperties(undefined), [])
  assert.throws(() => safeRepositoryFile(root, '../secret'), /Invalid/)
  lock.patchedDependencies['a@1.0.0'].path = '../outside.patch'
  assert.throws(() => patchProvenance(root, lock), /Invalid exact/)
})
