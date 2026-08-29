import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const failures = []
const observations = []

async function exists(relative) {
  try {
    await fs.access(path.join(root, relative))
    return true
  } catch {
    return false
  }
}

async function read(relative) {
  return fs.readFile(path.join(root, relative), 'utf8')
}

async function filesBelow(relative) {
  const directory = path.join(root, relative)
  const result = []
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (['node_modules', '.git', 'coverage', 'playwright-report', 'test-results'].includes(entry.name)) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(full)
      else result.push(full)
    }
  }
  await visit(directory)
  return result
}

for (const required of [
  '.gitattributes',
  '.github/workflows/ci.yml',
  '.node-version',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'docs/industrial-delivery-matrix.md',
  'docs/dependency-compatibility-waivers.md',
  'docs/operations-runbook.md',
  'docs/threat-model.md',
  'packages/content/src/data/content-items.json',
  'packages/content/src/data/evidence-sources.json',
  'packages/content/src/data/claim-matrix.json',
  'apps/client/dist/h5/index.html',
  'apps/client/dist/h5/sw.js',
  'apps/client/dist/weapp/app.json',
  'scripts/build-android-public.mjs',
  'deploy/tencent-cloudbase/package-lock.json',
  'deploy/tencent-cloudbase/security-headers.json',
  'deploy/tencent-cloudbase/assets/favicon.svg',
  'deploy/tencent-cloudbase/assets/robots.txt',
  'deploy/tencent-cloudbase/scripts/build.mjs',
  'deploy/tencent-cloudbase/scripts/verify.mjs',
]) {
  if (!await exists(required)) failures.push(`${required}: 必需的工业交付项缺失`)
}

const packageJson = JSON.parse(await read('package.json'))
const pinnedNode = (await read('.node-version')).trim()
if (packageJson.packageManager !== 'pnpm@11.19.0') failures.push('packageManager 必须固定为 pnpm@11.19.0')
if (pinnedNode !== '24.14.1' || packageJson.engines?.node !== '>=24.14.1 <25') {
  failures.push('Node.js 必须由 .node-version 固定为 24.14.1，engines 限定在 Node 24')
}

const gitignore = await read('.gitignore')
const ignoreLines = gitignore.split(/\r?\n/).map((line) => line.trim())
if (!ignoreLines.includes('/data/')) failures.push('.gitignore 必须只忽略根运行目录 /data/')
if (ignoreLines.includes('data/')) failures.push('.gitignore 的 data/ 会误伤医学内容数据，必须改为 /data/')
if (!ignoreLines.includes('/apps/client/.swc/')) failures.push('.gitignore 必须排除 apps/client/.swc 本机构建缓存')
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
  if (!ignoreLines.includes(requiredIgnore)) failures.push(`.gitignore 缺少公开源码排除项 ${requiredIgnore}`)
}
if (!ignoreLines.includes('!.env.example')) failures.push('.gitignore 必须保留 .env.example')

for (const relative of ['.gitattributes']) {
  const attributes = await read(relative)
  if (!attributes.split(/\r?\n/).some((line) => line.trim() === '* text=auto eol=lf')) {
    failures.push(`${relative} 必须把文本工作树行尾固定为 LF，保证 Windows 克隆后的发布指纹可复现`)
  }
}

if (await exists('docs/qa-screenshots/04-wechat-devtools-compile.png')) {
  failures.push('微信开发者工具原始截图包含登录用户头像，不得进入公开源码交付')
}

for (const relative of [
  'packages/content/src/index.js',
  'packages/content/src/index.js.map',
  'packages/content/src/index.d.ts',
  'packages/contracts/src/index.js',
  'packages/contracts/src/index.js.map',
  'packages/contracts/src/index.d.ts',
]) {
  if (await exists(relative)) failures.push(`${relative}: src 中不得混入旧编译产物`)
}

const contractsPackage = JSON.parse(await read('packages/contracts/package.json'))
if (contractsPackage.scripts?.build !== 'tsc -p tsconfig.build.json') {
  failures.push('contracts 构建必须使用 tsconfig.build.json，避免把测试编译进发布 dist')
}
const contractsVitest = await read('packages/contracts/vitest.config.ts')
if (!contractsVitest.includes("include: ['src/**/*.test.ts']")) {
  failures.push('contracts Vitest 必须只发现 TypeScript 源测试，测试数不得受历史 dist 影响')
}

const clientSource = (await Promise.all((await filesBelow('apps/client/src'))
  .filter((file) => /\.(?:ts|tsx)$/.test(file))
  .map((file) => fs.readFile(file, 'utf8')))).join('\n')
