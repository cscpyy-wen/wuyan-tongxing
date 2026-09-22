import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { AccessibleButton as Button } from './AccessibleButton'
import { PageHeader } from './PageHeader'

export function WithheldHealthContent() {
  return (
    <View className='screen screen--detail'>
      <PageHeader
        eyebrow='HarmonyOS 首发范围'
        title='此内容暂未开放'
        subtitle='当前版本仅提供本机记录与非医疗自助工具；健康教育、用药科普、专业资源和长期随访暂不提供。'
      />
      <View className='card card--soft'>
        <Text className='fine-print'>该限制不影响逐支记录、日终确认、个人进展和伙伴支持。</Text>
      </View>
      <Button className='button' onClick={() => Taro.navigateBack()}>返回</Button>
    </View>
  )
}
