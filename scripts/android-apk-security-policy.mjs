import { createHash } from 'node:crypto'

const requiredCsp = new Map([
  ['default-src', ["'self'"]],
  ['script-src-attr', ["'none'"]],
  ['style-src', ["'self'", "'unsafe-inline'"]],
  ['img-src', ["'self'", 'data:', 'blob:']],
  ['font-src', ["'self'", 'data:']],
  ['connect-src', ["'self'"]],
  ['worker-src', ["'self'"]],
  ['manifest-src', ["'self'"]],
  ['object-src', ["'none'"]],
  ['base-uri', ["'none'"]],
  ['form-action', ["'self'"]],
])

function sameTokens(actual, expected) {
  return actual.length === expected.length && expected.every((token) => actual.includes(token))
}

function htmlAttributes(tag) {
  const attributes = new Map()
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gis)) {
    attributes.set(match[1].toLowerCase(), match[3])
  }
  return attributes
}

export function assertStrictAndroidCsp(index) {
  if (typeof index !== 'string') throw new Error('APK Android 入口不是文本')
  const cspTags = [...index.matchAll(/<meta\b[^>]*>/gis)].filter((match) => (
    htmlAttributes(match[0]).get('http-equiv')?.toLowerCase() === 'content-security-policy'
  ))
  if (cspTags.length !== 1) throw new Error(`APK Android 入口必须且只能包含一个 CSP meta，实际 ${cspTags.length}`)
  const firstScript = index.search(/<script\b/i)
  if (firstScript >= 0 && cspTags[0].index > firstScript) throw new Error('APK Android 入口 CSP 未在脚本前生效')

  const policy = htmlAttributes(cspTags[0][0]).get('content')
  if (!policy) throw new Error('APK Android 入口 CSP 缺少 content')
  const directives = new Map()
  for (const rawDirective of policy.split(';')) {
    const tokens = rawDirective.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const name = tokens.shift().toLowerCase()
    if (directives.has(name)) throw new Error(`APK Android CSP 指令重复：${name}`)
    directives.set(name, tokens)
  }

  for (const [name, expected] of requiredCsp) {
    const actual = directives.get(name)
    if (!actual || !sameTokens(actual, expected)) {
      throw new Error(`APK Android CSP ${name} 必须精确为：${expected.join(' ')}`)
    }
  }
  const scripts = directives.get('script-src')
  if (!scripts?.includes("'self'")) throw new Error("APK Android CSP script-src 必须包含 'self'")
  const hashes = scripts.filter((token) => /^'sha256-[A-Za-z0-9+/]+={0,2}'$/.test(token))
  if (hashes.length === 0 || scripts.length !== hashes.length + 1) {
    throw new Error("APK Android CSP script-src 只允许 'self' 和至少一个 sha256 内联脚本哈希")
  }
  const expectedHashes = new Set(
    [...index.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gis)]
      .filter((match) => !/\bsrc\s*=/i.test(match[1] ?? ''))
      .map((match) => `'sha256-${createHash('sha256').update(match[2] ?? '', 'utf8').digest('base64')}'`),
  )
  if (
    hashes.length !== expectedHashes.size
    || hashes.some((hash) => !expectedHashes.has(hash))
  ) throw new Error('APK Android CSP 内联脚本哈希与最终 HTML 不精确一致')
  const allowedNames = new Set([...requiredCsp.keys(), 'script-src'])
  const unexpected = [...directives.keys()].filter((name) => !allowedNames.has(name))
  if (unexpected.length > 0) throw new Error(`APK Android CSP 包含未批准指令：${unexpected.join(', ')}`)
  return { directiveCount: directives.size, inlineScriptHashCount: hashes.length }
}

export function assertBinaryManifestSecurity(xmltree) {
  if (typeof xmltree !== 'string' || !/^\s*E: manifest\b/m.test(xmltree)) {
    throw new Error('无法解析 APK 二进制 AndroidManifest.xml')
  }
  const lines = xmltree.split(/\r?\n/)
  const applicationIndex = lines.findIndex((line) => /^\s*E: application\b/.test(line))
  if (applicationIndex < 0) throw new Error('APK 二进制 manifest 缺少 application')
  const attributes = []
  for (let index = applicationIndex + 1; index < lines.length; index += 1) {
    if (/^\s*E: /.test(lines[index])) break
    if (/^\s*A: /.test(lines[index])) attributes.push(lines[index])
  }
  const debuggable = attributes.find((line) => /:debuggable(?:\(|=)/.test(line))
  if (debuggable && !/(?:=false\b|=0x0+\b)/i.test(debuggable)) {
    throw new Error('APK 二进制 manifest 的 application debuggable 不是 false')
  }
  const cleartext = attributes.find((line) => /:usesCleartextTraffic(?:\(|=)/.test(line))
  if (!cleartext || !/(?:=false\b|=0x0+\b)/i.test(cleartext)) {
    throw new Error('APK 二进制 manifest 必须显式设置 usesCleartextTraffic=false')
  }
  return {
    debuggable: false,
    debuggableEvidence: debuggable ? 'explicit-false' : 'platform-default-false',
    usesCleartextTraffic: false,
  }
}

export function assertCapacitorRuntimeSecurity(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('APK 内 Capacitor 配置格式错误')
  if (config.loggingBehavior !== 'none' || config.android?.loggingBehavior !== 'none') {
    throw new Error('APK 内 Capacitor loggingBehavior 必须在根级与 Android 级均为 none')
  }
  if (config.android?.webContentsDebuggingEnabled !== false) {
    throw new Error('APK 内 Capacitor webContentsDebuggingEnabled 必须显式为 false')
  }
  if (
    config.android?.allowMixedContent !== false
    || config.android?.useLegacyBridge !== false
    || config.android?.resolveServiceWorkerRequests !== false
    || config.server?.cleartext !== false
  ) throw new Error('APK 内 Capacitor 混合内容、旧桥接、Service Worker 或明文边界未失败关闭')
  if (config.server?.url) throw new Error('APK 内 Capacitor 配置不得包含远程 server.url')
  if (config.server?.hostname !== 'localhost' || config.server?.androidScheme !== 'https') {
    throw new Error('APK 内 Capacitor 本地 origin 必须固定为 https://localhost')
  }
  if (!Array.isArray(config.server?.allowNavigation) || config.server.allowNavigation.length !== 0) {
    throw new Error('APK 内 Capacitor allowNavigation 必须显式为空数组')
  }
  return { webContentsDebuggingEnabled: false, loggingBehavior: 'none' }
}
