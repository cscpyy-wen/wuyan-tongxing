import { Text, View } from '@tarojs/components'
import Taro, { useDidHide } from '@tarojs/taro'
import { useMemo, useState } from 'react'
import { AccessibleButton as Button } from '../../components/AccessibleButton'
import { HarmonyScrollablePage } from '../../components/HarmonyScrollablePage'
import { LoadingScreen } from '../../components/LoadingScreen'
import { PageHeader } from '../../components/PageHeader'
import { SmokingEventSheet } from '../../components/SmokingEventSheet'
import { useDeferredSheetOpen } from '../../hooks/useDeferredSheetOpen'
import { useMinuteClock } from '../../hooks/useMinuteClock'
import {
  buildClientReductionSchedule,
  computeClientProgress,
  createDailyCheckInConfirmation,
  daysBetween,
  getCurrentReductionLimit,
  getJourneyPhase,
  toLocalDate,
} from '../../lib/model'
import { HEALTH_CONTENT_ENABLED } from '../../lib/healthContentGate'
import { openSosPage } from '../../lib/navigation'
import { getTodayContent } from '../../lib/shared'
import { formatSmokingInterval, formatSmokingTime, summarizeSmokingLogs } from '../../lib/smokingLogs'
import { cigaretteLogMutationConsequences } from '../../lib/smokingLogConsequences'
import { useRequireOnboarding } from '../../hooks/useRequireOnboarding'
import { useAppState } from '../../state/AppState'
import type { ClientCigaretteLog } from '../../types'
import './index.scss'

