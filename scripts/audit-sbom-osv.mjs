import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_ENDPOINT = 'https://api.osv.dev/v1/querybatch'
const DEFAULT_BATCH_SIZE = 100

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function osvQueriesFromSbom(sbom) {
  if (!Array.isArray(sbom?.components)) throw new Error('SBOM 缺少 components')
  const components = sbom.components.filter((component) => (
    typeof component?.purl === 'string' && component.purl.includes('@')
  ))
  if (components.length === 0) throw new Error('SBOM 没有可审计的带版本 purl')
  return components.map((component) => ({
    ref: component['bom-ref'] ?? component.purl,
    purl: component.purl,
    ecosystem: component.purl.startsWith('pkg:maven/') ? 'maven' : 'npm',
    query: { package: { purl: component.purl } },
  }))
}

export async function queryOsvBatch(entries, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时不支持 fetch')
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) throw new Error('OSV 批大小无效')

  const findings = []
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const batch = entries.slice(offset, offset + batchSize)
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: batch.map((entry) => entry.query) }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`OSV 查询失败：HTTP ${response.status}`)
    const body = await response.json()
    if (!Array.isArray(body?.results) || body.results.length !== batch.length) {
      throw new Error('OSV 返回条目数与请求不一致')
    }
    body.results.forEach((result, index) => {
      const entry = batch[index]
      const vulnerabilities = Array.isArray(result?.vulns) ? result.vulns : []
      vulnerabilities.forEach((vulnerability) => {
        if (typeof vulnerability?.id !== 'string') throw new Error('OSV 返回无效漏洞条目')
        findings.push({
          ref: entry.ref,
          purl: entry.purl,
          ecosystem: entry.ecosystem,
          id: vulnerability.id,
          aliases: Array.isArray(vulnerability.aliases) ? vulnerability.aliases : [],
          modified: typeof vulnerability.modified === 'string' ? vulnerability.modified : null,
        })
      })
    })
  }
  return findings.sort((left, right) => (
    left.purl.localeCompare(right.purl) || left.id.localeCompare(right.id)
  ))
}

export async function runOsvAudit(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? path.resolve(import.meta.dirname, '..')
  const sbomPath = path.join(repositoryRoot, 'docs', 'sbom.cdx.json')
  const reportPath = path.join(repositoryRoot, 'docs', 'osv-audit.json')
  const sbomBytes = await fs.readFile(sbomPath)
  const sbom = JSON.parse(sbomBytes.toString('utf8'))
  const entries = osvQueriesFromSbom(sbom)
  const findings = await queryOsvBatch(entries, options)
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'OSV querybatch API',
    endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
    sbomPath: 'docs/sbom.cdx.json',
    sbomSha256: sha256(sbomBytes),
    componentCount: entries.length,
    ecosystems: {
      npm: entries.filter((entry) => entry.ecosystem === 'npm').length,
      maven: entries.filter((entry) => entry.ecosystem === 'maven').length,
    },
    findingCount: findings.length,
    findings,
  }
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (findings.length > 0) {
    throw new Error(`OSV 发现 ${findings.length} 个受影响组件记录；详见 docs/osv-audit.json`)
  }
  return report
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  const report = await runOsvAudit()
  console.log(`OSV 审计通过：npm ${report.ecosystems.npm} 个，Maven ${report.ecosystems.maven} 个，发现 0。`)
}
