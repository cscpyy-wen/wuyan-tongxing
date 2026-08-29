import type { QuitPhase, QuitStrategy, Trigger } from '@wuyan/contracts'

const QUIT_STRATEGIES = ['ABRUPT', 'REDUCE_THEN_QUIT'] as const
const QUIT_PHASES = ['ONBOARDING', 'PREPARATION', 'REDUCTION', 'QUIT_DAY', 'ACTIVE_28', 'MAINTENANCE'] as const
const TRIGGERS = [
  'AFTER_MEAL',
  'ALCOHOL',
  'COFFEE_TEA',
  'WORK_BREAK',
  'DRIVING',
  'SOCIAL_OFFER',
  'STRESS',
  'BOREDOM',
  'NEGATIVE_EMOTION',
  'OTHER_STRUCTURED',
] as const
const TIME_BUCKETS = ['MORNING', 'MIDDAY', 'EVENING', 'NIGHT'] as const
const DEPENDENCE_BANDS = ['LOWER', 'HIGHER'] as const
const ACTION_TYPES = ['PRIMARY_CONTENT', 'SUPPORT_CARD', 'SOS', 'LAPSE_RECOVERY', 'FOLLOW_UP'] as const

export type TimeBucket = (typeof TIME_BUCKETS)[number]

export interface RuleInput {
  strategy: QuitStrategy
  phase: QuitPhase
  relativeDay: number
  dependenceBand: 'LOWER' | 'HIGHER'
  recentCraving: number | null
  recentLapse: boolean
  selectedTriggers: Trigger[]
  completedTaskIds: string[]
  localTimeBucket: TimeBucket
}

export interface RuleCondition {
  strategies?: QuitStrategy[]
  phases?: QuitPhase[]
  relativeDayMin?: number
  relativeDayMax?: number
  dependenceBands?: Array<'LOWER' | 'HIGHER'>
  minimumRecentCraving?: number
  recentLapse?: boolean
  anyTrigger?: Trigger[]
  completedTaskIdsAll?: string[]
  timeBuckets?: TimeBucket[]
}

export interface RuleDefinition {
  id: string
  version: string
  enabled: boolean
  priority: number
  condition: RuleCondition
  decision: {
    actionType: (typeof ACTION_TYPES)[number]
    contentId: string
    reasonCode: string
    evidenceSourceIds: string[]
    cooldownHours: number
  }
}

interface ValidationIssue {
  message: string
  path: Array<string | number>
}

class RuleValidationError extends Error {
  readonly issues: ValidationIssue[]

  constructor(message: string, path: Array<string | number> = []) {
    super(message)
    this.name = 'RuleValidationError'
    this.issues = [{ message, path }]
  }
}

type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: RuleValidationError }

interface RuntimeSchema<T> {
  parse(value: unknown): T
  safeParse(value: unknown): SafeParseResult<T>
}

function runtimeSchema<T>(parser: (value: unknown) => T): RuntimeSchema<T> {
  return {
    parse: parser,
    safeParse(value) {
      try {
        return { success: true, data: parser(value) }
      } catch (error) {
        const validationError = error instanceof RuleValidationError
          ? error
          : new RuleValidationError(error instanceof Error ? error.message : '规则格式无效')
        return { success: false, error: validationError }
      }
    },
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuleValidationError(`${label}必须是对象`)
  }
  return value as Record<string, unknown>
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new RuleValidationError(`${label}包含未允许字段：${unknown}`, [unknown])
}

function stringValue(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new RuleValidationError(`${label}格式无效`)
  }
  return value
}

function integerValue(value: unknown, label: string, minimum?: number, maximum?: number): number {
  if (
    !Number.isSafeInteger(value)
    || (minimum !== undefined && (value as number) < minimum)
    || (maximum !== undefined && (value as number) > maximum)
  ) {
    throw new RuleValidationError(`${label}必须是有效整数`)
  }
  return value as number
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new RuleValidationError(`${label}必须是布尔值`)
  return value
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new RuleValidationError(`${label}不在允许范围内`)
  }
  return value as T[number]
}

function arrayValue<T>(value: unknown, label: string, parseItem: (item: unknown, index: number) => T): T[] {
  if (!Array.isArray(value)) throw new RuleValidationError(`${label}必须是数组`)
  return value.map(parseItem)
}

