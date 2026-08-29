import Taro from '@tarojs/taro'
import { useEffect } from 'react'
import { dismissAndroidBootstrap } from '../lib/androidBootstrap'
import { useAppState } from '../state/AppState'

export function useRequireOnboarding() {
  const { state, ready, loadFailure } = useAppState()
  useEffect(() => {
    if (loadFailure) {
      dismissAndroidBootstrap()
      return
    }
    if (!ready) return
    if (!state.onboarded) {
      void Taro.reLaunch({ url: '/pages/onboarding/index' })
        .finally(() => dismissAndroidBootstrap())
      return
    }
    dismissAndroidBootstrap()
  }, [loadFailure, ready, state.onboarded])
  return { state, ready, loadFailure }
}
