import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { osvQueriesFromSbom, queryOsvBatch } from './audit-sbom-osv.mjs'

const entries = osvQueriesFromSbom({
  components: [
    { 'bom-ref': 'npm-a', purl: 'pkg:npm/a@1.0.0' },
    { 'bom-ref': 'maven-b', purl: 'pkg:maven/com.example/b@2.0.0' },
  ],
})

describe('OSV SBOM 审计', () => {
  it('逐条绑定返回结果并保留 npm 与 Maven 范围', async () => {
    const calls = []
    const findings = await queryOsvBatch(entries, {
      batchSize: 1,
      fetchImpl: async (_url, request) => {
        calls.push(JSON.parse(request.body))
        return {
          ok: true,
          json: async () => ({
            results: calls.length === 1 ? [{ vulns: [{ id: 'OSV-1', aliases: ['CVE-1'] }] }] : [{}],
          }),
        }
      },
    })

    assert.equal(calls.length, 2)
    assert.deepEqual(findings, [{
      ref: 'npm-a',
      purl: 'pkg:npm/a@1.0.0',
      ecosystem: 'npm',
      id: 'OSV-1',
      aliases: ['CVE-1'],
      modified: null,
    }])
  })

  it('HTTP 失败和结果数量错位时失败关闭', async () => {
    await assert.rejects(
      queryOsvBatch(entries, { fetchImpl: async () => ({ ok: false, status: 503 }) }),
      /HTTP 503/,
    )
    await assert.rejects(
      queryOsvBatch(entries, {
        fetchImpl: async () => ({ ok: true, json: async () => ({ results: [] }) }),
      }),
      /条目数与请求不一致/,
    )
  })
})
