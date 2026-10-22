import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AndroidBootstrapStorage } from './androidBootstrapQueue'
import { offerRecoveryRotation } from './nativeRecoveryRotation'

const mocks = vi.hoisted(() => ({
  showModal: vi.fn(),
  showToast: vi.fn(),
  getStorage: vi.fn(),
  hasRecovery: vi.fn(),
  rotate: vi.fn(),
  runModal: vi.fn(),
}))

vi.mock('@tarojs/taro', () => ({ default: { showModal: mocks.showModal, showToast: mocks.showToast } }))
vi.mock('./androidHealthStorage', () => ({ getAndroidHealthStorage: mocks.getStorage }))
vi.mock('./androidBootstrapQueue', () => ({
  hasAndroidBootstrapRecoveryToRotate: mocks.hasRecovery,
  rotateAndroidBootstrapCorruptArchiveAfterExport: mocks.rotate,
}))
vi.mock('./modalCoordinator', () => ({ runAppModal: mocks.runModal }))

let storage: AndroidBootstrapStorage
let snapshot: Map<string, string>

beforeEach(() => {
  vi.resetAllMocks()
  snapshot = new Map([['private-recovery-snapshot', '{"health":"必须保留的原始恢复证据"}']])
  storage = {
    getItem: vi.fn((key) => snapshot.get(key) ?? null),
    setItem: vi.fn((key, value) => { snapshot.set(key, value) }),
    removeItem: vi.fn((key) => { snapshot.delete(key) }),
  }
  mocks.getStorage.mockReturnValue(storage)
  mocks.hasRecovery.mockReturnValue(true)
  mocks.showModal.mockResolvedValue({ confirm: true, cancel: false })
  mocks.runModal.mockImplementation((show: () => Promise<unknown>) => show())
})

describe('post-export native recovery rotation', () => {
  it('keeps the entire recovery snapshot untouched when the user cancels', async () => {
    mocks.showModal.mockResolvedValue({ confirm: false, cancel: true })
    const before = [...snapshot]
    const consume = vi.fn()

    await offerRecoveryRotation(consume)

    expect(mocks.runModal).toHaveBeenCalledOnce()
    expect(mocks.showModal).toHaveBeenCalledWith(expect.objectContaining({
      title: '释放快速记录恢复区？',
      confirmText: '确认释放',
      cancelText: '继续保留',
    }))
    expect(mocks.rotate).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect([...snapshot]).toEqual(before)
    expect(mocks.showToast).not.toHaveBeenCalled()
  })

  it('does not prompt when there is no recovery archive', async () => {
    mocks.hasRecovery.mockReturnValue(false)
    const consume = vi.fn()

    await offerRecoveryRotation(consume)

    expect(mocks.hasRecovery).toHaveBeenCalledWith(storage)
    expect(mocks.runModal).not.toHaveBeenCalled()
    expect(mocks.showModal).not.toHaveBeenCalled()
    expect(mocks.rotate).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()
  })

  it('does not inspect archives or prompt when native storage is unavailable', async () => {
    mocks.getStorage.mockReturnValue(undefined)
    const consume = vi.fn()

    await offerRecoveryRotation(consume)

    expect(mocks.hasRecovery).not.toHaveBeenCalled()
    expect(mocks.runModal).not.toHaveBeenCalled()
    expect(mocks.rotate).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()
  })

  it('rotates only after explicit confirmation, then consumes the queue before reporting success', async () => {
    const consume = vi.fn()

    await offerRecoveryRotation(consume)

    expect(mocks.rotate).toHaveBeenCalledExactlyOnceWith(storage)
    expect(mocks.showModal.mock.invocationCallOrder[0]).toBeLessThan(mocks.rotate.mock.invocationCallOrder[0]!)
    expect(mocks.rotate.mock.invocationCallOrder[0]).toBeLessThan(consume.mock.invocationCallOrder[0]!)
    expect(consume.mock.invocationCallOrder[0]).toBeLessThan(mocks.showToast.mock.invocationCallOrder[0]!)
    expect(mocks.showToast).toHaveBeenCalledExactlyOnceWith({ title: '快速记录恢复区已释放', icon: 'success' })
  })

  it('does not consume or report success when archive rotation fails', async () => {
    const before = [...snapshot]
    mocks.rotate.mockImplementation(() => { throw new Error('archive write failed') })
    const consume = vi.fn()

    await expect(offerRecoveryRotation(consume)).resolves.toBeUndefined()

    expect(consume).not.toHaveBeenCalled()
    expect([...snapshot]).toEqual(before)
    expect(mocks.showToast).toHaveBeenCalledExactlyOnceWith({ title: '操作未全部完成，请保留导出副本', icon: 'none' })
  })

  it('does not falsely claim the archive is unchanged if consuming after rotation fails', async () => {
    const consume = vi.fn(() => { throw new Error('queue replay failed') })

    await expect(offerRecoveryRotation(consume)).resolves.toBeUndefined()

    expect(mocks.rotate).toHaveBeenCalledOnce()
    expect(consume).toHaveBeenCalledOnce()
    expect(mocks.showToast).toHaveBeenCalledExactlyOnceWith({ title: '操作未全部完成，请保留导出副本', icon: 'none' })
  })

  it('leaves recovery evidence intact when the confirmation dialog cannot be shown', async () => {
    const before = [...snapshot]
    mocks.showModal.mockRejectedValue(new Error('modal unavailable'))
    const consume = vi.fn()

    await expect(offerRecoveryRotation(consume)).rejects.toThrow('modal unavailable')

    expect(mocks.rotate).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()
    expect([...snapshot]).toEqual(before)
    expect(mocks.showToast).not.toHaveBeenCalled()
  })
})
