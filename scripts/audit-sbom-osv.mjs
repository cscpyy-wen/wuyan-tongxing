import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_ENDPOINT = 'https://api.osv.dev/v1/querybatch'
const DEFAULT_BATCH_SIZE = 100
const DEFAULT_MAX_REPORT_AGE_MS = 24 * 60 * 60 * 1_000

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
  const now = options.now ? new Date(options.now()) : new Date()
  if (!Number.isFinite(now.getTime())) throw new Error('OSV 审计时间无效')
  const report = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
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
  if (options.checkOnly) {
    if (findings.length > 0) {
      throw new Error(`OSV 实时复查发现 ${findings.length} 个受影响组件记录；发布已停止且未改写已提交报告`)
    }
    let stored
    try {
      stored = JSON.parse(await fs.readFile(reportPath, 'utf8'))
    } catch {
      throw new Error('缺少可解析的已提交 OSV 审计报告；请先运行 pnpm audit:sbom-osv 并提交结果')
    }
    const storedTime = new Date(stored.generatedAt).getTime()
    const maximumAge = options.maxReportAgeMs ?? DEFAULT_MAX_REPORT_AGE_MS
    if (
      !Number.isFinite(storedTime)
      || !Number.isFinite(maximumAge)
      || maximumAge < 0
      || storedTime > now.getTime() + 5 * 60 * 1_000
      || now.getTime() - storedTime > maximumAge
    ) {
      throw new Error('已提交 OSV 审计报告已过期或时间无效；请刷新并提交报告')
    }
    const comparableStored = {
      schemaVersion: stored.schemaVersion,
      source: stored.source,
      endpoint: stored.endpoint,
      sbomPath: stored.sbomPath,
      sbomSha256: stored.sbomSha256,
      componentCount: stored.componentCount,
      ecosystems: stored.ecosystems,
      findingCount: stored.findingCount,
      findings: stored.findings,
    }
    const comparableCurrent = {
      schemaVersion: report.schemaVersion,
      source: report.source,
      endpoint: report.endpoint,
      sbomPath: report.sbomPath,
      sbomSha256: report.sbomSha256,
      componentCount: report.componentCount,
      ecosystems: report.ecosystems,
      findingCount: report.findingCount,
      findings: report.findings,
    }
    if (JSON.stringify(comparableStored) !== JSON.stringify(comparableCurrent)) {
      throw new Error('已提交 OSV 审计报告与当前 SBOM 或实时查询结果不一致；请刷新并提交报告')
    }
    return stored
  }
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (findings.length > 0) {
    throw new Error(`OSV 发现 ${findings.length} 个受影响组件记录；详见 docs/osv-audit.json`)
  }
  return report
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  const argumentsList = process.argv.slice(2)
  if (argumentsList.some((argument) => argument !== '--check')) {
    throw new Error(`未知 OSV 审计参数：${argumentsList.join(', ')}`)
  }
  const checkOnly = argumentsList.includes('--check')
  const report = await runOsvAudit({ checkOnly })
  console.log(
    `OSV 审计通过：npm ${report.ecosystems.npm} 个，Maven ${report.ecosystems.maven} 个，发现 0${checkOnly ? '；已提交报告匹配且未改写' : ''}。`,
  )
}
