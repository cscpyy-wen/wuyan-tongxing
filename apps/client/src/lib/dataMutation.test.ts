import { describe, expect, it } from 'vitest'
import { DataMutationCoordinator } from './dataMutation'

describe('全局数据 mutation gate', () => {
  it('串行化导入并允许未被失效的等待导入继续', async () => {
    const coordinator = new DataMutationCoordinator()
    const first = await coordinator.beginImport(coordinator.reserveImport())
    expect(first?.isCurrent()).toBe(true)

    let secondResolved = false
    const secondPromise = coordinator.beginImport().then((lease) => {
      secondResolved = true
      return lease
    })
    await Promise.resolve()
    expect(secondResolved).toBe(false)

    first?.release()
    const second = await secondPromise
    expect(second?.isCurrent()).toBe(true)
    second?.release()
  })

  it('删除请求立即使活动及等待导入失效并在导入退出后独占执行', async () => {
    const coordinator = new DataMutationCoordinator()
    const activeImport = await coordinator.beginImport(coordinator.reserveImport())
    const waitingReservation = coordinator.reserveImport()
    const waitingImport = coordinator.beginImport(waitingReservation)
    const deletion = coordinator.beginDestructiveMutation()

    expect(activeImport?.isCurrent()).toBe(false)
    activeImport?.release()

    const deletionLease = await deletion
    expect(await waitingImport).toBeUndefined()
    expect(await coordinator.beginImport()).toBeUndefined()
    deletionLease.release()

    const laterImport = await coordinator.beginImport()
    expect(laterImport?.isCurrent()).toBe(true)
    laterImport?.release()
  })

  it('普通状态提交可以让异步导入租约失效', async () => {
    const coordinator = new DataMutationCoordinator()
    const lease = await coordinator.beginImport()
    coordinator.invalidateImports()
    expect(lease?.isCurrent()).toBe(false)
    lease?.release()
  })

  it('删除会使尚未取得锁的预留恢复失效', async () => {
    const coordinator = new DataMutationCoordinator()
    const reservation = coordinator.reserveImport()
    expect(reservation).toBeDefined()

    const deletion = await coordinator.beginDestructiveMutation()
    deletion.release()

    await expect(coordinator.beginImport(reservation)).resolves.toBeUndefined()
  })

  it('平台提醒变更与导入和删除共享同一独占门禁', async () => {
    const coordinator = new DataMutationCoordinator()
    const platform = await coordinator.beginPlatformMutation()
    const importReservation = coordinator.reserveImport()
    const waitingImport = coordinator.beginImport(importReservation)
    const deletion = coordinator.beginDestructiveMutation()

    expect(platform?.isCurrent()).toBe(false)
    platform?.release()
    const destructive = await deletion
    expect(await waitingImport).toBeUndefined()
    destructive.release()
  })
})
