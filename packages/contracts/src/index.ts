import { z } from 'zod'

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '必须使用 YYYY-MM-DD')
export const IsoDateTimeSchema = z.string().datetime({ offset: true })
export const UuidSchema = z.string().uuid()

export const QuitStrategySchema = z.enum(['ABRUPT', 'REDUCE_THEN_QUIT'])
export type QuitStrategy = z.infer<typeof QuitStrategySchema>

export const QuitPhaseSchema = z.enum([
  'ONBOARDING',
  'PREPARATION',
  'REDUCTION',
  'QUIT_DAY',
  'ACTIVE_28',
  'MAINTENANCE',
])
export type QuitPhase = z.infer<typeof QuitPhaseSchema>

export const TimeToFirstCigaretteSchema = z.enum(['WITHIN_5', '6_TO_30', '31_TO_60', 'AFTER_60'])
export type TimeToFirstCigarette = z.infer<typeof TimeToFirstCigaretteSchema>

export const TriggerSchema = z.enum([
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
])
export type Trigger = z.infer<typeof TriggerSchema>

export const BaselineAssessmentSchema = z.object({
  id: UuidSchema,
  ageConfirmed: z.literal(true),
  currentPaperCigaretteUser: z.literal(true),
  cigarettesPerDay: z.number().int().min(1).max(100),
  timeToFirstCigarette: TimeToFirstCigaretteSchema,
  previousQuitAttempts: z.number().int().min(0).max(100),
  reasons: z.array(z.string().trim().min(1).max(80)).min(1).max(3),
  triggers: z.array(TriggerSchema).min(1).max(3),
  assessedAt: IsoDateTimeSchema,
}).strict()
export type BaselineAssessment = z.infer<typeof BaselineAssessmentSchema>

export const ReductionTargetSchema = z.object({
  date: IsoDateSchema,
  maximumCigarettes: z.number().int().min(0).max(100),
  ratio: z.union([z.literal(0.75), z.literal(0.5), z.literal(0.25), z.literal(0)]),
}).strict()
export type ReductionTarget = z.infer<typeof ReductionTargetSchema>

