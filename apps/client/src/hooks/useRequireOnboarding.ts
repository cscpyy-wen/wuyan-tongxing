import { useEffect } from 'react'
import { dismissAndroidBootstrap } from '../lib/androidBootstrap'
import { openOnboardingAsRoot } from '../lib/navigation'
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
      void openOnboardingAsRoot().finally(() => dismissAndroidBootstrap())
      return
    }
    dismissAndroidBootstrap()
  }, [loadFailure, ready, state.onboarded])
  return { state, ready, loadFailure }
}
