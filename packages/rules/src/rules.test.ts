import { describe, expect, it } from 'vitest'
import { evaluateRules, RuleDefinitionSchema, type RuleInput } from './index'

const baseInput: RuleInput = {
  strategy: 'ABRUPT',
  phase: 'ACTIVE_28',
  relativeDay: 2,
  dependenceBand: 'LOWER',
  recentCraving: 2,
  recentLapse: false,
  selectedTriggers: [],
  completedTaskIds: [],
  localTimeBucket: 'MORNING',
}

describe('transparent rule engine', () => {
  it('prioritizes lapse recovery over a simultaneous strong craving', () => {
    const result = evaluateRules({ ...baseInput, recentCraving: 9, recentLapse: true })
    expect(result.contentId).toBe('lapse-01')
    expect(result.reasonCode).toBe('RECENT_LAPSE')
  })

  it('returns deterministic results for identical versioned input', () => {
    const first = evaluateRules({ ...baseInput, selectedTriggers: ['SOCIAL_OFFER'] })
    const second = evaluateRules({ ...baseInput, selectedTriggers: ['SOCIAL_OFFER'] })
    expect(first).toEqual(second)
    expect(first.ruleId).toBe('social-trigger-plan')
  })

  it('falls back to the correct program day without evaluating code', () => {
    const result = evaluateRules(baseInput, [])
    expect(result.contentId).toBe('day-03')
    expect(result.reasonCode).toBe('PROGRAM_DAY_DEFAULT')
  })

  it('maps the seven preparation modules in order during the final seven days', () => {
    const ids = Array.from({ length: 7 }, (_, index) => evaluateRules({
      ...baseInput,
      phase: 'PREPARATION',
      relativeDay: index - 7,
    }, []).contentId)
    expect(ids).toEqual(['prep-01', 'prep-02', 'prep-03', 'prep-04', 'prep-05', 'prep-06', 'prep-07'])
    expect(evaluateRules({ ...baseInput, phase: 'REDUCTION', relativeDay: -14 }, []).contentId).toBe('prep-01')
    expect(evaluateRules({ ...baseInput, phase: 'REDUCTION', relativeDay: -1 }, []).contentId).toBe('prep-07')
  })

  it('maps day 1 through day 28 and maintenance weeks 5 through 8 by relative date', () => {
    expect(evaluateRules({ ...baseInput, phase: 'QUIT_DAY', relativeDay: 0 }, []).contentId).toBe('day-01')
    expect(evaluateRules({ ...baseInput, phase: 'ACTIVE_28', relativeDay: 27 }, []).contentId).toBe('day-28')
    expect([28, 35, 42, 49].map((relativeDay) => evaluateRules({
      ...baseInput,
      phase: 'MAINTENANCE',
      relativeDay,
    }, []).contentId)).toEqual([
      'maintenance-week-05',
      'maintenance-week-06',
      'maintenance-week-07',
      'maintenance-week-08',
    ])
  })

  it('uses content IDs that match stress and social-support semantics', () => {
    expect(evaluateRules({ ...baseInput, selectedTriggers: ['STRESS'] }).contentId).toBe('day-08')
    expect(evaluateRules({ ...baseInput, selectedTriggers: ['SOCIAL_OFFER'] }).contentId).toBe('day-19')
  })

  it('rejects unknown executable fields through the strict DSL schema', () => {
    expect(() => RuleDefinitionSchema.parse({
      id: 'unsafe',
      version: '1',
      enabled: true,
      priority: 1,
      condition: { eval: 'process.exit()' },
      decision: {
        actionType: 'PRIMARY_CONTENT',
        contentId: 'day-01',
        reasonCode: 'UNSAFE',
        evidenceSourceIds: ['x'],
        cooldownHours: 0,
      },
    })).toThrow()
  })

  it('keeps safeParse compatibility for API validation without Zod at runtime', () => {
    const rejected = RuleDefinitionSchema.safeParse({
      id: 'unknown-field',
      version: '1',
      enabled: true,
      priority: 1,
      condition: {},
      decision: {
        actionType: 'PRIMARY_CONTENT',
        contentId: 'day-01',
        reasonCode: 'VALID',
        evidenceSourceIds: ['WHO-TOBACCO-CESSATION-2024'],
        cooldownHours: 0,
        script: 'return true',
      },
    })
    expect(rejected.success).toBe(false)
    if (!rejected.success) expect(rejected.error.issues[0]?.message).toContain('未允许字段')
  })

  it('rejects integers outside JavaScript safe range', () => {
    const unsafe = RuleDefinitionSchema.safeParse({
      id: 'unsafe-number',
      version: '1',
      enabled: true,
      priority: 1,
      condition: { relativeDayMax: Number.MAX_SAFE_INTEGER + 1 },
      decision: {
        actionType: 'PRIMARY_CONTENT',
        contentId: 'day-01',
        reasonCode: 'VALID',
        evidenceSourceIds: ['WHO-TOBACCO-CESSATION-2024'],
        cooldownHours: 0,
      },
    })
    expect(unsafe.success).toBe(false)
  })
})
