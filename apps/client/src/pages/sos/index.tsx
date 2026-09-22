import { Text, View } from '@tarojs/components'
import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { AccessibleButton as Button } from '../../components/AccessibleButton'
import { AccessibleRadio } from '../../components/AccessibleRadio'
import { HarmonyScrollablePage } from '../../components/HarmonyScrollablePage'
import { dismissAndroidBootstrap } from '../../lib/androidBootstrap'
import { leaveSosPage } from '../../lib/navigation'
import { EMERGENCY_SUPPORT_COPY } from '../../lib/releaseCopy'
import { registerNativeBackHandler } from '../../lib/runtime'
import { useAppState } from '../../state/AppState'
import type { CravingLevel } from '../../types'
import './index.scss'

interface Technique {
  id: string
  short: string
  title: string
  instruction: string
  duration: number
}

const TECHNIQUES: Technique[] = [
  { id: 'breathing', short: '呼吸', title: '先把呼吸放慢', instruction: '双脚踩地。轻轻吸气 4 秒，再缓缓呼气 6 秒。不必把烟瘾赶走，只要为选择争取一点空间。', duration: 60 },
  { id: 'urge-surfing', short: '冲浪', title: '和烟瘾待一会儿', instruction: '留意它在身体哪个位置最明显。像观察一阵浪：它会上升，也会下降。你不必服从它。', duration: 180 },
  { id: 'change-scene', short: '换场景', title: '离开点烟的自动路线', instruction: '站起来，拿一杯水，走到无烟的地方。只改变接下来五分钟，不要求解决一整天。', duration: 120 },
  { id: 'reasons', short: '看理由', title: '回到你在意的理由', instruction: '慢慢读一遍自己的理由。选择其中一个，想象今天不点这支烟会保护什么。', duration: 90 },
  { id: 'partner', short: '找伙伴', title: '让可信赖的人陪你几分钟', instruction: '你可以发送一张不含吸烟量、药物或戒烟日期的支持卡，由你决定发给谁。', duration: 0 },
]

