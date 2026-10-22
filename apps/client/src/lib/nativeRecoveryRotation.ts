import Taro from '@tarojs/taro'
import { getAndroidHealthStorage } from './androidHealthStorage'
import { hasAndroidBootstrapRecoveryToRotate, rotateAndroidBootstrapCorruptArchiveAfterExport } from './androidBootstrapQueue'
import { runAppModal } from './modalCoordinator'

/** Rare post-export recovery UI is bundled offline, but loaded only on demand. */
export async function offerRecoveryRotation(consumeQueue: () => void): Promise<void> {
  const storage = getAndroidHealthStorage()
  if (!storage || !hasAndroidBootstrapRecoveryToRotate(storage)) return
  const result = await runAppModal(() => Taro.showModal({
    title: '释放快速记录恢复区？',
    content: '恢复快照已包含在刚导出的副本中。释放后，当前异常记录会重新隔离，快速记录可继续使用。',
    confirmText: '确认释放',
    cancelText: '继续保留',
  }))
  if (!result.confirm) return
  try {
    rotateAndroidBootstrapCorruptArchiveAfterExport(storage)
    consumeQueue()
    Taro.showToast({ title: '快速记录恢复区已释放', icon: 'success' })
  } catch {
    Taro.showToast({ title: '操作未全部完成，请保留导出副本', icon: 'none' })
  }
}
