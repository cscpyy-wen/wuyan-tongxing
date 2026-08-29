function reviewedEntries(names, version, license, upstreamPackage) {
  return names.map((name) => [`${name}@${version}`, { license, upstreamPackage }])
}

// The exact npm version metadata for all 59 package identities below was reviewed on
// 2026-08-29. Both name and version are allowlisted so new architectures and upgrades
// fail closed instead of inheriting a family-level declaration.
const reviewedOptionalPlatformPackages = new Map([
  ...reviewedEntries([
    '@esbuild/aix-ppc64',
    '@esbuild/android-arm',
    '@esbuild/android-arm64',
    '@esbuild/android-x64',
    '@esbuild/darwin-arm64',
    '@esbuild/darwin-x64',
    '@esbuild/freebsd-arm64',
    '@esbuild/freebsd-x64',
    '@esbuild/linux-arm',
    '@esbuild/linux-arm64',
    '@esbuild/linux-ia32',
    '@esbuild/linux-loong64',
    '@esbuild/linux-mips64el',
    '@esbuild/linux-ppc64',
    '@esbuild/linux-riscv64',
    '@esbuild/linux-s390x',
    '@esbuild/linux-x64',
    '@esbuild/netbsd-arm64',
    '@esbuild/netbsd-x64',
    '@esbuild/openbsd-arm64',
    '@esbuild/openbsd-x64',
    '@esbuild/openharmony-arm64',
    '@esbuild/sunos-x64',
    '@esbuild/win32-arm64',
    '@esbuild/win32-ia32',
    '@esbuild/win32-x64',
  ], '0.25.12', 'MIT', 'esbuild@0.25.12'),
  ...reviewedEntries([
    '@parcel/watcher-android-arm64',
    '@parcel/watcher-darwin-arm64',
    '@parcel/watcher-darwin-x64',
    '@parcel/watcher-freebsd-x64',
    '@parcel/watcher-linux-arm-glibc',
    '@parcel/watcher-linux-arm-musl',
    '@parcel/watcher-linux-arm64-glibc',
    '@parcel/watcher-linux-arm64-musl',
    '@parcel/watcher-linux-x64-glibc',
    '@parcel/watcher-linux-x64-musl',
    '@parcel/watcher-win32-arm64',
    '@parcel/watcher-win32-x64',
  ], '2.6.0', 'MIT', '@parcel/watcher@2.6.0'),
  ...reviewedEntries([
    '@swc/core-darwin-arm64',
    '@swc/core-darwin-x64',
    '@swc/core-linux-arm-gnueabihf',
    '@swc/core-linux-arm64-gnu',
    '@swc/core-linux-arm64-musl',
    '@swc/core-linux-x64-gnu',
    '@swc/core-linux-x64-musl',
    '@swc/core-win32-arm64-msvc',
    '@swc/core-win32-ia32-msvc',
    '@swc/core-win32-x64-msvc',
  ], '1.3.96', 'Apache-2.0 AND MIT', '@swc/core@1.3.96'),
  ...reviewedEntries([
    'lightningcss-android-arm64',
    'lightningcss-darwin-arm64',
    'lightningcss-darwin-x64',
    'lightningcss-freebsd-x64',
    'lightningcss-linux-arm-gnueabihf',
    'lightningcss-linux-arm64-gnu',
    'lightningcss-linux-arm64-musl',
    'lightningcss-linux-x64-gnu',
    'lightningcss-linux-x64-musl',
    'lightningcss-win32-arm64-msvc',
    'lightningcss-win32-x64-msvc',
  ], '1.33.0', 'MPL-2.0', 'lightningcss@1.33.0'),
])

export const reviewedOptionalPlatformPackageIdentities = Object.freeze(
  [...reviewedOptionalPlatformPackages.keys()].sort(),
)

export function optionalPlatformPackageUpstream(name, version) {
  if (/^@esbuild\/[^/]+$/.test(name)) return `esbuild@${version}`
  if (/^@parcel\/watcher-/.test(name)) return `@parcel/watcher@${version}`
  if (/^@swc\/core-/.test(name)) return `@swc/core@${version}`
  if (/^lightningcss-/.test(name)) return `lightningcss@${version}`
  return null
}

export function reviewedOptionalPlatformLicense({ name, version, declaredLicense }) {
  const upstreamPackage = optionalPlatformPackageUpstream(name, version)
  if (!upstreamPackage) return null
  const reviewed = reviewedOptionalPlatformPackages.get(`${name}@${version}`)
  if (!reviewed) {
    throw new Error(`可选平台包 ${name}@${version} 缺少精确版本许可证复核`)
  }
  const { license } = reviewed
  if (declaredLicense && declaredLicense !== license) {
    throw new Error(
      `可选平台包 ${name}@${version} 的已安装许可证 ${declaredLicense} 与复核值 ${license} 不一致`,
    )
  }
  return {
    license,
    upstreamPackage: reviewed.upstreamPackage,
    source: `reviewed-exact-npm-version-metadata:${name}@${version}`,
  }
}
