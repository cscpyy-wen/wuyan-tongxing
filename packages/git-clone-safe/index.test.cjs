'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const clone = require('./index.cjs')

test('accepts only explicit network git transports', () => {
  assert.equal(clone.validateRemote('https://github.com/example/project.git'), true)
  assert.equal(clone.validateRemote('git@github.com:example/project.git'), true)
  assert.equal(clone.validateRemote('ssh://git@example.com/example/project.git'), true)
  assert.equal(clone.validateRemote('ext::sh -c calc'), false)
  assert.equal(clone.validateRemote('--upload-pack=calc'), false)
  assert.equal(clone.validateRemote('file:///tmp/repository'), false)
})

test('terminates ref option parsing and rejects malformed refs', () => {
  assert.equal(clone.validateRef('release/v1.2.3'), true)
  assert.equal(clone.validateRef('-c'), false)
  assert.equal(clone.validateRef('main --upload-pack=calc'), false)
  assert.equal(clone.validateRef('refs/heads/a..b'), false)
  assert.equal(clone.validateRef('refs/heads/a.lock'), false)
})

test('rejects an unsafe remote before launching git', async () => {
  await new Promise((resolve, reject) => {
    clone('ext::sh -c calc', 'unused', (error) => {
      try {
        assert.match(error.message, /unsafe git remote/)
        resolve()
      } catch (assertionError) {
        reject(assertionError)
      }
    })
  })
})
