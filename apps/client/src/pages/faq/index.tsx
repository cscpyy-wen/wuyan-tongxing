import { Text, View } from '@tarojs/components'
import { contentItemsByKind } from '@wuyan/content'
import { PageHeader } from '../../components/PageHeader'
import './index.scss'

export default function FaqPage() {
  return (
    <View className='screen screen--detail faq-page'>
      <PageHeader eyebrow='12 个常见问题' title='把疑问说清楚' subtitle='回答用于一般健康教育，不诊断、不处方，也不替代医生或药师。' />

      <View className='stack faq-list'>
        {contentItemsByKind.faq.map((item, index) => (
          <View className='card faq-card' key={item.id}>
            <Text className='faq-card__number'>{String(index + 1).padStart(2, '0')}</Text>
            <View className='grow'>
              <Text className='faq-card__question'>{item.title}</Text>
              <Text className='faq-card__answer'>{item.body}</Text>
              <Text className='fine-print faq-card__boundary'>{item.riskStatement}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  )
}
