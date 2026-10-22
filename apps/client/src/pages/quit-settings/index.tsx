import { Input, Picker, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibleButton as Button } from '../../components/AccessibleButton'
import { AccessibleCheckbox } from '../../components/AccessibleCheckbox'
import { HarmonyScrollablePage } from '../../components/HarmonyScrollablePage'
import { LoadingScreen } from '../../components/LoadingScreen'
import { PageHeader } from '../../components/PageHeader'
import { useRequireOnboarding } from '../../hooks/useRequireOnboarding'
import { useAppState } from '../../state/AppState'
import { toLocalDate } from '../../lib/model'
import { shanghaiDateTimeToIso, toShanghaiTime } from '../../lib/smokingLogs'
import { validateQuitJourneyInput } from '../../lib/quitJourney'
import { openTodayAsRoot } from '../../lib/navigation'
import { registerNativeBackHandler } from '../../lib/runtime'
import './index.scss'

export default function QuitSettingsPage() {
  const { state, ready } = useRequireOnboarding()
  if (!ready || !state.plan || !state.baseline) return <LoadingScreen />
  return <QuitSettingsForm key={state.plan.id} />
}

function QuitSettingsForm() {
  const { state, actions } = useAppState()
  const existing = state.quitJourney?.attemptId === state.plan!.id ? state.quitJourney : undefined
  const [attemptId] = useState(state.plan!.id)
  const [date, setDate] = useState(existing ? toLocalDate(existing.startedAt) : '')
  const [time, setTime] = useState(existing ? toShanghaiTime(existing.startedAt) : '')
  const [daily, setDaily] = useState(String(existing?.cigarettesPerDay ?? state.plan!.baselineCigarettesPerDay))
  const [price, setPrice] = useState(String(existing?.pricePerPack ?? state.plan!.baselinePricePerPack))
  const [pack, setPack] = useState(String(existing?.cigarettesPerPack ?? 20))
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const savePending = useRef(false)
  const leaving = useRef(false)
  const [preciseTime, setPreciseTime] = useState<string>()
  const returnHome = useCallback(async () => {
    if (leaving.current) return
    leaving.current = true
    try {
      // Recreate the tab root: Taro's outgoing detail animation can otherwise
      // hide the cached Today page after a fast switchTab back to it.
      await openTodayAsRoot()
    } catch {
      leaving.current = false
      Taro.showToast({ title: '返回失败，请重试', icon: 'none' })
    }
  }, [])
  useEffect(() => registerNativeBackHandler(() => { void returnHome() }), [returnHome])
  const latestLog = state.cigarettes.filter((log) => log.count > 0 && log.source !== 'DAILY_CHECKIN' && new Date(log.createdAt) <= new Date())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
  const sameStart = Boolean(existing && date === toLocalDate(existing.startedAt) && time === toShanghaiTime(existing.startedAt)
    && (!preciseTime || new Date(preciseTime).getTime() === new Date(existing.startedAt).getTime()))
  const needsDeclaration = !sameStart

  const save = async () => {
    if (savePending.current || leaving.current) return
    const startedAt = preciseTime ?? (sameStart ? existing!.startedAt : shanghaiDateTimeToIso(date, time))
    if (!date || !time || !startedAt) { setError('请选择最后一支烟的日期和时间'); return }
    if (needsDeclaration && !confirmed) { setError('请确认此后没有再吸烟'); return }
    if (!daily.trim() || !price.trim() || !pack.trim()) { setError('请填完整估算参数'); return }
    const input = { attemptId, startedAt, cigarettesPerDay: Number(daily), pricePerPack: Number(price), cigarettesPerPack: Number(pack) }
    const message = validateQuitJourneyInput(state, input, new Date())
    if (message) { setError(message); return }
    savePending.current = true
    setSaving(true)
    try {
      if (await actions.saveQuitJourney(input)) await returnHome()
    } catch {
      setError('保存未完成，请重试；原有记录未删除')
    } finally { savePending.current = false; setSaving(false) }
  }

  return <HarmonyScrollablePage className='screen quit-settings' viewport='full'>
    <Button className='quit-back' onClick={() => void returnHome()}>‹ 返回首页</Button>
    <PageHeader title='你的无烟起点' subtitle='从最后一支烟，开始新的每一天。' />
    <View className='card quit-settings__fields'>
      <Text className='field-label'>最后一支 · 北京时间</Text>
      <View className='quit-settings__date'>
        <Picker mode='date' start='1970-01-01' end={toLocalDate(new Date())} value={date || toLocalDate(new Date())}
          onChange={(event) => { setDate(event.detail.value); setPreciseTime(undefined); setConfirmed(false); setError('') }}>
          <Button className='picker-field' aria-label='最后一支烟的日期'>{date || '选择日期'}</Button>
        </Picker>
        <Picker mode='time' value={time || toShanghaiTime(new Date())}
          onChange={(event) => { setTime(event.detail.value); setPreciseTime(undefined); setConfirmed(false); setError('') }}>
          <Button className='picker-field' aria-label='最后一支烟的时间'>{time || '选择时间'}</Button>
        </Picker>
      </View>
      {latestLog ? <Button className='quit-source-button' onClick={() => {
        setDate(toLocalDate(latestLog.createdAt)); setTime(toShanghaiTime(latestLog.createdAt)); setPreciseTime(latestLog.createdAt); setConfirmed(false); setError('')
      }}>使用最近记录的准确时间</Button> : null}
      {needsDeclaration ? <AccessibleCheckbox checked={confirmed} label='从这个时间起，我没有再吸烟' value='quit-declaration'
        className={`quit-declaration ${confirmed ? 'quit-declaration--checked' : ''}`} onToggle={() => setConfirmed(!confirmed)}>
        <Text aria-hidden='true'>{confirmed ? '✓' : '○'}</Text><Text>此后没有再吸烟</Text>
      </AccessibleCheckbox> : null}
    </View>
    <View className='card quit-settings__fields'>
      <Text className='field-label'>戒烟前的习惯</Text>
      {[
        { label: '每天支数', unit: '支 / 天', value: daily, set: setDaily, type: 'number' as const },
        { label: '每包价格', unit: '元 / 包', value: price, set: setPrice, type: 'digit' as const },
        { label: '每包支数', unit: '支 / 包', value: pack, set: setPack, type: 'number' as const },
      ].map((field) => <View className='quit-settings__field' key={field.label}>
        <Text>{field.label}</Text>
        <Input className='input' type={field.type} aria-label={field.label} nativeProps={{ 'aria-label': field.label }}
          value={field.value} maxlength={8} onInput={(event) => { field.set(event.detail.value); setError('') }} />
        <Text className='muted'>{field.unit}</Text>
      </View>)}
    </View>
    <Text className='quit-settings__note'>仅更新无烟首页的估算，不改动原有记录。以后若吸烟，照常记一支，连续计时会重新开始。</Text>
    {error ? <View className='quit-settings__error' role='alert'>{error}</View> : null}
    <Button className='button' disabled={saving} onClick={() => void save()}>{saving ? '正在保存' : '保存并查看成就'}</Button>
  </HarmonyScrollablePage>
}
