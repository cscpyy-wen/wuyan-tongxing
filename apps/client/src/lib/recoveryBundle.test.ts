import { describe, expect, it } from 'vitest'
import { createClientPlan, createInitialState } from './model'
import {
  encodeLosslessBase64,
  MAX_SINGLE_NATIVE_RECOVERY_BYTES,
  utf8ByteLength,
} from './recoveryCodec'
import { NATIVE_DURABLE_STATE_MAX_BYTES } from './nativeDurableStore'
import {
  createBoundedNativeRecoveryBundle,
  MAX_RECOVERY_IMPORT_CHARACTERS,
  MAX_RECOVERY_PENDING_IMPORT_RAW_CHARACTERS,
  parseRecoveryImportCandidate,
} from './recoveryBundle'

function validState() {
  const initial = createInitialState()
  const baseline = {
    cigarettesPerDay: 10,
    firstCigaretteMinutes: 30,
    previousAttempts: 0,
    reasons: ['健康'],
    triggers: ['stress' as const],
    pricePerPack: 25,
  }
  return {
    ...initial,
    onboarded: true,
    baseline,
    plan: createClientPlan({ baseline, path: 'abrupt' as const, quitDate: '2026-09-01' }),
    settings: { ...initial.settings, sensitiveHealthData: true },
  }
}

describe('recovery bundle import', () => {
  it('fits two exact-limit unreadable native slots and explicitly omits oversized attachments', () => {
    expect(NATIVE_DURABLE_STATE_MAX_BYTES).toBe(4 * 1024 * 1024)
    expect(MAX_SINGLE_NATIVE_RECOVERY_BYTES).toBe(12 * 1024 * 1024)
    expect(MAX_RECOVERY_IMPORT_CHARACTERS).toBe(MAX_SINGLE_NATIVE_RECOVERY_BYTES)
    const raw = 'x'.repeat(NATIVE_DURABLE_STATE_MAX_BYTES)
    const encoded = encodeLosslessBase64(raw)
    const bundle = createBoundedNativeRecoveryBundle({
      core: {
        exportedAt: '2026-08-28T00:00:00.000Z',
        readStatus: { primary: 'unreadable', lastKnownGood: 'unreadable' },
        primary: encoded,
        lastKnownGood: encoded,
      },
      bootstrapRecovery: { oversized: 'b'.repeat(2 * 1024 * 1024) },
      bootstrapAvailable: true,
      pendingBootstrapImport: { evidence: 'p'.repeat(2 * 1024 * 1024) },
      pendingImportAvailable: true,
    })

    expect(utf8ByteLength(bundle)).toBe(11_185_247)
    expect(MAX_SINGLE_NATIVE_RECOVERY_BYTES - utf8ByteLength(bundle)).toBe(1_397_665)
    const parsed = JSON.parse(bundle) as Record<string, any>
    expect(parsed.primary).toEqual(encoded)
    expect(parsed.lastKnownGood).toEqual(encoded)
    expect(parsed._androidBootstrapRecovery).toBeUndefined()
    expect(parsed._androidBootstrapPendingImport).toBeUndefined()
    expect(parsed._recoveryIntegrity).toMatchObject({
      bootstrapIncluded: false,
      pendingImportIncluded: false,
      bootstrapOmittedForSize: true,
      pendingImportOmittedForSize: true,
    })
  })

  it('includes bounded bootstrap and pending-import evidence when both fit', () => {
    const bundle = createBoundedNativeRecoveryBundle({
      core: {
        readStatus: { primary: 'unreadable', lastKnownGood: 'missing' },
        primary: encodeLosslessBase64('broken'),
        lastKnownGood: null,
      },
      bootstrapRecovery: { queue: 'kept' },
      pendingBootstrapImport: { status: 'validated', evidence: 'kept' },
    })
    const parsed = JSON.parse(bundle) as Record<string, any>
    expect(parsed._androidBootstrapRecovery).toEqual({ queue: 'kept' })
    expect(parsed._androidBootstrapPendingImport).toEqual({ status: 'validated', evidence: 'kept' })
    expect(parsed._recoveryIntegrity).toMatchObject({
      bootstrapIncluded: true,
      pendingImportIncluded: true,
      bootstrapOmittedForSize: false,
      pendingImportOmittedForSize: false,
    })
  })

  it('keeps the worst-UTF8 capped pending journal beside two exact native core slots', () => {
    const encoded = encodeLosslessBase64('x'.repeat(NATIVE_DURABLE_STATE_MAX_BYTES))
    const pendingEvidence = encodeLosslessBase64(
      '戒'.repeat(MAX_RECOVERY_PENDING_IMPORT_RAW_CHARACTERS),
    )
    const bundle = createBoundedNativeRecoveryBundle({
      core: {
        readStatus: { primary: 'unreadable', lastKnownGood: 'unreadable' },
        primary: encoded,
        lastKnownGood: encoded,
      },
      pendingBootstrapImport: { status: 'unreadable', evidence: pendingEvidence },
    })

    const parsed = JSON.parse(bundle) as Record<string, any>
    expect(parsed._recoveryIntegrity.pendingImportIncluded).toBe(true)
    expect(parsed._androidBootstrapPendingImport.evidence).toEqual(pendingEvidence)
    expect(utf8ByteLength(bundle)).toBeLessThanOrEqual(MAX_SINGLE_NATIVE_RECOVERY_BYTES)
  })

  it('restores the independently captured valid backup when primary is corrupt', () => {
    const state = validState()
    const parsed = parseRecoveryImportCandidate({
      readStatus: { primary: 'unreadable', lastKnownGood: 'valid' },
      primary: encodeLosslessBase64('{"data":'),
      lastKnownGood: state,
      _androidBootstrapRecovery: { queue: 'kept' },
    })
    expect(parsed?.state.plan?.id).toBe(state.plan?.id)
    expect(parsed?.bootstrapRecovery).toEqual({ queue: 'kept' })
  })

  it('decodes an exact Taro wrapper captured as lossless evidence', () => {
    const state = validState()
    const parsed = parseRecoveryImportCandidate({
      readStatus: { primary: 'unreadable', lastKnownGood: 'missing' },
      primary: encodeLosslessBase64(JSON.stringify({ data: state })),
      lastKnownGood: null,
    })
    expect(parsed?.state.onboarded).toBe(true)
  })

  it('prefers a status-valid backup over parseable unreadable primary evidence', () => {
    const primary = validState()
    primary.baseline = { ...primary.baseline!, pricePerPack: 99 }
    const backup = validState()
    backup.baseline = { ...backup.baseline!, pricePerPack: 21 }
    const parsed = parseRecoveryImportCandidate({
      readStatus: { primary: 'unreadable', lastKnownGood: 'valid' },
      primary,
      lastKnownGood: backup,
    })
    expect(parsed?.state.baseline?.pricePerPack).toBe(21)
  })

  it('rejects a bundle with no strict onboarded state', () => {
    expect(parseRecoveryImportCandidate({
      readStatus: { primary: 'unreadable', lastKnownGood: 'missing' },
      primary: encodeLosslessBase64('broken'),
      lastKnownGood: null,
    })).toBeUndefined()
  })
})