export const QuitPlanSchema = z.object({
  id: UuidSchema,
  attemptNumber: z.number().int().min(1),
  strategy: QuitStrategySchema,
  startDate: IsoDateSchema,
  quitDate: IsoDateSchema,
  timezone: z.literal('Asia/Shanghai'),
  baselineCigarettesPerDay: z.number().int().min(1).max(100),
  pricePerPackCny: z.number().min(0).max(10_000).nullable(),
  cigarettesPerPack: z.number().int().min(1).max(100).default(20),
  reductionTargets: z.array(ReductionTargetSchema),
  status: z.enum(['ACTIVE', 'COMPLETED', 'ARCHIVED']),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict()
export type QuitPlan = z.infer<typeof QuitPlanSchema>

export const MoodSchema = z.enum(['CALM', 'HAPPY', 'NEUTRAL', 'TIRED', 'ANXIOUS', 'SAD', 'ANGRY'])
export type Mood = z.infer<typeof MoodSchema>

export const DailyCheckInSchema = z.object({
  id: UuidSchema,
  attemptId: UuidSchema,
  date: IsoDateSchema,
  cigarettesSmoked: z.number().int().min(0).max(100),
  cravingIntensity: z.number().int().min(0).max(10),
  mood: MoodSchema.nullable(),
  triggers: z.array(TriggerSchema).max(3),
  taskCompleted: z.boolean(),
  recordedAt: IsoDateTimeSchema,
}).strict()
export type DailyCheckIn = z.infer<typeof DailyCheckInSchema>

export const CravingEventSchema = z.object({
  id: UuidSchema,
  attemptId: UuidSchema,
  occurredAt: IsoDateTimeSchema,
  intensityBefore: z.number().int().min(0).max(10),
  intensityAfter: z.number().int().min(0).max(10).nullable(),
  triggers: z.array(TriggerSchema).max(3),
  copingToolId: z.string().trim().min(1).max(80).nullable(),
  outcome: z.enum(['EASED', 'STILL_STRONG', 'SMOKED', 'UNKNOWN']),
}).strict()
export type CravingEvent = z.infer<typeof CravingEventSchema>

export const CigaretteLogSchema = z.object({
  id: UuidSchema,
  attemptId: UuidSchema,
  smokedAt: IsoDateTimeSchema,
  trigger: TriggerSchema.nullable(),
  cravingIntensity: z.number().int().min(1).max(5).nullable().optional(),
  source: z.enum(['QUICK_LOG', 'DAILY_CHECKIN', 'LAPSE_FLOW']),
}).strict()
export type CigaretteLog = z.infer<typeof CigaretteLogSchema>

export const LapseEventSchema = z.object({
  id: UuidSchema,
  attemptId: UuidSchema,
  occurredAt: IsoDateTimeSchema,
  trigger: TriggerSchema.nullable(),
  recoveryChoice: z.enum(['CONTINUE_NOW', 'UPDATE_PLAN', 'CONTACT_PARTNER', 'NEW_QUIT_DATE', 'PROFESSIONAL_SUPPORT']),
  createdAt: IsoDateTimeSchema,
}).strict()
export type LapseEvent = z.infer<typeof LapseEventSchema>

export const TaskProgressSchema = z.object({
  taskId: z.string().trim().min(1).max(80),
  attemptId: UuidSchema,
  status: z.enum(['AVAILABLE', 'COMPLETED', 'SKIPPED']),
  completedAt: IsoDateTimeSchema.nullable(),
}).strict()
export type TaskProgress = z.infer<typeof TaskProgressSchema>

const AbstinenceAnswerSchema = z.union([z.boolean(), z.null()])
export const OutcomeAssessmentSchema = z.object({
  id: UuidSchema,
  attemptId: UuidSchema,
  dueMonth: z.union([z.literal(3), z.literal(6), z.literal(12)]),
  assessedAt: IsoDateTimeSchema,
  sevenDayAbstinent: AbstinenceAnswerSchema,
  thirtyDayAbstinent: AbstinenceAnswerSchema,
  continuouslyAbstinentSinceQuitDate: AbstinenceAnswerSchema,
  currentCigarettesPerDay: z.number().int().min(0).max(100).nullable(),
  additionalQuitAttempts: z.number().int().min(0).max(100).nullable(),
  confidence: z.number().int().min(0).max(10).nullable(),
  usedProfessionalSupport: z.boolean().nullable(),
  selfReported: z.literal(true),
  biochemicallyVerified: z.literal(false),
}).strict()
export type OutcomeAssessment = z.infer<typeof OutcomeAssessmentSchema>

export const ConsentScopeSchema = z.enum([
  'SENSITIVE_HEALTH_DATA',
  'CLOUD_SYNC',
  'PSEUDONYMOUS_ANALYTICS',
  'SUBSCRIPTION_MESSAGES',
])
export type ConsentScope = z.infer<typeof ConsentScopeSchema>

export const ConsentReceiptSchema = z.object({
  id: UuidSchema,
  scope: ConsentScopeSchema,
  granted: z.boolean(),
  policyVersion: z.string().trim().min(1).max(40),
  recordedAt: IsoDateTimeSchema,
}).strict()
export type ConsentReceipt = z.infer<typeof ConsentReceiptSchema>

export const ReminderIntentSchema = z.object({
  id: UuidSchema,
  type: z.enum(['TODAY_TASK', 'FOLLOW_UP', 'GENTLE_RETURN']),
  dueAt: IsoDateTimeSchema,
  channel: z.enum(['IN_APP', 'WECHAT_SUBSCRIPTION']),
  status: z.enum(['PENDING', 'DELIVERED', 'FAILED', 'DECLINED', 'EXPIRED']),
  neutralTemplateKey: z.string().trim().min(1).max(80),
  idempotencyKey: z.string().trim().min(8).max(160),
  createdAt: IsoDateTimeSchema,
}).strict()
export type ReminderIntent = z.infer<typeof ReminderIntentSchema>

export const ReminderPreferenceSchema = z.object({
  id: UuidSchema,
  todayTaskEnabled: z.boolean(),
  followUpEnabled: z.boolean(),
  gentleReturnEnabled: z.boolean(),
  preferredTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '必须使用 HH:mm'),
  updatedAt: IsoDateTimeSchema,
}).strict()
export type ReminderPreference = z.infer<typeof ReminderPreferenceSchema>

export const SyncObjectTypeSchema = z.enum([
  'BASELINE',
  'QUIT_PLAN',
  'DAILY_CHECKIN',
  'CRAVING_EVENT',
  'CIGARETTE_LOG',
  'LAPSE_EVENT',
  'TASK_PROGRESS',
  'OUTCOME',
  'REMINDER_PREFERENCE',
])
export type SyncObjectType = z.infer<typeof SyncObjectTypeSchema>

const SyncPayloadSchemas = {
  BASELINE: BaselineAssessmentSchema,
  QUIT_PLAN: QuitPlanSchema,
  DAILY_CHECKIN: DailyCheckInSchema,
  CRAVING_EVENT: CravingEventSchema,
  CIGARETTE_LOG: CigaretteLogSchema,
  LAPSE_EVENT: LapseEventSchema,
  TASK_PROGRESS: TaskProgressSchema,
  OUTCOME: OutcomeAssessmentSchema,
  REMINDER_PREFERENCE: ReminderPreferenceSchema,
} as const

export const SyncMutationSchema = z.object({
  opId: UuidSchema,
  objectId: UuidSchema,
  objectType: SyncObjectTypeSchema,
  operation: z.enum(['UPSERT', 'DELETE']),
  objectVersion: z.number().int().min(1),
  payload: z.record(z.string(), z.unknown()).nullable(),
  clientChangedAt: IsoDateTimeSchema,
}).strict().superRefine((mutation, context) => {
  if (mutation.operation === 'DELETE') {
    if (mutation.payload !== null) {
      context.addIssue({ code: 'custom', path: ['payload'], message: 'DELETE 变更不得携带数据' })
    }
    return
  }
  if (mutation.payload === null) {
    context.addIssue({ code: 'custom', path: ['payload'], message: 'UPSERT 变更必须携带完整对象' })
    return
  }
  const parsed = SyncPayloadSchemas[mutation.objectType].safeParse(mutation.payload)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: 'custom',
        path: ['payload', ...issue.path],
        message: issue.message,
      })
    }
    return
  }
  if ('id' in parsed.data && parsed.data.id !== mutation.objectId) {
    context.addIssue({ code: 'custom', path: ['objectId'], message: 'objectId 必须与 payload.id 一致' })
  }
})
export type SyncMutation = z.infer<typeof SyncMutationSchema>

