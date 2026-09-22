import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { AccessibleButton as Button } from './AccessibleButton'
import { useAppState } from '../state/AppState'
import {
  dispatchNativeOpenJsonReady,
  dispatchNativeOpenJsonRetry,
  isNativeMobileApp,
  probeNativePendingOpenJson,
  selectNativeOpenJson,
} from '../lib/runtime'
import {
  beginAndroidBackupRestoreIntent,
  clearAndroidBackupRestoreIntent,
} from '../lib/androidBootstrapQueue'
import { getAndroidHealthStorage } from '../lib/androidHealthStorage'

export function LoadingScreen() {
  const { loadFailure, backupRestorePending, actions } = useAppState()
  const retryPendingRestore = async () => {
    try {
      const pending = await probeNativePendingOpenJson()
      if (!pending) {
        await Taro.showToast({ title: '备份文件未保留，请重新选择', icon: 'none' })
        return
      }
      dispatchNativeOpenJsonReady(pending)
    } catch {
      await Taro.showToast({ title: '暂时无法恢复，请稍后重试', icon: 'none' }).catch(() => undefined)
    }
  }
  const restoreFromFile = async () => {
    const storage = getAndroidHealthStorage()
    if (!storage) {
      await Taro.showToast({ title: '另一项数据操作正在进行', icon: 'none' })
      return
    }
    try {
      beginAndroidBackupRestoreIntent(storage)
      const selected = await selectNativeOpenJson()
      if (!selected) {
        await Taro.showToast({ title: '已取消恢复', icon: 'none' })
        clearAndroidBackupRestoreIntent(storage)
        return
      }
      dispatchNativeOpenJsonReady(selected)
    } catch {
      await Taro.showToast({ title: '恢复流程中断，将在返回应用后重试', icon: 'none' }).catch(() => undefined)
      dispatchNativeOpenJsonRetry()
    }
  }
  if (loadFailure) {
    return (
      <View className='screen screen--detail stack' aria-live='assertive'>
        <Text className='page-title'>本机数据需要恢复</Text>
        <Text className='page-subtitle'>应用没有覆盖原记录。请先重试；仍失败时可导出恢复副本。</Text>
        <Button className='button' onClick={actions.retryLocalState}>重试读取</Button>
        <Button className='button button--secondary' onClick={() => void actions.exportRecoveryData()}>导出恢复副本</Button>
        {isNativeMobileApp()
          ? <Button className='button button--secondary' onClick={() => void restoreFromFile()}>从副本恢复</Button>
          : null}
        <Button className='button button--danger' onClick={() => void actions.clearCorruptedState()}>清除后重来</Button>
      </View>
    )
  }
  if (backupRestorePending && isNativeMobileApp()) {
    return (
      <View className='screen screen--detail'>
        <View className='card empty-state' role='status'>
          <Text>备份仍在本机</Text>
          <Button className='button' onClick={() => void retryPendingRestore()}>重试恢复</Button>
        </View>
      </View>
    )
  }
  return (
    <View className='screen screen--detail'>
      <View className='card empty-state' role='status'>
        <Text>正在从本机读取你的计划…</Text>
      </View>
    </View>
  )
}
