import Taro from '@tarojs/taro'
import { getAndroidHealthStorage } from './androidHealthStorage'
import {
  beginAndroidBackupRestoreIntent,
  clearAndroidBackupRestoreIntent,
} from './androidBootstrapQueue'
import {
  dispatchNativeOpenJsonReady,
  dispatchNativeOpenJsonRetry,
  selectNativeOpenJson,
} from './runtime'

/**
 * Starts Android's durable SAF selection flow. Selecting a document only
 * stages and verifies it; NativeRuntimeBridge owns the file-specific preview,
 * final confirmation and atomic commit.
 */
export async function requestNativeBackupRestoreSelection(): Promise<boolean> {
  const confirmation = await Taro.showModal({
    title: '选择备份',
    content: '选中文件后会先显示计划和记录摘要；最终确认前不会修改当前数据。',
    confirmText: '选择文件',
    confirmColor: '#176B55',
    cancelText: '取消',
  })
  if (!confirmation.confirm) return false

  try {
    const androidStorage = getAndroidHealthStorage()
    if (!androidStorage) throw new Error('本机恢复状态不可用')
    beginAndroidBackupRestoreIntent(androidStorage)
    const selected = await selectNativeOpenJson()
    if (!selected) {
      await Taro.showToast({ title: '已取消恢复', icon: 'none' })
      clearAndroidBackupRestoreIntent(androidStorage)
      return false
    }
    dispatchNativeOpenJsonReady(selected)
    return true
  } catch {
    // PREPARING, corrupt and transient native states remain fail-closed. The
    // app-level foreground/cold-start probe owns exact retry and cleanup.
    await Taro.showToast({ title: '恢复流程中断，将在返回应用后重试', icon: 'none' })
      .catch(() => undefined)
    dispatchNativeOpenJsonRetry()
    return false
  }
}
