import { createHash } from 'node:crypto'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const deployRoot = resolve(scriptDir, '..')
const outputRoot = resolve(deployRoot, 'dist')
const artifactRoot = resolve(deployRoot, 'artifacts')

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

for (const required of ['index.html', 'sw.js', 'js/app.js', 'css/app.css', 'favicon.svg', 'robots.txt']) {
  await access(resolve(outputRoot, required))
}

const index = await readFile(resolve(outputRoot, 'index.html'), 'utf8')
const requiredIndexMarkers = [
  '<html lang="zh-CN">',
  'href="/favicon.svg"',
  'name="robots" content="noindex,nofollow,noarchive"',
  'name="referrer" content="no-referrer"',
  'http-equiv="Content-Security-Policy"',
  "navigator.serviceWorker.register('/sw.js',{scope:'/'})",
]
for (const marker of requiredIndexMarkers) {
  if (!index.includes(marker)) throw new Error(`入口缺少安全或离线标记：${marker}`)
}
if (/chatgpt\.site|openai\.com|accounts\.google\.com/i.test(index)) {
  throw new Error('入口仍包含境外托管或登录依赖')
}
if (/localhost|127\.0\.0\.1/.test(index)) throw new Error('入口包含本地地址')

const csp = index.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]
if (!csp) throw new Error('无法解析 CSP')
const cspPosition = index.indexOf('http-equiv="Content-Security-Policy"')
const firstActiveContent = Math.min(
  ...['<script', 'rel="stylesheet"'].map((marker) => {
    const position = index.indexOf(marker)
    return position === -1 ? Number.POSITIVE_INFINITY : position
  }),
)
if (cspPosition > firstActiveContent) throw new Error('CSP 必须位于所有脚本和样式表之前')
const inlineScripts = [...index.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.length > 0)
for (const script of inlineScripts) {
  const hash = `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`
  if (!csp.includes(hash)) throw new Error(`CSP 缺少内联脚本哈希：${hash}`)
}
if (csp.includes("script-src 'self' 'unsafe-inline'")) throw new Error('CSP 不得放宽内联脚本')

const serviceWorker = await readFile(resolve(outputRoot, 'sw.js'), 'utf8')
for (const pathname of ['/index.html', '/favicon.svg', '/robots.txt', '/js/app.js', '/css/app.css']) {
  if (!serviceWorker.includes(`"${pathname}"`)) throw new Error(`离线缓存缺少：${pathname}`)
}
if (!serviceWorker.includes("url.origin !== self.location.origin")) {
  throw new Error('Service Worker 未限制同源请求')
}
if (!serviceWorker.includes("new Request(url, { cache: 'reload' })")) {
  throw new Error('Service Worker 升级预缓存必须绕过旧 HTTP 缓存')
}

const allowedPath = /^(?:index\.html|sw\.js|favicon\.svg|robots\.txt|(?:js|chunk)\/[0-9a-z.-]+\.js(?:\.LICENSE\.txt)?|css\/[0-9a-z.-]+\.css)$/i
const forbiddenContent = /chatgpt\.site|openai\.com|accounts\.google\.com|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKID[A-Za-z0-9]{13,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bsk-[A-Za-z0-9_-]{20,}\b/i

const expectedSums = (await readFile(resolve(artifactRoot, 'SHA256SUMS.txt'), 'utf8'))
  .trim()
  .split('\n')
const files = (await listFiles(outputRoot)).sort()
if (files.length !== expectedSums.length) throw new Error('校验清单文件数量不匹配')
for (let index = 0; index < files.length; index += 1) {
  const file = files[index]
  const pathname = relative(outputRoot, file).split(sep).join('/')
  if (!allowedPath.test(pathname)) throw new Error(`产物包含未允许的文件：${pathname}`)
  const body = await readFile(file)
  if (body.length > 1_048_576) throw new Error(`单文件超过 1 MiB 门禁：${pathname}`)
  if (forbiddenContent.test(body.toString('utf8'))) throw new Error(`产物命中秘密或境外登录依赖模式：${pathname}`)
  const checksum = createHash('sha256').update(await readFile(file)).digest('hex')
  if (expectedSums[index] !== `${checksum}  ${pathname}`) {
    throw new Error(`校验和不匹配：${pathname}`)
  }
}

const resolvedHeaders = JSON.parse(
  await readFile(resolve(artifactRoot, 'resolved-security-headers.json'), 'utf8'),
)
const expectedHeaders = {
  'Content-Security-Policy': csp.replace("; form-action 'self'", "; frame-ancestors 'none'; form-action 'self'"),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}
for (const [header, expected] of Object.entries(expectedHeaders)) {
  if (resolvedHeaders[header] !== expected) throw new Error(`响应头参考不匹配：${header}`)
}
if (resolvedHeaders['Content-Security-Policy'].includes('{{')) {
  throw new Error('响应头参考仍包含未解析变量')
}
if (Object.keys(resolvedHeaders).length !== Object.keys(expectedHeaders).length) {
  throw new Error('响应头参考包含未审核的额外字段')
}

console.log(`腾讯 CloudBase H5 包验证通过：${files.length} 个文件，免登录根路径部署`)
