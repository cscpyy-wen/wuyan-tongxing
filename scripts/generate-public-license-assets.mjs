import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { spdxIdentifiers } from './spdx-license-expression.mjs'
import { verifyLicenseInventoryFiles } from './verify-license-inventory.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseAssetsRoot = path.join(root, 'release-assets')
const licenseFilename = /^(?:licen[cs]e|copying|notice|copyright|authors?)(?:$|[._-])/i
const pinnedSpdxTexts = new Map([
  ['MPL-1.1', {
    url: 'https://raw.githubusercontent.com/spdx/license-list-data/a3cbf2e897d54bccec0c35469c691521d089ef53/text/MPL-1.1.txt',
    sha256: '6214f8b1300bb9f37b16ebc146f8f61af0187e0025042ff95c8b3030744a8795',
  }],
])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function runPnpm(args) {
  const pnpmCli = process.env.npm_execpath
  if (!pnpmCli) throw new Error('请通过 pnpm release:license-pack 运行此脚本')
  return execFileSync(process.execPath, [pnpmCli, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

function collectDependencyPaths(trees) {
  const result = new Map()
  function visit(dependencies = {}) {
    for (const [name, dependency] of Object.entries(dependencies)) {
      const version = dependency?.version
      if (typeof version === 'string' && dependency.resolved && !/^(?:link|file|workspace):/.test(version)) {
        result.set(`${name}@${version}`, dependency.path)
      }
      visit(dependency?.dependencies)
    }
  }
  for (const tree of trees) visit(tree.dependencies)
  return result
}

async function componentLicenseFiles(packagePath) {
  if (typeof packagePath !== 'string') return []
  let entries
  try {
    entries = await fs.readdir(packagePath, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !licenseFilename.test(entry.name)) continue
    const bytes = await fs.readFile(path.join(packagePath, entry.name))
    if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) {
      throw new Error(`许可证文本不是合理的非空文本文件：${path.join(packagePath, entry.name)}`)
    }
    files.push({ filename: entry.name, bytes })
  }
  return files
}

function upstreamIdentity(component) {
  if (component.name.startsWith('@esbuild/')) return `esbuild@${component.version}`
  if (/^@parcel\/watcher-/.test(component.name)) return `@parcel/watcher@${component.version}`
  if (/^@swc\/core-/.test(component.name)) return `@swc/core@${component.version}`
  if (/^lightningcss-/.test(component.name)) return `lightningcss@${component.version}`
  return null
}

function licenseLabels(licenses) {
  return licenses.map((license) => license.expression ?? license.license?.id ?? license.license?.name ?? '<missing>')
}

function splitTarPath(pathname) {
  if (Buffer.byteLength(pathname) <= 100) return { name: pathname, prefix: '' }
  const slashes = [...pathname.matchAll(/\//g)].map((match) => match.index)
  for (const index of slashes.reverse()) {
    const prefix = pathname.slice(0, index)
    const name = pathname.slice(index + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  throw new Error(`tar 路径过长：${pathname}`)
}

function writeString(target, offset, length, value) {
  const bytes = Buffer.from(value)
  if (bytes.length > length) throw new Error(`tar 字段过长：${value}`)
  bytes.copy(target, offset)
}

function writeOctal(target, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0')
  writeString(target, offset, length, `${encoded}\0`)
}

function tarHeader(pathname, size) {
  const header = Buffer.alloc(512)
  const { name, prefix } = splitTarPath(pathname)
  writeString(header, 0, 100, name)
  writeOctal(header, 100, 8, 0o644)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = '0'.charCodeAt(0)
  writeString(header, 257, 6, 'ustar\0')
  writeString(header, 263, 2, '00')
  writeString(header, 345, 155, prefix)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  return header
}

export function createTar(entries) {
  const parts = []
  for (const entry of [...entries].sort((left, right) => left.pathname.localeCompare(right.pathname))) {
    if (!entry.pathname || entry.pathname.startsWith('/') || entry.pathname.includes('..')) {
      throw new Error(`tar 条目路径非法：${entry.pathname}`)
    }
    const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes)
    parts.push(tarHeader(entry.pathname, bytes.length), bytes)
    const remainder = bytes.length % 512
    if (remainder !== 0) parts.push(Buffer.alloc(512 - remainder))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

export async function generatePublicLicenseAssets() {
  const summary = await verifyLicenseInventoryFiles({ root })
  const [sbomBytes, inventoryBytes, noticesBytes, capacitorTemplateLicenseBytes, versionBytes, workspaceTrees] = await Promise.all([
    fs.readFile(path.join(root, 'docs', 'sbom.cdx.json')),
    fs.readFile(path.join(root, 'docs', 'third-party-licenses.json')),
    fs.readFile(path.join(root, 'THIRD_PARTY_NOTICES.md')),
    fs.readFile(path.join(root, 'apps', 'android-shell', 'android', 'LICENSE-CAPACITOR')),
    fs.readFile(path.join(root, 'apps', 'android-shell', 'personal-version.json')),
    Promise.resolve(JSON.parse(runPnpm(['list', '-r', '--prod', '--depth', 'Infinity', '--json']))),
  ])
  const inventory = JSON.parse(inventoryBytes.toString('utf8'))
  const version = JSON.parse(versionBytes.toString('utf8'))
  const dependencyPaths = collectDependencyPaths(workspaceTrees)
  const components = [...inventory.components].sort((left, right) => left.purl.localeCompare(right.purl))
  const directTexts = new Map()
  const identityToPurl = new Map()
  for (const component of components.filter(({ purl }) => purl.startsWith('pkg:npm/'))) {
    const identity = `${component.name}@${component.version}`
    identityToPurl.set(identity, component.purl)
    directTexts.set(component.purl, await componentLicenseFiles(dependencyPaths.get(identity)))
  }

  const canonicalByIdentifier = new Map()
  for (const component of components) {
    const labels = licenseLabels(component.licenses)
    const identifiers = labels.length === 1 ? spdxIdentifiers(labels[0]) : []
    const files = directTexts.get(component.purl) ?? []
    if (identifiers.length === 1 && labels[0] === identifiers[0] && files.length > 0 && !canonicalByIdentifier.has(identifiers[0])) {
      canonicalByIdentifier.set(identifiers[0], { sourcePurl: component.purl, files })
    }
  }

  const archivedTexts = new Map()
  function archiveTexts(source, files) {
    return files.map(({ filename, bytes }) => {
      const digest = sha256(bytes)
      if (!archivedTexts.has(digest)) {
        const safeName = filename.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'LICENSE.txt'
        archivedTexts.set(digest, { pathname: `texts/${digest}-${safeName}`, bytes })
      }
      const archived = archivedTexts.get(digest)
      return { path: archived.pathname, sha256: digest, source, sourceFile: filename }
    })
  }

  for (const [identifier, pinned] of pinnedSpdxTexts) {
    if (canonicalByIdentifier.has(identifier)) continue
    const response = await fetch(pinned.url, { redirect: 'error' })
    if (!response.ok) throw new Error(`SPDX ${identifier} 固定文本下载失败：HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const actualSha256 = sha256(bytes)
    if (actualSha256 !== pinned.sha256) {
      throw new Error(`SPDX ${identifier} 固定文本摘要错误：${actualSha256}`)
    }
    canonicalByIdentifier.set(identifier, {
      sourcePurl: pinned.url,
      files: [{ filename: `${identifier}.txt`, bytes }],
    })
  }

  const coverage = { componentPackage: 0, upstreamPackage: 0, sharedLicenseText: 0 }
  const manifestComponents = []
  for (const component of components) {
    let files = directTexts.get(component.purl) ?? []
    let sourcePurl = component.purl
    let resolution = 'component-package'
    if (files.length === 0) {
      const upstream = upstreamIdentity(component)
      const upstreamPurl = upstream ? identityToPurl.get(upstream) : null
      const upstreamFiles = upstreamPurl ? directTexts.get(upstreamPurl) ?? [] : []
      if (upstreamFiles.length > 0) {
        files = upstreamFiles
        sourcePurl = upstreamPurl
        resolution = 'upstream-platform-package'
      }
    }

    let texts
    if (files.length > 0) {
      texts = archiveTexts(sourcePurl, files)
    } else {
      resolution = 'shared-license-text'
      const identifiers = [...new Set(licenseLabels(component.licenses).flatMap(spdxIdentifiers))]
      const missingIdentifiers = identifiers.filter((identifier) => !canonicalByIdentifier.has(identifier))
      if (identifiers.length === 0 || missingIdentifiers.length > 0) {
        throw new Error(`无法为 ${component.purl} 解析完整许可证文本；缺少 SPDX 文本：${missingIdentifiers.join(', ') || '<non-SPDX>'}`)
      }
      texts = identifiers.flatMap((identifier) => {
        const canonical = canonicalByIdentifier.get(identifier)
        return archiveTexts(canonical.sourcePurl, canonical.files)
      })
      texts = [...new Map(texts.map((text) => [text.sha256, text])).values()]
    }
    if (texts.length === 0) throw new Error(`许可证包不得留下无文本组件：${component.purl}`)
    coverage[resolution === 'component-package' ? 'componentPackage'
      : resolution === 'upstream-platform-package' ? 'upstreamPackage'
        : 'sharedLicenseText'] += 1
    manifestComponents.push({
      purl: component.purl,
      licenses: component.licenses,
      resolution,
      texts,
    })
  }

  if (manifestComponents.length !== summary.componentCount) {
    throw new Error(`许可证包组件数错误：${manifestComponents.length}/${summary.componentCount}`)
  }
  const manifest = {
    schemaVersion: 1,
    artifactKind: 'public-release-adjacent-third-party-license-pack',
    applicationVersion: version.versionName,
    componentIdentity: 'purl',
    componentCount: manifestComponents.length,
    textFileCount: archivedTexts.size,
    coverage,
    inputs: {
      sbomSha256: sha256(sbomBytes),
      licenseInventorySha256: sha256(inventoryBytes),
      noticesSha256: sha256(noticesBytes),
      capacitorTemplateLicenseSha256: sha256(capacitorTemplateLicenseBytes),
    },
    components: manifestComponents,
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const archiveBase = `wuyan-tongxing-third-party-licenses-${version.versionName}`
  const archiveRoot = `${archiveBase}/`
  const entries = [
    { pathname: `${archiveRoot}THIRD_PARTY_NOTICES.md`, bytes: noticesBytes },
    { pathname: `${archiveRoot}sbom.cdx.json`, bytes: sbomBytes },
    { pathname: `${archiveRoot}third-party-licenses.json`, bytes: inventoryBytes },
    { pathname: `${archiveRoot}license-pack-manifest.json`, bytes: manifestBytes },
    { pathname: `${archiveRoot}source-derived/LICENSE-CAPACITOR`, bytes: capacitorTemplateLicenseBytes },
    ...[...archivedTexts.values()].map((entry) => ({
      pathname: `${archiveRoot}${entry.pathname}`,
      bytes: entry.bytes,
    })),
  ]
  const archiveBytes = gzipSync(createTar(entries), { level: 9, mtime: 0 })
  const archiveName = `${archiveBase}.tar.gz`
  const manifestName = `${archiveBase}.manifest.json`
  await fs.mkdir(releaseAssetsRoot, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(releaseAssetsRoot, archiveName), archiveBytes),
    fs.writeFile(path.join(releaseAssetsRoot, `${archiveName}.sha256`), `${sha256(archiveBytes)}  ${archiveName}\n`, 'utf8'),
    fs.writeFile(path.join(releaseAssetsRoot, manifestName), manifestBytes),
  ])
  return {
    archiveName,
    archiveSha256: sha256(archiveBytes),
    componentCount: manifestComponents.length,
    textFileCount: archivedTexts.size,
    coverage,
  }
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  const result = await generatePublicLicenseAssets()
  console.log(`公开 Release 邻接许可证包已生成：release-assets/${result.archiveName}`)
  console.log(`组件 ${result.componentCount}，去重文本 ${result.textFileCount}；覆盖 ${JSON.stringify(result.coverage)}；SHA-256 ${result.archiveSha256}`)
}
