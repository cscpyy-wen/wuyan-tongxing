export const FIRST_CIGARETTE_MINUTES = [5, 30, 60, 61] as const
export const FIRST_CIGARETTE_LABELS: string[] = ['5 分钟内', '6–30 分钟', '31–60 分钟', '60 分钟以后']

export function firstCigarettePickerIndex(minutes: number): number {
  if (minutes <= 5) return 0
  if (minutes <= 30) return 1
  if (minutes <= 60) return 2
  return 3
}

export function firstCigaretteMinutesAfterPicker(
  current: number | undefined,
  rawIndex: unknown,
): number | undefined {
  const index = Number(rawIndex)
  if (!Number.isInteger(index) || index < 0 || index >= FIRST_CIGARETTE_MINUTES.length) return current
  // Opening the picker and confirming its already selected category must be a
  // true no-op, including for legacy values such as 31 inside the 31–60 band.
  if (current !== undefined && index === firstCigarettePickerIndex(current)) return current
  return FIRST_CIGARETTE_MINUTES[index] ?? current
}
