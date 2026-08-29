import { describe, expect, it } from 'vitest'
import {
  firstCigaretteMinutesAfterPicker,
  firstCigarettePickerIndex,
  FIRST_CIGARETTE_LABELS,
} from './assessmentLogic'

describe('晨起首支烟选择器', () => {
  it('keeps unanswered distinct until the user explicitly selects a category', () => {
    expect(firstCigaretteMinutesAfterPicker(undefined, 'invalid')).toBeUndefined()
    expect(firstCigaretteMinutesAfterPicker(undefined, 2)).toBe(60)
  })

  it('opens on the category currently shown to the user', () => {
    expect([5, 6, 30, 31, 60, 61, 120].map(firstCigarettePickerIndex)).toEqual([0, 1, 1, 2, 2, 3, 3])
    expect(FIRST_CIGARETTE_LABELS[firstCigarettePickerIndex(31)]).toBe('31–60 分钟')
  })

  it('is idempotent when the user opens and confirms without scrolling', () => {
    expect(firstCigaretteMinutesAfterPicker(31, 2)).toBe(31)
    expect(firstCigaretteMinutesAfterPicker(6, 1)).toBe(6)
    expect(firstCigaretteMinutesAfterPicker(61, 3)).toBe(61)
  })

  it('maps a deliberate category change and rejects malformed indices', () => {
    expect(firstCigaretteMinutesAfterPicker(31, 0)).toBe(5)
    expect(firstCigaretteMinutesAfterPicker(31, 1)).toBe(30)
    expect(firstCigaretteMinutesAfterPicker(31, 3)).toBe(61)
    expect(firstCigaretteMinutesAfterPicker(31, 99)).toBe(31)
    expect(firstCigaretteMinutesAfterPicker(31, 'bad')).toBe(31)
  })
})
