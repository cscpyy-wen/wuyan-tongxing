const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/

function daysInGregorianMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    return leapYear ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

export function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const match = RFC3339_TIMESTAMP.exec(value)
  if (!match) return false

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (
    year < 1
    || month < 1 || month > 12
    || day < 1 || day > daysInGregorianMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
  ) return false

  if (offsetText !== 'Z') {
    const offsetHour = Number(offsetText!.slice(1, 3))
    const offsetMinute = Number(offsetText!.slice(4, 6))
    if (offsetHour > 23 || offsetMinute > 59) return false
  }
  return Number.isFinite(new Date(value).getTime())
}
