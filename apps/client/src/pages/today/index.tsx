import { lazy, Suspense } from 'react'
import { LoadingScreen } from '../../components/LoadingScreen'
import { useRequireOnboarding } from '../../hooks/useRequireOnboarding'

// Each mode loads only its own UI; both are included in the offline package.
const SmokingToday = lazy(() => import(/* webpackChunkName: "today-smoking" */ './SmokingToday'))
const QuitToday = lazy(() => import(/* webpackChunkName: "today-quit" */ './QuitToday'))

export default function TodayPage() {
  const { state, ready } = useRequireOnboarding()
  if (!ready || !state.plan || !state.baseline) return <LoadingScreen />
  const quitMode = process.env.TARO_ENV !== 'harmony_cpp' && state.quitJourney?.attemptId === state.plan.id
  return <Suspense fallback={<LoadingScreen />}>{quitMode ? <QuitToday /> : <SmokingToday />}</Suspense>
}
