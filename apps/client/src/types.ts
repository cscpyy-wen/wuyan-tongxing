import type {
  BaselineAssessment,
  CigaretteLog,
  ConsentReceipt,
  CravingEvent,
  DailyCheckIn,
  LapseEvent,
  OutcomeAssessment,
  QuitPlan,
  ReminderIntent,
  SyncMutation,
} from '@wuyan/contracts'

/** Compile-time bridge documenting the shared contract surface used by this client. */
export interface SharedContractSurface {
  baseline: BaselineAssessment
  plan: QuitPlan
  checkIn: DailyCheckIn
  craving: CravingEvent
  cigarette: CigaretteLog
  lapse: LapseEvent
  outcome: OutcomeAssessment
  consent: ConsentReceipt
  reminder: ReminderIntent
  mutation: SyncMutation
}

export type QuitPath = 'abrupt' | 'reduction'
export type Trigger =
  | 'work'
  | 'meal'
  | 'toilet'
  | 'stress'
  | 'social'
  | 'alcohol'
  | 'exercise'
  | 'boredom'
  | 'morning'
  | 'coffee'
  | 'habit'
export type CravingLevel = 1 | 2 | 3 | 4 | 5

export interface ClientBaseline {
  cigarettesPerDay: number
  firstCigaretteMinutes: number
  previousAttempts: number
  reasons: string[]
  triggers: Trigger[]
  pricePerPack: number
}

export interface ClientQuitPlan {
  id: string
  path: QuitPath
  createdAt: string
  quitDate: string
  baselineCigarettesPerDay: number
  baselinePricePerPack: number
  attemptNumber: number
  reductionLimits?: {
    stage75: number
    stage50: number
    stage25: number
  }
}

export interface ClientCheckIn {
  id: string
  date: string
  cigarettesSmoked: number
  cravingPeak: CravingLevel
  smokeFree: boolean
  createdAt: string
  attemptId: string
}

export interface ClientCravingEvent {
  id: string
  createdAt: string
  level: CravingLevel
  trigger?: Trigger
  technique?: string
  resolved?: boolean
  attemptId: string
}

export interface ClientCigaretteLog {
  /** Actual smoking instant; retained as createdAt for v1 storage compatibility. */
  id: string
  createdAt: string
  loggedAt?: string
  updatedAt?: string
  count: number
  trigger?: Trigger
  /** Omitted by one-tap system shortcuts and some legacy records. */
  cravingIntensity?: CravingLevel
  attemptId?: string
  source?: 'QUICK_LOG' | 'DAILY_CHECKIN' | 'LAPSE_FLOW'
}

export interface ClientLapseEvent {
  id: string
  createdAt: string
  cigarettes: number
  trigger?: Trigger
  /** Captured for new lapse-flow cigarettes; optional for legacy backups. */
  cravingIntensity?: CravingLevel
  recoveryAction: string
  /**
   * References the visible cigarette record for this recovery event.
   * Optional only while reading legacy v1 backups that predate atomic linking;
   * every newly committed lapse includes it.
   */
  cigaretteLogId?: string
  attemptId: string
}

export interface ClientOutcomeAssessment {
  id: string
  planId: string
  dueMonth: 3 | 6 | 12
  assessedAt: string
  sevenDayAbstinent: boolean | null
  thirtyDayAbstinent: boolean | null
  continuouslyAbstinent: boolean | null
  currentCigarettesPerDay: number | null
  additionalQuitAttempts: number | null
  confidence: number | null
  usedProfessionalSupport: boolean | null
  selfReported: true
  biochemicallyVerified: false
}

export interface CompletedTask {
  contentId: string
  completedAt: string
  attemptId: string
}

export interface ClientSettings {
  sensitiveHealthData: boolean
  inAppReminder: boolean
  reminderHour: number
  subscriptionEnabled: boolean
  subscriptionStatus?: 'not-requested' | 'simulated' | 'denied'
  cloudSync: boolean
  outcomeAnalytics: boolean
  syncConsentAt?: string | undefined
  analyticsConsentAt?: string | undefined
}

export interface ClientState {
  version: 1
  onboarded: boolean
  baseline?: ClientBaseline
  plan?: ClientQuitPlan
  /** Previous plans are retained when the user deliberately starts a new attempt. */
  archivedPlans: ClientQuitPlan[]
  lastCigaretteAt?: string
  checkIns: ClientCheckIn[]
  cravings: ClientCravingEvent[]
  cigarettes: ClientCigaretteLog[]
  /** Prevents a crash-left static queue item from reviving a user-deleted log. */
  deletedCigaretteIds: string[]
  lapses: ClientLapseEvent[]
  outcomes: ClientOutcomeAssessment[]
  completedTasks: CompletedTask[]
  settings: ClientSettings
}

export interface OnboardingPayload {
  baseline: ClientBaseline
  path: QuitPath
  quitDate: string
}

export interface ProgressSnapshot {
  currentStreakHours: number
  smokeFreeDays: number
  knownTrackingDays: number
  streakConfirmed: boolean
  lastRecordedCigaretteAt?: string
  cigarettesAvoided: number
  moneySaved: number
  completedTasks: number
  attemptNumber: number
}
