import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { assessNpmReport, verifySecurityPatches } from './security-patch-policy.mjs'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function vulnerabilityTotal(report) {
  const counts = report?.metadata?.vulnerabilities
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    throw new Error('审计 JSON 缺少 metadata.vulnerabilities；拒绝把未知结果当作 0 漏洞')
  }
  const values = Object.values(counts)
  if (['info', 'low', 'moderate', 'high', 'critical'].some((level) => !(level in counts))
    || values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('审计 JSON 的漏洞计数无效；拒绝把未知结果当作 0 漏洞')
  }
  return values.reduce((sum, value) => sum + Number(value), 0)
}

export function dependencyAuditPlan(options = {}) {
  const root = path.resolve(options.root ?? defaultRoot)
  const pnpmCli = options.pnpmCli ?? process.env.npm_execpath
  if (!pnpmCli) throw new Error('必须通过 pnpm 运行全依赖审计闸门，以固定根工作区 pnpm 版本')
  const nodeExecutable = options.nodeExecutable ?? process.execPath
  const platform = options.platform ?? process.platform
  const npmExecutable = options.npmExecutable ?? 'npm'
  const npmArgs = ['audit', '--audit-level', 'low', '--json']
  const npmScope = (name, cwd) => platform === 'win32'
    ? {
        name,
        executable: options.commandShell ?? process.env.ComSpec ?? 'cmd.exe',
        args: ['/d', '/s', '/c', [npmExecutable, ...npmArgs].join(' ')],
        cwd,
        shell: false,
      }
    : { name, executable: npmExecutable, args: npmArgs, cwd, shell: false }
  return [
    {
      name: '根工作区 pnpm 生产依赖图',
      executable: nodeExecutable,
      args: [pnpmCli, 'audit', '--prod', '--audit-level', 'low', '--json'],
      cwd: root,
      shell: false,
    },
    {
      name: '根工作区 pnpm 完整依赖图',
      executable: nodeExecutable,
      args: [pnpmCli, 'audit', '--audit-level', 'low', '--json'],
      cwd: root,
      shell: false,
    },
    npmScope('tencent-cloudbase npm 锁文件', path.join(root, 'deploy', 'tencent-cloudbase')),
  ]
}

export function runAllDependencyAudits(options = {}) {
  const spawn = options.spawn ?? spawnSync
  const evidence = (options.verifyPatches ?? verifySecurityPatches)(options)
  const results = []
  for (const scope of dependencyAuditPlan(options)) {
    const result = spawn(scope.executable, scope.args, {
      cwd: scope.cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      shell: scope.shell,
      windowsHide: true,
      timeout: 120_000,
    })
    if (result.error) throw new Error(`${scope.name}审计无法启动：${result.error.message}`, { cause: result.error })
    let report
    try {
      report = JSON.parse(result.stdout)
    } catch {
      throw new Error(`${scope.name}未返回有效 JSON：${`${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()}`)
    }
    const total = vulnerabilityTotal(report)
    const assessment = assessNpmReport(report, total, evidence)
    // npm/pnpm exit 1 is the documented vulnerability result. It is allowed
    // only when every original advisory is independently remediated above.
    if ((result.status !== 0 && !(result.status === 1 && total > 0)) || assessment.unresolvedFindingCount !== 0) {
      throw new Error(`${scope.name}必须在 low 阈值下为 0 未修复漏洞（退出码 ${result.status ?? 'unknown'}，原始计数 ${total}，未处置 ${assessment.unresolvedFindingCount}）`)
    }
    results.push({ name: scope.name, total, report, assessment })
  }
  if (options.saveReport === true) {
    const reportDirectory = path.join(options.root ?? defaultRoot, 'docs')
    mkdirSync(reportDirectory, { recursive: true })
    writeFileSync(path.join(reportDirectory, 'dependency-audit.json'), `${JSON.stringify({
      schemaVersion: 1, generatedAt: new Date().toISOString(), threshold: 'low',
      policy: 'No unresolved findings; original advisories retained; installed patch bytes and regressions verified',
      evidence, scopes: results,
    }, null, 2)}\n`)
  }
  return results
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  if (process.argv.slice(2).some((argument) => argument !== '--write-report')) throw new Error('未知审计参数')
  const saveReport = process.argv.includes('--write-report')
  const results = runAllDependencyAudits({ saveReport })
  console.log(`全依赖审计通过：${results.map(({ name, total }) => `${name}原始警报 ${total}`).join('、')}；low 阈值未处置项 0，已核验本地补丁${saveReport ? '；原始报告已保存至 docs/dependency-audit.json' : '；未改写已提交报告'}。`)
}
