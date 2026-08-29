import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'

const workspaceRoot = resolve(import.meta.dirname, '..')
const outputRoot = resolve(workspaceRoot, 'apps/client/dist/h5')
const indexPath = resolve(outputRoot, 'index.html')
const cacheableExtensions = new Set([
  '.css', '.html', '.ico', '.jpeg', '.jpg', '.js', '.json', '.png', '.svg', '.webp',
])

async function walk(directory) {
  const files = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(fullPath))
    else files.push(fullPath)
  }
  return files
}

const files = (await walk(outputRoot))
  .filter((file) => file !== resolve(outputRoot, 'sw.js'))
  .filter((file) => cacheableExtensions.has(extname(file).toLowerCase()))
  .sort()

const digest = createHash('sha256')
for (const file of files) {
  digest.update(relative(outputRoot, file))
  digest.update(await fs.readFile(file))
}
const version = digest.digest('hex').slice(0, 16)
const assetUrls = files.map((file) => `/${relative(outputRoot, file).split(sep).join('/')}`)

const worker = `const CACHE_PREFIX = 'wuyan-h5-static-'
const CACHE_NAME = CACHE_PREFIX + '${version}'
const PRECACHE = ${JSON.stringify(assetUrls, null, 2)}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      // registration.active 只在已有旧 Worker 时存在；版本升级必须等待
      // 旧页面全部关闭，避免旧 app.js 与新动态分包在同一会话中混用。
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

await fs.writeFile(resolve(outputRoot, 'sw.js'), worker, 'utf8')

const registration = `<script data-wuyan-offline>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(function(){})})}</script>`
const currentIndex = await fs.readFile(indexPath, 'utf8')
const withoutPreviousRegistration = currentIndex.replace(/<script data-wuyan-offline>[\s\S]*?<\/script>/g, '')
const nextIndex = withoutPreviousRegistration.includes('</body>')
  ? withoutPreviousRegistration.replace('</body>', `${registration}</body>`)
  : `${withoutPreviousRegistration}${registration}`
await fs.writeFile(indexPath, nextIndex, 'utf8')

process.stdout.write(`H5 离线静态包已生成：${assetUrls.length} 个文件，缓存版本 ${version}\n`)
