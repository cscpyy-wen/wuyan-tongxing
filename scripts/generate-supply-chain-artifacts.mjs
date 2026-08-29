import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { cyclonedxLicense } from './spdx-license-expression.mjs'
import { reviewedOptionalPlatformLicense } from './supply-chain-license-policy.mjs'
import { validateLicenseInventory } from './verify-license-inventory.mjs'
import { verifyGradleWrapper } from './verify-gradle-wrapper.mjs'

const root = path.resolve(import.meta.dirname, '..')
const docs = path.join(root, 'docs')
const androidRoot = path.join(root, 'apps', 'android-shell', 'android')
const gradleWrapper = path.join(androidRoot, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
const version = JSON.parse(await fs.readFile(path.join(root, 'apps', 'android-shell', 'personal-version.json'), 'utf8'))
await verifyGradleWrapper(root)

function runPnpm(args) {
  const pnpmCli = process.env.npm_execpath
  if (!pnpmCli) throw new Error('请通过 pnpm supply-chain 运行此脚本')
  return execFileSync(process.execPath, [pnpmCli, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

async function exists(pathname) {
  try {
    await fs.stat(pathname)
    return true
  } catch {
    return false
  }
}

function commandInvocation(executable, args) {
  if (process.platform !== 'win32' || !/\.(?:bat|cmd)$/i.test(executable)) {
    return { executable, args, shell: false }
  }
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`
  return { executable: [quote(executable), ...args.map(quote)].join(' '), args: [], shell: true }
}

async function resolvedGradleModules() {
  const repositoryJdk = path.join(root, '.toolchains', 'jdk-21')
  const repositorySdk = path.join(root, '.toolchains', 'android-sdk')
  const javaHome = await exists(path.join(repositoryJdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))
    ? repositoryJdk
    : process.env.JAVA_HOME
  const androidSdk = await exists(path.join(repositorySdk, 'platforms', 'android-36', 'android.jar'))
    ? repositorySdk
    : process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
  if (!javaHome || !androidSdk) throw new Error('生成 Android SBOM 需要 JDK 21 与 Android SDK 36')

  const invocation = commandInvocation(gradleWrapper, [
    '--no-daemon',
    '--dependency-verification',
    'strict',
    '-q',
    ':app:printReleaseRuntimeDependencies',
  ])
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: androidRoot,
    env: {
      ...process.env,
      JAVA_HOME: javaHome,
      ANDROID_HOME: androidSdk,
      ANDROID_SDK_ROOT: androidSdk,
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: invocation.shell,
    windowsHide: true,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error) throw new Error(`Gradle 依赖解析启动失败：${result.error.message}`)
  if (result.status !== 0) throw new Error(`Gradle 依赖解析失败（${result.status}）\n${output.trim()}`)
  const marker = [...output.matchAll(/^WUYAN_GRADLE_DEPENDENCIES=(.+)$/gm)].at(-1)?.[1]
  if (!marker) throw new Error('Gradle 未输出可解析的 releaseRuntimeClasspath 依赖清单')
  const modules = JSON.parse(marker)
  if (!Array.isArray(modules)) throw new Error('Gradle release 依赖清单格式错误')
  return modules
}

function purlName(name) {
  if (!name.startsWith('@')) return encodeURIComponent(name)
  const [scope, packageName] = name.split('/')
  return `${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}`
}

function stableUuid(input) {
  const bytes = Buffer.from(createHash('sha256').update(input).digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function packageIdentityFromLockKey(lockKey) {
  const separator = lockKey.lastIndexOf('@')
  if (separator <= 0) return null
  const name = lockKey.slice(0, separator)
  const componentVersion = lockKey.slice(separator + 1).replace(/\(.+$/, '')
  return name && componentVersion ? `${name}@${componentVersion}` : null
}

function cyclonedxHashFromIntegrity(integrity) {
  if (typeof integrity !== 'string') return null
  const token = integrity.split(/\s+/).find((item) => /^sha(?:256|384|512)-/i.test(item))
  const matched = /^sha(256|384|512)-([^?]+)$/i.exec(token ?? '')
  if (!matched) return null
  const bytes = Buffer.from(matched[2], 'base64')
  if (bytes.length * 8 !== Number(matched[1])) return null
  return { alg: `SHA-${matched[1]}`, content: bytes.toString('hex') }
}

async function packageJsonLicense(packagePath) {
  if (typeof packagePath !== 'string') return null
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(packagePath, 'package.json'), 'utf8'))
    const raw = typeof packageJson.license === 'string'
      ? packageJson.license
      : typeof packageJson.license?.type === 'string'
        ? packageJson.license.type
        : null
    return raw ? cyclonedxLicense(raw) : null
  } catch {
    return null
  }
}

function decodeXml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .trim()
}

function xmlTag(block, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block)
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, '')) : null
}

async function listFiles(directory) {
  const files = []
  if (!await exists(directory)) return files
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const pathname = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(pathname))
    else if (entry.isFile()) files.push(pathname)
  }
  return files
}

async function mavenPomMetadata(module, seen = new Set()) {
  const coordinates = `${module.group}:${module.name}:${module.version}`
  if (seen.has(coordinates)) return { licenses: [], pomSha256: null }
  seen.add(coordinates)
  const gradleCache = process.env.GRADLE_USER_HOME
    ? path.resolve(process.env.GRADLE_USER_HOME)
    : path.join(homedir(), '.gradle')
  const componentRoot = path.join(
    gradleCache,
    'caches',
    'modules-2',
    'files-2.1',
    module.group,
    module.name,
    module.version,
  )
  const pomPath = (await listFiles(componentRoot))
    .find((pathname) => path.basename(pathname) === `${module.name}-${module.version}.pom`)
  if (!pomPath) return { licenses: [], pomSha256: null }
  const pomBytes = await fs.readFile(pomPath)
  const xml = pomBytes.toString('utf8')
  const licensesBlock = /<licenses(?:\s[^>]*)?>([\s\S]*?)<\/licenses>/i.exec(xml)?.[1] ?? ''
  let licenses = [...licensesBlock.matchAll(/<license(?:\s[^>]*)?>([\s\S]*?)<\/license>/gi)]
    .flatMap((match) => {
      const name = xmlTag(match[1], 'name')
      const url = xmlTag(match[1], 'url')
      const parsed = cyclonedxLicense(name, url)
      return parsed ? [parsed] : []
    })
  if (licenses.length === 0) {
    const parentBlock = /<parent(?:\s[^>]*)?>([\s\S]*?)<\/parent>/i.exec(xml)?.[1]
    const parent = parentBlock ? {
      group: xmlTag(parentBlock, 'groupId'),
      name: xmlTag(parentBlock, 'artifactId'),
      version: xmlTag(parentBlock, 'version'),
    } : null
    if (parent?.group && parent.name && parent.version) {
      licenses = (await mavenPomMetadata(parent, seen)).licenses
    }
  }
  return {
    licenses,
    pomSha256: createHash('sha256').update(pomBytes).digest('hex'),
  }
}

const lockfile = await fs.readFile(path.join(root, 'pnpm-lock.yaml'))
const lockDocument = parseYaml(lockfile.toString('utf8'))
const npmIntegrityByComponent = new Map()
for (const [lockKey, entry] of Object.entries(lockDocument?.packages ?? {})) {
  const identity = packageIdentityFromLockKey(lockKey)
  const hash = cyclonedxHashFromIntegrity(entry?.resolution?.integrity)
  if (identity && hash) npmIntegrityByComponent.set(identity, hash)
}

const rawLicenses = JSON.parse(runPnpm(['licenses', 'list', '--prod', '--json']))
const normalizedLicenses = Object.fromEntries(Object.entries(rawLicenses)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([license, entries]) => [license, entries
    .map((entry) => ({
      name: entry.name,
      versions: [...entry.versions].sort(),
      license: entry.license,
      ...(entry.author ? { author: entry.author } : {}),
      ...(entry.homepage ? { homepage: entry.homepage } : {}),
      ...(entry.description ? { description: entry.description } : {}),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))]))

const licenseByComponent = new Map()
for (const [license, entries] of Object.entries(normalizedLicenses)) {
  for (const entry of entries) {
    for (const componentVersion of entry.versions) licenseByComponent.set(`${entry.name}@${componentVersion}`, license)
  }
}

const reviewedExactLicenseOverrides = new Map([
  // fsevents is a Darwin-only optional package and is not materialized by pnpm on Windows.
  // The exact npm version document at https://registry.npmjs.org/fsevents/2.3.3 declares MIT.
  // Keep this exact-version override fail-closed so a dependency upgrade requires fresh review.
  ['fsevents@2.3.3', 'MIT'],
])

const workspaceTrees = JSON.parse(runPnpm(['list', '-r', '--prod', '--depth', 'Infinity', '--json']))
const components = new Map()

async function collectNpm(dependencies = {}) {
  for (const [name, dependency] of Object.entries(dependencies)) {
    const componentVersion = dependency.version
    if (typeof componentVersion === 'string' && !/^(?:link|file|workspace):/.test(componentVersion) && dependency.resolved) {
      const key = `${name}@${componentVersion}`
      if (!components.has(`npm:${key}`)) {
        const purl = `pkg:npm/${purlName(name)}@${encodeURIComponent(componentVersion)}`
        const declaredLicense = licenseByComponent.get(key)
        const reviewedPlatformLicense = reviewedOptionalPlatformLicense({
          name,
          version: componentVersion,
          declaredLicense,
        })
        const reviewedLicense = reviewedExactLicenseOverrides.get(key)
        const packageLicense = reviewedPlatformLicense?.license || declaredLicense || reviewedLicense
          ? null
          : await packageJsonLicense(dependency.path)
        const license = reviewedPlatformLicense?.license || declaredLicense || reviewedLicense
          ? cyclonedxLicense(reviewedPlatformLicense?.license ?? declaredLicense ?? reviewedLicense)
          : packageLicense
        const licenseSource = reviewedPlatformLicense
          ? reviewedPlatformLicense.source
          : declaredLicense
            ? `pnpm-license-report:${key}`
            : reviewedLicense
              ? `reviewed-exact-version-override:${key}`
              : packageLicense
                ? `installed-package-json:${key}`
                : 'missing'
        const hash = npmIntegrityByComponent.get(key)
        if (!hash) throw new Error(`pnpm 锁文件缺少 ${key} 的完整性哈希`)
        components.set(`npm:${key}`, {
          type: 'library',
          'bom-ref': purl,
          name,
          version: componentVersion,
          purl,
          hashes: [hash],
          ...(license ? { licenses: [license] } : {}),
          properties: [
            { name: 'wuyan:ecosystem', value: 'npm' },
            { name: 'wuyan:license-source', value: licenseSource },
          ],
          externalReferences: [{ type: 'distribution', url: dependency.resolved }],
        })
      }
    }
    await collectNpm(dependency.dependencies)
  }
}

for (const workspace of workspaceTrees) await collectNpm(workspace.dependencies)
const npmComponentCount = components.size
const gradleModules = await resolvedGradleModules()
for (const module of gradleModules) {
  if (
    typeof module?.group !== 'string'
    || typeof module?.name !== 'string'
    || typeof module?.version !== 'string'
  ) throw new Error('Gradle release 依赖条目格式错误')
  if (!Array.isArray(module.artifacts)) throw new Error('Gradle release 依赖缺少构件哈希清单')
  const artifacts = [...new Map(module.artifacts.map((artifact) => [
    `${artifact?.fileName}:${artifact?.sha256}`,
    artifact,
  ])).values()]
  if (artifacts.some((artifact) => (
    typeof artifact?.fileName !== 'string' || !/^[a-f0-9]{64}$/.test(artifact?.sha256 ?? '')
  ))) throw new Error(`Gradle 构件哈希格式错误：${module.group}:${module.name}:${module.version}`)
  if (artifacts.length > 1) {
    throw new Error(`Gradle 组件解析出多个不同运行构件：${module.group}:${module.name}:${module.version}`)
  }
  const pom = await mavenPomMetadata(module)
  const primaryHash = artifacts[0]?.sha256 ?? pom.pomSha256
  if (!primaryHash) throw new Error(`无法绑定 Maven 构件哈希：${module.group}:${module.name}:${module.version}`)
  const purl = `pkg:maven/${encodeURIComponent(module.group)}/${encodeURIComponent(module.name)}@${encodeURIComponent(module.version)}`
  const artifactKind = artifacts[0]?.extension ?? 'pom'
  components.set(`gradle:${module.group}:${module.name}:${module.version}`, {
    type: 'library',
    'bom-ref': purl,
    group: module.group,
    name: module.name,
    version: module.version,
    purl,
    hashes: [{ alg: 'SHA-256', content: primaryHash }],
    ...(pom.licenses.length > 0 ? { licenses: pom.licenses } : {}),
    properties: [
      { name: 'wuyan:ecosystem', value: 'gradle-releaseRuntimeClasspath' },
      { name: 'wuyan:hashed-artifact-kind', value: artifactKind },
    ],
  })
}

const sortedComponents = [...components.values()].sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']))
const lockfileSha256 = createHash('sha256').update(lockfile).digest('hex')
const componentsWithHashes = sortedComponents.filter((component) => Array.isArray(component.hashes) && component.hashes.length > 0).length
const componentsWithLicenses = sortedComponents.filter((component) => Array.isArray(component.licenses) && component.licenses.length > 0).length
if (componentsWithHashes !== sortedComponents.length) throw new Error('SBOM 仍有组件缺少构件哈希')
const fingerprint = createHash('sha256')
  .update(JSON.stringify(sortedComponents))
  .update(lockfileSha256)
  .update(version.versionName)
  .digest('hex')
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${stableUuid(fingerprint)}`,
  version: 1,
  metadata: {
    component: {
      type: 'application',
      'bom-ref': `pkg:generic/wuyan-tongxing-android-personal@${encodeURIComponent(version.versionName)}`,
      name: 'wuyan-tongxing-android-personal',
      version: version.versionName,
      properties: [
        { name: 'wuyan:inventory-scope', value: 'npm production graph plus resolved Android releaseRuntimeClasspath' },
        { name: 'wuyan:pnpm-lock-sha256', value: lockfileSha256 },
        { name: 'wuyan:android-package', value: version.packageName },
        { name: 'wuyan:android-variant', value: 'release' },
        { name: 'wuyan:gradle-configuration', value: 'releaseRuntimeClasspath' },
        { name: 'wuyan:npm-component-count', value: String(npmComponentCount) },
        { name: 'wuyan:gradle-component-count', value: String(gradleModules.length) },
        { name: 'wuyan:components-with-hashes', value: String(componentsWithHashes) },
        { name: 'wuyan:components-with-licenses', value: String(componentsWithLicenses) },
      ],
    },
  },
  components: sortedComponents,
}

const licenseInventory = {
  schemaVersion: 5,
  scope: 'pnpm production dependency graph and resolved Android releaseRuntimeClasspath POM declarations',
  sources: [
    'pnpm licenses list --prod --json',
    'reviewed exact npm version metadata for allowlisted optional platform package identities',
    'installed npm package.json fallback',
    'reviewed exact-version overrides for other packages not materialized on this host',
    'resolved Maven POM files',
  ],
  componentIdentity: 'purl',
  components: sortedComponents.map((component) => ({
    purl: component.purl,
    ecosystem: component.properties.find((property) => property.name === 'wuyan:ecosystem')?.value,
    licenseSource: component.properties.find((property) => property.name === 'wuyan:license-source')?.value
      ?? 'resolved-maven-pom',
    ...(component.group ? { group: component.group } : {}),
    name: component.name,
    version: component.version,
    licenses: component.licenses ?? [],
  })),
  summary: {
    componentCount: sortedComponents.length,
    npmComponentCount,
    mavenComponentCount: gradleModules.length,
    componentsWithDeclaredLicense: componentsWithLicenses,
    componentsWithoutDeclaredLicense: sortedComponents.length - componentsWithLicenses,
  },
}

validateLicenseInventory(sbom, licenseInventory)

function licenseLabel(license) {
  return license.expression ?? license.license?.id ?? license.license?.name ?? '<missing>'
}

const declarationCounts = new Map()
for (const component of licenseInventory.components) {
  const declaration = component.licenses.map(licenseLabel).join(' ; ')
  declarationCounts.set(declaration, (declarationCounts.get(declaration) ?? 0) + 1)
}
const declarationRows = [...declarationCounts]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([declaration, count]) => `| \`${declaration.replaceAll('|', '\\|')}\` | ${count} |`)
  .join('\n')
const notices = `# 第三方软件与许可证说明

本文件由 \`pnpm supply-chain\` 从锁定的生产依赖图自动生成。机器可读的 CycloneDX SBOM 位于 \`docs/sbom.cdx.json\`，许可证清单位于 \`docs/third-party-licenses.json\`；两份文件以 purl 为组件身份，必须通过 \`pnpm verify:licenses\` 的双向精确集合校验。

## 当前清单

- 生产组件总数：${sortedComponents.length}
- npm 组件：${npmComponentCount}
- Android \`releaseRuntimeClasspath\` Maven 组件：${gradleModules.length}
- 有声明许可证的组件：${componentsWithLicenses}
- 无声明许可证的组件：${sortedComponents.length - componentsWithLicenses}

| 上游声明的许可证或 SPDX 表达式 | 组件数 |
| --- | ---: |
${declarationRows}

## 源代码中的派生模板

\`apps/android-shell/android\` 的部分文件源自 \`@capacitor/cli@8.5.0\` 随附的 Capacitor Android template，Copyright (c) 2017-present Drifty Co.，采用 MIT License。完整通知与许可文本位于 \`apps/android-shell/android/LICENSE-CAPACITOR\`。该派生模板归属不包含已从公开快照删除的 Capacitor 默认标志 PNG。

## 公开 Release 邻接许可证包

维护者运行 \`pnpm release:license-pack\` 后，会在被 Git 忽略的 \`release-assets/\` 中得到版本化的 \`.tar.gz\` 许可证包及其 SHA-256 文件。包内包含本说明、SBOM、逐 purl 许可证清单、逐组件文本来源清单以及实际许可证/NOTICE 文本；它不复制 APK。

上游许可证元数据和文本用于可追溯的工程盘点，不等同于法律意见，也不自动免除署名、NOTICE、源代码提供或再分发义务。公开发布前仍须由负责人员复核新增许可证、素材归属及适用义务；未通过复核不得发布。
`

await fs.mkdir(docs, { recursive: true })
await fs.writeFile(path.join(docs, 'sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8')
await fs.writeFile(path.join(docs, 'third-party-licenses.json'), `${JSON.stringify(licenseInventory, null, 2)}\n`, 'utf8')
await fs.writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), notices, 'utf8')

console.log(`供应链清单已生成：npm ${npmComponentCount} 个，Gradle ${gradleModules.length} 个，共 ${sortedComponents.length} 个 release 组件；构件哈希 ${componentsWithHashes}/${sortedComponents.length}，许可证声明 ${componentsWithLicenses}/${sortedComponents.length}。`)