export const TelemetryEventSchema = z.object({
  eventId: UuidSchema,
  analyticsId: UuidSchema,
  name: z.enum([
    'APP_OPENED',
    'ONBOARDING_COMPLETED',
    'TASK_COMPLETED',
    'SOS_STARTED',
    'SOS_COMPLETED',
    'FOLLOW_UP_SUBMITTED',
  ]),
  occurredAt: IsoDateTimeSchema,
  phase: QuitPhaseSchema.nullable(),
  properties: z.object({
    contentId: z.string().trim().min(1).max(80).optional(),
    ruleVersion: z.string().trim().min(1).max(40).optional(),
    stage: QuitPhaseSchema.optional(),
    completed: z.boolean().optional(),
    followUpMonth: z.union([z.literal(3), z.literal(6), z.literal(12)]).optional(),
  }).strict(),
}).strict()
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>

export const SyncPushRequestSchema = z.object({
  deviceId: UuidSchema,
  mutations: z.array(SyncMutationSchema).max(250),
}).strict()
export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>

export const SyncPushResponseSchema = z.object({
  acceptedOpIds: z.array(UuidSchema),
  acknowledgements: z.array(z.object({
    opId: UuidSchema,
    status: z.enum(['applied', 'duplicate']),
    revision: z.number().int().min(1),
  }).strict()),
  conflicts: z.array(z.object({
    objectId: UuidSchema,
    objectType: SyncObjectTypeSchema,
    localVersion: z.number().int().min(1),
    cloudVersion: z.number().int().min(1),
    cloudPayload: z.record(z.string(), z.unknown()).nullable(),
    reason: z.enum([
      'version_requires_user_choice',
      'multiple_active_quit_plans_require_user_choice',
      'idempotency_key_reused',
    ]),
    otherObjectId: UuidSchema.optional(),
  }).strict()),
  serverCursor: z.string().regex(/^\d+$/),
}).strict()
export type SyncPushResponse = z.infer<typeof SyncPushResponseSchema>

export const ExportRequestSchema = z.object({
  format: z.enum(['JSON', 'CSV_ZIP']),
  includeTelemetry: z.boolean().default(false),
}).strict()
export type ExportRequest = z.infer<typeof ExportRequestSchema>

export const MedicalContentStatusSchema = z.enum(['DRAFT', 'EVIDENCE_VERIFIED', 'MEDICALLY_APPROVED', 'PUBLISHED', 'RETIRED'])
export type MedicalContentStatus = z.infer<typeof MedicalContentStatusSchema>

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>
