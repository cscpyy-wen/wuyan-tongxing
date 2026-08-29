import { Input, Picker, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useState } from 'react'
import { AccessibleButton as Button } from '../../components/AccessibleButton'
import { AccessibleCheckbox } from '../../components/AccessibleCheckbox'
import { AccessibleRadio } from '../../components/AccessibleRadio'
import { LoadingScreen } from '../../components/LoadingScreen'
import { useMinuteClock } from '../../hooks/useMinuteClock'
import { dismissAndroidBootstrap } from '../../lib/androidBootstrap'
import { canBeginPersonalPlan, MAX_PREVIOUS_ATTEMPTS } from '../../lib/model'
import { requestNativeBackupRestoreSelection } from '../../lib/nativeBackupRestoreSelection'
import { isNativeAndroidApp } from '../../lib/runtime'
import { SMOKING_TRIGGER_OPTIONS } from '../../lib/smokingLogs'
import { useAppState } from '../../state/AppState'
import type { QuitPath, Trigger } from '../../types'
import { getOnboardingQuitDateWindow, validateOnboardingQuitDateAtSubmission } from './dateLogic'
import {
  firstCigaretteMinutesAfterPicker,
  firstCigarettePickerIndex,
  FIRST_CIGARETTE_LABELS,
} from './assessmentLogic'
import './index.scss'

const REASONS = ['为了健康', '陪伴家人', '省下开支', '恢复体能', '摆脱依赖', '给自己一个承诺']
function toggleLimited<T>(values: T[], value: T, limit = 3): T[] {
  if (values.includes(value)) return values.filter((item) => item !== value)
  if (values.length >= limit) {
    Taro.showToast({ title: `最多选择 ${limit} 项`, icon: 'none' })
    return values
  }
  return [...values, value]
}

