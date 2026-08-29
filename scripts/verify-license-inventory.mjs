import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function requireComponents(document, label) {
  if (!Array.isArray(document?.components) || document.components.length === 0) {
    throw new Error(`${label} 缺少非空 components 明细`)
  }
  return document.components
}

function indexByPurl(components, label) {
  const index = new Map()
  const duplicates = new Set()
  const missing = []
  for (const [position, component] of components.entries()) {
    const purl = typeof component?.purl === 'string' ? component.purl.trim() : ''
    if (!purl) {
      missing.push(position)
      continue
    }
    if (index.has(purl)) duplicates.add(purl)
    else index.set(purl, component)
  }
  if (missing.length > 0) throw new Error(`${label} 组件缺少 purl：索引 ${missing.join(', ')}`)
  if (duplicates.size > 0) throw new Error(`${label} 存在重复 purl：${[...duplicates].sort().join(', ')}`)
  return index
}

function requireLicenses(index, label) {
  const missing = [...index]
    .filter(([, component]) => !Array.isArray(component.licenses) || component.licenses.length === 0)
    .map(([purl]) => purl)
    .sort()
  if (missing.length > 0) throw new Error(`${label} 组件缺少许可证声明：${missing.join(', ')}`)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).sort().join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function exactSetDifference(left, right) {
  return [...left.keys()].filter((purl) => !right.has(purl)).sort()
}

export function validateLicenseInventory(sbom, inventory) {
  const sbomIndex = indexByPurl(requireComponents(sbom, 'SBOM'), 'SBOM')
  const inventoryIndex = indexByPurl(requireComponents(inventory, '许可证清单'), '许可证清单')
  requireLicenses(sbomIndex, 'SBOM')
  requireLicenses(inventoryIndex, '许可证清单')

  const sbomOnly = exactSetDifference(sbomIndex, inventoryIndex)
  const inventoryOnly = exactSetDifference(inventoryIndex, sbomIndex)
  if (sbomOnly.length > 0 || inventoryOnly.length > 0) {
    throw new Error(`SBOM/许可证清单 purl 集合不一致：仅 SBOM [${sbomOnly.join(', ')}]；仅许可证清单 [${inventoryOnly.join(', ')}]`)
  }

  const licenseMismatches = [...sbomIndex]
    .filter(([purl, component]) => stableJson(component.licenses) !== stableJson(inventoryIndex.get(purl).licenses))
    .map(([purl]) => purl)
    .sort()
  if (licenseMismatches.length > 0) {
    throw new Error(`SBOM/许可证清单的许可证声明不一致：${licenseMismatches.join(', ')}`)
  }

  const expectedSummary = {
    componentCount: inventoryIndex.size,
    npmComponentCount: [...inventoryIndex.keys()].filter((purl) => purl.startsWith('pkg:npm/')).length,
    mavenComponentCount: [...inventoryIndex.keys()].filter((purl) => purl.startsWith('pkg:maven/')).length,
    componentsWithDeclaredLicense: inventoryIndex.size,
    componentsWithoutDeclaredLicense: 0,
  }
  for (const [field, expected] of Object.entries(expectedSummary)) {
    if (inventory?.summary?.[field] !== expected) {
      throw new Error(`许可证清单 summary.${field} 不真实：期望 ${expected}，实际 ${inventory?.summary?.[field] ?? '<missing>'}`)
    }
  }
  return expectedSummary
}

export async function verifyLicenseInventoryFiles(options = {}) {
  const root = path.resolve(options.root ?? defaultRoot)
  const sbomPath = path.resolve(options.sbomPath ?? path.join(root, 'docs', 'sbom.cdx.json'))
  const inventoryPath = path.resolve(options.inventoryPath ?? path.join(root, 'docs', 'third-party-licenses.json'))
  const [sbom, inventory] = await Promise.all([
    fs.readFile(sbomPath, 'utf8').then(JSON.parse),
    fs.readFile(inventoryPath, 'utf8').then(JSON.parse),
  ])
  return validateLicenseInventory(sbom, inventory)
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  const summary = await verifyLicenseInventoryFiles()
  console.log(`许可证清单验证通过：${summary.componentCount} 个 purl（npm ${summary.npmComponentCount}，Maven ${summary.mavenComponentCount}），双向集合、许可证声明与汇总精确一致。`)
}