function optionalArray<T>(
  source: Record<string, unknown>,
  key: string,
  parseItem: (item: unknown, index: number) => T,
): T[] | undefined {
  const value = source[key]
  return value === undefined ? undefined : arrayValue(value, key, parseItem)
}

function parseTimeBucket(value: unknown): TimeBucket {
  return enumValue(value, TIME_BUCKETS, 'timeBucket')
}

function parseRuleCondition(value: unknown): RuleCondition {
  const input = record(value, 'condition')
  rejectUnknownKeys(input, [
    'strategies',
    'phases',
    'relativeDayMin',
    'relativeDayMax',
    'dependenceBands',
    'minimumRecentCraving',
    'recentLapse',
    'anyTrigger',
    'completedTaskIdsAll',
    'timeBuckets',
  ], 'condition')

  const result: RuleCondition = {}
  const strategies = optionalArray(input, 'strategies', (item) => enumValue(item, QUIT_STRATEGIES, 'strategy'))
  const phases = optionalArray(input, 'phases', (item) => enumValue(item, QUIT_PHASES, 'phase'))
  const dependenceBands = optionalArray(input, 'dependenceBands', (item) => enumValue(item, DEPENDENCE_BANDS, 'dependenceBand'))
  const anyTrigger = optionalArray(input, 'anyTrigger', (item) => enumValue(item, TRIGGERS, 'trigger'))
  const completedTaskIdsAll = optionalArray(input, 'completedTaskIdsAll', (item) => {
    if (typeof item !== 'string') throw new RuleValidationError('completedTaskIdsAll 只能包含字符串')
    return item
  })
  const timeBuckets = optionalArray(input, 'timeBuckets', parseTimeBucket)

  if (strategies) result.strategies = strategies
  if (phases) result.phases = phases
  if (input.relativeDayMin !== undefined) result.relativeDayMin = integerValue(input.relativeDayMin, 'relativeDayMin')
  if (input.relativeDayMax !== undefined) result.relativeDayMax = integerValue(input.relativeDayMax, 'relativeDayMax')
  if (dependenceBands) result.dependenceBands = dependenceBands
  if (input.minimumRecentCraving !== undefined) {
    result.minimumRecentCraving = integerValue(input.minimumRecentCraving, 'minimumRecentCraving', 0, 10)
  }
  if (input.recentLapse !== undefined) result.recentLapse = booleanValue(input.recentLapse, 'recentLapse')
  if (anyTrigger) result.anyTrigger = anyTrigger
  if (completedTaskIdsAll) result.completedTaskIdsAll = completedTaskIdsAll
  if (timeBuckets) result.timeBuckets = timeBuckets
  return result
}

function parseRuleDefinition(value: unknown): RuleDefinition {
  const input = record(value, 'rule')
  rejectUnknownKeys(input, ['id', 'version', 'enabled', 'priority', 'condition', 'decision'], 'rule')
  const decision = record(input.decision, 'decision')
  rejectUnknownKeys(decision, ['actionType', 'contentId', 'reasonCode', 'evidenceSourceIds', 'cooldownHours'], 'decision')
  const evidenceSourceIds = arrayValue(decision.evidenceSourceIds, 'evidenceSourceIds', (item) => {
    if (typeof item !== 'string') throw new RuleValidationError('evidenceSourceIds 只能包含字符串')
    return item
  })
  if (evidenceSourceIds.length === 0) throw new RuleValidationError('evidenceSourceIds 至少包含一项')

  return {
    id: stringValue(input.id, 'id', /^[a-z0-9][a-z0-9-]*$/),
    version: stringValue(input.version, 'version'),
    enabled: booleanValue(input.enabled, 'enabled'),
    priority: integerValue(input.priority, 'priority', 0, 10_000),
    condition: parseRuleCondition(input.condition),
    decision: {
      actionType: enumValue(decision.actionType, ACTION_TYPES, 'actionType'),
      contentId: stringValue(decision.contentId, 'contentId'),
      reasonCode: stringValue(decision.reasonCode, 'reasonCode', /^[A-Z0-9_]+$/),
      evidenceSourceIds,
      cooldownHours: integerValue(decision.cooldownHours, 'cooldownHours', 0, 24 * 365),
    },
  }
}

