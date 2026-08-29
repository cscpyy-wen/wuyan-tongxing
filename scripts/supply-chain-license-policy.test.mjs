import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  optionalPlatformPackageUpstream,
  reviewedOptionalPlatformLicense,
  reviewedOptionalPlatformPackageIdentities,
} from './supply-chain-license-policy.mjs'

const reviewedFamilies = [
  ['@esbuild/linux-x64', '0.25.12', 'MIT', 'esbuild@0.25.12'],
  ['@parcel/watcher-win32-x64', '2.6.0', 'MIT', '@parcel/watcher@2.6.0'],
  ['@swc/core-linux-x64-gnu', '1.3.96', 'Apache-2.0 AND MIT', '@swc/core@1.3.96'],
  ['lightningcss-win32-x64-msvc', '1.33.0', 'MPL-2.0', 'lightningcss@1.33.0'],
]

test('optional native package licenses are exact-version and operating-system independent', () => {
  for (const [name, version, license, upstreamPackage] of reviewedFamilies) {
    const absentOnThisPlatform = reviewedOptionalPlatformLicense({ name, version })
    const installedOnThisPlatform = reviewedOptionalPlatformLicense({
      name,
      version,
      declaredLicense: license,
    })
    assert.deepEqual(absentOnThisPlatform, installedOnThisPlatform)
    assert.deepEqual(installedOnThisPlatform, {
      license,
      upstreamPackage,
      source: `reviewed-exact-npm-version-metadata:${name}@${version}`,
    })
  }
})

test('optional native package policy fails closed on upgrades and conflicting manifests', () => {
  assert.equal(optionalPlatformPackageUpstream('ordinary-package', '1.0.0'), null)
  assert.equal(reviewedOptionalPlatformLicense({ name: 'ordinary-package', version: '1.0.0' }), null)
  assert.throws(() => reviewedOptionalPlatformLicense({
    name: '@swc/core-linux-x64-gnu',
    version: '1.3.97',
  }), /缺少精确版本许可证复核/)
  assert.throws(() => reviewedOptionalPlatformLicense({
    name: '@swc/core-linux-x64-gnu',
    version: '1.3.96',
    declaredLicense: 'Apache-2.0',
  }), /与复核值 Apache-2.0 AND MIT 不一致/)
  assert.throws(() => reviewedOptionalPlatformLicense({
    name: '@swc/core-unreviewed-target',
    version: '1.3.96',
  }), /缺少精确版本许可证复核/)
  assert.throws(() => reviewedOptionalPlatformLicense({
    name: 'lightningcss-unreviewed-package',
    version: '1.33.0',
  }), /缺少精确版本许可证复核/)
})

test('committed inventory applies the reviewed policy to every optional platform package', () => {
  const inventory = JSON.parse(readFileSync(
    new URL('../docs/third-party-licenses.json', import.meta.url),
    'utf8',
  ))
  const optionalComponents = inventory.components.filter((component) => (
    optionalPlatformPackageUpstream(component.name, component.version)
  ))
  const inventoryIdentities = optionalComponents
    .map((component) => `${component.name}@${component.version}`)
    .sort()
  assert.equal(reviewedOptionalPlatformPackageIdentities.length, 59)
  assert.deepEqual(inventoryIdentities, reviewedOptionalPlatformPackageIdentities)
  for (const component of optionalComponents) {
    const policy = reviewedOptionalPlatformLicense({
      name: component.name,
      version: component.version,
      declaredLicense: component.licenses.map((item) => item.expression).join(' AND '),
    })
    assert.equal(component.licenseSource, policy.source)
  }
})
