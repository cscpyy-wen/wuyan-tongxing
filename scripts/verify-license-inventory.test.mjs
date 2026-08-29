import assert from 'node:assert/strict'
import test from 'node:test'
import { validateLicenseInventory } from './verify-license-inventory.mjs'

function component(purl, expression = 'MIT') {
  return { purl, name: purl, version: '1.0.0', licenses: [{ expression }] }
}

function fixture() {
  const components = [
    component('pkg:npm/example@1.0.0'),
    component('pkg:maven/org.example/library@2.0.0', 'Apache-2.0'),
  ]
  return {
    sbom: { components: structuredClone(components) },
    inventory: {
      components: structuredClone(components),
      summary: {
        componentCount: 2,
        npmComponentCount: 1,
        mavenComponentCount: 1,
        componentsWithDeclaredLicense: 2,
        componentsWithoutDeclaredLicense: 0,
      },
    },
  }
}

test('accepts an exact bidirectional purl and license match', () => {
  const { sbom, inventory } = fixture()
  assert.deepEqual(validateLicenseInventory(sbom, inventory), inventory.summary)
})

test('fails with both directions when SBOM and inventory purl sets diverge', () => {
  const { sbom, inventory } = fixture()
  sbom.components[0] = component('pkg:npm/only-in-sbom@1.0.0')
  inventory.components[0] = component('pkg:npm/only-in-inventory@1.0.0')
  assert.throws(
    () => validateLicenseInventory(sbom, inventory),
    /仅 SBOM \[pkg:npm\/only-in-sbom@1\.0\.0\].*仅许可证清单 \[pkg:npm\/only-in-inventory@1\.0\.0\]/,
  )
})

test('fails on duplicate purls in either document', () => {
  const left = fixture()
  left.sbom.components.push(structuredClone(left.sbom.components[0]))
  assert.throws(() => validateLicenseInventory(left.sbom, left.inventory), /SBOM 存在重复 purl/)

  const right = fixture()
  right.inventory.components.push(structuredClone(right.inventory.components[0]))
  assert.throws(() => validateLicenseInventory(right.sbom, right.inventory), /许可证清单 存在重复 purl/)
})

test('fails when either document has a component without a purl', () => {
  const left = fixture()
  delete left.sbom.components[0].purl
  assert.throws(() => validateLicenseInventory(left.sbom, left.inventory), /SBOM 组件缺少 purl/)

  const right = fixture()
  delete right.inventory.components[0].purl
  assert.throws(() => validateLicenseInventory(right.sbom, right.inventory), /许可证清单 组件缺少 purl/)
})

test('fails closed when either side has no declared license', () => {
  const left = fixture()
  left.sbom.components[0].licenses = []
  assert.throws(() => validateLicenseInventory(left.sbom, left.inventory), /SBOM 组件缺少许可证声明/)

  const right = fixture()
  delete right.inventory.components[0].licenses
  assert.throws(() => validateLicenseInventory(right.sbom, right.inventory), /许可证清单 组件缺少许可证声明/)
})

test('fails when license declarations or summary claims differ', () => {
  const licenses = fixture()
  licenses.inventory.components[0].licenses = [{ expression: 'ISC' }]
  assert.throws(() => validateLicenseInventory(licenses.sbom, licenses.inventory), /许可证声明不一致/)

  const summary = fixture()
  summary.inventory.summary.componentCount = 717
  assert.throws(() => validateLicenseInventory(summary.sbom, summary.inventory), /summary\.componentCount 不真实/)
})