export const TimeBucketSchema = runtimeSchema(parseTimeBucket)
export const RuleConditionSchema = runtimeSchema(parseRuleCondition)
export const RuleDefinitionSchema = runtimeSchema(parseRuleDefinition)

export interface RuleDecision {
  actionType: RuleDefinition['decision']['actionType']
  contentId: string
  priority: number
  reasonCode: string
  evidenceSourceIds: string[]
  cooldownHours: number
  ruleId: string
  ruleVersion: string
  explanation: string
}

function includesAny<T>(left: T[], right: T[]): boolean {
  return left.some((value) => right.includes(value))
}

function matches(condition: RuleCondition, input: RuleInput): boolean {
  if (condition.strategies && !condition.strategies.includes(input.strategy)) return false
  if (condition.phases && !condition.phases.includes(input.phase)) return false
  if (condition.relativeDayMin !== undefined && input.relativeDay < condition.relativeDayMin) return false
  if (condition.relativeDayMax !== undefined && input.relativeDay > condition.relativeDayMax) return false
  if (condition.dependenceBands && !condition.dependenceBands.includes(input.dependenceBand)) return false
  if (condition.minimumRecentCraving !== undefined && (input.recentCraving ?? -1) < condition.minimumRecentCraving) return false
  if (condition.recentLapse !== undefined && input.recentLapse !== condition.recentLapse) return false
  if (condition.anyTrigger && !includesAny(input.selectedTriggers, condition.anyTrigger)) return false
  if (condition.completedTaskIdsAll && !condition.completedTaskIdsAll.every((id) => input.completedTaskIds.includes(id))) return false
  if (condition.timeBuckets && !condition.timeBuckets.includes(input.localTimeBucket)) return false
  return true
}

function specificity(condition: RuleCondition): number {
  return Object.values(condition).filter((value) => value !== undefined).length
}

function fallbackContent(input: RuleInput): { contentId: string; reasonCode: string } {
  if (input.phase === 'QUIT_DAY') return { contentId: 'day-01', reasonCode: 'QUIT_DAY_DEFAULT' }
  if (input.phase === 'ACTIVE_28') {
    const day = Math.min(28, Math.max(1, input.relativeDay + 1))
    return { contentId: `day-${String(day).padStart(2, '0')}`, reasonCode: 'PROGRAM_DAY_DEFAULT' }
  }
  if (input.phase === 'REDUCTION' || input.phase === 'PREPARATION') {
    // The seven preparation modules run in order during the final seven days.
    // Earlier preparation/reduction days keep prep-01 as a safe repeatable entry.
    const module = Math.min(7, Math.max(1, input.relativeDay + 8))
    return {
      contentId: `prep-${String(module).padStart(2, '0')}`,
      reasonCode: input.phase === 'REDUCTION' ? 'REDUCTION_DEFAULT' : 'PREPARATION_DEFAULT',
    }
  }
  if (input.phase === 'MAINTENANCE') {
    const week = Math.min(8, Math.max(5, 5 + Math.floor((input.relativeDay - 28) / 7)))
    return { contentId: `maintenance-week-${String(week).padStart(2, '0')}`, reasonCode: 'MAINTENANCE_DEFAULT' }
  }
  return { contentId: 'prep-01', reasonCode: 'SAFE_DEFAULT' }
}

const explanationByReason: Record<string, string> = {
  RECENT_LAPSE: '你刚记录了一次吸烟，先处理滑倒比继续课程更重要。',
  STRONG_CRAVING: '你最近记录的烟瘾较强，优先展示即时应对工具。',
  SOCIAL_TRIGGER: '你选择了递烟或聚会场景，展示拒烟与退出脚本。',
  STRESS_TRIGGER: '你选择了压力或负面情绪场景，展示短时减压方法。',
  HIGHER_DEPENDENCE_SUPPORT: '你的依赖提示较高，展示专业支持与药物科普入口。',
  QUIT_DAY_DEFAULT: '今天是你的戒烟日。',
  PROGRAM_DAY_DEFAULT: '这是当前戒烟日程对应的今日内容。',
  REDUCTION_DEFAULT: '你正在限期减量阶段。',
  PREPARATION_DEFAULT: '你正在为戒烟日做准备。',
  MAINTENANCE_DEFAULT: '你已进入长期巩固阶段。',
  SAFE_DEFAULT: '当前没有其他匹配内容，展示安全默认内容。',
}

