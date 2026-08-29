import { createHash } from 'node:crypto'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(scriptDir, '..', 'www')

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const pathname = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(pathname))
    else if (entry.isFile()) files.push(pathname)
  }
  return files
}

for (const pathname of ['index.html', 'js/app.js', 'css/app.css', 'android-assets.json']) {
  await access(resolve(webRoot, pathname))
}
try {
  await access(resolve(webRoot, 'sw.js'))
  throw new Error('Android 包不得包含 sw.js')
} catch (error) {
  if (error?.message === 'Android 包不得包含 sw.js') throw error
}

const index = await readFile(resolve(webRoot, 'index.html'), 'utf8')
for (const marker of [
  'name="wuyan-runtime" content="android-local"',
  'http-equiv="Content-Security-Policy"',
  'name="referrer" content="no-referrer"',
  'src="/js/app.js"',
  'href="/css/app.css"',
  'data-wuyan-android-bootstrap',
  'id="wuyan-android-bootstrap"',
  'aria-label="正在读取本机记录"',
  'href="#/pages/sos/index"',
  'id="wuyan-bootstrap-begin"',
  'id="wuyan-bootstrap-sheet"',
  'src="/android-bootstrap-runtime.js"',
  '<div id="app"></div>',
]) {
  if (!index.includes(marker)) throw new Error(`Android 入口缺少：${marker}`)
}
if (/serviceWorker|data-wuyan-offline|chatgpt\.site|openai\.com|tcloudbaseapp\.com/i.test(index)) {
  throw new Error('Android 入口仍包含 Service Worker 或远程托管依赖')
}
if (index.indexOf('id="wuyan-android-bootstrap"') > index.indexOf('<div id="app"></div>')) {
  throw new Error('Android 启动骨架必须位于 React 根节点之外并先于根节点')
}
if (index.indexOf('http-equiv="Content-Security-Policy"') > index.indexOf('<script')) {
  throw new Error('Android CSP 必须位于所有脚本之前')
}
const bootstrapScriptIndex = index.indexOf('src="/android-bootstrap-runtime.js"')
const applicationScriptIndexes = [...index.matchAll(/src="\/js\/[^"?]+\.js"/gu)]
  .map((match) => match.index)
  .filter((value) => value !== undefined)
if (applicationScriptIndexes.length === 0 || applicationScriptIndexes.some((value) => value < bootstrapScriptIndex)) {
  throw new Error('Android 快速记录运行时必须先于 React/Taro 入口执行')
}
if (!/<script\s+defer\s+src="\/android-bootstrap-runtime\.js"><\/script>/u.test(index)) {
  throw new Error('Android 快速记录运行时必须以 defer 脚本加载')
}

const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/iu.exec(index)?.[1]
if (!csp) throw new Error('Android CSP 无法解析')
const scriptDirective = csp.split(';').map((directive) => directive.trim())
  .find((directive) => /^script-src\s/iu.test(directive))
if (!scriptDirective) throw new Error('Android CSP 缺少 script-src')
const declaredHashes = new Set(scriptDirective.split(/\s+/u).filter((token) => /^'sha256-/u.test(token)))
const expectedHashes = new Set(
  [...index.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)]
    .filter((match) => !/\bsrc\s*=/iu.test(match[1] ?? ''))
    .map((match) => `'sha256-${createHash('sha256').update(match[2] ?? '', 'utf8').digest('base64')}'`),
)
if (
  declaredHashes.size !== expectedHashes.size
  || [...expectedHashes].some((hash) => !declaredHashes.has(hash))
) {
  throw new Error('Android CSP 内联脚本哈希必须与最终入口精确一致')
}

const bootstrapRuntimeBytes = await readFile(resolve(webRoot, 'android-bootstrap-runtime.js'))
const bootstrapSourceBytes = await readFile(resolve(scriptDir, 'android-bootstrap-runtime.js'))
if (!bootstrapRuntimeBytes.equals(bootstrapSourceBytes)) {
  throw new Error('Android 打包运行时与版本化源文件不一致，请重新执行 prepare:web')
}
const bootstrapRuntime = bootstrapRuntimeBytes.toString('utf8')
for (const marker of [
  'wuyan-tongxing/android-bootstrap-cigarettes/v1',
  'wuyan:bootstrap-cigarette',
  'wuyanBootstrapBusy',
  'localStorage.setItem',
]) {
  if (!bootstrapRuntime.includes(marker)) throw new Error(`Android 快速记录运行时缺少：${marker}`)
}
if (/https?:\/\//iu.test(bootstrapRuntime)) throw new Error('Android 快速记录运行时不得包含远程 URL')

const assetManifest = JSON.parse(await readFile(resolve(webRoot, 'android-assets.json'), 'utf8'))
if (assetManifest.runtime !== 'capacitor-android-local' || assetManifest.serviceWorker !== false) {
  throw new Error('Android 资源清单运行时边界错误')
}
const expected = new Map(assetManifest.files.map((entry) => [entry.pathname, entry]))
const files = (await listFiles(webRoot)).filter((file) => !file.endsWith('android-assets.json'))
if (files.length !== expected.size) throw new Error('Android 资源清单数量不匹配')
for (const file of files) {
  const pathname = relative(webRoot, file).split(sep).join('/')
  const entry = expected.get(pathname)
  if (!entry) throw new Error(`Android 资源未列入清单：${pathname}`)
  const body = await readFile(file)
  const checksum = createHash('sha256').update(body).digest('hex')
  if (body.length !== entry.bytes || checksum !== entry.sha256) {
    throw new Error(`Android 资源校验失败：${pathname}`)
  }
}

console.log(`Android 本地 Web 资源验证通过：${files.length} 个应用文件，免登录、无远程运行依赖`)
