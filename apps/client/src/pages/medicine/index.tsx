import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { contentItemsByKind } from '@wuyan/content'
import { AccessibleButton as Button } from '../../components/AccessibleButton'
import { PageHeader } from '../../components/PageHeader'
import './index.scss'

export default function MedicinePage() {
  const topics = contentItemsByKind.medication_referral
  return (
    <View className='screen screen--detail medicine-page'>
      <PageHeader eyebrow='一般科普，不是处方' title='把专业支持接进戒烟计划' subtitle='行为支持与适合个人情况的药物支持可以配合使用。是否适合、怎样使用，应咨询医生或药师。' />

      <View className='card card--warning medicine-boundary'>
        <Text className='field-label'>这里不会为你选药或计算剂量</Text>
        <Text className='fine-print'>孕期或哺乳期、未成年人、近期严重心血管症状、正在使用其他药物、既往严重精神健康问题或出现疑似不良反应时，请先获得专业评估。突发胸痛或严重呼吸困难请拨打 120。</Text>
      </View>

      <Text className='section-title'>6 个循证专题</Text>
      <View className='stack'>
        {topics.map((topic, index) => (
          <View className='card medicine-topic' key={topic.id}>
            <View className='medicine-topic__number'>{String(index + 1).padStart(2, '0')}</View>
            <View className='grow'>
              <Text className='medicine-topic__title'>{topic.title}</Text>
              <Text className='medicine-topic__body'>{topic.body}</Text>
              <View className='medicine-topic__action'>下一步：{topic.action}</View>
              <Text className='fine-print'>{topic.riskStatement}</Text>
            </View>
          </View>
        ))}
      </View>

      <View className='card card--soft'>
        <Text className='field-label'>关于电子烟</Text>
        <Text className='muted'>本产品不提供电子烟专用戒烟路径，不推广或销售电子烟。正在使用多种烟草/尼古丁产品时，请把实际情况告诉专业人员。</Text>
      </View>
      <Button className='button medicine-referral' onClick={() => Taro.navigateTo({ url: '/pages/referral/index' })}>查找权威热线与门诊入口</Button>
    </View>
  )
}
