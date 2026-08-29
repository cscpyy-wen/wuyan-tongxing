import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ANDROID_RELEASE_PROTOCOL,
  createAndroidReleaseStaging,
  publishAndroidRelease,
  recoverAndroidReleaseStore,
  recoverLegacyAndroidPublication,
  resolveCurrentAndroidRelease,
} from './android-release-store.mjs'

const temporaryRoots = []

test.after(async () => {
  await Promise.all(temporaryRoots.map((pathname) => fs.rm(pathname, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wuyan-android-release-store-'))
  temporaryRoots.push(root)
  const containerRoot = path.join(root, 'release', 'android')
  await fs.mkdir(containerRoot, { recursive: true })
  return { root, containerRoot }
}

async function stage(containerRoot, releaseId, payload = releaseId) {
  const stagingDirectory = await createAndroidReleaseStaging(containerRoot)
  await fs.writeFile(path.join(stagingDirectory, 'payload.bin'), payload)
  await fs.writeFile(path.join(stagingDirectory, 'complete.marker'), 'verified')
  await fs.writeFile(path.join(stagingDirectory, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 4,
    releaseId,
    artifact: { pathname: 'payload.bin' },
  }, null, 2)}\n`)
  return stagingDirectory
}

async function verifyComplete(stagingDirectory) {
  assert.equal(await fs.readFile(path.join(stagingDirectory, 'complete.marker'), 'utf8'), 'verified')
  assert.ok((await fs.stat(path.join(stagingDirectory, 'payload.bin'))).size > 0)
}

async function publish(containerRoot, releaseId, options = {}) {
  return publishAndroidRelease({
    containerRoot,
    stagingDirectory: await stage(containerRoot, releaseId),
    releaseId,
    verifyRelease: options.verifyRelease ?? verifyComplete,
    faultInjector: options.faultInjector,
    now: () => new Date('2026-08-28T00:00:00.000Z'),
  })
}

test('legacy flat release remains resolvable before first pointer-journal publication', async () => {
  const { containerRoot } = await fixture()
  await fs.writeFile(path.join(containerRoot, 'manifest.json'), '{"schemaVersion":3}\n')
  const current = await resolveCurrentAndroidRelease(containerRoot)
  assert.equal(current.mode, 'legacy-flat-directory')
  assert.equal(current.releaseRoot, containerRoot)
})

test('append-only CURRENT journal publishes only a completely verified immutable release', async () => {
  const { containerRoot } = await fixture()
  const result = await publish(containerRoot, 'release-1')
  assert.equal(result.current.pointer.releaseId, 'release-1')
  assert.equal(result.current.pointer.protocol, ANDROID_RELEASE_PROTOCOL)
  assert.equal(await fs.readFile(path.join(result.current.releaseRoot, 'payload.bin'), 'utf8'), 'release-1')

  const currentFiles = (await fs.readdir(path.join(containerRoot, 'CURRENT'))).filter((name) => name.endsWith('.json'))
  assert.equal(currentFiles.length, 1)
  assert.equal((await fs.readdir(path.join(containerRoot, 'releases'))).length, 1)

  await assert.rejects(
    publish(containerRoot, 'release-2', { verifyRelease: async () => { throw new Error('verification failed') } }),
    /verification failed/,
  )
  await recoverAndroidReleaseStore(containerRoot)
  assert.equal((await resolveCurrentAndroidRelease(containerRoot)).pointer.releaseId, 'release-1')
})

test('every publication fault leaves either the old verified release or the fully verified new release resolvable', async (t) => {
  const pointsBeforeVisibility = [
    'before-recovery',
    'after-recovery',
    'before-verification',
    'after-verification',
    'after-staging-sync',
    'before-release-rename',
    'after-release-rename',
    'before-immutable-verification',
    'after-immutable-verification',
    'before-pointer-write',
    'after-pointer-fsync',
  ]
  const pointsAfterVisibility = ['after-pointer-rename', 'after-pointer-directory-sync']
  for (const point of [...pointsBeforeVisibility, ...pointsAfterVisibility]) {
    await t.test(point, async () => {
      const { containerRoot } = await fixture()
      await publish(containerRoot, 'release-old')
      await assert.rejects(
        publish(containerRoot, 'release-new', {
          faultInjector: async (currentPoint) => {
            if (currentPoint === point) throw new Error(`fault:${point}`)
          },
        }),
        new RegExp(`fault:${point}`),
      )
      const immediatelyResolvable = await resolveCurrentAndroidRelease(containerRoot)
      const immediatelyExpected = pointsAfterVisibility.includes(point) ? 'release-new' : 'release-old'
      assert.equal(immediatelyResolvable.pointer.releaseId, immediatelyExpected)
      await recoverAndroidReleaseStore(containerRoot)
      const current = await resolveCurrentAndroidRelease(containerRoot)
      const expected = pointsAfterVisibility.includes(point) ? 'release-new' : 'release-old'
      assert.equal(current.pointer.releaseId, expected)
      assert.equal(await fs.readFile(path.join(current.releaseRoot, 'complete.marker'), 'utf8'), 'verified')
      assert.equal((await fs.readdir(containerRoot)).some((name) => name.startsWith('.staging-')), false)
      assert.equal((await fs.readdir(path.join(containerRoot, 'CURRENT'))).some((name) => name.startsWith('.pending-')), false)
    })
  }
})

test('a pending fsynced pointer is never authoritative before its final rename', async () => {
  const { containerRoot } = await fixture()
  await publish(containerRoot, 'release-old')
  const published = await publish(containerRoot, 'release-new')
  await fs.rename(published.pointerPath, path.join(containerRoot, 'CURRENT', '.pending-simulated-crash.json'))
  assert.equal((await resolveCurrentAndroidRelease(containerRoot)).pointer.releaseId, 'release-old')
})

test('the exact immutable directory is verified again before a pointer can expose it', async () => {
  const { containerRoot } = await fixture()
  await publish(containerRoot, 'release-old')
  let verificationCalls = 0
  await assert.rejects(
    publish(containerRoot, 'release-new', {
      verifyRelease: async (releaseRoot) => {
        verificationCalls += 1
        await verifyComplete(releaseRoot)
        if (verificationCalls === 2) throw new Error('immutable verification failed')
      },
    }),
    /immutable verification failed/,
  )
  assert.equal(verificationCalls, 2)
  assert.equal((await resolveCurrentAndroidRelease(containerRoot)).pointer.releaseId, 'release-old')
})

test('resolver skips a corrupt newest pointer and falls back to the last complete release', async () => {
  const { containerRoot } = await fixture()
  await publish(containerRoot, 'release-old')
  await fs.writeFile(path.join(containerRoot, 'CURRENT', '99999999999999999999-corrupt.json'), JSON.stringify({
    schemaVersion: 1,
    protocol: ANDROID_RELEASE_PROTOCOL,
    sequence: 99_999,
    releaseId: 'missing-release',
    releaseRelativePath: 'releases/missing-release',
    manifestSha256: '0'.repeat(64),
    committedAt: '2026-08-28T00:00:00.000Z',
  }))
  const current = await resolveCurrentAndroidRelease(containerRoot)
  assert.equal(current.pointer.releaseId, 'release-old')
  assert.equal(current.invalidPointers.length, 1)
})

test('startup recovery restores a legacy previous directory after an interrupted two-rename publication', async () => {
  const { root } = await fixture()
  const releaseParent = path.join(root, 'legacy-release')
  const previous = path.join(releaseParent, '.android-previous-123')
  const interrupted = path.join(releaseParent, '.android-publication-123')
  await fs.mkdir(previous, { recursive: true })
  await fs.mkdir(interrupted, { recursive: true })
  await fs.writeFile(path.join(previous, 'manifest.json'), '{"schemaVersion":3}\n')
  await fs.writeFile(path.join(interrupted, 'partial.tmp'), 'partial')

  const recovery = await recoverLegacyAndroidPublication(releaseParent)
  assert.equal(recovery.restoredFrom, previous)
  assert.equal((await resolveCurrentAndroidRelease(recovery.containerRoot)).mode, 'legacy-flat-directory')
  assert.deepEqual(recovery.interruptedPublicationResidues, [interrupted])
})
