import { createHash } from 'node:crypto'
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const deployRoot = resolve(scriptDir, '..')
const repoRoot = resolve(deployRoot, '..', '..')
const sourceRoot = resolve(repoRoot, 'apps', 'client', 'dist', 'h5')
const outputRoot = resolve(deployRoot, 'dist')
const artifactRoot = resolve(deployRoot, 'artifacts')
const assetsRoot = resolve(deployRoot, 'assets')

for (const required of ['index.html', 'sw.js', 'js/app.js', 'css/app.css']) {
  await access(resolve(sourceRoot, required))
}
if (relative(deployRoot, outputRoot) !== 'dist') {
  throw new Error('拒绝清理非预期构建目录')
}

await rm(outputRoot, { recursive: true, force: true })
await rm(artifactRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })
await mkdir(artifactRoot, { recursive: true })
await cp(sourceRoot, outputRoot, { recursive: true })

async function copyCanonicalText(source, destination) {
  const value = await readFile(source, 'utf8')
  await writeFile(destination, value.replace(/\r\n?/g, '\n'), 'utf8')
}

await copyCanonicalText(resolve(assetsRoot, 'favicon.svg'), resolve(outputRoot, 'favicon.svg'))
await copyCanonicalText(resolve(assetsRoot, 'robots.txt'), resolve(outputRoot, 'robots.txt'))

function insertBeforeHead(html, value) {
  if (!html.includes('</head>')) throw new Error('H5 入口缺少 </head>')
  return html.replace('</head>', `${value}</head>`)
}

function insertAfterCharset(html, value) {
  const charset = /<meta\s+charset=["'][^"']+["']\s*\/?>/i.exec(html)
  if (!charset || charset.index === undefined) throw new Error('H5 入口缺少 charset 声明')
  const end = charset.index + charset[0].length
  return `${html.slice(0, end)}${value}${html.slice(end)}`
}

let index = await readFile(resolve(outputRoot, 'index.html'), 'utf8')
index = index
  .replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*\/?\s*>/gi, '')
  .replace(/<meta\s+name=["']robots["'][^>]*\/?\s*>/gi, '')
  .replace(/<meta\s+name=["']referrer["'][^>]*\/?\s*>/gi, '')
  .replace(/<link\s+rel=["']icon["'][^>]*\/?\s*>/gi, '')

index = insertBeforeHead(index, '<link rel="icon" href="/favicon.svg" type="image/svg+xml"/>')
index = insertBeforeHead(index, '<meta name="robots" content="noindex,nofollow,noarchive"/>')
index = insertBeforeHead(index, '<meta name="referrer" content="no-referrer"/>')

const inlineScripts = [...index.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.length > 0)
if (inlineScripts.length === 0) throw new Error('未找到需要纳入 CSP 的内联启动脚本')

const inlineScriptHashes = inlineScripts.map((script) => (
  `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`
))
const metaContentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' ${inlineScriptHashes.join(' ')}`,
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')
index = insertAfterCharset(
  index,
  `<meta http-equiv="Content-Security-Policy" content="${metaContentSecurityPolicy}"/>`,
)
await writeFile(resolve(outputRoot, 'index.html'), index, 'utf8')

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

const cacheableExtensions = new Set(['.css', '.html', '.js', '.json', '.svg', '.txt'])
const precacheFiles = (await listFiles(outputRoot))
  .filter((file) => file !== resolve(outputRoot, 'sw.js'))
  .filter((file) => cacheableExtensions.has(extname(file).toLowerCase()))
  .sort()
const precache = precacheFiles.map((file) => (
  `/${relative(outputRoot, file).split(sep).join('/')}`
))
const versionDigest = createHash('sha256')
for (const file of precacheFiles) {
  versionDigest.update(relative(outputRoot, file).split(sep).join('/'))
  versionDigest.update(await readFile(file))
}
const cacheVersion = versionDigest.digest('hex').slice(0, 16)
const serviceWorker = `const CACHE_PREFIX = 'wuyan-h5-static-'
const CACHE_NAME = CACHE_PREFIX + '${cacheVersion}'
const PRECACHE = ${JSON.stringify(precache, null, 2)}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.registration.active ? undefined : self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (request.mode === 'navigate') {
    event.respondWith(caches.match('/index.html').then((cached) => cached || fetch(request)))
    return
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)))
})
`
await writeFile(resolve(outputRoot, 'sw.js'), serviceWorker, 'utf8')

const headerTemplate = JSON.parse(await readFile(resolve(deployRoot, 'security-headers.json'), 'utf8'))
headerTemplate['Content-Security-Policy'] = headerTemplate['Content-Security-Policy']
  .replace('{{INLINE_SCRIPT_HASHES}}', inlineScriptHashes.join(' '))
await writeFile(
  resolve(artifactRoot, 'resolved-security-headers.json'),
  `${JSON.stringify(headerTemplate, null, 2)}\n`,
  'utf8',
)

const checksums = []
for (const file of (await listFiles(outputRoot)).sort()) {
  const pathname = relative(outputRoot, file).split(sep).join('/')
  const checksum = createHash('sha256').update(await readFile(file)).digest('hex')
  checksums.push(`${checksum}  ${pathname}`)
}
await writeFile(resolve(artifactRoot, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`, 'utf8')

console.log(`腾讯 CloudBase H5 包已生成：${checksums.length} 个文件，离线缓存 ${cacheVersion}`)
