import assert from 'node:assert/strict'
import test from 'node:test'
import { createTar } from './generate-public-license-assets.mjs'

function field(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '')
}

test('deterministic tar writer sorts entries and preserves long ustar paths', () => {
  const longPath = `${'release-root/'.repeat(10)}LICENSE.txt`
  const entries = [
    { pathname: longPath, bytes: Buffer.from('long') },
    { pathname: 'a.txt', bytes: Buffer.from('first') },
  ]
  const left = createTar(entries)
  const right = createTar([...entries].reverse())
  assert.deepEqual(left, right)
  assert.equal(left.length % 512, 0)
  assert.equal(field(left, 0, 100), 'a.txt')
  assert.equal(Number.parseInt(field(left, 124, 12), 8), 5)
  assert.equal(left.subarray(512, 517).toString('utf8'), 'first')

  const secondHeader = 1024
  const reconstructed = [field(left, secondHeader + 345, 155), field(left, secondHeader, 100)]
    .filter(Boolean)
    .join('/')
  assert.equal(reconstructed, longPath)
})

test('tar writer rejects traversal and absolute paths', () => {
  assert.throws(() => createTar([{ pathname: '../LICENSE', bytes: 'bad' }]), /路径非法/)
  assert.throws(() => createTar([{ pathname: '/LICENSE', bytes: 'bad' }]), /路径非法/)
})
