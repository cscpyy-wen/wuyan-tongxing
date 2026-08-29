import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { AccessibleButton as Button } from '../../components/AccessibleButton'
import { LoadingScreen } from '../../components/LoadingScreen'
import { PageHeader } from '../../components/PageHeader'
import { useMinuteClock } from '../../hooks/useMinuteClock'
import { addDays, addMonths, computeClientProgress, daysBetween, toLocalDate } from '../../lib/model'
import { useRequireOnboarding } from '../../hooks/useRequireOnboarding'
import './index.scss'

export default function ProgressPage() {
  const { state, ready } = useRequireOnboarding()
  const now = useMinuteClock()
  if (!ready || !state.plan || !state.baseline) return <LoadingScreen />

  const progress = computeClientProgress(state, now)
  const checkInByDate = new Map(
    state.checkIns.filter((item) => item.attemptId === state.plan!.id).map((item) => [item.date, item]),
  )
  const recordedByDate = new Map<string, number>()
  state.cigarettes
    .filter((item) => item.attemptId === state.plan!.id)
    .forEach((item) => {
      const date = toLocalDate(item.createdAt)
      recordedByDate.set(date, (recordedByDate.get(date) ?? 0) + item.count)
    })
  const recentDays = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(now, index - 6)
    const checkIn = checkInByDate.get(date)
    const recorded = recordedByDate.get(date) ?? 0
    const status = checkIn ? 'confirmed' : recorded > 0 ? 'recorded' : 'unknown'
    return {
      date,
      label: new Date(`${date}T00:00:00+08:00`).toLocaleDateString('zh-CN', { weekday: 'short', timeZone: 'Asia/Shanghai' }).replace('周', ''),
      cigarettes: checkIn?.cigarettesSmoked ?? (recorded > 0 ? recorded : undefined),
      status,
    }
  })
  const maxCigarettes = Math.max(state.baseline.cigarettesPerDay, ...recentDays.map((item) => item.cigarettes ?? 0), 1)
  const milestones = [
    { value: progress.currentStreakHours >= 24, title: '24 小时' },
    { value: progress.smokeFreeDays >= 7, title: '7 天' },
    { value: progress.smokeFreeDays >= 28, title: '28 天' },
    { value: progress.smokeFreeDays >= 90, title: '90 天' },
  ]
  const relativeDay = daysBetween(state.plan.quitDate, now)
  const heroLabel = relativeDay < 0
    ? '距戒烟日'
    : progress.streakConfirmed
      ? '已确认无烟'
      : progress.lastRecordedCigaretteAt ? '距已记录上支' : '尚未确认无烟'
  const heroValue: string = relativeDay < 0
    ? `${Math.abs(relativeDay)} 天`
    : progress.streakConfirmed
      ? progress.smokeFreeDays > 0 ? `${progress.smokeFreeDays} 天` : `${progress.currentStreakHours} 小时`
      : progress.lastRecordedCigaretteAt ? `${progress.currentStreakHours} 小时` : '—'
  const moneyText = Number.isInteger(progress.moneySaved)
    ? progress.moneySaved.toFixed(0)
    : progress.moneySaved.toFixed(1)
  const followups = ([3, 6, 12] as const).map((month) => {
    const dueDate = addMonths(state.plan!.quitDate, month)
    const saved = state.outcomes.find((item) => item.planId === state.plan!.id && item.dueMonth === month)
    return {
      month,
      dueDate,
      due: daysBetween(dueDate, toLocalDate(now)) >= 0,
      saved,
    }
  })

  return (
    <View className='screen progress-page'>
      <PageHeader title='进展' showSos compact />

      <View className='card card--forest progress-hero'>
        <Text className='progress-hero__label'>{heroLabel}</Text>
        <Text className='progress-hero__value'>{heroValue}</Text>
        {progress.cigarettesAvoided > 0 ? (
          <View className='progress-hero__metrics'>
            <View>
              <Text className='progress-hero__small-value'>{progress.cigarettesAvoided}</Text>
              <Text className='progress-hero__small-label'>少吸</Text>
            </View>
            <View>
              <Text className='progress-hero__small-value'>¥{moneyText}</Text>
              <Text className='progress-hero__small-label'>节省</Text>
            </View>
          </View>
        ) : null}
        {progress.knownTrackingDays > 0 ? <Text className='progress-hero__known'>已确认 {progress.knownTrackingDays} 天</Text> : null}
      </View>

      <Text className='section-title'>最近 7 天</Text>
      <View className='card'>
        <View className='chart' aria-label='最近七天自报吸烟支数柱状图'>
          {recentDays.map((day) => (
            <View className='chart__column' key={day.date}>
              <View className='chart__bar-wrap'>
                <View
                  className={`chart__bar chart__bar--${day.status}`}
                  style={{ height: day.status !== 'unknown' ? `${Math.max(5, ((day.cigarettes ?? 0) / maxCigarettes) * 100)}%` : '24%' }}
                />
              </View>
              <Text className='chart__value'>{day.status === 'unknown' ? '—' : `${day.cigarettes}${day.status === 'confirmed' ? ' ✓' : ''}`}</Text>
              <Text className='chart__label'>{day.label}</Text>
            </View>
          ))}
        </View>
        <Text className='chart__legend'>数字为逐支记录 · ✓ 已做日终确认</Text>
      </View>

      <Text className='section-title'>随访</Text>
      <View className='card followup-list'>
        {followups.map((followup) => (
          <Button
            className='followup-row'
            key={followup.month}
            aria-label={`${followup.month} 个月随访，${followup.dueDate}，${followup.saved ? '已填写' : followup.due ? '可以填写' : '未到期'}`}
            onClick={() => Taro.navigateTo({ url: `/pages/followup/index?month=${followup.month}` })}
          >
            <View className='followup-row__month'>{followup.month}<Text>月</Text></View>
            <Text className='grow followup-row__date'>{followup.dueDate}</Text>
            <Text className={`followup-row__action ${followup.due && !followup.saved ? 'followup-row__action--due' : ''}`}>
              {followup.saved ? '已填' : followup.due ? '填写' : '›'}
            </Text>
          </Button>
        ))}
      </View>

      <Text className='section-title'>里程碑</Text>
      <View className='card milestone-list'>
        {milestones.map((milestone) => (
          <View className='milestone' key={milestone.title}>
            <View className={`milestone__mark ${milestone.value ? 'milestone__mark--done' : ''}`}>{milestone.value ? '✓' : '○'}</View>
            <Text className='milestone__title'>{milestone.title}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}
