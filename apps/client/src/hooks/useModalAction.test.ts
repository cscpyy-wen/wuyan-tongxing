import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAppModal } from '../lib/modalCoordinator'
import { useModalAction } from './useModalAction'

const mocks = vi.hoisted(() => ({ showToast: vi.fn() }))
vi.mock('@tarojs/taro', () => ({ default: { showToast: mocks.showToast } }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

beforeEach(() => vi.resetAllMocks())

describe('shared Today modal action guard', () => {
  it('blocks same-tick repeated taps, including after a rerender, and permits the next intentional action', async () => {
    const { result, rerender, unmount } = renderHook(useModalAction)
    const pending = deferred<void>()
    const first = vi.fn(() => pending.promise)
    const duplicate = vi.fn(async () => undefined)
    const completion = result.current(first)

    await result.current(duplicate)
    rerender()
    await result.current(duplicate)
    expect(first).toHaveBeenCalledOnce()
    expect(duplicate).not.toHaveBeenCalled()

    pending.resolve(undefined)
    await completion
    await result.current(duplicate)
    expect(duplicate).toHaveBeenCalledOnce()
    unmount()
  })

  it('releases after cancellation without committing and lets the user deliberately try again', async () => {
    const { result, unmount } = renderHook(useModalAction)
    const commit = vi.fn()
    const show = vi.fn<() => Promise<{ confirm: boolean }>>()
      .mockResolvedValueOnce({ confirm: false }).mockResolvedValueOnce({ confirm: true })
    const action = async () => {
      const choice = await runAppModal(show)
      if (choice.confirm) commit()
    }

    await result.current(action)
    expect(commit).not.toHaveBeenCalled()
    await result.current(action)
    expect(show).toHaveBeenCalledTimes(2)
    expect(commit).toHaveBeenCalledOnce()
    expect(mocks.showToast).not.toHaveBeenCalled()
    unmount()
  })

  it('releases after a failed modal and even failed error feedback; neither failure poisons subsequent actions', async () => {
    const { result, unmount } = renderHook(useModalAction)
    mocks.showToast.mockRejectedValue(new Error('toast unavailable'))
    const next = vi.fn(async () => undefined)

    await expect(result.current(async () => {
      await runAppModal(async () => { throw new Error('modal unavailable') })
    })).resolves.toBeUndefined()
    await result.current(() => runAppModal(next))

    expect(mocks.showToast).toHaveBeenCalledWith({ title: '无法打开确认框，请重试', icon: 'none' })
    expect(next).toHaveBeenCalledOnce()
    unmount()
  })

  it('queues behind an existing infrastructure modal and does not replace its callback or lose the later action', async () => {
    const infrastructureChoice = deferred<void>()
    const infrastructure = runAppModal(() => infrastructureChoice.promise)
    const { result, unmount } = renderHook(useModalAction)
    const showPageModal = vi.fn(async () => ({ confirm: true }))
    const commit = vi.fn()
    const action = vi.fn(async () => {
      const choice = await runAppModal(showPageModal)
      if (choice.confirm) commit()
    })
    const completion = result.current(action)
    await result.current(action)
    await Promise.resolve()
    expect(showPageModal).not.toHaveBeenCalled()

    infrastructureChoice.resolve(undefined)
    await infrastructure
    await completion
    expect(action).toHaveBeenCalledOnce()
    expect(showPageModal).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledOnce()
    await expect(runAppModal(async () => 'next infrastructure dialog')).resolves.toBe('next infrastructure dialog')
    unmount()
  })
})
