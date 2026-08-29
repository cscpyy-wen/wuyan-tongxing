import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  dependencyAuditPlan,
  runAllDependencyAudits,
  vulnerabilityTotal,
} from './verify-zero-vulnerabilities.mjs'

const root = path.resolve('audit-fixture-root')
const options = {
  root,
  pnpmCli: 'fixture-pnpm.cjs',
  nodeExecutable: 'fixture-node',
  npmExecutable: 'fixture-npm',
  platform: 'linux',
}

function cleanReport() {
  return JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } })
}

test('audit plan covers root pnpm prod/full and Tencent deploy lock at low threshold', () => {
  const plan = dependencyAuditPlan(options)
  assert.equal(plan.length, 3)
  assert.deepEqual(plan.map(({ name }) => name), [
    '根工作区 pnpm 生产依赖图',
    '根工作区 pnpm 完整依赖图',
    'tencent-cloudbase npm 锁文件',
  ])
  assert.deepEqual(plan[0].args, ['fixture-pnpm.cjs', 'audit', '--prod', '--audit-level', 'low', '--json'])
  assert.deepEqual(plan[1].args, ['fixture-pnpm.cjs', 'audit', '--audit-level', 'low', '--json'])
  assert.deepEqual(plan[2].args, ['audit', '--audit-level', 'low', '--json'])
  assert.deepEqual(plan[2].args, ['audit', '--audit-level', 'low', '--json'])
  assert.equal(plan[0].cwd, root)
  assert.equal(plan[1].cwd, root)
  assert.equal(plan[2].cwd, path.join(root, 'deploy', 'tencent-cloudbase'))
})

test('Windows npm lock audits use an explicit constant cmd invocation without child_process shell mode', () => {
  const plan = dependencyAuditPlan({ ...options, platform: 'win32', commandShell: 'fixture-cmd' })
  for (const scope of plan.slice(2)) {
    assert.equal(scope.executable, 'fixture-cmd')
    assert.deepEqual(scope.args, ['/d', '/s', '/c', 'fixture-npm audit --audit-level low --json'])
    assert.equal(scope.shell, false)
  }
})

test('all three clean audit scopes must execute', () => {
  const calls = []
  const results = runAllDependencyAudits({
    ...options,
    spawn(executable, args, spawnOptions) {
      calls.push({ executable, args, spawnOptions })
      return { status: 0, stdout: cleanReport(), stderr: '' }
    },
  })
  assert.equal(calls.length, 3)
  assert.equal(results.length, 3)
  assert.deepEqual(results.map(({ total }) => total), [0, 0, 0])
})

test('audit gate fails closed on a vulnerability and stops later scopes', () => {
  let calls = 0
  assert.throws(() => runAllDependencyAudits({
    ...options,
    spawn() {
      calls += 1
      const report = JSON.parse(cleanReport())
      if (calls === 2) report.metadata.vulnerabilities.low = 1
      return { status: calls === 2 ? 1 : 0, stdout: JSON.stringify(report), stderr: '' }
    },
  }), /完整依赖图必须在 low 阈值下为 0 漏洞/)
  assert.equal(calls, 2)
})

test('audit gate fails closed on nonzero exit even if reported counts are zero', () => {
  assert.throws(() => runAllDependencyAudits({
    ...options,
    spawn() { return { status: 1, stdout: cleanReport(), stderr: 'registry error' } },
  }), /退出码 1/)
})

test('audit gate rejects malformed or structurally incomplete JSON', () => {
  assert.throws(() => runAllDependencyAudits({
    ...options,
    spawn() { return { status: 0, stdout: 'not json', stderr: '' } },
  }), /未返回有效 JSON/)
  assert.throws(() => vulnerabilityTotal({ metadata: {} }), /缺少 metadata\.vulnerabilities/)
  assert.throws(() => vulnerabilityTotal({ metadata: { vulnerabilities: { low: 'unknown' } } }), /漏洞计数无效/)
})

test('audit gate reports process launch failure', () => {
  assert.throws(() => runAllDependencyAudits({
    ...options,
    spawn() { return { error: new Error('ENOENT'), status: null, stdout: '', stderr: '' } },
  }), /审计无法启动：ENOENT/)
})
