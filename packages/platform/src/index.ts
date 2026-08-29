import type { ReminderIntent } from '@wuyan/contracts'

export interface StorageAdapter {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
  remove(key: string): Promise<void>
  keys(): Promise<string[]>
}

export interface IdentitySession {
  mode: 'MOCK' | 'WECHAT'
  userId: string
  accessToken: string
  expiresAt: string
}

export interface IdentityAdapter {
  mode: 'MOCK' | 'WECHAT'
  bind(): Promise<IdentitySession>
  restore(): Promise<IdentitySession | null>
  logout(): Promise<void>
}

export interface ReminderPermissionResult {
  granted: boolean
  platformResult: 'ACCEPT' | 'REJECT' | 'UNAVAILABLE' | 'MOCK_ACCEPT'
}

export interface ReminderAdapter {
  mode: 'IN_APP_ONLY' | 'WECHAT_SUBSCRIPTION' | 'MOCK'
  requestPermission(templateKey: string): Promise<ReminderPermissionResult>
  saveIntent(intent: ReminderIntent): Promise<void>
  listDue(now: Date): Promise<ReminderIntent[]>
}

export interface SharePayload {
  template: 'INVITE' | 'HELP' | 'MILESTONE' | 'RESTART'
  title: string
  message: string
  path?: string
}

export interface ShareAdapter {
  preview(payload: SharePayload): Promise<SharePayload>
  share(payload: SharePayload): Promise<'SHARED' | 'CANCELLED' | 'MOCKED'>
}

export interface PlatformAdapters {
  storage: StorageAdapter
  identity: IdentityAdapter
  reminders: ReminderAdapter
  share: ShareAdapter
}

export class MemoryStorageAdapter implements StorageAdapter {
  private readonly values = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value))
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key)
  }

  async keys(): Promise<string[]> {
    return [...this.values.keys()].sort()
  }
}

export class MockIdentityAdapter implements IdentityAdapter {
  readonly mode = 'MOCK' as const
  private session: IdentitySession | null = null

  async bind(): Promise<IdentitySession> {
    this.session = {
      mode: 'MOCK',
      userId: crypto.randomUUID(),
      accessToken: `mock.${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }
    return this.session
  }

  async restore(): Promise<IdentitySession | null> {
    return this.session
  }

  async logout(): Promise<void> {
    this.session = null
  }
}

export class MockReminderAdapter implements ReminderAdapter {
  readonly mode = 'MOCK' as const
  private readonly intents = new Map<string, ReminderIntent>()

  async requestPermission(): Promise<ReminderPermissionResult> {
    return { granted: true, platformResult: 'MOCK_ACCEPT' }
  }

  async saveIntent(intent: ReminderIntent): Promise<void> {
    this.intents.set(intent.idempotencyKey, structuredClone(intent))
  }

  async listDue(now: Date): Promise<ReminderIntent[]> {
    return [...this.intents.values()].filter((intent) =>
      intent.status === 'PENDING' && new Date(intent.dueAt) <= now,
    )
  }
}

export class MockShareAdapter implements ShareAdapter {
  async preview(payload: SharePayload): Promise<SharePayload> {
    return structuredClone(payload)
  }

  async share(): Promise<'MOCKED'> {
    return 'MOCKED'
  }
}

export function createMemoryPlatform(): PlatformAdapters {
  return {
    storage: new MemoryStorageAdapter(),
    identity: new MockIdentityAdapter(),
    reminders: new MockReminderAdapter(),
    share: new MockShareAdapter(),
  }
}
