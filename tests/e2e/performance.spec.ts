import { expect, test } from '@playwright/test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const ENTRY_GZIP_BUDGET_BYTES = 160 * 1024
const TODAY_FIRST_SCREEN_GZIP_BUDGET_BYTES = 180 * 1024
const TODAY_ROUTE = 'pages/today/index'
const FULL_CONTENT_FIELD_SENTINELS = ['body', 'steps', 'riskStatement', 'evidenceIds', 'mechanisms'] as const

function directorySize(directory: string): number {
  return readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const path = resolve(directory, entry.name)
    return total + (entry.isDirectory() ? directorySize(path) : statSync(path).size)
  }, 0)
}

function artifactFiles(directory: string, root = directory): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return artifactFiles(path, root)
    return [relative(root, path).replaceAll('\\', '/')]
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function routePattern(route: string): RegExp {
  return new RegExp(`(?:["']path["']|\\bpath)\\s*:\\s*["']${escapeRegExp(route)}["']`)
}

function routeChunkIds(entrySource: string, route: string): string[] {
  const marker = routePattern(route).exec(entrySource)
  if (!marker || marker.index === undefined) throw new Error(`生产入口中找不到路由：${route}`)

  const nextRoute = /(?:["']path["']|\bpath)\s*:\s*["'][^"']+["']/g
  nextRoute.lastIndex = marker.index + marker[0].length
  const nextMarker = nextRoute.exec(entrySource)
  const loaderSource = entrySource.slice(marker.index, nextMarker?.index ?? entrySource.length)
  const ids = [...loaderSource.matchAll(/\.e\(\s*(?:["']([^"']+)["']|(\d+))\s*\)/g)]
    .map((match) => match[1] ?? match[2])
    .filter((id): id is string => Boolean(id))

  if (ids.length === 0) throw new Error(`路由 ${route} 的生产 loader 未声明任何动态 chunk`)
  return [...new Set(ids)]
}

function gzipSize(h5Root: string, assets: string[]): number {
  return assets.reduce((total, asset) => total + gzipSync(readFileSync(resolve(h5Root, asset))).length, 0)
}

function kibibytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`
}

test('移动端发布包保持明确的入口、Today 首屏闭包与小程序体积预算', ({}, testInfo) => {
  const h5Root = resolve(process.cwd(), 'apps/client/dist/h5')
  const index = readFileSync(resolve(h5Root, 'index.html'), 'utf8')
  const entryAssets = [...new Set(
    [...index.matchAll(/(?:src|href)=["']([^"'?#]+)(?:[?#][^"']*)?["']/g)]
      .map((match) => match[1]?.replace(/^\//, ''))
      .filter((path): path is string => Boolean(path && /^(?:js|css)\/.+\.(?:js|css)$/.test(path))),
  )]
  expect(entryAssets.length, 'index.html 应声明生产入口 JS/CSS').toBeGreaterThanOrEqual(3)

  const routeEntry = entryAssets
    .filter((asset) => asset.endsWith('.js'))
    .map((asset) => ({ asset, source: readFileSync(resolve(h5Root, asset), 'utf8') }))
    .find(({ source }) => routePattern(TODAY_ROUTE).test(source))
  expect(routeEntry, `入口 JS 应包含 ${TODAY_ROUTE} 的生产路由 loader`).toBeDefined()

  const chunkIds = routeChunkIds(routeEntry!.source, TODAY_ROUTE)
  const allArtifacts = artifactFiles(h5Root)
  const todayRouteAssets = [...new Set(chunkIds.flatMap((id) => {
    const suffix = new RegExp(`(?:^|/)${escapeRegExp(id)}\\.(?:js|css)$`)
    return allArtifacts.filter((asset) => suffix.test(asset))
  }))]

  for (const id of chunkIds) {
    expect(
      todayRouteAssets.some((asset) => asset.endsWith(`/${id}.js`) || asset === `${id}.js`),
      `Today loader 声明的 chunk ${id} 必须解析到生产 JS 制品`,
    ).toBe(true)
  }

  const entryGzipBytes = gzipSize(h5Root, entryAssets)
  const todayFirstScreenAssets = [...new Set([...entryAssets, ...todayRouteAssets])]
  const todayFirstScreenGzipBytes = gzipSize(h5Root, todayFirstScreenAssets)
  const metrics = [
    `entry-only=${kibibytes(entryGzipBytes)} [${entryAssets.join(', ')}]`,
    `Today-first-screen=${kibibytes(todayFirstScreenGzipBytes)} [${todayFirstScreenAssets.join(', ')}]`,
  ]
  console.info(`[performance] ${metrics.join('; ')}`)
  testInfo.annotations.push({ type: 'H5 gzip', description: metrics.join('; ') })

  expect(entryGzipBytes, 'H5 entry-only gzip 总量应不超过 160 KiB')
    .toBeLessThanOrEqual(ENTRY_GZIP_BUDGET_BYTES)
  expect(todayFirstScreenGzipBytes, 'H5 Today-first-screen（entry + 路由动态 JS/CSS）gzip 总量应不超过 180 KiB')
    .toBeLessThanOrEqual(TODAY_FIRST_SCREEN_GZIP_BUDGET_BYTES)

  const todayRouteJavascript = todayRouteAssets
    .filter((asset) => asset.endsWith('.js'))
    .map((asset) => readFileSync(resolve(h5Root, asset), 'utf8'))
    .join('\n')
  for (const field of FULL_CONTENT_FIELD_SENTINELS) {
    expect(
      todayRouteJavascript,
      `Today 动态 chunk 不得包含完整 73 条内容目录字段 ${field}`,
    ).not.toMatch(new RegExp(`(?:["']${field}["']|\\b${field})\\s*:`))
  }

  const weappBytes = directorySize(resolve(process.cwd(), 'apps/client/dist/weapp'))
  expect(weappBytes, '微信小程序候选包应显著低于 2 MiB 主包上限').toBeLessThanOrEqual(1.5 * 1024 * 1024)
})