export const defaultRules: RuleDefinition[] = [
  {
    id: 'recent-lapse-first',
    version: '1.0.0',
    enabled: true,
    priority: 100,
    condition: { recentLapse: true },
    decision: {
      actionType: 'LAPSE_RECOVERY',
      contentId: 'lapse-01',
      reasonCode: 'RECENT_LAPSE',
      evidenceSourceIds: ['WHO-TOBACCO-CESSATION-2024'],
      cooldownHours: 0,
    },
  },
  {
    id: 'strong-craving-sos',
    version: '1.0.0',
    enabled: true,
    priority: 90,
    condition: { minimumRecentCraving: 7 },
    decision: {
      actionType: 'SOS',
      contentId: 'sos-surf',
      reasonCode: 'STRONG_CRAVING',
      evidenceSourceIds: ['ICANQUIT-ACT-RCT-2020'],
      cooldownHours: 1,
    },
  },
  {
    id: 'social-trigger-plan',
    version: '1.0.0',
    enabled: true,
    priority: 70,
    condition: { anyTrigger: ['SOCIAL_OFFER', 'ALCOHOL'] },
    decision: {
      actionType: 'SUPPORT_CARD',
      contentId: 'day-19',
      reasonCode: 'SOCIAL_TRIGGER',
      evidenceSourceIds: ['WHO-TOBACCO-CESSATION-2024'],
      cooldownHours: 24,
    },
  },
  {
    id: 'stress-trigger-plan',
    version: '1.0.0',
    enabled: true,
    priority: 65,
    condition: { anyTrigger: ['STRESS', 'NEGATIVE_EMOTION'] },
    decision: {
      actionType: 'SUPPORT_CARD',
      contentId: 'day-08',
      reasonCode: 'STRESS_TRIGGER',
      evidenceSourceIds: ['WHO-TOBACCO-CESSATION-2024'],
      cooldownHours: 24,
    },
  },
  {
    id: 'higher-dependence-support',
    version: '1.0.0',
    enabled: true,
    priority: 60,
    condition: { dependenceBands: ['HIGHER'] },
    decision: {
      actionType: 'SUPPORT_CARD',
      contentId: 'medication-01',
      reasonCode: 'HIGHER_DEPENDENCE_SUPPORT',
      evidenceSourceIds: ['WHO-TOBACCO-CESSATION-2024'],
      cooldownHours: 72,
    },
  },
].map((rule) => RuleDefinitionSchema.parse(rule))

export function evaluateRules(
  input: RuleInput,
  definitions: RuleDefinition[] = defaultRules,
): RuleDecision {
  const parsed = definitions.map((definition) => RuleDefinitionSchema.parse(definition))
  const winner = parsed
    .filter((definition) => definition.enabled && matches(definition.condition, input))
    .sort((left, right) =>
      right.priority - left.priority
      || specificity(right.condition) - specificity(left.condition)
      || left.id.localeCompare(right.id),
    )[0]

  if (!winner) {
    const fallback = fallbackContent(input)
    return {
      actionType: 'PRIMARY_CONTENT',
      contentId: fallback.contentId,
      priority: 0,
      reasonCode: fallback.reasonCode,
      evidenceSourceIds: ['WHO-TOBACCO-CESSATION-2024'],
      cooldownHours: 0,
      ruleId: 'safe-fallback',
      ruleVersion: '1.0.0',
      explanation: explanationByReason[fallback.reasonCode] ?? explanationByReason.SAFE_DEFAULT!,
    }
  }

  return {
    ...winner.decision,
    priority: winner.priority,
    evidenceSourceIds: [...winner.decision.evidenceSourceIds],
    ruleId: winner.id,
    ruleVersion: winner.version,
    explanation: explanationByReason[winner.decision.reasonCode] ?? explanationByReason.SAFE_DEFAULT!,
  }
}
