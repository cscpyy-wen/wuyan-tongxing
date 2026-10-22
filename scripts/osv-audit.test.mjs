import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { osvQueriesFromSbom, queryOsvBatch, runOsvAudit, verifyOsvReportForRelease } from './audit-sbom-osv.mjs'
import { createHash } from 'node:crypto'
import { assessOsvFindings } from './security-patch-policy.mjs'

const entries = osvQueriesFromSbom({
  components: [
    { 'bom-ref': 'npm-a', purl: 'pkg:npm/a@1.0.0' },
    { 'bom-ref': 'maven-b', purl: 'pkg:maven/com.example/b@2.0.0' },
  ],
})

describe('OSV SBOM 审计', () => {
  it('维护者 release 构建实时复查但不刷新已提交报告', async () => {
    const packageJson = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'))
    assert.match(packageJson.scripts['build:android:maintainer-release'], /pnpm audit:sbom-osv:check/)
    assert.doesNotMatch(packageJson.scripts['build:android:maintainer-release'], /pnpm audit:sbom-osv(?:\s|&&)/)
  })

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

  it('未获取的分页或无效结果结构不能当作零发现', async () => {
    for (const result of [null, [], { vulns: null }, { vulns: [], next_page_token: 'unread' }]) {
      await assert.rejects(queryOsvBatch(entries, {
        fetchImpl: async () => ({ ok: true, json: async () => ({ results: [result, {}] }) }),
      }), /无效结果结构|分页/)
    }
  })

  it('发布检查实时复查已提交报告且保持工作树文件不变', async (t) => {
    const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wuyan-osv-check-'))
    t.after(() => fs.rm(repositoryRoot, { recursive: true, force: true }))
    await fs.mkdir(path.join(repositoryRoot, 'docs'), { recursive: true })
    await fs.writeFile(path.join(repositoryRoot, 'docs', 'sbom.cdx.json'), JSON.stringify({
      components: [
        { 'bom-ref': 'npm-a', purl: 'pkg:npm/a@1.0.0' },
        { 'bom-ref': 'maven-b', purl: 'pkg:maven/com.example/b@2.0.0' },
      ],
    }))
    const emptyResponse = async () => ({
      ok: true,
      json: async () => ({ results: [{}, {}] }),
    })
    await runOsvAudit({
      repositoryRoot,
      fetchImpl: emptyResponse,
      now: () => new Date('2026-08-30T01:00:00.000Z'),
      verifyPatches: () => ({ packages: [] }),
    })
    const reportPath = path.join(repositoryRoot, 'docs', 'osv-audit.json')
    const before = await fs.readFile(reportPath)
    const checked = await runOsvAudit({
      repositoryRoot,
      fetchImpl: emptyResponse,
      checkOnly: true,
      now: () => new Date('2026-08-30T02:00:00.000Z'),
      verifyPatches: () => ({ packages: [] }),
    })
    const after = await fs.readFile(reportPath)
    assert.equal(checked.generatedAt, '2026-08-30T01:00:00.000Z')
    assert.deepEqual(after, before)

    const stale = JSON.parse(after.toString('utf8'))
    stale.sbomSha256 = '0'.repeat(64)
    await fs.writeFile(reportPath, `${JSON.stringify(stale, null, 2)}\n`)
    await assert.rejects(
      runOsvAudit({
        repositoryRoot,
        fetchImpl: emptyResponse,
        checkOnly: true,
        now: () => new Date('2026-08-30T02:00:00.000Z'),
        verifyPatches: () => ({ packages: [] }),
      }),
      /与当前 SBOM 或实时查询结果不一致/,
    )
  })
})

it('APK 报告核验重新计算处置结果，不信任人为填零或过期证据', () => {
  const patchSha = '1'.repeat(64)
  const evidence = { packages: [{ purl: 'pkg:npm/a@1.0.0', patchSha256: patchSha, pnpmPatchHash: patchSha,
    advisories: [{ id: 'GHSA-aaaa-bbbb-cccc', osvModified: '2026-10-02T00:00:00Z' }] }] }
  const sbomBytes = Buffer.from(JSON.stringify({ components: [{ 'bom-ref': 'npm-a', purl: 'pkg:npm/a@1.0.0', properties: [
    { name: 'wuyan:patch-sha256', value: patchSha }, { name: 'wuyan:pnpm-patch-hash', value: patchSha },
  ] }] }))
  const findings = [{ purl: 'pkg:npm/a@1.0.0', ref: 'npm-a', ecosystem: 'npm', id: 'GHSA-aaaa-bbbb-cccc', modified: '2026-10-02T00:00:00Z' }]
  const report = {
    schemaVersion: 2, source: 'OSV querybatch API', endpoint: 'https://api.osv.dev/v1/querybatch',
    generatedAt: '2026-10-22T07:00:00Z', sbomPath: 'docs/sbom.cdx.json',
    sbomSha256: createHash('sha256').update(sbomBytes).digest('hex'), componentCount: 1,
    ecosystems: { npm: 1, maven: 0 }, findingCount: 1, findings, assessment: assessOsvFindings(findings, evidence),
  }
  const now = Date.parse('2026-10-22T08:00:00Z')
  assert.equal(verifyOsvReportForRelease(report, sbomBytes, evidence, now).unresolvedFindingCount, 0)
  assert.throws(() => verifyOsvReportForRelease({ ...report, findingCount: 0 }, sbomBytes, evidence, now), /结构/)
  assert.throws(() => verifyOsvReportForRelease(report, sbomBytes, { packages: [] }, now), /未修复/)
  assert.throws(() => verifyOsvReportForRelease(report, sbomBytes, evidence, now + 86_400_000), /时效/)
  const changed = structuredClone(report)
  changed.findings[0].modified = '2026-10-03T00:00:00Z'
  assert.throws(() => verifyOsvReportForRelease(changed, sbomBytes, evidence, now), /未修复/)
})
