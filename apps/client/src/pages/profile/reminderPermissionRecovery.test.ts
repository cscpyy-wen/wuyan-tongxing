import { describe, expect, it, vi } from 'vitest'
import { recoverReminderPermissionAfterSettings } from './reminderPermissionRecovery'

function dependencies(result: 'scheduled' | 'denied' | 'unsupported', enableLocal = true) {
  return {
    reschedule: vi.fn().mockResolvedValue(result),
    cancel: vi.fn().mockResolvedValue(undefined),
    enableLocal: vi.fn(() => enableLocal),
    publish: vi.fn(),
  }
}

describe('notification settings recovery', () => {
  it('schedules and commits the local switch after permission is granted', async () => {
    const deps = dependencies('scheduled')
    await expect(recoverReminderPermissionAfterSettings(20, deps)).resolves.toBe('scheduled')
    expect(deps.reschedule).toHaveBeenCalledWith(20)
    expect(deps.enableLocal).toHaveBeenCalledTimes(1)
    expect(deps.publish).toHaveBeenLastCalledWith(true)
    expect(deps.cancel).not.toHaveBeenCalled()
  })

  it('keeps the switch off when permission is still denied', async () => {
    const deps = dependencies('denied')
    await expect(recoverReminderPermissionAfterSettings(20, deps)).resolves.toBe('denied')
    expect(deps.enableLocal).not.toHaveBeenCalled()
    expect(deps.publish).toHaveBeenLastCalledWith(false)
  })

  it('cancels a native schedule when local persistence fails', async () => {
    const deps = dependencies('scheduled', false)
    await expect(recoverReminderPermissionAfterSettings(20, deps)).resolves.toBe('failed')
    expect(deps.cancel).toHaveBeenCalledTimes(1)
    expect(deps.publish).toHaveBeenLastCalledWith(false)
  })

  it('fails closed and cleans up after a native error', async () => {
    const deps = dependencies('scheduled')
    deps.reschedule.mockRejectedValueOnce(new Error('native failure'))
    await expect(recoverReminderPermissionAfterSettings(20, deps)).resolves.toBe('failed')
    expect(deps.cancel).toHaveBeenCalledTimes(1)
    expect(deps.publish).toHaveBeenLastCalledWith(false)
  })
})
