import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { recoverLegacyAndroidPublication, resolveCurrentAndroidRelease } from './android-release-store.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseParent = path.join(repositoryRoot, 'release')
const legacy = await recoverLegacyAndroidPublication(releaseParent)
const current = await resolveCurrentAndroidRelease(legacy.containerRoot)
const result = {
  mode: current.mode,
  releaseRoot: current.releaseRoot,
  pointerPath: current.pointerPath,
  releaseId: current.pointer?.releaseId ?? null,
  invalidPointerCount: current.invalidPointers.length,
}

if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
else console.log(current.releaseRoot)
