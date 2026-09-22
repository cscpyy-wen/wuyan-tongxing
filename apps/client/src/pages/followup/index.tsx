import { Input, Slider, Text, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useEffect, useMemo, useState } from 'react'
import { getContentItem } from '@wuyan/content'
import { AccessibleButton as Button } from '../../components/AccessibleButton'
import { LoadingScreen } from '../../components/LoadingScreen'
import { PageHeader } from '../../components/PageHeader'
import { WithheldHealthContent } from '../../components/WithheldHealthContent'
import { HEALTH_CONTENT_ENABLED } from '../../lib/healthContentGate'
import { addMonths, daysBetween, toLocalDate } from '../../lib/model'
import { useRequireOnboarding } from '../../hooks/useRequireOnboarding'
import { useAppState } from '../../state/AppState'
import './index.scss'

type DueMonth = 3 | 6 | 12
type TriState = boolean | null

function parseMonth(value: string | undefined): DueMonth {
  if (value === '6') return 6
  if (value === '12') return 12
  return 3
}

interface TriStateQuestionProps {
  label: string
  value: TriState
  onChange(value: TriState): void
}

function TriStateQuestion({ label, value, onChange }: TriStateQuestionProps) {
  return (
    <View className='followup-question'>
      <Text className='field-label'>{label}</Text>
      <View className='tri-grid' role='group' aria-label={label}>
        <Button className={`choice ${value === true ? 'choice--active' : ''}`} onClick={() => onChange(true)}>是</Button>
        <Button className={`choice ${value === false ? 'choice--active' : ''}`} onClick={() => onChange(false)}>否</Button>
        <Button className={`choice ${value === null ? 'choice--active' : ''}`} onClick={() => onChange(null)}>暂不回答</Button>
      </View>
    </View>
  )
}

