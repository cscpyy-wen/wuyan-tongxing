import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { stringify } from 'yaml'
import {
  assessNpmReport, assessOsvFindings, digest, installedPackageFiles, npmAdvisoryFingerprint,
  validateRegressionResult, verifyPackageFiles, verifySecurityPatches,
} from './security-patch-policy.mjs'

const pass = { status: 0, stdout: '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n' }
const now = Date.parse('2026-10-22T10:00:00.000Z')
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wuyan-patch-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  function write(relative, content) {
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content))
  }
  write('patches/example.patch', 'reviewed patch\n')
  write('scripts/security-patches/example.test.cjs', 'reviewed regression\n')
  write('node_modules/example/package.json', { name: 'example', version: '1.0.0' })
  write('node_modules/example/index.js', 'patched source\n')
  const patchHash = digest('reviewed patch\n')
  const lock = {
    patchedDependencies: { 'example@1.0.0': patchHash },
    packages: { 'example@1.0.0': { resolution: { integrity: 'sha512-original' } } },
    snapshots: { [`example@1.0.0(patch_hash=${patchHash})`]: {} },
  }
  const workspace = { patchedDependencies: { 'example@1.0.0': 'patches/example.patch' } }
  write('pnpm-lock.yaml', stringify(lock))
  write('pnpm-workspace.yaml', stringify(workspace))
  const packagePath = path.join(root, 'node_modules/example')
  const manifest = {
    schemaVersion: 1, reviewedAt: '2026-10-22T07:00:00Z', reviewBy: '2026-11-21T07:00:00Z',
    packages: [{
      name: 'example', version: '1.0.0', upstreamIntegrity: 'sha512-original',
      patchPath: 'patches/example.patch', patchSha256: patchHash, pnpmPatchHash: patchHash,
      regressionPath: 'scripts/security-patches/example.test.cjs', regressionSha256: digest('reviewed regression\n'),
      minimumTestCount: 2, files: installedPackageFiles(packagePath),
      advisories: [{ id: 'GHSA-aaaa-bbbb-cccc', osvModified: '2026-10-02T00:00:00Z' }],
    }],
  }
  write('docs/security-patches/manifest.json', manifest)
  const options = { root, now, pnpmCli: 'fixture-pnpm', trees: [{ dependencies: { example: { path: packagePath } } }], spawn: () => pass }
  return { root, write, manifest, lock, workspace, options, packagePath }
}

test('verified evidence binds every installed byte, patch, lock and regression without private paths', (t) => {
  const f = fixture(t)
  let called = 0
  const evidence = verifySecurityPatches({ ...f.options, spawn(_exe, args, options) {
    called++
    assert.deepEqual(args.slice(0, 2), ['--test', '--test-reporter=tap'])
    assert.equal(options.env.WUYAN_SECURITY_PATCH_PACKAGE_PATH, f.packagePath)
    return pass
  } })
  assert.equal(called, 1)
  assert.equal(evidence.packages.length, 1)
  assert.equal(evidence.lockfileSha256, digest(readFileSync(path.join(f.root, 'pnpm-lock.yaml'))))
  assert.ok(!JSON.stringify(evidence).includes(f.root))
})

for (const [name, mutate] of [
  ['patch changed', (f) => f.write('patches/example.patch', 'different')],
  ['regression changed', (f) => f.write('scripts/security-patches/example.test.cjs', 'different')],
  ['installed code changed', (f) => f.write('node_modules/example/index.js', 'different')],
  ['unexpected installed file', (f) => f.write('node_modules/example/extra.js', 'different')],
  ['missing installed package', (f) => { f.options.trees = [] }],
  ['review expired', (f) => { f.options.now = Date.parse('2026-12-01') }],
  ['future review', (f) => { f.options.now = Date.parse('2026-10-20') }],
  ['unpatched snapshot', (f) => { f.lock.snapshots['example@1.0.0'] = {}; f.write('pnpm-lock.yaml', stringify(f.lock)) }],
  ['unreviewed package version', (f) => { f.lock.snapshots['example@2.0.0'] = {}; f.write('pnpm-lock.yaml', stringify(f.lock)) }],
  ['unreviewed upstream integrity', (f) => { f.lock.packages['example@1.0.0'].resolution.integrity = 'changed'; f.write('pnpm-lock.yaml', stringify(f.lock)) }],
  ['removed workspace patch', (f) => f.write('pnpm-workspace.yaml', '{}')],
  ['patch path traversal', (f) => { f.lock.patchedDependencies['example@1.0.0'] = { hash: 'a'.repeat(64), path: '../secret' }; f.write('pnpm-lock.yaml', stringify(f.lock)) }],
  ['regression failure', (f) => { f.options.spawn = () => ({ ...pass, status: 1 }) }],
]) {
  test(`fails closed: ${name}`, (t) => {
    const f = fixture(t)
    mutate(f)
    assert.throws(() => verifySecurityPatches(f.options))
  })
}

