import { describe, expect, it } from 'vitest'
import { createMemoryPlatform } from './index'

describe('internal platform adapters', () => {
  it('keeps local use independent from identity binding', async () => {
    const platform = createMemoryPlatform()
    await platform.storage.set('plan', { id: 'local-only' })
    expect(await platform.identity.restore()).toBeNull()
    expect(await platform.storage.get('plan')).toEqual({ id: 'local-only' })
  })

  it('deduplicates reminder intents by idempotency key', async () => {
    const platform = createMemoryPlatform()
    const first = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'TODAY_TASK' as const,
      dueAt: '2026-08-23T09:00:00.000+08:00',
      channel: 'IN_APP' as const,
      status: 'PENDING' as const,
      neutralTemplateKey: 'today-task',
      idempotencyKey: 'today-task:2026-08-23',
      createdAt: '2026-08-23T08:00:00.000+08:00',
    }
    await platform.reminders.saveIntent(first)
    await platform.reminders.saveIntent({ ...first, id: '22222222-2222-4222-8222-222222222222' })
    expect(await platform.reminders.listDue(new Date('2026-08-23T02:00:00.000Z'))).toHaveLength(1)
  })
})
