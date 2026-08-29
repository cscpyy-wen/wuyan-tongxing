import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const sourceRoots = ['apps', 'packages', 'deploy', 'scripts']
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.scss', '.css', '.html', '.md', '.txt', '.yaml', '.yml'])
const ignoredDirectories = new Set(['node_modules', 'dist', 'coverage', '.git', '.gradle', 'build', 'www', '.toolchains'])
const failures = []
const unfinishedPattern = new RegExp(
  `\\b(?:${['TO', 'DO', '|FIX', 'ME', '|LOREM_', 'IPSUM', '|PLACEHOLDER_', 'CONTENT'].join('')})\\b`,
  'i',
)

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(full))
    else if (textExtensions.has(path.extname(entry.name))) files.push(full)
  }
  return files
}

for (const sourceRoot of sourceRoots) {
  const directory = path.join(root, sourceRoot)
  try {
    for (const file of await walk(directory)) {
      const relative = path.relative(root, file)
      const value = await fs.readFile(file, 'utf8')
      const normalized = relative.replaceAll('\\', '/')
      const isPlaceholderValidator = normalized === 'scripts/verify-repo.mjs'
        || normalized === 'packages/content/scripts/verify-content.mjs'
      if (!isPlaceholderValidator && unfinishedPattern.test(value)) {
        failures.push(`${relative}: 含未完成占位标记`)
      }
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)) {
        failures.push(`${relative}: 疑似包含私钥`)
      }
      for (const [label, pattern] of [
        ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
        ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
        ['OpenAI key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
      ]) {
        if (pattern.test(value)) failures.push(`${relative}: 疑似包含${label}`)
      }
      if (normalized.endsWith('.ts') || normalized.endsWith('.tsx')) {
        for (const [lineIndex, line] of value.split(/\r?\n/u).entries()) {
          if (!/\b(?:confirmText|cancelText)\s*:/u.test(line)) continue
          const valueExpression = line.slice(line.indexOf(':') + 1)
          for (const match of valueExpression.matchAll(/(['"])([^'"\r\n]*)\1/gu)) {
            const label = match[2]
            if ([...label].length > 4) {
              failures.push(`${relative}:${lineIndex + 1}: showModal 操作文字“${label}”超过 4 个字符`)
            }
          }
        }
      }
    }
  } catch (error) {
    failures.push(`${sourceRoot}: 无法扫描（${error instanceof Error ? error.message : String(error)}）`)
  }
}

const required = [
  'apps/client/package.json',
  'apps/api/package.json',
  'apps/admin/package.json',
  'apps/worker/package.json',
  'apps/android-shell/package.json',
  'apps/android-shell/android/LICENSE-CAPACITOR',
  'apps/android-shell/personal-version.json',
  'apps/android-shell/capacitor.config.json',
  'scripts/build-android-public.mjs',
  'deploy/tencent-cloudbase/assets/favicon.svg',
  'deploy/tencent-cloudbase/assets/robots.txt',
  'packages/contracts/package.json',
  'packages/domain/package.json',
  'packages/rules/package.json',
  'packages/content/package.json',
  'packages/persistence/package.json',
  'packages/persistence/src/index.js',
  'packages/content/src/data/content-items.json',
  'packages/content/src/data/evidence-sources.json',
  'packages/content/src/data/claim-matrix.json',
  'docs/privacy-data-map.md',
  'docs/medical-review-checklist.md',
  'docs/release-checklist.md',
  'docs/android-personal-app.md',
]

for (const relative of required) {
  try {
    await fs.access(path.join(root, relative))
  } catch {
    failures.push(`${relative}: 必需交付缺失`)
  }
}

try {
  const [notice, capacitorLicense] = await Promise.all([
    fs.readFile(path.join(root, 'NOTICE'), 'utf8'),
    fs.readFile(path.join(root, 'apps/android-shell/android/LICENSE-CAPACITOR'), 'utf8'),
  ])
  if (!notice.includes('Capacitor Android') || !notice.includes('Drifty Co.')) {
    failures.push('NOTICE: 必须保留 Capacitor Android template 与 Drifty Co. 的明确归属')
  }
  if (!capacitorLicense.includes('MIT License') || !capacitorLicense.includes('Copyright (c) 2017-present Drifty Co.')) {
    failures.push('apps/android-shell/android/LICENSE-CAPACITOR: 必须保留完整的上游 MIT 许可头')
  }
  const licenseDigest = createHash('sha256').update(capacitorLicense).digest('hex')
  if (licenseDigest !== '9c6ebf3e5ab832ba4d5af38f340978e1fedbfee6e3d23662dfdb8917a9d864dd') {
    failures.push('apps/android-shell/android/LICENSE-CAPACITOR: 必须与锁定的 @capacitor/cli@8.5.0 MIT 文本逐字节一致')
  }
} catch (error) {
  failures.push(`Capacitor 模板许可链无法核验（${error instanceof Error ? error.message : String(error)}）`)
}

try {
  const [personalVersion, androidPackage] = await Promise.all([
    fs.readFile(path.join(root, 'apps/android-shell/personal-version.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(root, 'apps/android-shell/package.json'), 'utf8').then(JSON.parse),
  ])
  if (androidPackage.version !== personalVersion.versionName) {
    failures.push('apps/android-shell/package.json: version 必须与 personal-version.json 的 versionName 完全一致')
  }
  const suffix = /-personal\.(\d+)$/u.exec(personalVersion.versionName)?.[1]
  if (!suffix || Number(suffix) !== personalVersion.versionCode) {
    failures.push('apps/android-shell/personal-version.json: versionName 后缀必须与 versionCode 一致')
  }
} catch (error) {
  failures.push(`Android 版本元数据无法解析（${error instanceof Error ? error.message : String(error)}）`)
}

try {
  const [packageJson, gradleBuild, projectConfig, gitignore] = await Promise.all([
    fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(root, 'apps/android-shell/android/app/build.gradle'), 'utf8'),
    fs.readFile(path.join(root, 'apps/client/project.config.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(root, '.gitignore'), 'utf8'),
  ])
  if (packageJson.scripts?.['build:android'] !== 'node scripts/build-android-public.mjs') {
    failures.push('package.json: 默认 build:android 必须只运行公开 debug 构建器')
  }
  if (!packageJson.scripts?.['build:android:maintainer-release']?.endsWith('node scripts/build-android.mjs')) {
    failures.push('package.json: 维护者签名链必须保留为 build:android:maintainer-release')
  }
  for (const forbiddenScript of ['build:site', 'release:artifacts', 'verify:release']) {
    if (forbiddenScript in (packageJson.scripts ?? {})) failures.push(`package.json: 不得保留 ${forbiddenScript}`)
  }
  if (!/debug\s*\{[\s\S]*applicationIdSuffix\s+["']\.debug["'][\s\S]*versionNameSuffix\s+["']-debug["']/m.test(gradleBuild)) {
    failures.push('apps/android-shell/android/app/build.gradle: debug 必须使用独立包名和版本后缀')
  }
  if (projectConfig.appid !== 'touristappid') failures.push('apps/client/project.config.json: 公开源码只能使用 touristappid')
  if (/内部/u.test(projectConfig.projectname ?? '')) failures.push('apps/client/project.config.json: 项目名不得标记为内部版本')
  const ignoreLines = new Set(gitignore.split(/\r?\n/).map((line) => line.trim()))
  for (const requiredIgnore of [
    '/release/',
    '/.audit-tmp/',
    '/.private/',
    '/apps/android-shell/www/',
    '/apps/android-shell/android/app/src/main/assets/',
    '/apps/android-shell/android/capacitor-cordova-android-plugins/src/main/assets/',
    '/apps/android-shell/android/app/build/',
    '/docs/qa-screenshots/',
  ]) {
    if (!ignoreLines.has(requiredIgnore)) failures.push(`.gitignore: 缺少公开边界 ${requiredIgnore}`)
  }
  if (!ignoreLines.has('!.env.example')) failures.push('.gitignore: 必须明确保留 .env.example')
} catch (error) {
  failures.push(`公开构建配置无法核验（${error instanceof Error ? error.message : String(error)}）`)
}

try {
  const workflow = await fs.readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8')
  const actionReferences = [...workflow.matchAll(/^\s*uses:\s*([^@\s]+)@([^\s#]+)/gmu)]
  if (actionReferences.length === 0) failures.push('.github/workflows/ci.yml: 未找到可核验的 GitHub Action 引用')
  for (const [, action, revision] of actionReferences) {
    if (!/^[a-f0-9]{40}$/u.test(revision)) {
      failures.push(`.github/workflows/ci.yml: ${action} 必须固定到完整 40 位提交 SHA`)
    }
  }
} catch (error) {
  failures.push(`GitHub Actions 固定版本无法核验（${error instanceof Error ? error.message : String(error)}）`)
}

try {
  const wrapperPath = 'apps/android-shell/android/gradlew'
  const indexEntry = execFileSync('git', ['ls-files', '--stage', '--', wrapperPath], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
  if (!indexEntry.startsWith('100755 ')) {
    failures.push(`${wrapperPath}: Git 文件模式必须为 100755，确保 Ubuntu CI 可直接执行`)
  }
} catch (error) {
  failures.push(`Android Gradle Wrapper Git 模式无法核验（${error instanceof Error ? error.message : String(error)}）`)
}

for (const forbidden of ['deploy/public-preview-site', '.private', 'release']) {
  try {
    await fs.access(path.join(root, forbidden))
    failures.push(`${forbidden}: 公开源码快照不得包含该目录`)
  } catch {
    // Expected: public snapshots contain neither private material nor historical releases.
  }
}

async function auditSensitiveNames(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.toolchains', 'dist', 'coverage', 'build', 'www'].includes(entry.name)) continue
    const full = path.join(directory, entry.name)
    const relative = path.relative(root, full).replaceAll('\\', '/')
    if (entry.isDirectory()) {
      await auditSensitiveNames(full)
      continue
    }
    if (/\.(?:jks|keystore|p12|pfx|pem|key)$/i.test(entry.name)) {
      failures.push(`${relative}: 公开源码不得包含私钥或密钥库文件`)
    }
    if (/^\.env(?:\.|$)/i.test(entry.name) && relative !== '.env.example') {
      failures.push(`${relative}: 公开源码不得包含环境密钥文件`)
    }
    if (relative.startsWith('apps/android-shell/android/app/src/main/res/') && entry.name.toLowerCase().endsWith('.png')) {
      failures.push(`${relative}: 公开 Android 资源采用可审计矢量策略，不得重新引入来源不明的 legacy PNG`)
    }
  }
}
await auditSensitiveNames(root)

if (failures.length > 0) {
  console.error(`仓库审计失败（${failures.length} 项）：`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('仓库审计通过：公开 debug 构建边界完整，无 Sites 包装、历史 release、私钥或内部小程序标识。')
