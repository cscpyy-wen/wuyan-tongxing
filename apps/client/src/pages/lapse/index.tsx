import { Picker, Text, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { AccessibleButton as Button } from '../../components/AccessibleButton'
import { AccessibleRadio } from '../../components/AccessibleRadio'
import { LoadingScreen } from '../../components/LoadingScreen'
import { PageHeader } from '../../components/PageHeader'
import { useRequireOnboarding } from '../../hooks/useRequireOnboarding'
import { createId } from '../../lib/model'
import { runAppModal } from '../../lib/modalCoordinator'
import { formatSmokingTime, smokingTriggerLabel, SMOKING_TIMEZONE_LABEL, SMOKING_TRIGGER_OPTIONS } from '../../lib/smokingLogs'
import { cigaretteLogAdditionConsequences } from '../../lib/smokingLogConsequences'
import { useAppState } from '../../state/AppState'
import type { CravingLevel, Trigger } from '../../types'
import './index.scss'

const ACTIONS = ['离开吸烟场景并处理剩余烟', '马上做一次烟瘾急救', '联系可信赖的支持者', '更新一个“如果—那么”计划']
const INTENSITIES: ReadonlyArray<{ value: CravingLevel; label: string }> = [
  { value: 1, label: '很轻' },
  { value: 2, label: '较轻' },
  { value: 3, label: '明显' },
  { value: 4, label: '很强' },
  { value: 5, label: '难忍' },
]

export default function LapsePage() {
  const { state, ready } = useRequireOnboarding()
  const { actions } = useAppState()
  const router = useRouter()
  const referenced = typeof router.params.cigaretteLogId === 'string'
    ? state.cigarettes.find((item) => item.id === router.params.cigaretteLogId && item.attemptId === state.plan?.id)
    : undefined
  const existingLapse = referenced
    ? state.lapses.find((item) => item.cigaretteLogId === referenced.id && item.attemptId === state.plan?.id)
    : undefined
  const suggestedIntensity = Number(router.params.cravingIntensity)
  const [cigarettes, setCigarettes] = useState(1)
  const [trigger, setTrigger] = useState<Trigger | undefined>()
  const [intensity, setIntensity] = useState<CravingLevel | undefined>(() => (
    Number.isInteger(suggestedIntensity) && suggestedIntensity >= 1 && suggestedIntensity <= 5
      ? suggestedIntensity as CravingLevel
      : undefined
  ))
  const [recoveryAction, setRecoveryAction] = useState(ACTIONS[0]!)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const pendingSmokedAtRef = useRef<string>()
  const operationIdRef = useRef<string>()
  if (!operationIdRef.current) operationIdRef.current = createId('lapse-operation')

  useEffect(() => {
    if (existingLapse) setRecoveryAction(existingLapse.recoveryAction)
  }, [existingLapse])

  if (!ready || !state.plan) return <LoadingScreen />

  const save = async () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    let committed = false
    try {
      if (existingLapse) {
        if (existingLapse.recoveryAction === recoveryAction) {
          Taro.showToast({ title: '没有更改', icon: 'none' })
          void Taro.navigateBack()
          return
        }
        if (!actions.editLapseRecoveryAction(existingLapse.id, recoveryAction)) {
          Taro.showToast({ title: '未能保存，请重试', icon: 'none' })
          return
        }
        committed = true
        Taro.showToast({ title: '复盘已更新', icon: 'none' })
        setTimeout(() => Taro.navigateBack(), 350)
        return
      }

      if (!referenced && (!trigger || !intensity)) return
      const smokedAt = referenced?.createdAt ?? pendingSmokedAtRef.current ?? new Date().toISOString()
      pendingSmokedAtRef.current = smokedAt
      const consequences = cigaretteLogAdditionConsequences(state, smokedAt)
      if (consequences.affectedCheckInCount > 0) {
        const confirmation = await runAppModal(() => Taro.showModal({
          title: '保存这次复盘？',
          content: `${referenced ? '不会重复增加烟支；' : `将记录 ${cigarettes} 支烟；`}将撤销 ${consequences.affectedCheckInCount} 条受影响日期的日终确认。`,
          confirmText: '确认保存',
          cancelText: '继续编辑',
        }))
        if (!confirmation.confirm) {
          pendingSmokedAtRef.current = undefined
          return
        }
      }
      if (!actions.recordLapse(
        cigarettes,
        trigger,
        recoveryAction,
        referenced?.id,
        operationIdRef.current!,
        { smokedAt, ...(intensity ? { cravingIntensity: intensity } : {}) },
      )) {
        Taro.showToast({ title: '未能保存，请重试', icon: 'none' })
        return
      }
      committed = true
      Taro.showToast({ title: '计划已恢复，累计进展保留', icon: 'none', duration: 1800 })
      setTimeout(() => Taro.switchTab({ url: '/pages/progress/index' }), 500)
    } catch {
      Taro.showToast({ title: '无法打开确认框，请重试', icon: 'none' })
    } finally {
      if (!committed) {
        savingRef.current = false
        setSaving(false)
      }
    }
  }

  return (
    <View className='screen screen--detail lapse-page'>
      <PageHeader title={existingLapse ? '编辑复盘' : '复盘这次吸烟'} subtitle='连续时间重算，累计进展保留。' />
      <View className='card card--soft lapse-reassurance'>
        <Text className='lapse-reassurance__number'>任务 {state.completedTasks.filter((item) => item.attemptId === state.plan!.id).length} · 急救 {state.cravings.filter((item) => item.attemptId === state.plan!.id).length}</Text>
        <Text className='lapse-reassurance__text'>已有进展不会清零</Text>
      </View>
      <Text className='section-title'>发生了什么？</Text>
      {referenced ? (
        <View className='card stack'>
          <View className='row row--between'>
            <Text className='field-label'>已记录的这支烟</Text>
            <Text className='pill'>{SMOKING_TIMEZONE_LABEL} {formatSmokingTime(referenced.createdAt)}</Text>
          </View>
          <Text className='muted'>{smokingTriggerLabel(referenced.trigger)} · 烟瘾 {referenced.cravingIntensity ? `${referenced.cravingIntensity}/5` : '未记录'}</Text>
          <Text className='fine-print'>{existingLapse ? '修改恢复动作，不改变烟支统计。' : '这里只补充恢复动作，不会重复增加烟支。'}</Text>
        </View>
      ) : (
        <View className='card stack'>
          <View>
            <Text className='field-label'>这次吸了多少支？</Text>
            <View className='lapse-count-stepper' role='group' aria-label={`这次吸烟 ${cigarettes} 支`}>
              <Button className='lapse-count-stepper__button' aria-label='减少一支' disabled={cigarettes <= 1} onClick={() => setCigarettes((value) => Math.max(1, value - 1))}>−</Button>
              <Text className='lapse-count-stepper__value' aria-live='polite'>{cigarettes} 支</Text>
              <Button className='lapse-count-stepper__button' aria-label='增加一支' disabled={cigarettes >= 60} onClick={() => setCigarettes((value) => Math.min(60, value + 1))}>＋</Button>
            </View>
          </View>
          <View>
            <Text className='field-label'>原因</Text>
            <Picker mode='selector' range={SMOKING_TRIGGER_OPTIONS.map((item) => item.label)} onChange={(event) => setTrigger(SMOKING_TRIGGER_OPTIONS[Number(event.detail.value)]?.value)}>
              <Button className='picker-field picker-field--trigger' aria-label={`吸烟原因，${smokingTriggerLabel(trigger)}`}>{smokingTriggerLabel(trigger)}</Button>
            </Picker>
          </View>
          <View>
            <Text className='field-label'>烟瘾</Text>
            <View className='lapse-intensity' role='radiogroup' aria-label='选择这次烟瘾强度'>
              {INTENSITIES.map((option) => (
                <AccessibleRadio
                  key={option.value}
                  className={`lapse-intensity__choice ${intensity === option.value ? 'lapse-intensity__choice--active' : ''}`}
                  checked={intensity === option.value}
                  groupName='lapse-intensity'
                  label={`烟瘾强度 ${option.value}，${option.label}`}
                  value={String(option.value)}
                  onSelect={() => setIntensity(option.value)}
                >{option.value}</AccessibleRadio>
              ))}
            </View>
          </View>
        </View>
      )}
      <Text className='section-title'>下一步只做一个动作</Text>
      <View className='stack' role='radiogroup' aria-label='选择恢复动作'>
        {ACTIONS.map((action) => (
          <AccessibleRadio
            key={action}
            className={`recovery-choice ${recoveryAction === action ? 'recovery-choice--active' : ''}`}
            checked={recoveryAction === action}
            groupName='lapse-recovery-action'
            label={`恢复动作：${action}`}
            value={action}
            onSelect={() => setRecoveryAction(action)}
          >
            <Text>{recoveryAction === action ? '✓' : '○'}</Text>
            <Text className='grow'>{action}</Text>
          </AccessibleRadio>
        ))}
      </View>
      <Button className='button lapse-save' disabled={saving || (!referenced && (!trigger || !intensity))} onClick={() => void save()}>
        {saving ? '正在保存…' : existingLapse ? '保存复盘修改' : '保留进展并重新出发'}
      </Button>
      <Text className='fine-print lapse-note'>本模块是行为支持工具，不替代专业医疗。反复滑倒或戒断反应难以应对时，可在“我的”中查找专业支持。</Text>
    </View>
  )
}
