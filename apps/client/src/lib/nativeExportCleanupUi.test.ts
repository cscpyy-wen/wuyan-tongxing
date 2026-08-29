import { afterEach, describe, expect, it, vi } from 'vitest'
import { showNativeExportCleanupIssue } from './nativeExportCleanupUi'

const mocks = vi.hoisted(() => ({
  showModal: vi.fn(),
  showToast: vi.fn(),
  purge: vi.fn(),
  acknowledge: vi.fn(),
  forgetOutcome: vi.fn(),
  acknowledgePendingOutcome: vi.fn(),
}))

vi.mock('@tarojs/taro', () => ({
  default: {
    showModal: mocks.showModal,
    showToast: mocks.showToast,
  },
}))
vi.mock('./runtime', () => ({
  purgeNativePendingExports: mocks.purge,
  acknowledgeNativeSelectedDocumentCleanup: mocks.acknowledge,
  forgetNativeCorruptExportOutcome: mocks.forgetOutcome,
  acknowledgePendingNativeExportOutcome: mocks.acknowledgePendingOutcome,
}))

afterEach(() => vi.clearAllMocks())

describe('native export cleanup guidance', () => {
  it('retries private cleanup immediately when requested', async () => {
    mocks.showModal.mockResolvedValue({ confirm: true })
    mocks.purge.mockResolvedValue(undefined)

    await showNativeExportCleanupIssue('local-temporary')

    expect(mocks.showModal).toHaveBeenCalledWith(expect.objectContaining({
      confirmText: '重试清理',
      cancelText: '稍后',
    }))
    expect(mocks.purge).toHaveBeenCalledOnce()
    expect(mocks.showToast).toHaveBeenCalledWith({ title: '本机暂存已清理', icon: 'success' })
  })

  it('keeps selected-document cleanup guidance separate from private cleanup', async () => {
    mocks.showModal.mockResolvedValue({ confirm: true })
    mocks.acknowledge.mockResolvedValue(undefined)

    await showNativeExportCleanupIssue('selected-document')

    expect(mocks.showModal).toHaveBeenCalledWith(expect.objectContaining({
      confirmText: '已处理',
      cancelText: '稍后',
    }))
    expect(mocks.acknowledge).toHaveBeenCalledOnce()
    expect(mocks.purge).not.toHaveBeenCalled()
  })

  it('shows the durable selected filename without exposing its URI', async () => {
    mocks.showModal.mockResolvedValue({ confirm: false })

    await showNativeExportCleanupIssue('selected-document', 'wuyan-tongxing-backup.json')

    expect(mocks.showModal).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('wuyan-tongxing-backup.json'),
    }))
    expect(mocks.acknowledge).not.toHaveBeenCalled()
  })

  it('does not claim success when a manual retry still fails', async () => {
    mocks.showModal.mockResolvedValue({ confirm: true })
    mocks.purge.mockRejectedValue(new Error('locked'))

    await showNativeExportCleanupIssue('saved-local-temporary')

    expect(mocks.showToast).toHaveBeenCalledWith({ title: '仍未清理，将自动重试', icon: 'none' })
  })

  it('serializes concurrent startup warnings and merges them into the strongest dialog', async () => {
    mocks.showModal.mockResolvedValue({ confirm: false })

    await Promise.all([
      showNativeExportCleanupIssue('local-temporary'),
      showNativeExportCleanupIssue('both'),
    ])

    expect(mocks.showModal).toHaveBeenCalledOnce()
    expect(mocks.showModal).toHaveBeenCalledWith(expect.objectContaining({
      title: '两处清理都未完成',
    }))
  })

  it('still purges private temporary data when selected-document acknowledgement fails', async () => {
    mocks.showModal.mockResolvedValue({ confirm: true })
    mocks.acknowledge.mockRejectedValue(new Error('grant still held'))
    mocks.purge.mockResolvedValue(undefined)

    await showNativeExportCleanupIssue('both')

    expect(mocks.acknowledge).toHaveBeenCalledOnce()
    expect(mocks.purge).toHaveBeenCalledOnce()
    expect(mocks.showToast).toHaveBeenCalledWith({ title: '仍未清理，将自动重试', icon: 'none' })
  })

  it('settles after a platform modal rejection and can drain the next warning', async () => {
    mocks.showModal
      .mockRejectedValueOnce(new Error('modal unavailable'))
      .mockResolvedValueOnce({ confirm: false })

    await expect(showNativeExportCleanupIssue('selected-document')).resolves.toBe(false)
    await expect(showNativeExportCleanupIssue('local-temporary')).resolves.toBe(false)

    expect(mocks.showModal).toHaveBeenCalledTimes(2)
    expect(mocks.showToast).toHaveBeenCalledWith({
      title: '仍有不完整文件待手动删除',
      icon: 'none',
    })
  })

  it('only confirms saved visibility after either the modal or explicit fallback toast is shown', async () => {
    mocks.showModal.mockRejectedValueOnce(new Error('modal unavailable'))
    mocks.showToast.mockResolvedValueOnce(undefined)

    await expect(showNativeExportCleanupIssue('saved-local-temporary')).resolves.toBe(true)
    expect(mocks.showToast).toHaveBeenCalledWith({
      title: '副本已保存，本机暂存待清理',
      icon: 'none',
    })

    mocks.showModal.mockRejectedValueOnce(new Error('modal unavailable'))
    mocks.showToast.mockRejectedValueOnce(new Error('toast unavailable'))
    await expect(showNativeExportCleanupIssue('saved-local-temporary')).resolves.toBe(false)
  })

  it('requires explicit file verification before releasing a corrupt export outcome', async () => {
    mocks.showModal.mockResolvedValue({ confirm: true })
    mocks.forgetOutcome.mockResolvedValue(undefined)

    await expect(showNativeExportCleanupIssue('export-outcome')).resolves.toBe(false)

    expect(mocks.showModal).toHaveBeenCalledWith(expect.objectContaining({
      title: '核对上次导出',
      confirmText: '已核对',
      cancelText: '稍后',
    }))
    expect(mocks.forgetOutcome).toHaveBeenCalledOnce()
    expect(mocks.showToast).toHaveBeenCalledWith({ title: '导出状态已释放', icon: 'success' })
  })

  it('keeps a corrupt export outcome when the user postpones verification', async () => {
    mocks.showModal.mockResolvedValue({ confirm: false })

    await showNativeExportCleanupIssue('export-outcome')

    expect(mocks.forgetOutcome).not.toHaveBeenCalled()
  })

  it('requires visible confirmation before acknowledging a valid pending outcome', async () => {
    mocks.showModal.mockResolvedValue({ confirm: true })
    mocks.acknowledgePendingOutcome.mockResolvedValue(true)

    await expect(showNativeExportCleanupIssue('pending-export-outcome')).resolves.toBe(true)

    expect(mocks.showModal).toHaveBeenCalledWith(expect.objectContaining({
      title: '上次副本已保存',
      confirmText: '已核对',
    }))
    expect(mocks.acknowledgePendingOutcome).toHaveBeenCalledOnce()
  })
})
