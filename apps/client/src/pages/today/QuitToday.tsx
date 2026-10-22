import { Text, View } from '@tarojs/components'
import Taro, { useDidHide } from '@tarojs/taro'
import { useMemo, useState } from 'react'
import { AccessibleButton as Button } from '../../components/AccessibleButton'
import { HarmonyScrollablePage } from '../../components/HarmonyScrollablePage'
import { PageHeader } from '../../components/PageHeader'
import { QuitDashboard } from '../../components/QuitDashboard'
import { SmokingEventSheet } from '../../components/SmokingEventSheet'
import { useDeferredSheetOpen } from '../../hooks/useDeferredSheetOpen'
import { useMinuteClock } from '../../hooks/useMinuteClock'
import { useModalAction } from '../../hooks/useModalAction'
import { createDailyCheckInConfirmation, toLocalDate } from '../../lib/model'
import { runAppModal } from '../../lib/modalCoordinator'
import { cigaretteLogMutationConsequences } from '../../lib/smokingLogConsequences'
import { useAppState } from '../../state/AppState'
import type { ClientCigaretteLog } from '../../types'

export default function QuitToday() {
  const { state, actions } = useAppState()
  const clock = useMinuteClock()
  // A saved/widget cigarette must reset the display immediately, even between ticks.
  const now = useMemo(() => new Date(), [clock, state])
  const [smokedAt, setSmokedAt] = useState<string>()
  const [editing, setEditing] = useState<ClientCigaretteLog>()
  const [recentId, setRecentId] = useState<string>()
  const defer = useDeferredSheetOpen()
  const runModalAction = useModalAction()
  const close = () => { setSmokedAt(undefined); setEditing(undefined) }
  useDidHide(close)
  const recent = state.cigarettes.find((log) => log.id === recentId)
  const today = toLocalDate(now)
  const checkIn = state.checkIns.find((item) => item.attemptId === state.plan?.id && item.date === today)
  const todayCount = state.cigarettes.filter((item) => item.attemptId === state.plan?.id && toLocalDate(item.createdAt) === today).reduce((sum, item) => sum + item.count, 0)

  const confirmDay = () => runModalAction(async () => {
    const confirmation = createDailyCheckInConfirmation(state, new Date())
    if (!confirmation) return
    const result = await runAppModal(() => Taro.showModal({
      title: '确认今日记录？',
      content: `今天记录了 ${confirmation.cigarettesSmoked} 支。确认后仍可撤销。`,
      confirmText: '确认',
      cancelText: '再看看',
    }))
    if (result.confirm) actions.recordCheckIn(confirmation)
  })
  const undoConfirmation = () => runModalAction(async () => {
    if (!checkIn) return
    const result = await runAppModal(() => Taro.showModal({
      title: '撤销今日确认？',
      content: '逐支记录不会删除。',
      confirmText: '撤销',
      cancelText: '保留',
    }))
    if (result.confirm) actions.removeTodayCheckIn(checkIn)
  })
  const undoRecent = () => runModalAction(async () => {
    if (!recent) return
    const consequences = cigaretteLogMutationConsequences(state, recent)
    const result = await runAppModal(() => Taro.showModal({
      title: '撤销刚才记录？',
      content: `将删除这支烟${consequences.affectedCheckInCount ? '，并撤销关联日终确认' : ''}${consequences.linkedLapseCount ? '，同时删除关联复盘' : ''}。`,
      confirmText: '确认撤销',
    }))
    if (result.confirm && actions.deleteCigaretteLog(recent.id)) setRecentId(undefined)
  })
  return <HarmonyScrollablePage className='screen today-page today-page--quit' viewport='tab' overlay={
    <SmokingEventSheet open={Boolean(smokedAt || editing)} capturedAt={smokedAt} editing={editing} allowTimeEdit={Boolean(editing)} onClose={close} onSaved={setRecentId} />
  }>
    <PageHeader title='无烟生活' compact showSos />
    <QuitDashboard state={state} now={now} onRecord={() => { const capturedAt = new Date().toISOString(); defer(() => setSmokedAt(capturedAt)) }} />
    {recent ? <View className='quit-recent-actions'><Text>刚刚记录</Text>
      <Button className='quit-text-button' onClick={() => defer(() => setEditing(recent))}>编辑</Button>
      <Button className='quit-text-button' onClick={() => void undoRecent()}>撤销</Button>
    </View> : null}
    <View className='quit-day-confirmation'>
      {checkIn ? <><Text>今日已确认 {checkIn.cigarettesSmoked} 支</Text><Button className='quit-text-button' onClick={() => void undoConfirmation()}>撤销今日确认</Button></>
        : <Button className='quit-basis-toggle' onClick={() => void confirmDay()}>确认今日 {todayCount} 支</Button>}
    </View>
  </HarmonyScrollablePage>
}
