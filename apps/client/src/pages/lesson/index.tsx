import { Text, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { evidenceById, getContentItem } from '@wuyan/content'
import { useState } from 'react'
import { AccessibleButton as Button } from '../../components/AccessibleButton'
import { LoadingScreen } from '../../components/LoadingScreen'
import { PageHeader } from '../../components/PageHeader'
import { useRequireOnboarding } from '../../hooks/useRequireOnboarding'
import { useAppState } from '../../state/AppState'
import './index.scss'

export default function LessonPage() {
  const router = useRouter()
  const { state, ready } = useRequireOnboarding()
  const { actions } = useAppState()
  const item = getContentItem(router.params.id ?? '')
  const [evidenceExpanded, setEvidenceExpanded] = useState(false)
  const returnToday = () => {
    Taro.reLaunch({ url: '/pages/today/index' })
  }

  if (!ready) return <LoadingScreen />

  if (!item) {
    return (
      <View className='screen screen--detail'>
        <PageHeader eyebrow='内容不可用' title='没有找到这项练习' subtitle='内容可能已更新，请返回今日页重新打开。' />
        <Button className='button lesson-back' onClick={returnToday}>返回今日</Button>
      </View>
    )
  }

  const completed = state.completedTasks.some((entry) => entry.contentId === item.id && entry.attemptId === state.plan?.id)
  const evidence = item.evidenceIds.map((id) => evidenceById[id]).filter(Boolean)
  const finish = () => {
    if (actions.completeTask(item.id)) {
      Taro.showToast({ title: '练习已保存', icon: 'success' })
      returnToday()
    }
  }

  return (
    <View className='screen screen--detail lesson-page'>
      <PageHeader eyebrow='今日练习' title={item.title} subtitle={item.goal} />

      <View className='card lesson-body'>
        <Text className='lesson-body__label'>先了解</Text>
        <Text className='lesson-body__text'>{item.body}</Text>
      </View>

      <Text className='section-title'>练习步骤</Text>
      <View className='stack'>
        {item.steps.map((step, index) => (
          <View className='card lesson-step' key={`${item.id}-${index}`}>
            <Text className='lesson-step__number'>{index + 1}</Text>
            <Text className='lesson-step__text'>{step}</Text>
          </View>
        ))}
      </View>

      <View className='card card--soft lesson-action'>
        <Text className='field-label'>现在行动</Text>
        <Text className='lesson-action__text'>{item.action}</Text>
      </View>

      {item.id === 'prep-01' && state.baseline?.reasons.length ? (
        <View className='card lesson-reasons' aria-label='我的戒烟理由'>
          <Text className='field-label'>我的理由</Text>
          <View className='lesson-reasons__list'>
            {state.baseline.reasons.map((reason) => (
              <Text className='lesson-reasons__item' key={reason}>{reason}</Text>
            ))}
          </View>
        </View>
      ) : null}

      <View className='card card--warning lesson-boundary'>
        <Text className='field-label'>安全与适用边界</Text>
        <Text className='fine-print'>{item.riskStatement}</Text>
      </View>

      <Button
        className={`button lesson-complete ${completed ? 'button--secondary' : ''}`}
        onClick={completed ? returnToday : finish}
      >
        {completed ? '返回今日' : '完成练习并返回今日'}
      </Button>

      {evidence.length > 0 ? (
        <View className='lesson-evidence'>
          <Button
            aria-controls='lesson-evidence-list'
            aria-expanded={evidenceExpanded}
            className='lesson-evidence-toggle'
            onClick={() => setEvidenceExpanded((value) => !value)}
          >
            {evidenceExpanded ? '收起依据' : '查看依据'}
          </Button>
          {evidenceExpanded ? (
            <View id='lesson-evidence-list' className='lesson-evidence__list'>
              {evidence.map((source) => source ? (
                <Text className='fine-print lesson-evidence__item' key={source.id}>{source.organization} · {source.year}</Text>
              ) : null)}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}
