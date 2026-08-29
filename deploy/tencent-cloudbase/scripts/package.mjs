import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const deployRoot = resolve(scriptDir, '..')
const sourceRoot = resolve(deployRoot, 'dist')
const artifactRoot = resolve(deployRoot, 'artifacts')
const packageMetadata = JSON.parse(await readFile(resolve(deployRoot, 'package.json'), 'utf8'))
const archiveName = `wuyan-tongxing-cloudbase-h5-${packageMetadata.version}.zip`
const targetPath = resolve(artifactRoot, archiveName)
const temporaryPath = `${targetPath}.tmp`

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

await readFile(resolve(sourceRoot, 'index.html'))
await mkdir(artifactRoot, { recursive: true })
if (relative(artifactRoot, targetPath).startsWith('..')) {
  throw new Error('压缩包目标越出预期 artifacts 目录')
}

const files = (await listFiles(sourceRoot)).sort((left, right) => (
  relative(sourceRoot, left).localeCompare(relative(sourceRoot, right))
))
if (files.length === 0) throw new Error('CloudBase H5 产物为空')

const zip = new AdmZip()
const fixedLocalTimestamp = new Date(2000, 0, 1, 0, 0, 0)
for (const file of files) {
  const entryName = relative(sourceRoot, file).split(sep).join('/')
  zip.addFile(entryName, await readFile(file), '', 0o644)
  const entry = zip.getEntry(entryName)
  if (!entry) throw new Error(`无法创建 ZIP 条目：${entryName}`)
  entry.header.time = fixedLocalTimestamp
}

await writeFile(temporaryPath, zip.toBuffer())
await rm(targetPath, { force: true })
await rename(temporaryPath, targetPath)
const body = await readFile(targetPath)
const hash = createHash('sha256').update(body).digest('hex').toUpperCase()
const artifactFiles = ['SHA256SUMS.txt', 'resolved-security-headers.json']
const artifactSums = []
for (const name of artifactFiles) {
  const artifactBody = await readFile(resolve(artifactRoot, name))
  artifactSums.push(`${createHash('sha256').update(artifactBody).digest('hex')}  ${name}`)
}
artifactSums.push(`${hash.toLowerCase()}  ${archiveName}`)
await writeFile(resolve(artifactRoot, 'ARTIFACT-SHA256SUMS.txt'), `${artifactSums.join('\n')}\n`, 'utf8')
console.log(`ZIP=${targetPath}`)
console.log(`FILES=${files.length}`)
console.log(`SHA256=${hash}`)
