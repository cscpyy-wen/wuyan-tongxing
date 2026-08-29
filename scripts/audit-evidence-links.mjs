import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const sourcePath = path.join(root, 'packages/content/src/data/evidence-sources.json')
const outputPath = path.join(root, 'docs/evidence-link-audit.json')
const sources = JSON.parse(await fs.readFile(sourcePath, 'utf8'))

async function inspect(source) {
  const startedAt = Date.now()
  try {
    const response = await fetch(source.url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'user-agent': 'WuyanTongxing-Evidence-Audit/0.1 (+internal release verification)',
        accept: 'text/html,application/pdf,application/json;q=0.9,*/*;q=0.5',
      },
    })
    const status = response.status
    await response.body?.cancel()
    const verdict = status === 404 || status === 410
      ? 'confirmed-broken'
      : status >= 200 && status < 400
        ? 'reachable'
        : [401, 403, 405, 406, 409, 412, 429].includes(status)
          ? 'access-restricted'
          : 'unverified-http'
    return {
      id: source.id,
      url: source.url,
      status,
      finalUrl: response.url,
      verdict,
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      id: source.id,
      url: source.url,
      status: null,
      verdict: 'unverified-network',
      error: error instanceof Error ? error.name : 'UnknownError',
      elapsedMs: Date.now() - startedAt,
    }
  }
}

const results = []
const queue = [...sources]
await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
  while (queue.length > 0) {
    const source = queue.shift()
    if (source) results.push(await inspect(source))
  }
}))
results.sort((left, right) => left.id.localeCompare(right.id))

const counts = Object.fromEntries([...new Set(results.map((result) => result.verdict))]
  .sort()
  .map((verdict) => [verdict, results.filter((result) => result.verdict === verdict).length]))
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  policy: '404/410 is a release failure; access restrictions and transport timeouts require manual browser review, not automatic deletion.',
  sourceCount: sources.length,
  counts,
  results,
}

await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`证据链接审计完成：${sources.length} 条；${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(', ')}`)

if (results.some((result) => result.verdict === 'confirmed-broken')) process.exit(1)