export default function TodayPage() {
  const { state, ready } = useRequireOnboarding()
  const { actions } = useAppState()
  const now = useMinuteClock()
  const [smokeLogAt, setSmokeLogAt] = useState<string>()
  const [editingLog, setEditingLog] = useState<ClientCigaretteLog>()
  const [recentSavedId, setRecentSavedId] = useState<string>()
  const deferSheetOpen = useDeferredSheetOpen()

  const closeSmokingSheet = () => {
    setSmokeLogAt(undefined)
    setEditingLog(undefined)
  }

  useDidHide(closeSmokingSheet)

  const progress = useMemo(() => computeClientProgress(state, now), [state, now])
  if (!ready || !state.plan || !state.baseline) return <LoadingScreen />

  const phase = getJourneyPhase(state.plan, now)
  const relativeDay = daysBetween(state.plan.quitDate, now)
  const currentAttemptCigarettes = state.cigarettes.filter((item) => item.attemptId === state.plan!.id)
  const recentSavedLog = currentAttemptCigarettes.find((item) => item.id === recentSavedId)
  const recentPostQuitCigarette = currentAttemptCigarettes.find((item) => toLocalDate(item.createdAt) >= state.plan!.quitDate)
  const content = getTodayContent(
    state.plan,
    now,
    undefined,
    false,
    state.baseline.firstCigaretteMinutes,
    state.baseline.triggers,
    state.completedTasks.filter((item) => item.attemptId === state.plan!.id).map((item) => item.contentId),
  )
  const taskDone = state.completedTasks.some((item) => item.contentId === content.id && item.attemptId === state.plan!.id)
  const todaySummary = summarizeSmokingLogs(currentAttemptCigarettes, toLocalDate(now))
  const todayCheckIn = state.checkIns.find((item) => item.date === toLocalDate(now) && item.attemptId === state.plan!.id)
  const minutesSinceLast = todaySummary.lastSmokedAt
    ? Math.max(0, Math.floor((now.getTime() - new Date(todaySummary.lastSmokedAt).getTime()) / 60_000))
    : undefined
  const reductionLimit = getCurrentReductionLimit(state.plan, now)
  const schedule = buildClientReductionSchedule(state.plan)
  const visibleMetricCount = 1
    + (todaySummary.averageIntervalMinutes !== undefined ? 1 : 0)
    + (todaySummary.topReason ? 1 : 0)

  const heroValue: number | string = relativeDay < 0
    ? Math.abs(relativeDay)
    : progress.streakConfirmed
      ? progress.smokeFreeDays > 0 ? progress.smokeFreeDays : progress.currentStreakHours
      : progress.lastRecordedCigaretteAt ? progress.currentStreakHours : '—'
  const heroUnit = relativeDay < 0
    ? '天后戒烟'
    : progress.streakConfirmed
      ? progress.smokeFreeDays > 0 ? '天已确认无烟' : '小时已确认无烟'
      : progress.lastRecordedCigaretteAt ? '小时距已记录上支' : '尚未确认无烟'

  const confirmToday = async () => {
    const confirmation = createDailyCheckInConfirmation(state, new Date())
    if (!confirmation) return
    const result = await Taro.showModal({
      title: '确认今日记录？',
      content: `今天记录了 ${confirmation.cigarettesSmoked} 支。确认后仍可撤销。`,
      confirmText: '确认',
      cancelText: '再看看',
    })
    if (!result.confirm) return
    const saved = actions.recordCheckIn(confirmation)
    if (saved) Taro.showToast({ title: '今日记录已确认', icon: 'success' })
  }

  const unconfirmToday = async () => {
    const result = await Taro.showModal({
      title: '撤销今日确认？',
      content: '逐支记录不会删除。',
      confirmText: '撤销',
      cancelText: '保留',
      confirmColor: '#A8382D',
    })
    if (!result.confirm) return
    if (actions.removeTodayCheckIn()) Taro.showToast({ title: '已撤销今日确认', icon: 'none' })
  }

  const beginQuickLog = () => {
    const capturedAt = new Date().toISOString()
    deferSheetOpen(() => setSmokeLogAt(capturedAt))
  }

  const undoRecent = async () => {
    if (!recentSavedLog) return
    const consequences = cigaretteLogMutationConsequences(state, recentSavedLog)
    const related = [
      consequences.affectedCheckInCount > 0
        ? `同时撤销 ${consequences.affectedCheckInCount} 条日终确认`
        : undefined,
      consequences.linkedLapseCount > 0 ? `同时删除 ${consequences.linkedLapseCount} 条关联复盘` : undefined,
    ].filter(Boolean).join('，')
    const result = await Taro.showModal({
      title: '撤销刚才记录？',
      content: `将删除 ${formatSmokingTime(recentSavedLog.createdAt)} 的这支烟${related ? `，${related}` : ''}。`,
      confirmText: '确认撤销',
      confirmColor: '#A8382D',
    })
    if (!result.confirm) return
    if (actions.deleteCigaretteLog(recentSavedLog.id)) {
      setRecentSavedId(undefined)
      Taro.showToast({ title: '已撤销', icon: 'none' })
    }
  }

  const finishTask = () => {
    if (!HEALTH_CONTENT_ENABLED) return
    if (content.actionType === 'LAPSE_RECOVERY') {
      const suffix = recentPostQuitCigarette ? `?cigaretteLogId=${encodeURIComponent(recentPostQuitCigarette.id)}` : ''
      Taro.navigateTo({ url: `/pages/lapse/index${suffix}` })
      return
    }
    if (content.actionType === 'SOS') {
      void openSosPage()
      return
    }
    Taro.navigateTo({ url: `/pages/lesson/index?id=${encodeURIComponent(content.id)}` })
  }

  return (
    <HarmonyScrollablePage
      className='screen today-page'
      viewport='tab'
      overlay={(
        <SmokingEventSheet
          open={Boolean(smokeLogAt) || Boolean(editingLog)}
          capturedAt={smokeLogAt}
          editing={editingLog}
          allowTimeEdit={Boolean(editingLog)}
          onClose={closeSmokingSheet}
          onSaved={(id) => setRecentSavedId(id)}
        />
      )}
    >
      <PageHeader title='今天' showSos compact />

      <View className='card smoking-hero'>
        <Text className='smoking-hero__count'>{todaySummary.recordedCount}<Text> 支</Text></Text>
        {todaySummary.recordedCount > 0 ? (
          <View className={`smoking-hero__metrics smoking-hero__metrics--${visibleMetricCount}`}>
            <View className='smoking-hero__metric'>
              <Text className='smoking-hero__metric-value'>{formatSmokingInterval(minutesSinceLast)}</Text>
              <Text className='smoking-hero__metric-label'>距上支</Text>
            </View>
            {todaySummary.averageIntervalMinutes !== undefined ? (
              <View className='smoking-hero__metric'>
                <Text className='smoking-hero__metric-value'>{formatSmokingInterval(todaySummary.averageIntervalMinutes)}</Text>
                <Text className='smoking-hero__metric-label'>间隔</Text>
              </View>
            ) : null}
            {todaySummary.topReason ? (
              <View className='smoking-hero__metric'>
                <Text className='smoking-hero__metric-value smoking-hero__metric-value--reason'>{todaySummary.topReason.label}</Text>
                <Text className='smoking-hero__metric-label'>原因</Text>
              </View>
            ) : null}
          </View>
        ) : null}
        {todayCheckIn ? (
          <View className='smoking-day-confirmed' aria-live='polite'>
            <Text>今日已确认 {todayCheckIn.cigarettesSmoked} 支</Text>
            <Button className='smoking-day-unconfirm' aria-label='撤销今日确认' onClick={() => void unconfirmToday()}>撤销</Button>
          </View>
        ) : (
          <Button className='smoking-day-confirm' onClick={() => void confirmToday()}>
            确认今日 {todaySummary.recordedCount} 支
          </Button>
        )}
      </View>

      <View className='card card--soft progress-summary'>
        <View className='progress-summary__main'>
          <Text className='progress-summary__number'>{heroValue}</Text>
          <View className='grow'>
            <Text className='progress-summary__unit'>{heroUnit}</Text>
          </View>
        </View>
        {phase === 'reduce' ? (
          <View className='progress-summary__limit'>
            <Text>今日上限</Text>
            <Text className='progress-summary__limit-value'>{reductionLimit} 支</Text>
            <Text>已记 {todaySummary.recordedCount} 支</Text>
          </View>
        ) : null}
      </View>

      <View className={`smoke-log-action ${recentSavedLog ? 'smoke-log-action--recent' : ''}`}>
        <Button
          className='smoke-log-primary'
          aria-label='我吸了一支烟，开始记录原因和烟瘾强度'
          onClick={beginQuickLog}
        >
          <Text className='smoke-log-primary__plus' aria-hidden='true'>＋</Text>
          <Text>我吸了一支烟</Text>
        </Button>
        {recentSavedLog ? (
          <View className='recent-log-actions' aria-label='刚刚记录的操作'>
            <Text className='recent-log-actions__label'>刚刚记录</Text>
            <Button
              className='recent-log-action'
              onClick={() => deferSheetOpen(() => setEditingLog(recentSavedLog))}
            >编辑</Button>
            <Button className='recent-log-action recent-log-action--undo' onClick={() => void undoRecent()}>撤销</Button>
          </View>
        ) : null}
      </View>

      {HEALTH_CONTENT_ENABLED ? <>
        <View className='row row--between today-section-head'>
          <Text className='section-title'>今日任务</Text>
          <Text className='pill'>{content.durationMinutes} 分钟</Text>
        </View>
        <View className='card lesson-card'>
          <View className='lesson-card__marker'>{taskDone ? '✓' : '01'}</View>
          <View className='grow'>
            <Text className='lesson-card__title'>{content.title}</Text>
            <Button className={`button ${taskDone ? 'button--secondary' : ''}`} onClick={finishTask}>
              {taskDone ? '再看' : content.actionType === 'LAPSE_RECOVERY' ? '开始恢复' : content.actionType === 'SOS' ? '烟瘾急救' : '开始'}
            </Button>
          </View>
        </View>
      </> : <>
        <Text className='section-title'>首发范围</Text>
        <View className='card card--soft'>
          <Text className='field-label'>专注本机记录</Text>
          <Text className='muted'>HarmonyOS 首版暂不提供健康教育课程、用药科普、专业资源和长期随访。</Text>
        </View>
      </>}

      <Text className='section-title'>更多</Text>
      <View className='quick-grid'>
        <Button className='quick-card' onClick={() => Taro.navigateTo({ url: '/pages/partner/index' })}>
          <Text className='quick-card__icon' aria-hidden='true'>↗</Text>
          <Text className='quick-card__title'>伙伴支持</Text>
        </Button>
        {HEALTH_CONTENT_ENABLED ? <Button className='quick-card' onClick={() => Taro.navigateTo({ url: '/pages/medicine/index' })}>
          <Text className='quick-card__icon' aria-hidden='true'>＋</Text>
          <Text className='quick-card__title'>药物与支持</Text>
        </Button> : null}
      </View>

      {schedule.length > 0 && phase === 'reduce' ? (
        <View className='card card--soft'>
          <View className='row row--between'>
            <Text className='field-label'>减量计划</Text>
            <Text className='pill pill--sun'>戒烟日归零</Text>
          </View>
          {schedule.map((stage, index) => {
            const minimum = schedule[index + 1]?.dailyLimit ?? 1
            const maximum = schedule[index - 1]?.dailyLimit ?? state.baseline!.cigarettesPerDay
            return (
            <View className='schedule-row' key={stage.ratio}>
              <View className='grow'>
                <Text className='schedule-row__title'>{stage.label}</Text>
                <Text className='muted'>{stage.from} 至 {stage.to}</Text>
              </View>
              <View className='schedule-row__adjust' aria-label={`${stage.label}上限 ${stage.dailyLimit} 支`}>
                <Button
                  className='schedule-adjust'
                  aria-label={`降低${stage.label}上限`}
                  disabled={stage.dailyLimit <= minimum}
                  onClick={() => actions.adjustReductionLimit(stage.ratio as 0.75 | 0.5 | 0.25, -1)}
                >−</Button>
                <Text className='schedule-row__limit'>≤ {stage.dailyLimit} 支</Text>
                <Button
                  className='schedule-adjust'
                  aria-label={`提高${stage.label}上限`}
                  disabled={stage.dailyLimit >= maximum}
                  onClick={() => actions.adjustReductionLimit(stage.ratio as 0.75 | 0.5 | 0.25, 1)}
                >＋</Button>
              </View>
            </View>
            )
          })}
        </View>
      ) : null}

    </HarmonyScrollablePage>
  )
}
