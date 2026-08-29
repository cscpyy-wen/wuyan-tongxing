import { Picker, Text, View } from '@tarojs/components'
import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { useMemo, useRef, useState } from 'react'
import { AccessibleButton as Button } from '../../components/AccessibleButton'
import { LoadingScreen } from '../../components/LoadingScreen'
import { PageHeader } from '../../components/PageHeader'
import { SmokingEventSheet } from '../../components/SmokingEventSheet'
import { useDeferredSheetOpen } from '../../hooks/useDeferredSheetOpen'
import { useMinuteClock } from '../../hooks/useMinuteClock'
import { addDays, toLocalDate } from '../../lib/model'
import {
  formatSmokingInterval,
  formatSmokingTime,
  smokingTriggerLabel,
  shanghaiDateTimeToIso,
  SMOKING_TIMEZONE_LABEL,
  summarizeSmokingLogs,
  toShanghaiTime,
} from '../../lib/smokingLogs'
import { cigaretteLogMutationConsequences } from '../../lib/smokingLogConsequences'
import { useRequireOnboarding } from '../../hooks/useRequireOnboarding'
import { useAppState } from '../../state/AppState'
import type { ClientCigaretteLog } from '../../types'
import './index.scss'

export default function RecordsPage() {
  const { state, ready } = useRequireOnboarding()
  const { actions } = useAppState()
  const now = useMinuteClock()
  const [smokeLogAt, setSmokeLogAt] = useState<string>()
  const [editingLog, setEditingLog] = useState<ClientCigaretteLog>()
  const deferSheetOpen = useDeferredSheetOpen()
  const today = toLocalDate(now)
  const [selectedDate, setSelectedDate] = useState(today)
  const lastShownAttemptId = useRef<string>()

  const closeSheet = () => {
    setSmokeLogAt(undefined)
    setEditingLog(undefined)
  }

  useDidHide(closeSheet)

  useDidShow(() => {
    const attemptId = state.plan?.id
    if (!attemptId) return
    if (lastShownAttemptId.current && lastShownAttemptId.current !== attemptId) {
      setSelectedDate(today)
      void Taro.pageScrollTo({ scrollTop: 0, duration: 0 })
    }
    lastShownAttemptId.current = attemptId
  })

  const currentAttemptCigarettes = useMemo(
    () => state.cigarettes.filter((item) => item.attemptId === state.plan?.id),
    [state.cigarettes, state.plan?.id],
  )
  const summary = useMemo(
    () => summarizeSmokingLogs(currentAttemptCigarettes, selectedDate),
    [currentAttemptCigarettes, selectedDate],
  )
  const timeline = [...summary.logs].reverse()
  const visibleMetricCount = (summary.averageIntervalMinutes !== undefined ? 1 : 0)
    + (summary.topReason ? 1 : 0)
    + (summary.averageCravingIntensity !== undefined ? 1 : 0)

  if (!ready || !state.plan) return <LoadingScreen />

  const undo = async (id: string, time: string) => {
    const log = currentAttemptCigarettes.find((item) => item.id === id)
    const recordDate = toLocalDate(time)
    const dateLabel = recordDate === today ? '今日' : recordDate
    const consequences = log ? cigaretteLogMutationConsequences(state, log) : undefined
    const related = [
      consequences?.affectedCheckInCount ? `撤销 ${consequences.affectedCheckInCount} 条相关日终确认` : undefined,
      consequences?.linkedLapseCount ? `删除 ${consequences.linkedLapseCount} 条关联复盘` : undefined,
    ].filter(Boolean).join('，')
    const result = await Taro.showModal({
      title: '撤销这条记录？',
      content: `将删除 ${dateLabel} ${formatSmokingTime(time)} 的这支烟，并重新计算${dateLabel}统计${related ? `；同时${related}` : ''}。`,
      confirmText: '确认撤销',
      confirmColor: '#A8382D',
    })
    if (!result.confirm) return
    if (actions.deleteCigaretteLog(id)) Taro.showToast({ title: '这条记录已撤销', icon: 'none' })
  }

  const openBackfill = () => {
    const captured = shanghaiDateTimeToIso(selectedDate, toShanghaiTime(now))
    if (captured) deferSheetOpen(() => setSmokeLogAt(captured))
  }

  return (
    <View className='screen records-page'>
      <PageHeader title='记录' showSos compact />

      <View className='card records-summary'>
        <View className='row row--between'>
          <View>
            <Picker mode='date' value={selectedDate} start={addDays(today, -90)} end={today} onChange={(event) => setSelectedDate(event.detail.value)}>
              <Text className='records-summary__label'>{selectedDate === today ? '今日' : selectedDate}⌄</Text>
            </Picker>
            <Text className='records-summary__count'>{summary.recordedCount}<Text> 支</Text></Text>
          </View>
        </View>
        <Button className='records-log-button' aria-label='补记一支烟' onClick={openBackfill}>＋ 补记</Button>
        {visibleMetricCount > 0 ? (
          <View className={`records-metrics records-metrics--${visibleMetricCount}`}>
            {summary.averageIntervalMinutes !== undefined ? (
              <View className='records-metric'>
                <Text className='records-metric__value records-metric__value--interval'>{formatSmokingInterval(summary.averageIntervalMinutes)}</Text>
                <Text className='records-metric__label'>间隔</Text>
              </View>
            ) : null}
            {summary.topReason ? (
              <View className='records-metric'>
                <Text className='records-metric__value'>{summary.topReason.label}</Text>
                <Text className='records-metric__label'>原因</Text>
              </View>
            ) : null}
            {summary.averageCravingIntensity !== undefined ? (
              <View className='records-metric'>
                <Text className='records-metric__value'>{summary.averageCravingIntensity.toFixed(1)}</Text>
                <Text className='records-metric__label'>烟瘾 / 5</Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>

      {timeline.length === 0 ? <Text className='records-empty'>记录后显示原因与间隔</Text> : null}

      {timeline.length > 0 ? (
        <View className='records-timeline-column'>
          <View className='row row--between records-timeline-title'>
            <Text className='section-title'>时间线</Text>
            <Text className='records-timezone'>{SMOKING_TIMEZONE_LABEL}</Text>
          </View>
          <View className='card activity-list'>
            {timeline.map((item) => {
              const sequence = summary.logs.findIndex((candidate) => candidate.id === item.id) + 1
              const linkedLapse = state.lapses.find((lapse) => (
                lapse.attemptId === state.plan!.id && lapse.cigaretteLogId === item.id
              ))
              const canReview = toLocalDate(item.createdAt) >= state.plan!.quitDate && !linkedLapse
              return (
                <View className='activity-row' key={item.id}>
                  <View className='activity-row__time-block'>
                    <Text className='activity-row__time'>{formatSmokingTime(item.createdAt)}</Text>
                    <Text className='activity-row__sequence'>第 {sequence} 支</Text>
                  </View>
                  <View className='grow'>
                    <Text className='activity-row__title'>{item.count === 1 ? smokingTriggerLabel(item.trigger) : `历史合计 ${item.count} 支`}</Text>
                    <Text className='muted'>
                      {item.count === 1
                        ? `烟瘾 ${item.cravingIntensity ? `${item.cravingIntensity}/5` : '—'}`
                        : '合计记录'}
                    </Text>
                    {linkedLapse ? (
                      <View className='activity-row__recovery'>
                        <Text className='pill'>已复盘</Text>
                        <Text className='activity-row__recovery-action'>{linkedLapse.recoveryAction}</Text>
                      </View>
                    ) : null}
                    <View className='activity-row__actions'>
                      {item.count === 1 ? (
                        <Button className='activity-action' aria-label={`编辑 ${formatSmokingTime(item.createdAt)} 的吸烟记录`} onClick={() => deferSheetOpen(() => setEditingLog(item))}>编辑</Button>
                      ) : null}
                      {canReview ? (
                        <Button className='activity-action' onClick={() => Taro.navigateTo({ url: `/pages/lapse/index?cigaretteLogId=${encodeURIComponent(item.id)}` })}>复盘</Button>
                      ) : null}
                      {linkedLapse ? (
                        <Button className='activity-action' aria-label={`编辑 ${formatSmokingTime(item.createdAt)} 的复盘动作`} onClick={() => Taro.navigateTo({ url: `/pages/lapse/index?cigaretteLogId=${encodeURIComponent(item.id)}` })}>编辑复盘</Button>
                      ) : null}
                      <Button className='activity-action activity-action--undo' aria-label={`撤销 ${formatSmokingTime(item.createdAt)} 的吸烟记录`} onClick={() => undo(item.id, item.createdAt)}>撤销</Button>
                    </View>
                  </View>
                </View>
              )
            })}
          </View>
        </View>
      ) : null}

      {summary.reasons.length > 0 ? <>
        <Text className='section-title'>原因</Text>
        <View className='card reason-summary'>
          {summary.reasons.map((reason) => (
          <View className='reason-row' key={reason.trigger ?? 'unknown'}>
            <View className='row row--between'>
              <Text className='reason-row__label'>{reason.label}</Text>
              <Text className='reason-row__count'>{reason.count} 支 · {reason.percentage}%</Text>
            </View>
            <View className='reason-row__track'>
              <View className='reason-row__fill' style={{ width: `${reason.percentage}%` }} />
            </View>
          </View>
          ))}
        </View>
      </> : null}

      <SmokingEventSheet
        open={Boolean(smokeLogAt) || Boolean(editingLog)}
        capturedAt={smokeLogAt}
        editing={editingLog}
        allowTimeEdit
        onClose={closeSheet}
        onSaved={(_id, smokedAt) => setSelectedDate(toLocalDate(smokedAt))}
      />
    </View>
  )
}
