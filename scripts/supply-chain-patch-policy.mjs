import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

// A pnpm patch is a transformation of the upstream package, not a new npm
// release. Never put pnpm's installation suffix in the PURL sent to scanners.
export function upstreamNpmVersion(value) {
  if (typeof value !== 'string') throw new Error('npm version must be a string')
  const match = /^(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?:\(patch_hash=[a-zA-Z0-9]+\))?$/.exec(value)
  if (!match) throw new Error(`Unsupported npm version: ${value}`)
  return match[1]
}

export function safeRepositoryFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\')
    || path.posix.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid repository-relative evidence path')
  }
  const canonicalRoot = realpathSync(root)
  const result = realpathSync(path.join(canonicalRoot, relative))
  if (!result.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error('Evidence path escapes repository')
  return result
}

export function patchProvenance(root, lockDocument, workspace = {}) {
  return new Map(Object.entries(lockDocument.patchedDependencies ?? {}).map(([identity, locked]) => {
    const entry = typeof locked === 'string'
      ? { hash: locked, path: workspace.patchedDependencies?.[identity] }
      : locked
    if (!/^(@[^/]+\/)?[^@]+@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(identity)
      || typeof entry?.hash !== 'string' || !/^[a-zA-Z0-9]{16,128}$/.test(entry.hash)
      || typeof entry.path !== 'string' || !entry.path.startsWith('patches/')) {
      throw new Error(`Invalid exact patched dependency: ${identity}`)
    }
    const bytes = readFileSync(safeRepositoryFile(root, entry.path))
    return [identity, {
      path: entry.path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      lockHash: entry.hash,
    }]
  }))
}

export function patchProperties(provenance) {
  return provenance ? [
    { name: 'wuyan:upstream-hash-scope', value: 'npm upstream tarball, before local patch' },
    { name: 'wuyan:patch-path', value: provenance.path },
    { name: 'wuyan:patch-sha256', value: provenance.sha256 },
    { name: 'wuyan:pnpm-patch-hash', value: provenance.lockHash },
  ] : []
}
