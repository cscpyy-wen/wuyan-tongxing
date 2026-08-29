import assert from 'node:assert/strict'
import test from 'node:test'
import { cyclonedxLicense, isSpdxExpression, spdxIdentifiers } from './spdx-license-expression.mjs'

test('parenthesized SPDX OR expressions remain expressions without being downgraded', () => {
  for (const expression of [
    '(Apache-2.0 OR MIT)',
    '(Apache-2.0 OR MPL-1.1)',
    '(MIT OR CC0-1.0)',
    'Apache-2.0 AND (MIT OR BSD-2-Clause)',
  ]) {
    assert.equal(isSpdxExpression(expression), true)
    assert.deepEqual(cyclonedxLicense(expression), { expression })
  }
})

test('SPDX parser rejects free-form license prose and malformed operators', () => {
  for (const value of ['MIT License', '(MIT OR)', 'MIT AND AND ISC', 'SEE LICENSE IN LICENSE.txt']) {
    assert.equal(isSpdxExpression(value), false)
  }
  assert.deepEqual(cyclonedxLicense('MIT License'), { expression: 'MIT' })
  assert.deepEqual(cyclonedxLicense('custom upstream terms'), { license: { name: 'custom upstream terms' } })
})

test('SPDX identifier extraction removes operators and duplicate atoms', () => {
  assert.deepEqual(spdxIdentifiers('(MIT OR MIT) AND Apache-2.0'), ['MIT', 'Apache-2.0'])
})