export default function SosPage() {
  const { state, ready, loadFailure, actions } = useAppState()
  const [level, setLevel] = useState<CravingLevel>(3)
  const [selected, setSelected] = useState(TECHNIQUES[0]!)
  const [secondsLeft, setSecondsLeft] = useState(TECHNIQUES[0]!.duration)
  const [complete, setComplete] = useState(false)
  const [running, setRunning] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [pageVisible, setPageVisible] = useState(true)
  const eventId = useRef<string>()
  const exitPromptOpen = useRef(false)

  useDidShow(() => setPageVisible(true))
  useDidHide(() => setPageVisible(false))

  useEffect(() => {
    if (ready || loadFailure) dismissAndroidBootstrap()
  }, [loadFailure, ready])

  useEffect(() => {
    if (!running || complete || secondsLeft <= 0 || selected.duration === 0) return
    const timer = setInterval(() => setSecondsLeft((current) => Math.max(0, current - 1)), 1000)
    return () => clearInterval(timer)
  }, [complete, running, secondsLeft, selected.duration])

  useEffect(() => {
    if (!pageVisible) return undefined
    return registerNativeBackHandler(() => {
      if (!running) {
        void leaveSosPage()
        return
      }
      if (exitPromptOpen.current) return
      exitPromptOpen.current = true
      setRunning(false)
      void Taro.showModal({
        title: '暂停练习？',
        content: '返回会结束本次急救，当前剩余时间会保留到你作出选择。',
        confirmText: '退出急救',
        cancelText: '继续练习',
        confirmColor: '#A8382D',
      }).then((result) => {
        if (result.confirm) return leaveSosPage()
        setRunning(true)
        return undefined
      }).finally(() => {
        exitPromptOpen.current = false
      })
    })
  }, [pageVisible, running])

  const chooseTechnique = (technique: Technique) => {
    setSelected(technique)
    setSecondsLeft(technique.duration)
    setComplete(false)
    setRunning(false)
    setOptionsOpen(false)
  }

  const ensureCravingEvent = (eventLevel: CravingLevel = level) => {
    if (!ready) return undefined
    if (!eventId.current) eventId.current = actions.recordCraving(eventLevel)
    return eventId.current
  }

  const changeLevel = (nextLevel: CravingLevel) => {
    setLevel(nextLevel)
    const existingId = eventId.current
    const id = ensureCravingEvent(nextLevel)
    if (existingId && id) actions.updateCravingLevel(id, nextLevel)
  }

  const startPractice = () => {
    ensureCravingEvent()
    setRunning(true)
  }

  const finish = () => {
    const id = ensureCravingEvent()
    if (id) actions.resolveCraving(id, selected.id, level)
    setComplete(true)
    setRunning(false)
    Taro.vibrateShort({ type: 'light' }).catch(() => undefined)
  }

  const reasonText = state.baseline?.reasons.join(' · ') || '为了健康，也为了重新拥有选择'
  const elapsed = selected.duration - secondsLeft
  const progress = selected.duration > 0 ? Math.min(100, (elapsed / selected.duration) * 100) : 0
  const breathCue = !running ? elapsed > 0 ? '已暂停' : '准备开始' : elapsed % 10 < 4 ? '慢慢吸气' : '缓缓呼气'
  const restart = () => {
    ensureCravingEvent()
    setSecondsLeft(selected.duration)
    setRunning(true)
  }

  const openPartner = () => {
    const id = ensureCravingEvent()
    if (id) actions.resolveCraving(id, 'partner', level)
    Taro.navigateTo({ url: '/pages/partner/index' })
  }

  return (
    <HarmonyScrollablePage className='screen screen--detail sos-page' viewport='full'>
      <View className='row row--between sos-head'>
        <Text className='page-title'>这一阵会过去</Text>
        <Button
          className='sos-lapse-short'
          aria-label='已经吸烟，记录并复盘'
          onClick={() => Taro.navigateTo({ url: `/pages/lapse/index?cravingIntensity=${level}` })}
        >已吸烟</Button>
      </View>

      {!running && !complete ? (
        <Button
          className='sos-options-toggle'
          aria-label='调整烟瘾强度和练习方法'
          aria-expanded={optionsOpen}
          aria-controls='sos-options-panel'
          onClick={() => setOptionsOpen((open) => !open)}
        >
          <Text>{selected.short} · {level}/5</Text>
          <Text className='sos-options-toggle__action'>{optionsOpen ? '收起' : '调整'}</Text>
        </Button>
      ) : null}

      {optionsOpen && !running && !complete ? (
        <View id='sos-options-panel' className='sos-options-panel'>
          <View className='card sos-level'>
            <View className='row row--between'>
              <Text className='field-label'>烟瘾强度</Text>
              <Text className='sos-level__value'>{level} / 5</Text>
            </View>
            <View className='sos-level-options' role='radiogroup' aria-label='此刻烟瘾强度'>
              {([1, 2, 3, 4, 5] as const).map((value) => (
                <AccessibleRadio
                  key={value}
                  className={`sos-level-choice ${level === value ? 'sos-level-choice--active' : ''}`}
                  checked={level === value}
                  groupName='sos-level'
                  label={`烟瘾强度 ${value}`}
                  value={String(value)}
                  onSelect={() => changeLevel(value)}
                >{value}</AccessibleRadio>
              ))}
            </View>
          </View>

          <View className='technique-tabs' role='tablist' aria-label='选择烟瘾应对练习'>
            {TECHNIQUES.map((technique) => (
              <Button
                key={technique.id}
                className={`technique-tab ${selected.id === technique.id ? 'technique-tab--active' : ''}`}
                role='tab'
                aria-selected={selected.id === technique.id}
                tabIndex={selected.id === technique.id ? 0 : -1}
                onClick={() => chooseTechnique(technique)}
              >
                {technique.short}
              </Button>
            ))}
          </View>
        </View>
      ) : null}

      <View className='sos-practice' aria-live='polite'>
        {complete ? (
          <View className='sos-complete'>
            <Text className='sos-complete__mark'>✓</Text>
            <Text className='sos-complete__title'>你穿过了这一阵</Text>
            <Text className='sos-complete__text'>烟瘾再次出现也很正常。需要时随时回来，不必等到“忍不住”。</Text>
            <Button className='button button--secondary' onClick={() => chooseTechnique(selected)}>再练一次</Button>
          </View>
        ) : (
          <>
            <Text className='sos-practice__title'>{selected.title}</Text>
            {selected.id === 'reasons' ? <Text className='reason-quote'>“{reasonText}”</Text> : null}
            <Text className='sos-practice__instruction'>{selected.instruction}</Text>
            {selected.duration > 0 ? (
              <>
                <Button
                  className='button'
                  onClick={secondsLeft === 0 ? finish : running ? finish : startPractice}
                >
                  {secondsLeft === 0 ? '完成练习' : running ? '我已经稳住一些了' : elapsed > 0 ? '继续练习' : '开始练习'}
                </Button>
                {running ? <Button className='button button--ghost' onClick={() => setRunning(false)}>暂停</Button> : null}
                {!running && elapsed > 0 && secondsLeft > 0 ? <Button className='button button--ghost' onClick={restart}>重新开始</Button> : null}
                {selected.id === 'breathing' ? <Text className={`breath-cue ${running ? 'breath-cue--running' : ''}`}>{breathCue}</Text> : null}
                <View className='progress-track sos-practice__track'><View className='progress-fill' style={{ width: `${progress}%` }} /></View>
                <Text className='sos-practice__timer'>{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</Text>
              </>
            ) : (
              <Button className='button' onClick={openPartner}>预览伙伴支持卡</Button>
            )}
          </>
        )}
      </View>

      <View className='sos-footer stack'>
        <View className='card card--warning'>
          <Text className='field-label'>需要紧急人工帮助？</Text>
          <Text className='fine-print'>{EMERGENCY_SUPPORT_COPY}</Text>
        </View>
      </View>
    </HarmonyScrollablePage>
  )
}
