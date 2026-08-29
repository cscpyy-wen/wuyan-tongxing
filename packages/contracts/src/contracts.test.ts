import { describe, expect, it } from 'vitest'
import {
  BaselineAssessmentSchema,
  CigaretteLogSchema,
  ConsentReceiptSchema,
  SyncMutationSchema,
  TelemetryEventSchema,
} from './index'

describe('public contracts', () => {
  it('does not admit a minor into the adult baseline contract', () => {
    expect(() => BaselineAssessmentSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      ageConfirmed: false,
      currentPaperCigaretteUser: true,
      cigarettesPerDay: 10,
      timeToFirstCigarette: '31_TO_60',
      previousQuitAttempts: 0,
      reasons: ['健康'],
      triggers: ['AFTER_MEAL'],
      assessedAt: '2026-08-23T12:00:00.000+08:00',
    })).toThrow()
  })

  it('requires separate consent scopes instead of a blanket receipt', () => {
    const receipt = ConsentReceiptSchema.parse({
      id: '22222222-2222-4222-8222-222222222222',
      scope: 'CLOUD_SYNC',
      granted: false,
      policyVersion: 'internal-0.1',
      recordedAt: '2026-08-23T12:00:00.000+08:00',
    })
    expect(receipt.scope).toBe('CLOUD_SYNC')
    expect(receipt.granted).toBe(false)
  })

  it('accepts tombstones without retaining a deleted payload', () => {
    const mutation = SyncMutationSchema.parse({
      opId: '33333333-3333-4333-8333-333333333333',
      objectId: '44444444-4444-4444-8444-444444444444',
      objectType: 'DAILY_CHECKIN',
      operation: 'DELETE',
      objectVersion: 2,
      payload: null,
      clientChangedAt: '2026-08-23T12:00:00.000+08:00',
    })
    expect(mutation.payload).toBeNull()
  })

  it('accepts a structured per-cigarette craving intensity and rejects out-of-range values', () => {
    const payload = {
      id: '77777777-7777-4777-8777-777777777777',
      attemptId: '88888888-8888-4888-8888-888888888888',
      smokedAt: '2026-08-24T12:00:00.000+08:00',
      trigger: 'WORK_BREAK',
      cravingIntensity: 5,
      source: 'QUICK_LOG',
    }
    expect(CigaretteLogSchema.parse(payload).cravingIntensity).toBe(5)
    expect(() => CigaretteLogSchema.parse({ ...payload, cravingIntensity: 6 })).toThrow()
  })

  it('rejects arbitrary or mismatched health payloads at the sync boundary', () => {
    expect(() => SyncMutationSchema.parse({
      opId: '33333333-3333-4333-8333-333333333333',
      objectId: '44444444-4444-4444-8444-444444444444',
      objectType: 'QUIT_PLAN',
      operation: 'UPSERT',
      objectVersion: 1,
      payload: { privateDiary: '不应上传的自由文本' },
      clientChangedAt: '2026-08-23T12:00:00.000+08:00',
    })).toThrow()

    expect(() => SyncMutationSchema.parse({
      opId: '33333333-3333-4333-8333-333333333333',
      objectId: '44444444-4444-4444-8444-444444444444',
      objectType: 'DAILY_CHECKIN',
      operation: 'DELETE',
      objectVersion: 2,
      payload: { retained: true },
      clientChangedAt: '2026-08-23T12:00:00.000+08:00',
    })).toThrow()
  })

  it('rejects telemetry fields that could carry identity or free text', () => {
    expect(() => TelemetryEventSchema.parse({
      eventId: '55555555-5555-4555-8555-555555555555',
      analyticsId: '66666666-6666-4666-8666-666666666666',
      name: 'APP_OPENED',
      occurredAt: '2026-08-23T12:00:00.000+08:00',
      phase: null,
      properties: { openid: 'must-not-upload' },
    })).toThrow()
  })
})
