import { addDays, toLocalDate, validateQuitDate } from '../../lib/model'
import type { QuitPath } from '../../types'

export interface OnboardingQuitDateWindow {
  today: string
  start: string
  end: string
  recommended: string
}

/** Returns the date-picker window for the Beijing calendar day at `now`. */
export function getOnboardingQuitDateWindow(path: QuitPath, now: Date): OnboardingQuitDateWindow {
  const today = toLocalDate(now)
  const minimumDays = path === 'abrupt' ? 0 : 7
  const maximumDays = path === 'abrupt' ? 14 : 28
  return {
    today,
    start: addDays(today, minimumDays),
    end: addDays(today, maximumDays),
    recommended: addDays(today, path === 'abrupt' ? 7 : 14),
  }
}

/** Re-reads the Beijing day at submission time; do not pass a render snapshot. */
export function validateOnboardingQuitDateAtSubmission(
  path: QuitPath,
  quitDate: string,
  now = new Date(),
): boolean {
  return validateQuitDate(path, toLocalDate(now), quitDate)
}
