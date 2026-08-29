import assert from 'node:assert/strict'
import test from 'node:test'
import { isSourceSnapshotExcluded } from './source-snapshot-policy.mjs'

test('source snapshot excludes release output and every Kotlin session salive file', () => {
  for (const pathname of [
    'release/android/manifest.json',
    'release/android/CURRENT/0001.json',
    'release/.android-publication-123/manifest.json',
    'release/.android-previous-123/manifest.json',
    'apps/android-shell/android/.kotlin/sessions/kotlin-compiler-123.salive',
    'nested/.kotlin/sessions/worker.SALIVE',
    'nested\\.kotlin\\sessions\\worker.salive',
  ]) assert.equal(isSourceSnapshotExcluded(pathname), true, pathname)

  for (const pathname of [
    'apps/android-shell/android/.kotlin/sessions/README.md',
    'apps/android-shell/android/.kotlin/other/cache.bin',
    'scripts/build-android.mjs',
    'release/README.md',
  ]) assert.equal(isSourceSnapshotExcluded(pathname), false, pathname)
})

test('transient Kotlin compiler session cannot change the selected source inventory', () => {
  const before = [
    'apps/android-shell/android/app/build.gradle',
    'scripts/build-android.mjs',
  ]
  const duringParallelGradle = [
    ...before,
    'apps/android-shell/android/.kotlin/sessions/kotlin-compiler-12692393617206850624.salive',
  ]
  const select = (paths) => paths.filter((pathname) => !isSourceSnapshotExcluded(pathname)).sort()
  assert.deepEqual(select(duringParallelGradle), select(before))
})
