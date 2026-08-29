import { describe, expect, it } from 'vitest'
import type { ClientCigaretteLog } from '../types'
import { createClientPlan, createInitialState } from './model'
import {
  cigaretteLogAdditionConsequences,
  cigaretteLogMutationConsequences,
} from './smokingLogConsequences'

describe('烟支记录变更影响披露', () => {
  it('counts affected day confirmations and the exact linked lapse', () => {
    const baseline = {
      cigarettesPerDay: 10,
      firstCigaretteMinutes: 30,
      previousAttempts: 0,
      reasons: ['为了健康'],
      triggers: ['stress' as const],
      pricePerPack: 25,
    }
    const plan = createClientPlan(
      { baseline, path: 'abrupt', quitDate: '2026-09-01' },
      new Date('2026-08-28T08:00:00+08:00'),
    )
    const log: ClientCigaretteLog = {
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-08-29T01:00:00.000Z',
      count: 1,
      trigger: 'stress',
      cravingIntensity: 3,
      attemptId: plan.id,
      source: 'QUICK_LOG',
    }
    const state = {
      ...createInitialState(),
      onboarded: true,
      baseline,
      plan,
      cigarettes: [log],
      checkIns: [{
        id: '22222222-2222-4222-8222-222222222222',
        date: '2026-08-29',
        cigarettesSmoked: 1,
        cravingPeak: 3 as const,
        smokeFree: false,
        createdAt: '2026-08-29T02:00:00.000Z',
        attemptId: plan.id,
      }],
      lapses: [{
        id: '33333333-3333-4333-8333-333333333333',
        createdAt: log.createdAt,
        cigarettes: 1,
        trigger: 'stress' as const,
        recoveryAction: '重新开始',
        cigaretteLogId: log.id,
        attemptId: plan.id,
      }],
      settings: { ...createInitialState().settings, sensitiveHealthData: true },
    }

    expect(cigaretteLogMutationConsequences(state, log)).toEqual({
      affectedCheckInCount: 1,
      linkedLapseCount: 1,
    })
    expect(cigaretteLogAdditionConsequences(state, log.createdAt)).toEqual({
      affectedCheckInCount: 1,
      linkedLapseCount: 0,
    })
  })
})
