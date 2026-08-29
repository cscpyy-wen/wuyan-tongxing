import { afterEach, describe, expect, it, vi } from 'vitest'
import { getOnboardingQuitDateWindow, validateOnboardingQuitDateAtSubmission } from './dateLogic'

afterEach(() => vi.useRealTimers())

describe('onboarding Beijing-date boundaries', () => {
  it('moves the visible date window at Beijing midnight', () => {
    const beforeMidnight = getOnboardingQuitDateWindow('reduction', new Date('2026-08-28T15:59:59.000Z'))
    const afterMidnight = getOnboardingQuitDateWindow('reduction', new Date('2026-08-28T16:00:01.000Z'))

    expect(beforeMidnight).toMatchObject({
      today: '2026-08-28',
      start: '2026-09-04',
      end: '2026-09-25',
    })
    expect(afterMidnight).toMatchObject({
      today: '2026-08-29',
      start: '2026-09-05',
      end: '2026-09-26',
    })
  })

  it('recomputes today when submitting instead of accepting a stale reduction lower bound', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T15:59:59.000Z'))
    const selectedAtRender = getOnboardingQuitDateWindow('reduction', new Date()).start
    expect(validateOnboardingQuitDateAtSubmission('reduction', selectedAtRender)).toBe(true)

    vi.setSystemTime(new Date('2026-08-28T16:00:01.000Z'))
    expect(validateOnboardingQuitDateAtSubmission('reduction', selectedAtRender)).toBe(false)
  })
})
