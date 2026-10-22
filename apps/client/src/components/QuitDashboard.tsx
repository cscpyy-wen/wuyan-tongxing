import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { lazy, Suspense, useEffect, useId, useState } from 'react'
import type { ClientState } from '../types'
import { computeQuitJourney } from '../lib/quitJourney'
import { HEALTH_MILESTONES, healthMilestonePhase } from '../lib/healthMilestones'
import { openSosPage } from '../lib/navigation'
import { AccessibleButton as Button } from './AccessibleButton'
import './QuitDashboard.scss'

export const openQuitSettings = () => Taro.navigateTo({ url: '/pages/quit-settings/index' })
const number = (value: number) => Math.round(value).toLocaleString('zh-CN')
const achievements = [1, 3, 7, 14, 30, 60, 100, 180, 365, 730, 1095, 1826, 3653]
const QuitCalculationDetails = lazy(() => import('./QuitCalculationDetails'))

export function QuitDashboard({ state, now, onRecord }: { state: ClientState; now: Date; onRecord(): void }) {
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [basisOpen, setBasisOpen] = useState(false)
  const orbitId = useId()
  const snapshot = computeQuitJourney(state, now)
  const showOrbit = Boolean(snapshot && !snapshot.clockSkew)
  useEffect(() => {
    if (process.env.TARO_ENV !== 'h5' || typeof ResizeObserver === 'undefined') return
    const orbit = document.getElementById(orbitId)
    const ring = orbit?.querySelector<HTMLElement>('.quit-orbit__ring')
    const parts = orbit?.querySelectorAll<HTMLElement>('.quit-orbit__label, .quit-orbit__count, .quit-orbit__time')
    if (!orbit || !ring || !parts) return
    const measure = () => {
      // Respect Android text zoom: keep the decorative circle at its normal
      // diameter, but let large text use a full-width, ring-free layout.
      const height = Array.from(parts).reduce((sum, part) => sum + part.getBoundingClientRect().height, 0)
      // Hysteresis prevents resize oscillation when the expanded layout
      // removes a line wrap near the normal ring's fit threshold.
      const margin = orbit.classList.contains('quit-orbit--expanded') ? 20 : 0
      const fits = height <= ring.getBoundingClientRect().width * .85 - margin
      orbit.classList.toggle('quit-orbit--expanded', !fits)
    }
    const observer = new ResizeObserver(measure)
    parts.forEach((part) => observer.observe(part))
    observer.observe(ring)
    measure()
    return () => observer.disconnect()
  }, [orbitId, showOrbit])
  if (!snapshot) return null
  if (snapshot.clockSkew) return <View className='card quit-dashboard'>
    <Text className='field-label'>请检查设备日期和时间</Text>
    <Text className='muted'>当前时间早于已保存的记录，暂不显示成就估算。</Text>
    <Button className='button button--secondary' onClick={openQuitSettings}>检查无烟起点</Button>
  </View>
  const { days, hours, minutes, cigarettesAvoided, moneySaved } = snapshot
  const continuousDays = days + hours / 24 + minutes / 1440
  const nextGoal = achievements.find((goal) => goal > days) ?? (Math.floor(days / 365) + 1) * 365
  const previousGoal = [...achievements].reverse().find((goal) => goal <= days) ?? 0
  const proportion = Math.min(100, Math.max(0, continuousDays / nextGoal * 100))
  const reference = HEALTH_MILESTONES.filter((item) => item.startDays !== undefined && item.startDays <= continuousDays).at(-1)
  const phaseText = { ahead: '未来参考', within: '时间已进入区间', elapsed: '已到参考年限', general: '早期变化' }

  return <View className='quit-dashboard'>
    <View className='quit-hero'>
      <View className='quit-hero__top'>
        <Text className='quit-hero__eyebrow'>新的每一天</Text>
        <Button className='quit-hero__edit' aria-label='修改无烟起点和估算参数' onClick={openQuitSettings}>调整 ↗</Button>
      </View>
      <View className='quit-orbit' id={orbitId}>
        <View className='quit-orbit__ring' aria-hidden='true' style={{ background: `conic-gradient(from 215deg, #cce8a5 ${proportion}%, rgba(255,255,255,.12) ${proportion}% 100%)` }} />
        <View className='quit-orbit__inside'>
          <Text className='quit-orbit__label'>{snapshot.recordedSinceStart ? '重新无烟' : '持续无烟'}</Text>
          <View className='quit-orbit__count'><Text className={`quit-orbit__number${days >= 1000 ? ' quit-orbit__number--long' : ''}`}>{snapshot.clockSkew ? '—' : days}</Text><Text className='quit-orbit__unit'>天</Text></View>
          <Text className='quit-orbit__time'>{hours} 小时 · {minutes} 分钟</Text>
        </View>
      </View>
      <View className='quit-hero__foot'>
        <Text className='quit-hero__badge'>{previousGoal ? `${previousGoal} 天纪念` : '无烟，从此刻开始'}</Text>
        <Text>下一站 · {nextGoal} 天</Text>
      </View>
      <Text className='quit-hero__basis'>{snapshot.clockSkew ? '设备时间异常，请检查系统时间' : snapshot.hasApproximateSmokingTime ? '自报记录 · 上次吸烟时间为近似值' : '根据你的自报与吸烟记录'}</Text>
    </View>

    <View className='quit-gains'>
      <View className='quit-gain quit-gain--money'>
        <Text className='quit-gain__label'>少花烟费 <Text className='quit-estimate'>估算</Text></Text>
        <Text className='quit-gain__value'><Text className='quit-gain__currency'>¥</Text>{number(moneySaved)}</Text>
      </View>
      <View className='quit-gain'>
        <Text className='quit-gain__label'>少吸卷烟 <Text className='quit-estimate'>估算</Text></Text>
        <Text className='quit-gain__value'>{number(cigarettesAvoided)}<Text className='quit-gain__unit'> 支</Text></Text>
      </View>
      <View className='quit-nicotine'>
        <View><Text className='quit-nicotine__label'>少摄入卷烟尼古丁</Text><Text className='quit-estimate'>粗估 · 非体内测量</Text></View>
        <Text className='quit-nicotine__value'>{number(cigarettesAvoided)}–{number(cigarettesAvoided * 2)}<Text> mg</Text></Text>
      </View>
    </View>

    <View className='quit-health'>
      <View className='quit-section-head'><Text className='quit-section-title'>健康，慢慢向好</Text><Button className='quit-text-button' onClick={() => setTimelineOpen(!timelineOpen)} aria-expanded={timelineOpen}>{timelineOpen ? '收起' : '时间线'} {timelineOpen ? '−' : '＋'}</Button></View>
      <Text className='quit-health__caption'>群体研究参考，不代表你的个人风险测量</Text>
      <View className='quit-health__current'>
        <Text className='quit-health__time'>{reference?.timeLabel ?? '戒烟早期'}</Text>
        <Text className='quit-health__current-title'>{reference?.label ?? '心率与一氧化碳开始改善'}</Text>
        <Text className='quit-health__detail'>{reference?.detail ?? '心率可在数分钟内下降；数天后，血液一氧化碳通常降至不吸烟者水平。'}</Text>
      </View>
      <View className='quit-risk-grid'>
        <View className='quit-risk-card'><Text className='quit-risk-card__time'>戒烟 3–6 年</Text><Text className='quit-risk-card__value'>约减半</Text><Text className='quit-risk-card__label'>冠心病额外风险</Text></View>
        <View className='quit-risk-card'><Text className='quit-risk-card__time'>戒烟 10–15 年</Text><Text className='quit-risk-card__value'>约减半</Text><Text className='quit-risk-card__label'>肺癌额外风险</Text></View>
      </View>
      <Text className='quit-health__comparison'>相对继续吸烟，减少的是吸烟带来的额外风险。</Text>
      {timelineOpen ? <View className='quit-timeline'>
        {HEALTH_MILESTONES.map((item) => <View className={`quit-timeline__item quit-timeline__item--${healthMilestonePhase(item, continuousDays)}`} key={item.id}>
          <Text className='quit-timeline__time'>{item.timeLabel}<Text className='quit-timeline__phase'> · {phaseText[healthMilestonePhase(item, continuousDays)]}</Text></Text>
          <Text className='quit-timeline__label'>{item.label}</Text><Text className='quit-health__detail'>{item.detail}</Text>
        </View>)}
      </View> : null}
    </View>

    <View className='quit-support-actions'>
      <Button className='button' onClick={() => void openSosPage()}>有点想抽，缓一缓</Button>
      <Button className='quit-record-button' onClick={onRecord}>记一支</Button>
    </View>
    <Button className='quit-basis-toggle' onClick={() => setBasisOpen(!basisOpen)} aria-expanded={basisOpen}>计算方式与科学依据 {basisOpen ? '−' : '＋'}</Button>
    {basisOpen ? <Suspense fallback={<Text>正在打开依据…</Text>}><QuitCalculationDetails startedAt={snapshot.startedAt} /></Suspense> : null}
  </View>
}
