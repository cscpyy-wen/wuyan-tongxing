import Taro from '@tarojs/taro'
import type { ClientState } from '../types'
import { getAndroidHealthStorage } from './androidHealthStorage'
import { readAndroidBootstrapQuarantine, readAndroidBootstrapQueue, readAndroidSystemShortcutQueue } from './androidBootstrapQueue'
import { isNativeAndroidApp } from './runtime'
import { setQuitJourney, type QuitJourneyInput } from './quitJourney'

/** Loaded on submission, never needed merely to launch the app. */
export function saveQuitJourneyAfterQueue(
  input: QuitJourneyInput,
  getState: () => ClientState,
  commit: (update: (state: ClientState) => ClientState, failure: string) => boolean,
  consumeQueue: () => void,
): boolean {
  // A durable widget write may precede its WebView event. Reconcile before
  // accepting a declaration, then validate again against the committed state.
  consumeQueue()
  if (isNativeAndroidApp()) {
    const storage = getAndroidHealthStorage()
    if (!storage) return false
    const current = getState()
    const logs = new Map(current.cigarettes.map((item) => [item.id, item]))
    const deleted = new Set(current.deletedCigaretteIds)
    const unresolved = (event: ReturnType<typeof readAndroidBootstrapQueue>[number]) => {
      if (deleted.has(event.id)) return false
      const stored = logs.get(event.id)
      return !stored || new Date(stored.createdAt).getTime() !== new Date(event.smokedAt).getTime()
        || stored.count !== 1 || stored.trigger !== event.trigger || stored.cravingIntensity !== event.cravingIntensity
    }
    // Consumption can leave an ID collision pending when quarantine cannot be
    // written. Only an exact smoking payload is a safely acknowledged replay.
    if ([...readAndroidBootstrapQueue(storage), ...readAndroidSystemShortcutQueue(storage)].some(unresolved)) {
      Taro.showToast({ title: '快捷记录尚未同步，请稍后重试', icon: 'none' })
      return false
    }
    // Reconciliation may move unknown-attempt records out of the pending queues
    // while their assignment dialog is still open. They remain smoking evidence.
    if (readAndroidBootstrapQuarantine(storage).some(unresolved)) {
      Taro.showToast({ title: '有待归类的快捷记录，请先处理后重试', icon: 'none' })
      return false
    }
  }
  return commit((previous) => setQuitJourney(previous, input, new Date()), '无烟设置保存失败')
}
