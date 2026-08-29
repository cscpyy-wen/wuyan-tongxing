type ScheduleResult = 'scheduled' | 'denied' | 'unsupported'

interface ReminderPermissionRecoveryDependencies {
  reschedule(hour: number): Promise<ScheduleResult>
  cancel(): Promise<void>
  enableLocal(): boolean
  publish(active: boolean): void
}

export type ReminderPermissionRecoveryResult = 'scheduled' | 'denied' | 'failed'

/**
 * Completes the reminder intent after Android returns from app notification
 * settings. It never prompts again and fails closed: a native schedule is
 * cancelled if the matching local state cannot be committed.
 */
export async function recoverReminderPermissionAfterSettings(
  hour: number,
  dependencies: ReminderPermissionRecoveryDependencies,
): Promise<ReminderPermissionRecoveryResult> {
  try {
    const result = await dependencies.reschedule(hour)
    if (result !== 'scheduled') {
      dependencies.publish(false)
      return result === 'denied' ? 'denied' : 'failed'
    }
    if (!dependencies.enableLocal()) {
      await dependencies.cancel().catch(() => undefined)
      dependencies.publish(false)
      return 'failed'
    }
    dependencies.publish(true)
    return 'scheduled'
  } catch {
    await dependencies.cancel().catch(() => undefined)
    dependencies.publish(false)
    return 'failed'
  }
}