for (const forbidden of [
  ['wx.login', /\bwx\.login\b/],
  ['Taro.login', /\bTaro\.login\b/],
  ['手机号授权', /\bgetPhoneNumber\b/],
  ['客户端网络请求', /\b(?:Taro\.)?request\s*\(|\bfetch\s*\(/],
]) {
  if (forbidden[1].test(clientSource)) failures.push(`免登录、本地优先边界被破坏：发现${forbidden[0]}`)
}

const projectConfig = JSON.parse(await read('apps/client/project.config.json'))
if (projectConfig.appid !== 'touristappid') failures.push('交付源码不得固化真实微信 AppID')
if (/内部/u.test(projectConfig.projectname ?? '')) failures.push('公开源码的小程序项目名不得标记为内部版本')
const clientPackage = JSON.parse(await read('apps/client/package.json'))
if (clientPackage.devDependencies?.webpack !== '5.104.1') {
  failures.push('Webpack 必须保持在已审计的 5.104.1；变更需更新依赖兼容豁免和安全审计')
}

async function measureBundle(relative, totalLimit, fileLimit) {
  if (!await exists(relative)) {
    observations.push(`${relative}: 构建产物缺失；先运行对应客户端构建后再执行体积审计`)
    return
  }
  const files = await filesBelow(relative)
  let total = 0
  let largest = { path: '', size: 0 }
  for (const file of files) {
    const stat = await fs.stat(file)
    total += stat.size
    if (stat.size > largest.size) largest = { path: path.relative(root, file), size: stat.size }
    if (/\.(?:map|env)$/i.test(file)) failures.push(`${path.relative(root, file)}: 客户端发布产物不得包含源码映射或环境文件`)
  }
  if (total > totalLimit) failures.push(`${relative}: 总体积 ${total} 超过预算 ${totalLimit}`)
  if (largest.size > fileLimit) failures.push(`${largest.path}: 单文件 ${largest.size} 超过预算 ${fileLimit}`)
  observations.push(`${relative}: ${files.length} files, ${total} bytes, largest ${largest.size} bytes`)
}

await measureBundle('apps/client/dist/h5', 2 * 1024 * 1024, 384 * 1024)
await measureBundle('apps/client/dist/weapp', 1024 * 1024, 250 * 1024)

if (await exists('apps/client/dist/h5/index.html')) {
  const h5Index = await read('apps/client/dist/h5/index.html')
  if (/openai\.com|auth\.openai|localhost|127\.0\.0\.1/i.test(h5Index)) {
    failures.push('H5 入口含登录提供商或本地服务地址')
  }
}

const tencentBuild = await read('deploy/tencent-cloudbase/scripts/build.mjs')
const tencentHeaders = await read('deploy/tencent-cloudbase/security-headers.json')
if (!tencentBuild.includes("const assetsRoot = resolve(deployRoot, 'assets')")) {
  failures.push('腾讯 CloudBase 构建必须从自身 assets 目录读取 favicon.svg 与 robots.txt')
}
if (tencentBuild.includes('public-preview-site') || tencentBuild.includes('@openai/sites')) {
  failures.push('腾讯 CloudBase 构建不得依赖历史 Sites 包装')
}
for (const expected of [
  'Content-Security-Policy',
  'X-Content-Type-Options',
  'X-Frame-Options',
  'X-Robots-Tag',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Resource-Policy',
]) {
  if (!tencentHeaders.includes(expected)) failures.push(`腾讯 CloudBase 安全响应头缺失：${expected}`)
}
for (const expected of ['favicon.svg', 'robots.txt', 'Content-Security-Policy', 'SHA256SUMS.txt']) {
  if (!tencentBuild.includes(expected)) failures.push(`腾讯 CloudBase 构建边界缺失：${expected}`)
}

for (const relative of ['deploy', 'apps', 'packages', 'scripts']) {
  for (const file of await filesBelow(relative)) {
    const stat = await fs.stat(file)
    if (stat.size > 2 * 1024 * 1024 || !/\.(?:cjs|css|html|js|json|md|mjs|scss|ts|tsx|txt|yaml|yml)$/i.test(file)) continue
    const value = await fs.readFile(file, 'utf8')
    for (const [label, pattern] of [
      ['私钥', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
      ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
      ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
      ['OpenAI key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
    ]) {
      if (pattern.test(value)) failures.push(`${path.relative(root, file)}: 疑似包含${label}`)
    }
  }
}

for (const forbidden of ['deploy/public-preview-site', '.private', 'release']) {
  if (await exists(forbidden)) failures.push(`${forbidden}: 公开源码快照不得包含该目录`)
}

for (const relative of ['package.json', '.github/workflows/ci.yml', '.github/dependabot.yml']) {
  const value = await read(relative)
  if (value.includes('public-preview-site') || value.includes('@openai/sites')) {
    failures.push(`${relative}: 不得引用历史 Sites 包装`)
  }
}

try {
  const gitRoot = path.resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root,
    encoding: 'utf8',
  }).trim())
  if (gitRoot !== root) throw new Error('snapshot is not an independent Git repository')
  execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, stdio: 'ignore' })
  for (const relative of [
    'packages/content/src/data/content-items.json',
    'packages/content/src/data/evidence-sources.json',
    'packages/content/src/data/claim-matrix.json',
    'deploy/tencent-cloudbase/package.json',
    'deploy/tencent-cloudbase/assets/favicon.svg',
  ]) {
    try {
      const mode = execFileSync('git', ['ls-files', '-s', '--error-unmatch', relative], { cwd: root, encoding: 'utf8' }).trim().split(/\s+/)[0]
      if (mode !== '100644') failures.push(`${relative}: Git 模式应为普通文件 100644，实际为 ${mode || 'unknown'}`)
    } catch {
      failures.push(`${relative}: 已有提交的仓库必须跟踪该交付文件`)
    }
  }
} catch {
  observations.push('仓库尚无基线提交；首次发布前必须建立可追溯提交')
}

if (failures.length > 0) {
  console.error(`工业交付审计失败（${failures.length} 项）：`)
  for (const failure of failures) console.error(`- ${failure}`)
  if (observations.length > 0) console.error(`观察：\n- ${observations.join('\n- ')}`)
  process.exit(1)
}

console.log('工业交付审计通过。')
for (const observation of observations) console.log(`- ${observation}`)