test('zero tests, skips, TODOs, cancellation, timeout and missing TAP counts cannot pass', () => {
  for (const result of [
    { status: 0, stdout: '' }, { ...pass, error: new Error('timeout') }, { ...pass, signal: 'SIGTERM' },
    { ...pass, stdout: pass.stdout.replace('# tests 2', '# tests 0') },
    ...['skipped', 'todo', 'cancelled', 'fail'].map((field) => ({ ...pass, stdout: pass.stdout.replace(`# ${field} 0`, `# ${field} 1`) })),
  ]) assert.throws(() => validateRegressionResult(result, 2), /did not fully pass/)
  assert.throws(() => validateRegressionResult(pass, 3), /did not fully pass/)
})

test('OSV dispositions require exact package, advisory and reviewed advisory revision', () => {
  const finding = { purl: 'pkg:npm/example@1.0.0', id: 'GHSA-aaaa-bbbb-cccc', modified: '2026-10-02T00:00:00Z' }
  const evidence = { packages: [{ purl: finding.purl, advisories: [{ id: finding.id, osvModified: finding.modified }] }] }
  const result = assessOsvFindings([finding], evidence)
  assert.equal(result.rawFindingCount, 1)
  assert.equal(result.unresolvedFindingCount, 0)
  for (const changed of [{ ...finding, purl: 'pkg:npm/example@2.0.0' }, { ...finding, id: 'new-advisory' }, { ...finding, modified: 'new-revision' }]) {
    assert.equal(assessOsvFindings([changed], evidence).unresolvedFindingCount, 1)
  }
  evidence.packages[0].advisories[0].osvModified = null
  assert.equal(assessOsvFindings([{ ...finding, modified: null }], evidence).unresolvedFindingCount, 1)
})

test('npm dispositions retain raw count and reject changed facts, unknown records and inconsistent counts', () => {
  const advisory = { github_advisory_id: 'GHSA-aaaa-bbbb-cccc', module_name: 'example', title: 'reviewed', severity: 'high', findings: [{ version: '1.0.0' }] }
  const report = { advisories: { 1: advisory } }
  const evidence = { packages: [{ name: 'example', version: '1.0.0', advisories: [{ id: advisory.github_advisory_id, npmFingerprint: npmAdvisoryFingerprint(advisory) }] }] }
  assert.equal(assessNpmReport(report, 1, evidence).rawFindingCount, 1)
  assert.equal(assessNpmReport(report, 1, evidence).unresolvedFindingCount, 0)
  assert.throws(() => assessNpmReport(report, 2, evidence), /counts/)
  assert.throws(() => assessNpmReport(report, 0, evidence), /counts/)
  advisory.overview = 'new unreviewed attack description'
  assert.equal(assessNpmReport(report, 1, evidence).unresolvedFindingCount, 1)
  delete advisory.overview
  advisory.severity = 'critical'
  assert.equal(assessNpmReport(report, 1, evidence).unresolvedFindingCount, 1)
})

test('aliased installed copies are not omitted from actual-byte validation', (t) => {
  const f = fixture(t)
  f.write('node_modules/alias/package.json', { name: 'example', version: '1.0.0' })
  f.write('node_modules/alias/index.js', 'vulnerable source')
  f.options.trees[0].dependencies['different-name'] = { path: path.join(f.root, 'node_modules/alias') }
  assert.throws(() => verifySecurityPatches(f.options), /bytes\/file set/)
  f.write('node_modules/alias/package.json', { name: 'concealed', version: '1.0.0' })
  f.options.trees[0].dependencies['different-name'].name = 'example'
  assert.throws(() => verifySecurityPatches(f.options), /bytes\/file set/)
  delete f.options.trees[0].dependencies['different-name'].name
  f.options.trees[0].dependencies['different-name'].resolved = 'https://registry.npmjs.org/example/-/example-1.0.0.tgz'
  assert.throws(() => verifySecurityPatches(f.options), /bytes\/file set/)
})

test('scoped DefinitelyTyped declarations are not mistaken for the runtime tarball', (t) => {
  const f = fixture(t)
  f.write('node_modules/types/package.json', { name: '@types/example', version: '1.0.0' })
  f.write('node_modules/types/index.d.ts', 'declarations')
  f.options.trees[0].dependencies['@types/example'] = {
    path: path.join(f.root, 'node_modules/types'), resolved: 'https://registry.npmjs.org/@types/example/-/example-1.0.0.tgz',
  }
  assert.equal(verifySecurityPatches(f.options).packages.length, 1)
})

test('full file-set check is order independent and rejects content changes', (t) => {
  const f = fixture(t)
  const files = installedPackageFiles(f.packagePath)
  assert.equal(verifyPackageFiles(f.packagePath, [...files].reverse()), digest(JSON.stringify(files)))
  files[0].sha256 = '0'.repeat(64)
  assert.throws(() => verifyPackageFiles(f.packagePath, files), /bytes\/file set/)
})
