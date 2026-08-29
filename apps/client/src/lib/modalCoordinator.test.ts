import { describe, expect, it, vi } from 'vitest'
import { runAppModal } from './modalCoordinator'

describe('global app modal coordinator', () => {
  it('never overlaps modal work and continues after a rejected modal', async () => {
    let releaseFirst!: () => void
    const first = runAppModal(() => new Promise<void>((resolve) => { releaseFirst = resolve }))
    const secondAction = vi.fn(async () => { throw new Error('platform modal failed') })
    const thirdAction = vi.fn(async () => 'third')
    const second = runAppModal(secondAction)
    const third = runAppModal(thirdAction)

    await Promise.resolve()
    expect(secondAction).not.toHaveBeenCalled()
    expect(thirdAction).not.toHaveBeenCalled()
    releaseFirst()
    await first
    await expect(second).rejects.toThrow('platform modal failed')
    await expect(third).resolves.toBe('third')
  })
})
