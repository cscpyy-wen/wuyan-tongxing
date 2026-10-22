import { describe, expect, it } from 'vitest'
import { canBeginPersonalPlan, type PlanEligibility } from './model'

const formerSmoker: PlanEligibility = {
  adultConfirmed: true,
  currentPaperCigaretteUser: false,
  formerPaperCigaretteUser: true,
  medicalBoundaryAccepted: true,
  sensitiveHealthDataAccepted: true,
}

describe('已戒烟成年用户的首次使用资格', () => {
  it('明确曾吸纸烟且已停止时允许建立记录', () => {
    expect(canBeginPersonalPlan(formerSmoker)).toBe(true)
  })

  it.each(['adultConfirmed', 'medicalBoundaryAccepted', 'sensitiveHealthDataAccepted'] as const)(
    '已停止吸烟不能绕过 %s', (required) => {
      expect(canBeginPersonalPlan({ ...formerSmoker, [required]: false })).toBe(false)
    },
  )

  it('未声明当前或曾经吸纸烟仍不通过；既有当前吸烟调用不变', () => {
    const { formerPaperCigaretteUser: _former, ...existingInput } = formerSmoker
    expect(canBeginPersonalPlan(existingInput)).toBe(false)
    expect(canBeginPersonalPlan({ ...existingInput, currentPaperCigaretteUser: true })).toBe(true)
    expect(canBeginPersonalPlan({ ...formerSmoker, formerPaperCigaretteUser: false })).toBe(false)
  })
})