export default function OnboardingPage() {
  const { state, ready, loadFailure, actions } = useAppState()
  const [step, setStep] = useState(0)
  const [adult, setAdult] = useState(false)
  const [minor, setMinor] = useState(false)
  const [currentSmoker, setCurrentSmoker] = useState(false)
  const [smokerAnswered, setSmokerAnswered] = useState(false)
  const [boundaryAccepted, setBoundaryAccepted] = useState(false)
  const [localHealthAccepted, setLocalHealthAccepted] = useState(false)
  const [cigarettesPerDay, setCigarettesPerDay] = useState(10)
  const [firstCigaretteMinutes, setFirstCigaretteMinutes] = useState<number>()
  const [previousAttempts, setPreviousAttempts] = useState(0)
  const [pricePerPack, setPricePerPack] = useState(25)
  const [reasons, setReasons] = useState<string[]>(['为了健康'])
  const [triggers, setTriggers] = useState<Trigger[]>([])
  const [path, setPath] = useState<QuitPath>('abrupt')
  const [restoring, setRestoring] = useState(false)
  const nativeAndroid = isNativeAndroidApp()
  const now = useMinuteClock()
  const dateWindow = getOnboardingQuitDateWindow(path, now)
  const [quitDate, setQuitDate] = useState(() => getOnboardingQuitDateWindow('abrupt', new Date()).recommended)
  useEffect(() => {
    if (loadFailure) {
      dismissAndroidBootstrap()
      return
    }
    if (!ready) return
    if (state.onboarded) {
      void Taro.reLaunch({ url: '/pages/today/index' })
        .finally(() => dismissAndroidBootstrap())
      return
    }
    dismissAndroidBootstrap()
  }, [loadFailure, ready, state.onboarded])

  if (!ready || state.onboarded) return <LoadingScreen />

  const setQuitPath = (next: QuitPath) => {
    setPath(next)
    setQuitDate(getOnboardingQuitDateWindow(next, new Date()).recommended)
  }

  const firstCigaretteText = firstCigaretteMinutes === undefined
    ? '请选择'
    : firstCigaretteMinutes <= 5
      ? '起床后 5 分钟内'
      : firstCigaretteMinutes <= 30
        ? '6–30 分钟'
        : firstCigaretteMinutes <= 60
          ? '31–60 分钟'
          : '60 分钟以后'

  const canContinue = [
    canBeginPersonalPlan({
      adultConfirmed: adult,
      currentPaperCigaretteUser: currentSmoker,
      medicalBoundaryAccepted: boundaryAccepted,
      sensitiveHealthDataAccepted: localHealthAccepted,
    }),
    cigarettesPerDay > 0 && firstCigaretteMinutes !== undefined,
    reasons.length > 0 && reasons.length <= 3,
    triggers.length > 0 && triggers.length <= 3,
    true,
  ][step]

  const next = () => {
    if (!canContinue) {
      Taro.showToast({ title: '请先完成本页选择', icon: 'none' })
      return
    }
    setStep((current) => Math.min(4, current + 1))
  }

  const submit = () => {
    if (firstCigaretteMinutes === undefined) {
      Taro.showToast({ title: '请选择起床后第一支时间', icon: 'none' })
      return
    }
    if (!validateOnboardingQuitDateAtSubmission(path, quitDate)) {
      Taro.showToast({ title: '请选择允许范围内的日期', icon: 'none' })
      return
    }
    const saved = actions.finishOnboarding({
      path,
      quitDate,
      baseline: {
        cigarettesPerDay,
        firstCigaretteMinutes,
        previousAttempts,
        reasons,
        triggers,
        pricePerPack,
      },
    })
    if (saved) Taro.reLaunch({ url: '/pages/today/index' })
  }

  const restoreBackup = async () => {
    if (!nativeAndroid || restoring) return
    setRestoring(true)
    try {
      await requestNativeBackupRestoreSelection()
    } finally {
      setRestoring(false)
    }
  }

  if (minor) {
    return (
      <View className='screen screen--detail onboarding'>
        <View className='minor-card'>
          <Text className='minor-card__icon' aria-hidden='true'>◌</Text>
          <Text className='page-title'>这版产品暂不面向未成年人</Text>
          <Text className='page-subtitle'>我们没有保存你的任何回答。请向监护人、学校卫生人员或正规医疗机构寻求帮助。</Text>
          <Button className='button button--secondary' onClick={() => setMinor(false)}>返回年龄确认</Button>
        </View>
      </View>
    )
  }

  return (
    <View className='screen screen--detail onboarding'>
      <View className='onboarding__top'>
        <View className='onboarding__brand'>无烟同行</View>
        <Text className='muted'>{step + 1} / 5</Text>
      </View>
      <View className='progress-track' aria-label={`首次设置进度 ${step + 1}/5`}>
        <View className='progress-fill' style={{ width: `${((step + 1) / 5) * 100}%` }} />
      </View>

      {step === 0 ? (
        <View className='onboarding__body'>
          <Text className='page-title'>先确认这几项</Text>
          <Text className='page-subtitle'>无需登录，数据只存本机。</Text>
          <View className='card card--soft stack'>
            <Text className='field-label'>请确认年龄</Text>
            <View className='choice-grid'>
              <AccessibleRadio
                checked={adult}
                className={`choice ${adult ? 'choice--active' : ''}`}
                groupName='adult-status'
                label='我已满 18 岁'
                value='adult'
                onSelect={() => { setAdult(true); setMinor(false) }}
              >
                我已满 18 岁
              </AccessibleRadio>
              <AccessibleRadio
                checked={minor}
                className={`choice ${minor ? 'choice--active' : ''}`}
                groupName='adult-status'
                label='我未满 18 岁'
                value='minor'
                onSelect={() => { setAdult(false); setMinor(true) }}
              >
                我未满 18 岁
              </AccessibleRadio>
            </View>
          </View>
          <View className='card card--soft stack'>
            <Text className='field-label'>你目前是否吸纸烟？</Text>
            <View className='choice-grid'>
              <AccessibleRadio
                checked={currentSmoker}
                className={`choice ${currentSmoker ? 'choice--active' : ''}`}
                groupName='smoking-status'
                label='是，当前吸纸烟'
                value='paper-cigarette'
                onSelect={() => { setCurrentSmoker(true); setSmokerAnswered(true) }}
              >是，当前吸纸烟</AccessibleRadio>
              <AccessibleRadio
                checked={smokerAnswered && !currentSmoker}
                className={`choice ${smokerAnswered && !currentSmoker ? 'choice--active' : ''}`}
                groupName='smoking-status'
                label='不是或不确定'
                value='not-current-smoker'
                onSelect={() => { setCurrentSmoker(false); setSmokerAnswered(true) }}
              >不是或不确定</AccessibleRadio>
            </View>
          </View>
          <View className='card stack onboarding-consent'>
            <View className='row row--between onboarding-consent__row'>
              <View className='grow'>
                <Text className='field-label'>接受：行为支持，不替代医生</Text>
              </View>
              <AccessibleCheckbox
                checked={boundaryAccepted}
                className='consent-switch'
                label='接受产品与医疗边界'
                value='medical-boundary'
                onToggle={() => setBoundaryAccepted((value) => !value)}
              >
                <View className={`consent-switch__track ${boundaryAccepted ? 'consent-switch__track--active' : ''}`} aria-hidden='true'>
                  <View className='consent-switch__thumb' />
                </View>
              </AccessibleCheckbox>
            </View>
            <View className='divider' />
            <View className='row row--between onboarding-consent__row'>
              <View className='grow'>
                <Text className='field-label'>同意：本机保存敏感健康记录</Text>
              </View>
              <AccessibleCheckbox
                checked={localHealthAccepted}
                className='consent-switch'
                label='单独同意本机处理敏感健康信息'
                value='local-sensitive-health'
                onToggle={() => setLocalHealthAccepted((value) => !value)}
              >
                <View className={`consent-switch__track ${localHealthAccepted ? 'consent-switch__track--active' : ''}`} aria-hidden='true'>
                  <View className='consent-switch__thumb' />
                </View>
              </AccessibleCheckbox>
            </View>
            <Text className='fine-print'>戒烟记录只存本机；拒绝则不创建计划。</Text>
          </View>
        </View>
      ) : null}

      {step === 1 ? (
        <View className='onboarding__body'>
          <Text className='eyebrow'>你的吸烟情况</Text>
          <Text className='page-title'>不评判，只为让建议更合适</Text>
          <View className='card stack'>
            <View>
              <Text className='field-label'>通常每天吸多少支？</Text>
              <View className='number-stepper' role='group' aria-label={`通常每天 ${cigarettesPerDay} 支`}>
                <Button className='number-stepper__button' aria-label='每天少一支' disabled={cigarettesPerDay <= 1} onClick={() => setCigarettesPerDay((value) => Math.max(1, value - 1))}>−</Button>
                <Text className='range-value' aria-live='polite'>{cigarettesPerDay} 支</Text>
                <Button className='number-stepper__button' aria-label='每天多一支' disabled={cigarettesPerDay >= 60} onClick={() => setCigarettesPerDay((value) => Math.min(60, value + 1))}>＋</Button>
              </View>
            </View>
            <View className='divider' />
            <View>
              <Text className='field-label'>起床后多久吸第一支？</Text>
              <Picker
                mode='selector'
                range={FIRST_CIGARETTE_LABELS}
                value={firstCigaretteMinutes === undefined ? 0 : firstCigarettePickerIndex(firstCigaretteMinutes)}
                onChange={(event) => setFirstCigaretteMinutes((current) => (
                  firstCigaretteMinutesAfterPicker(current, event.detail.value)
                ))}
              >
                <Button
                  className='picker-field picker-field--trigger'
                  aria-label={`起床后多久吸第一支，${firstCigaretteMinutes === undefined ? '尚未选择' : `当前 ${firstCigaretteText}`}`}
                >
                  {firstCigaretteText}
                </Button>
              </Picker>
            </View>
            <View>
              <Text className='field-label'>以前认真戒过几次？</Text>
              <Input
                className='input'
                type='number'
                aria-label='以前认真戒烟次数'
                nativeProps={{ 'aria-label': '以前认真戒烟次数' }}
                value={String(previousAttempts)}
                onInput={(event) => setPreviousAttempts(
                  Math.max(0, Math.min(MAX_PREVIOUS_ATTEMPTS, Math.trunc(Number(event.detail.value) || 0))),
                )}
              />
            </View>
            <View>
              <Text className='field-label'>一包烟大约多少钱？</Text>
              <Input
                className='input'
                type='digit'
                aria-label='每包烟价格'
                nativeProps={{ 'aria-label': '每包烟价格' }}
                value={String(pricePerPack)}
                onInput={(event) => setPricePerPack(Math.max(0, Math.min(999, Number(event.detail.value) || 0)))}
              />
            </View>
          </View>
        </View>
      ) : null}

      {step === 2 ? (
        <View className='onboarding__body'>
          <Text className='eyebrow'>你的理由</Text>
          <Text className='page-title'>烟瘾来时，什么值得你坚持？</Text>
          <Text className='page-subtitle'>请选择 1–3 项，之后随时能调整。已选 {reasons.length}/3。</Text>
          <View className='card'>
            <View className='choice-grid'>
              {REASONS.map((reason) => (
                <AccessibleCheckbox
                  checked={reasons.includes(reason)}
                  key={reason}
                  className={`choice ${reasons.includes(reason) ? 'choice--active' : ''}`}
                  label={reason}
                  value={reason}
                  onToggle={() => setReasons(toggleLimited(reasons, reason))}
                >
                  {reason}
                </AccessibleCheckbox>
              ))}
            </View>
          </View>
        </View>
      ) : null}

      {step === 3 ? (
        <View className='onboarding__body'>
          <Text className='eyebrow'>高风险时刻</Text>
          <Text className='page-title'>最容易点烟的场景有哪些？</Text>
          <Text className='page-subtitle'>请选择 1–3 项，用来安排烟瘾急救练习，不用于广告。已选 {triggers.length}/3。</Text>
          <View className='card'>
            <View className='choice-grid'>
              {SMOKING_TRIGGER_OPTIONS.map((trigger) => (
                <AccessibleCheckbox
                  checked={triggers.includes(trigger.value)}
                  key={trigger.value}
                  className={`choice ${triggers.includes(trigger.value) ? 'choice--active' : ''}`}
                  label={trigger.label}
                  value={trigger.value}
                  onToggle={() => setTriggers(toggleLimited(triggers, trigger.value))}
                >
                  {trigger.label}
                </AccessibleCheckbox>
              ))}
            </View>
          </View>
        </View>
      ) : null}

      {step === 4 ? (
        <View className='onboarding__body'>
          <Text className='eyebrow'>选择路径</Text>
          <Text className='page-title'>你想怎样开始？</Text>
          <View className='stack path-list'>
            <AccessibleRadio checked={path === 'abrupt'} className={`path-card ${path === 'abrupt' ? 'path-card--active' : ''}`} groupName='quit-path' label='直接戒断' value='abrupt' onSelect={() => setQuitPath('abrupt')}>
              <View className='path-card__copy'>
                <Text className='path-card__title'>直接戒断</Text>
                <Text className='path-card__text'>做好准备，到戒烟日停止吸烟</Text>
                <Text className='pill'>戒烟日：今天至 14 天后</Text>
              </View>
            </AccessibleRadio>
            <AccessibleRadio checked={path === 'reduction'} className={`path-card ${path === 'reduction' ? 'path-card--active' : ''}`} groupName='quit-path' label='限期减量' value='reduction' onSelect={() => setQuitPath('reduction')}>
              <View className='path-card__copy'>
                <Text className='path-card__title'>限期减量</Text>
                <Text className='path-card__text'>分三阶段减量，到目标日归零</Text>
                <Text className='pill'>戒烟日：7 至 28 天后</Text>
              </View>
            </AccessibleRadio>
          </View>
          <View className='card'>
            <Text className='field-label'>选择戒烟日</Text>
            <Picker
              mode='date'
              value={quitDate}
              start={dateWindow.start}
              end={dateWindow.end}
              onChange={(event) => setQuitDate(event.detail.value)}
            >
              <Button
                className='picker-field picker-field--trigger'
                aria-label={`选择戒烟日，当前 ${quitDate}`}
              >
                {quitDate}
              </Button>
            </Picker>
            <Text className='fine-print'>减量上限是自我管理工具，不是医疗处方。到戒烟日后目标均为 0 支。</Text>
          </View>
        </View>
      ) : null}

      <View className='onboarding__actions'>
        {step > 0 ? <Button className='button button--ghost' onClick={() => setStep((current) => current - 1)}>上一步</Button> : null}
        {step === 0 && nativeAndroid ? (
          <Button className='button button--ghost' disabled={restoring} onClick={() => void restoreBackup()}>
            {restoring ? '处理中…' : '恢复备份'}
          </Button>
        ) : null}
        <Button className='button' disabled={!canContinue || restoring} onClick={step === 4 ? submit : next}>
          {step === 4 ? '创建我的计划' : '继续'}
        </Button>
      </View>
    </View>
  )
}
