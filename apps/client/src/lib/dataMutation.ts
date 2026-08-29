export interface DataImportLease {
  isCurrent(): boolean
  release(): void
}

export interface DataImportReservation {
  readonly revision: number
}

export interface DataPlatformMutationLease {
  isCurrent(): boolean
  release(): void
}

export interface DestructiveDataMutationLease {
  release(): void
}

type ActiveMutation = {
  token: symbol
  kind: 'import' | 'platform' | 'destructive'
}

/**
 * Coordinates whole-state imports and destructive deletion without putting
 * sensitive backup JSON into a queue. Destructive work invalidates imports as
 * soon as it is requested, then waits for any in-flight platform call to wind
 * down before it starts cleanup.
 */
export class DataMutationCoordinator {
  private importRevision = 0
  private active: ActiveMutation | undefined
  private destructiveRequests = 0
  private readonly idleWaiters = new Set<() => void>()

  invalidateImports(): void {
    this.importRevision += 1
  }

  canCommitRegularMutation(): boolean {
    return this.destructiveRequests === 0 && this.active?.kind !== 'destructive'
  }

  reserveImport(): DataImportReservation | undefined {
    if (this.destructiveRequests > 0 || this.hasActiveDestructive()) return undefined
    return { revision: this.importRevision }
  }

  beginImport(reservation?: DataImportReservation): Promise<DataImportLease | undefined> {
    const requestedRevision = reservation?.revision ?? this.importRevision
    return this.beginRegularMutation('import', requestedRevision)
  }

  beginPlatformMutation(): Promise<DataPlatformMutationLease | undefined> {
    return this.beginRegularMutation('platform', this.importRevision)
  }

  private async beginRegularMutation(
    kind: 'import' | 'platform',
    requestedRevision: number,
  ): Promise<DataImportLease | undefined> {
    if (this.destructiveRequests > 0 || this.active?.kind === 'destructive') return undefined

    while (this.active) {
      await this.waitUntilIdle()
      if (
        requestedRevision !== this.importRevision
        || this.destructiveRequests > 0
        || this.hasActiveDestructive()
      ) return undefined
    }

    if (requestedRevision !== this.importRevision || this.destructiveRequests > 0) return undefined
    const token = Symbol(`data-${kind}`)
    this.active = { token, kind }
    let released = false
    return {
      isCurrent: () => (
        !released
        && this.active?.token === token
        && this.importRevision === requestedRevision
      ),
      release: () => {
        if (released) return
        released = true
        this.release(token)
      },
    }
  }

  async beginDestructiveMutation(): Promise<DestructiveDataMutationLease> {
    this.invalidateImports()
    this.destructiveRequests += 1
    try {
      while (this.active) await this.waitUntilIdle()
      const token = Symbol('destructive-data-mutation')
      this.active = { token, kind: 'destructive' }
      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          this.release(token)
        },
      }
    } finally {
      this.destructiveRequests = Math.max(0, this.destructiveRequests - 1)
    }
  }

  private waitUntilIdle(): Promise<void> {
    if (!this.active) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  private hasActiveDestructive(): boolean {
    return this.active?.kind === 'destructive'
  }

  private release(token: symbol): void {
    if (this.active?.token !== token) return
    this.active = undefined
    const waiters = [...this.idleWaiters]
    this.idleWaiters.clear()
    waiters.forEach((resolve) => resolve())
  }
}
