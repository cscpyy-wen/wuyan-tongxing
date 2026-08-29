import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageScript = resolve(scriptDir, 'package.mjs')
const deployRoot = resolve(scriptDir, '..')
const sourceRoot = resolve(deployRoot, 'dist')
const artifactRoot = resolve(deployRoot, 'artifacts')
const packageMetadata = JSON.parse(await readFile(resolve(deployRoot, 'package.json'), 'utf8'))
const archiveName = `wuyan-tongxing-cloudbase-h5-${packageMetadata.version}.zip`
const archivePath = resolve(artifactRoot, archiveName)

function packageArchive() {
  execFileSync(process.execPath, [packageScript], { stdio: 'inherit' })
}

async function archiveHash() {
  return createHash('sha256').update(await readFile(archivePath)).digest('hex')
}

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

async function verifyArchive() {
  const zip = new AdmZip(await readFile(archivePath))
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory)
  const files = await listFiles(sourceRoot)
  if (entries.length !== files.length) throw new Error('ZIP 条目数与 dist 不一致')
  const expected = new Map(files.map((file) => [
    relative(sourceRoot, file).split(sep).join('/'),
    file,
  ]))
  for (const entry of entries) {
    const file = expected.get(entry.entryName)
    if (!file) throw new Error(`ZIP 包含非预期条目：${entry.entryName}`)
    const source = await readFile(file)
    if (!entry.getData().equals(source)) throw new Error(`ZIP 条目字节不一致：${entry.entryName}`)
    if (entry.header.time.getFullYear() !== 2000) throw new Error(`ZIP 条目时间未固定：${entry.entryName}`)
    expected.delete(entry.entryName)
  }
  if (expected.size > 0) throw new Error(`ZIP 缺少条目：${[...expected.keys()].join(', ')}`)

  const manifest = await readFile(resolve(artifactRoot, 'ARTIFACT-SHA256SUMS.txt'), 'utf8')
  const hash = await archiveHash()
  if (!manifest.includes(`${hash}  ${archiveName}`)) throw new Error('制品清单缺少 ZIP SHA-256')
}

packageArchive()
await verifyArchive()
const first = await archiveHash()
packageArchive()
await verifyArchive()
const second = await archiveHash()
if (first !== second) throw new Error(`ZIP 不可复现：${first} != ${second}`)
console.log(`CloudBase ZIP 字节可复现：sha256:${first}`)
