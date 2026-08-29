import rawTodayContentSummaries from './data/today-content-summaries.json'

export interface TodayContentSummary {
  id: string
  title: string
  summary: string
  durationMinutes: number
  sourceLabel: string
}

/**
 * A deliberately small, generated-style projection of the reviewed catalog.
 * The content test fails whenever this projection drifts from content-items.json.
 */
export const TODAY_CONTENT_SUMMARIES = rawTodayContentSummaries as TodayContentSummary[]

export const todayContentById: Readonly<Record<string, TodayContentSummary>> = Object.freeze(
  Object.fromEntries(TODAY_CONTENT_SUMMARIES.map((item) => [item.id, item])),
)

export function getTodayContentSummary(id: string): TodayContentSummary | undefined {
  return todayContentById[id]
}