export default function FollowupPage() {
  const router = useRouter()
  const month = parseMonth(router.params.month)
  const { state, ready } = useRequireOnboarding()
  const { actions } = useAppState()
  const saved = state.plan
    ? state.outcomes.find((item) => item.planId === state.plan!.id && item.dueMonth === month)
    : undefined
  const [sevenDay, setSevenDay] = useState<TriState>(null)
  const [thirtyDay, setThirtyDay] = useState<TriState>(null)
  const [continuous, setContinuous] = useState<TriState>(null)
  const [currentCigarettes, setCurrentCigarettes] = useState<number | null>(null)
  const [additionalAttempts, setAdditionalAttempts] = useState<number | null>(null)
  const [confidence, setConfidence] = useState<number | null>(null)
  const [professionalSupport, setProfessionalSupport] = useState<TriState>(null)

  useEffect(() => {
    if (!saved) return
    setSevenDay(saved.sevenDayAbstinent)
    setThirtyDay(saved.thirtyDayAbstinent)
    setContinuous(saved.continuouslyAbstinent)
    setCurrentCigarettes(saved.currentCigarettesPerDay)
    setAdditionalAttempts(saved.additionalQuitAttempts)
    setConfidence(saved.confidence)
    setProfessionalSupport(saved.usedProfessionalSupport)
  }, [saved])

  const content = useMemo(() => getContentItem(`followup-month-${String(month).padStart(2, '0')}`), [month])
  if (!HEALTH_CONTENT_ENABLED) return <WithheldHealthContent />
  if (!ready || !state.plan) return <LoadingScreen />

  const dueDate = addMonths(state.plan.quitDate, month)
  const isDue = daysBetween(dueDate, toLocalDate(new Date())) >= 0

  const save = () => {
    if (!isDue) {
      Taro.showToast({ title: `随访将在 ${dueDate} 开放`, icon: 'none' })
      return
    }
    const savedOutcome = actions.recordOutcome({
      planId: state.plan!.id,
      dueMonth: month,
      sevenDayAbstinent: sevenDay,
      thirtyDayAbstinent: thirtyDay,
      continuouslyAbstinent: continuous,
      currentCigarettesPerDay: currentCigarettes,
      additionalQuitAttempts: additionalAttempts,
      confidence,
      usedProfessionalSupport: professionalSupport,
    })
    if (savedOutcome) {
      Taro.showToast({ title: '随访已保存在本机', icon: 'success' })
      setTimeout(() => Taro.navigateBack(), 500)
    }
  }

  return (
    <View className='screen screen--detail followup-page'>
      <PageHeader
        eyebrow={`${month} 个月随访 · ${isDue ? '已开放' : `计划 ${dueDate}`}`}
        title={content?.title ?? `${month} 个月随访`}
        subtitle='如实回答比“好看的结果”更有用；不确定或不想回答时请选择“暂不回答”。'
      />

      {!isDue ? (
        <View className='card card--soft followup-preview'>
          <Text className='field-label'>当前为问题预览</Text>
          <Text className='fine-print'>到期前不能提交，避免把提前回答误当作 {month} 个月结局。核心功能不依赖这份随访。</Text>
        </View>
      ) : null}

      {content ? (
        <View className='card followup-intro'>
          <Text className='muted'>{content.body}</Text>
          <Text className='fine-print'>{content.riskStatement}</Text>
        </View>
      ) : null}

      <Text className='section-title'>戒烟结局</Text>
      <View className='card stack'>
        <TriStateQuestion label='过去 7 天是否完全没有吸纸烟？' value={sevenDay} onChange={setSevenDay} />
        <View className='divider' />
        <TriStateQuestion label='过去 30 天是否完全没有吸纸烟？' value={thirtyDay} onChange={setThirtyDay} />
        <View className='divider' />
        <TriStateQuestion label='自戒烟日起是否持续没有吸纸烟？' value={continuous} onChange={setContinuous} />
      </View>

      <Text className='section-title'>现在的情况</Text>
      <View className='card stack'>
        <View>
          <Text className='field-label'>目前平均每天吸多少支？</Text>
          <Input
            className='input'
            type='number'
            value={currentCigarettes === null ? '' : String(currentCigarettes)}
            placeholder='不回答可留空'
            onInput={(event) => setCurrentCigarettes(event.detail.value === '' ? null : Math.max(0, Math.min(100, Number(event.detail.value) || 0)))}
          />
        </View>
        <View>
          <Text className='field-label'>这期间又开始过几次新的戒烟尝试？</Text>
          <Input
            className='input'
            type='number'
            value={additionalAttempts === null ? '' : String(additionalAttempts)}
            placeholder='不回答可留空'
            onInput={(event) => setAdditionalAttempts(event.detail.value === '' ? null : Math.max(0, Math.min(100, Number(event.detail.value) || 0)))}
          />
        </View>
        <TriStateQuestion label='这期间是否使用过戒烟门诊、热线、医生或药师支持？' value={professionalSupport} onChange={setProfessionalSupport} />
      </View>

      <Text className='section-title'>接下来继续的信心</Text>
      <View className='card stack'>
        <View className='row row--between'>
          <Text className='field-label'>0 分表示完全没信心，10 分表示非常有信心</Text>
          <Text className='followup-score'>{confidence === null ? '未答' : `${confidence} 分`}</Text>
        </View>
        <View className='choice-grid'>
          <Button className={`choice ${confidence === null ? 'choice--active' : ''}`} onClick={() => setConfidence(null)}>暂不回答</Button>
          <Button className={`choice ${confidence !== null ? 'choice--active' : ''}`} onClick={() => setConfidence(confidence ?? 5)}>填写分数</Button>
        </View>
        {confidence !== null ? <Slider min={0} max={10} step={1} value={confidence} showValue activeColor='#176B55' blockColor='#176B55' onChange={(event) => setConfidence(event.detail.value)} /> : null}
      </View>

      <Button className='button followup-save' disabled={!isDue} onClick={save}>
        {isDue ? saved ? '更新这次随访' : '保存这次随访' : `将于 ${dueDate} 开放`}
      </Button>
      <Text className='fine-print followup-disclaimer'>所有结果均为用户自报、未经生化验证。漏答保存为“未知”，不会自动填为成功或失败。</Text>
    </View>
  )
}
