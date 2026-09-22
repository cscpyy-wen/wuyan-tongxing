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
  const planCreatedAt = new Date('2026-08-28T00:00:00.000+08:00')
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
    plan: createClientPlan({ baseline, path: 'abrupt' as const, quitDate: '2026-09-01' }, planCreatedAt),
    settings: { ...initial.settings, sensitiveHealthData: true },
  }
}

describe('recovery bundle import', () => {
  // This boundary intentionally materializes an approximately 11 MiB bundle;
  // keep its slow-runner allowance local instead of weakening the suite timeout.
  it('fits two exact-limit unreadable native slots and explicitly omits oversized attachments', () => {
    expect(NATIVE_DURABLE_STATE_MAX_BYTES).toBe(4 * 1024 * 1024)
    expect(MAX_SINGLE_NATIVE_RECOVERY_BYTES).toBe(12 * 1024 * 1024)
    expect(MAX_RECOVERY_IMPORT_CHARACTERS).toBe(MAX_SINGLE_NATIVE_RECOVERY_BYTES)
    expect(NATIVE_DURABLE_STATE_MAX_BYTES % 3).toBe(1)
    // Base64("xxx") is "eHh4" and the one-byte remainder is "eA==". Build the
    // exact 4 MiB unreadable-slot fixture directly: the generic codec has its
    // own tests and its byte-by-byte work is unrelated to bundle sizing.
    const encoded = {
      encoding: 'base64-utf8' as const,
      data: `${'eHh4'.repeat(Math.floor(NATIVE_DURABLE_STATE_MAX_BYTES / 3))}eA==`,
    }
    const expectedCoreOnlyHeadroom = 1_397_665
    const oversizedAttachment = 'x'.repeat(expectedCoreOnlyHeadroom + 1)
    const bundle = createBoundedNativeRecoveryBundle({
      core: {
        exportedAt: '2026-08-28T00:00:00.000Z',
        readStatus: { primary: 'unreadable', lastKnownGood: 'unreadable' },
        primary: encoded,
        lastKnownGood: encoded,
      },
      bootstrapRecovery: oversizedAttachment,
      bootstrapAvailable: true,
      pendingBootstrapImport: oversizedAttachment,
      pendingImportAvailable: true,
    })

    const bundleBytes = utf8ByteLength(bundle)
    expect(bundleBytes).toBe(11_185_247)
    expect(MAX_SINGLE_NATIVE_RECOVERY_BYTES - bundleBytes).toBe(expectedCoreOnlyHeadroom)
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
  }, 10_000)

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
