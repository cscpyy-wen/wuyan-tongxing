import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const checksumPath = resolve(scriptDir, '..', 'artifacts', 'SHA256SUMS.txt')
const rawOrigin = process.argv[2]

if (!rawOrigin) {
  throw new Error('用法：npm run verify:live -- https://<CloudBase 域名>')
}

const origin = new URL(rawOrigin)
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) {
  throw new Error('线上校验地址必须是无凭据、无查询参数的 HTTPS 源站地址')
}
origin.pathname = '/'

const expectedFiles = (await readFile(checksumPath, 'utf8'))
  .trim()
  .split('\n')
  .map((line) => {
    const match = line.match(/^([a-f0-9]{64})  ([0-9A-Za-z./_-]+)$/)
    if (!match || match[2].startsWith('/') || match[2].includes('..')) {
      throw new Error(`非法校验清单行：${line}`)
    }
    return { checksum: match[1], pathname: match[2] }
  })

const expectedContentTypes = new Map([
  ['.css', 'text/css'],
  ['.html', 'text/html'],
  ['.js', 'application/javascript'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain'],
])

function expectedContentType(pathname) {
  for (const [suffix, value] of expectedContentTypes) {
    if (pathname.endsWith(suffix)) return value
  }
  throw new Error(`未配置内容类型断言：${pathname}`)
}

async function fetchFile({ checksum, pathname }) {
  const url = new URL(pathname, origin)
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status !== 200) throw new Error(`${pathname} 返回 ${response.status}`)
  if (response.url !== url.href) throw new Error(`${pathname} 最终地址异常：${response.url}`)
  const contentType = response.headers.get('content-type')?.split(';')[0]
  if (contentType !== expectedContentType(pathname)) {
    throw new Error(`${pathname} Content-Type 异常：${contentType}`)
  }
  const body = Buffer.from(await response.arrayBuffer())
  const actual = createHash('sha256').update(body).digest('hex')
  if (actual !== checksum) throw new Error(`${pathname} SHA-256 不匹配`)
  return { pathname, bytes: body.length }
}

const verified = []
for (let index = 0; index < expectedFiles.length; index += 8) {
  verified.push(...await Promise.all(expectedFiles.slice(index, index + 8).map(fetchFile)))
}

const missingUrl = new URL('__wuyan_missing_asset__.js', origin)
const missing = await fetch(missingUrl, {
  cache: 'no-store',
  redirect: 'manual',
  signal: AbortSignal.timeout(15_000),
})
if (missing.status !== 404) throw new Error(`缺失资源应返回 404，实际为 ${missing.status}`)

const indexResponse = await fetch(origin, {
  cache: 'no-store',
  redirect: 'manual',
  signal: AbortSignal.timeout(15_000),
})
if (indexResponse.status !== 200 || indexResponse.url !== origin.href) {
  throw new Error('首页存在错误状态或登录跳转')
}

const warnings = []
for (const header of [
  'content-security-policy',
  'permissions-policy',
  'referrer-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
]) {
  if (!indexResponse.headers.has(header)) warnings.push(`默认域名未返回 ${header}`)
}
const cacheControl = indexResponse.headers.get('cache-control') ?? ''
if (!/(?:^|[, ])max-age=(?:[0-9]|[1-9][0-9]|[12][0-9]{2}|300)(?:[, ]|$)/.test(cacheControl)) {
  warnings.push(`首页缓存时间高于内部测试建议值：${cacheControl || '未设置'}`)
}

const totalBytes = verified.reduce((sum, file) => sum + file.bytes, 0)
console.log(`线上制品校验通过：${verified.length} 个文件，${totalBytes} bytes，缺失资源 404，首页无跳转`)
for (const warning of warnings) console.warn(`边界提示：${warning}`)
