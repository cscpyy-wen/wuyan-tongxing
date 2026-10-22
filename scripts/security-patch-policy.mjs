import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { patchProvenance, safeRepositoryFile, upstreamNpmVersion } from './supply-chain-patch-policy.mjs'

export const PATCH_MANIFEST_PATH = 'docs/security-patches/manifest.json'
const defaultRoot = path.resolve(import.meta.dirname, '..')
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hex = /^[a-f0-9]{64}$/
const ordered = (files) => [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

export function installedPackageFiles(directory) {
  const result = []
  function visit(current, prefix = '') {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`
      if (entry.isSymbolicLink()) throw new Error('Unexpected symlink inside patched package')
      if (entry.isDirectory()) visit(path.join(current, entry.name), `${relative}/`)
      else if (entry.isFile()) result.push({ path: relative, sha256: digest(readFileSync(path.join(current, entry.name))) })
      else throw new Error('Unexpected non-file in patched package')
    }
  }
  visit(directory)
  return ordered(result)
}

export function verifyPackageFiles(directory, expected) {
  if (!Array.isArray(expected) || expected.length < 2 || expected.some((entry) => (
    typeof entry.path !== 'string' || !hex.test(entry.sha256)
  ))) throw new Error('Invalid reviewed package file inventory')
  const actual = installedPackageFiles(directory)
  if (JSON.stringify(actual) !== JSON.stringify(ordered(expected))) {
    const expectedByPath = new Map(expected.map((entry) => [entry.path, entry.sha256]))
    const changed = actual.filter((entry) => expectedByPath.get(entry.path) !== entry.sha256).map((entry) => entry.path)
    const missing = expected.filter((entry) => !actual.some((item) => item.path === entry.path)).map((entry) => entry.path)
    throw new Error(`Patched installed package bytes/file set differ from reviewed inventory: ${path.basename(directory)}; changed=${changed.join(',')}; missing=${missing.join(',')}`)
  }
  return digest(JSON.stringify(actual))
}

export function npmAdvisoryFingerprint(advisory) {
  // Paths vary by audit scope; all advisory facts (including newly added
  // descriptions/revisions) must remain exactly as reviewed.
  return digest(JSON.stringify(Object.fromEntries(Object.keys(advisory).sort()
    .filter((key) => key !== 'id' && key !== 'findings')
    .map((key) => [key, advisory[key]]))))
}

function dependencyPaths(trees, packageName) {
  const paths = new Set()
  const manifests = new Map()
  function visit(dependencies) {
    for (const [name, dependency] of Object.entries(dependencies ?? {})) {
      let actualName = dependency.name
      if (typeof dependency.path === 'string') {
        if (!manifests.has(dependency.path)) {
          try {
            manifests.set(dependency.path, JSON.parse(readFileSync(path.join(dependency.path, 'package.json'), 'utf8')).name)
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
            manifests.set(dependency.path, null) // optional platform package not materialized here
          }
        }
        actualName = manifests.get(dependency.path) ?? actualName
      }
      let resolvedIdentity = false
      if (typeof dependency.resolved === 'string') {
        try { resolvedIdentity = decodeURIComponent(new URL(dependency.resolved).pathname).startsWith(`/${packageName}/-/`) }
        catch { /* Non-registry resolution is still checked by graph/manifest identity. */ }
      }
      if (name === packageName || dependency.name === packageName || actualName === packageName || resolvedIdentity) {
        if (typeof dependency.path !== 'string') throw new Error(`Missing installed path for ${name}`)
        paths.add(realpathSync(dependency.path))
      }
      visit(dependency.dependencies)
      visit(dependency.devDependencies)
      visit(dependency.optionalDependencies)
    }
  }
  for (const tree of trees) {
    visit(tree.dependencies)
    visit(tree.devDependencies)
    visit(tree.optionalDependencies)
  }
  return [...paths].sort()
}

export function validateRegressionResult(result, minimumTestCount) {
  const output = String(result.stdout ?? '')
  const count = (name) => Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(output)?.[1] ?? NaN)
  if (result.error || result.signal || result.status !== 0
    || !Number.isSafeInteger(minimumTestCount) || minimumTestCount < 1
    || count('tests') < minimumTestCount || !Number.isFinite(count('tests'))
    || count('pass') !== count('tests') || count('fail') !== 0
    || count('cancelled') !== 0 || count('skipped') !== 0 || count('todo') !== 0) {
    throw new Error(`Security patch regression did not fully pass: ${result.error?.message ?? result.status}\n${output.slice(-3000)}`)
  }
}

// No advisory is accepted merely because it appears in a JSON allow-list.
// Every invocation verifies the original package identity, lock patch hash,
// patch bytes, every installed file and regression program, then runs that
// program against every resolved installed copy. No persistent pass cache.
export function verifySecurityPatches(options = {}) {
  const root = options.root ?? defaultRoot
  const manifestBytes = readFileSync(safeRepositoryFile(root, PATCH_MANIFEST_PATH))
  const manifest = JSON.parse(manifestBytes)
  const now = options.now ?? Date.now()
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages) || manifest.packages.length === 0
    || !Number.isFinite(Date.parse(manifest.reviewedAt)) || !Number.isFinite(Date.parse(manifest.reviewBy))
    || Date.parse(manifest.reviewedAt) > now + 300_000 || Date.parse(manifest.reviewBy) < now
    || Date.parse(manifest.reviewBy) <= Date.parse(manifest.reviewedAt)
    || Date.parse(manifest.reviewBy) - Date.parse(manifest.reviewedAt) > 31 * 86_400_000) {
    throw new Error('Security patch review is missing, invalid or expired')
  }
  const lockBytes = readFileSync(path.join(root, 'pnpm-lock.yaml'))
  const lock = parseYaml(lockBytes.toString('utf8'))
  const workspace = parseYaml(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'))
  const provenance = patchProvenance(root, lock, workspace)
  const identities = manifest.packages.map((entry) => `${entry.name}@${entry.version}`)
  if (new Set(identities).size !== identities.length
    || JSON.stringify([...provenance.keys()].sort()) !== JSON.stringify([...identities].sort())
    || JSON.stringify(Object.keys(workspace.patchedDependencies ?? {}).sort()) !== JSON.stringify([...identities].sort())) {
    throw new Error('Reviewed patches must exactly match workspace and lock patches')
  }
  const pnpmCli = options.pnpmCli ?? process.env.npm_execpath
  if (!pnpmCli) throw new Error('Run security patch verification through the pinned pnpm command')
  const trees = options.trees ?? JSON.parse(execFileSync(process.execPath, [pnpmCli, 'list', '-r', '--depth', 'Infinity', '--json'], {
    cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true, timeout: 60_000,
  }))
  const packages = manifest.packages.map((entry) => {
    const identity = `${entry.name}@${entry.version}`
    const patch = provenance.get(identity)
    if (upstreamNpmVersion(entry.version) !== entry.version || !hex.test(entry.patchSha256)
      || patch.path !== entry.patchPath || patch.sha256 !== entry.patchSha256 || patch.lockHash !== entry.pnpmPatchHash
      || workspace.patchedDependencies[identity] !== entry.patchPath
      || lock.packages?.[identity]?.resolution?.integrity !== entry.upstreamIntegrity) {
      throw new Error(`Patch identity, provenance or integrity mismatch: ${identity}`)
    }
    const snapshots = Object.keys(lock.snapshots ?? {}).filter((key) => key.startsWith(`${entry.name}@`))
    if (!snapshots.length || snapshots.some((key) => !key.startsWith(`${identity}(patch_hash=${patch.lockHash})`))) {
      throw new Error(`Unpatched or unreviewed lock snapshot: ${identity}`)
    }
    const regressionPath = safeRepositoryFile(root, entry.regressionPath)
    if (!entry.regressionPath.startsWith('scripts/security-patches/') || digest(readFileSync(regressionPath)) !== entry.regressionSha256) {
      throw new Error(`Regression evidence changed: ${identity}`)
    }
    const installed = dependencyPaths(trees, entry.name)
    if (!installed.length) throw new Error(`Patched package not installed: ${identity}`)
    let installedTreeSha256
    for (const directory of installed) {
      const repositoryModules = realpathSync(path.join(root, 'node_modules'))
      if (!directory.startsWith(`${repositoryModules}${path.sep}`)) throw new Error('Patched package resolved outside repository node_modules')
      installedTreeSha256 = verifyPackageFiles(directory, entry.files)
      const packageJson = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
      if (`${packageJson.name}@${packageJson.version}` !== identity) throw new Error(`Installed package identity mismatch: ${identity}`)
      const result = (options.spawn ?? spawnSync)(process.execPath, ['--test', '--test-reporter=tap', regressionPath], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, WUYAN_SECURITY_PATCH_PACKAGE_PATH: directory },
      })
      validateRegressionResult(result, entry.minimumTestCount)
    }
    if (!Array.isArray(entry.advisories) || entry.advisories.length === 0
      || entry.advisories.some((item) => !/^GHSA-[a-z0-9-]+$/.test(item.id))) throw new Error('Invalid reviewed advisory identity')
    return {
      name: entry.name, version: entry.version, purl: `pkg:npm/${entry.name}@${entry.version}`,
      patchPath: entry.patchPath, patchSha256: patch.sha256, pnpmPatchHash: patch.lockHash,
      upstreamIntegrity: entry.upstreamIntegrity, installedTreeSha256,
      regressionPath: entry.regressionPath, regressionSha256: entry.regressionSha256,
      minimumTestCount: entry.minimumTestCount, advisories: entry.advisories,
    }
  })
  return { schemaVersion: 1, manifestSha256: digest(manifestBytes), lockfileSha256: digest(lockBytes), packages }
}

export function assessOsvFindings(findings, evidence) {
  if (!Array.isArray(findings)) throw new Error('OSV findings missing')
  const dispositions = findings.map((finding) => {
    const reviewed = evidence.packages.find((entry) => entry.purl === finding.purl)
      ?.advisories.find((entry) => entry.id === finding.id && typeof entry.osvModified === 'string'
        && Number.isFinite(Date.parse(entry.osvModified)) && entry.osvModified === finding.modified)
    return { purl: finding.purl, id: finding.id, status: reviewed ? 'fixed-by-verified-local-patch' : 'unresolved' }
  })
  return { evidence, rawFindingCount: findings.length, unresolvedFindingCount: dispositions.filter((item) => item.status === 'unresolved').length, dispositions }
}

export function assessNpmReport(report, total, evidence) {
  const advisories = Object.values(report.advisories ?? {})
  if (total === 0 && Object.keys(report.vulnerabilities ?? {}).length > 0) throw new Error('Audit zero count conflicts with vulnerability records')
  if (advisories.length !== total) throw new Error('Audit counts do not match inspectable advisory records')
  if (total === 0) return { rawFindingCount: 0, unresolvedFindingCount: 0, dispositions: [] }
  const dispositions = advisories.map((advisory) => {
    const versions = advisory.findings?.map((finding) => finding.version)
    const fixed = Array.isArray(versions) && versions.length > 0 && versions.every((version) => (
      evidence.packages.find((entry) => entry.name === advisory.module_name && entry.version === version)
        ?.advisories.some((entry) => entry.id === advisory.github_advisory_id && entry.npmFingerprint === npmAdvisoryFingerprint(advisory))
    ))
    return { id: advisory.github_advisory_id, package: advisory.module_name, versions, status: fixed ? 'fixed-by-verified-local-patch' : 'unresolved' }
  })
  return { rawFindingCount: total, unresolvedFindingCount: dispositions.filter((item) => item.status === 'unresolved').length, dispositions }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = verifySecurityPatches()
  console.log(`安全补丁实际验证通过：${evidence.packages.map((entry) => `${entry.name}@${entry.version}（${entry.minimumTestCount} 项回归）`).join('、')}。`)
}
