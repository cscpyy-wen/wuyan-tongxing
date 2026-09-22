import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState } from 'react'
import { AccessibleButton as Button } from '../../components/AccessibleButton'
import { PageHeader } from '../../components/PageHeader'
import { WithheldHealthContent } from '../../components/WithheldHealthContent'
import { HEALTH_CONTENT_ENABLED } from '../../lib/healthContentGate'
import { isHarmonyApp } from '../../lib/platformCapabilities'
import './index.scss'

const PROVINCES = ['北京', '天津', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江', '上海', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '广西', '海南', '重庆', '四川', '贵州', '云南', '西藏', '陕西', '甘肃', '青海', '宁夏', '新疆']
const CHINA_QUIT_PLATFORM = 'https://www.chinacdc.cn/jkyj/yckz/gzdt/202203/t20220310_296389.html'

export default function ReferralPage() {
  const [province, setProvince] = useState('北京')
  const [selectorOpen, setSelectorOpen] = useState(false)
  const harmony = isHarmonyApp()

  if (!HEALTH_CONTENT_ENABLED) return <WithheldHealthContent />

  const copyPlatform = async () => {
    await Taro.setClipboardData({ data: CHINA_QUIT_PLATFORM })
    Taro.showModal({
      title: '官方入口已复制',
      content: harmony
        ? 'HarmonyOS 首版不在应用内直接打开外部网页。请在浏览器粘贴访问中国疾控中心发布的“中国戒烟平台”入口。'
        : '当前版本未配置外部业务域名，暂不能在小程序内直接打开网页。请在浏览器粘贴访问中国疾控中心发布的“中国戒烟平台”入口。',
      showCancel: false,
      confirmText: '知道了',
    })
  }

  return (
    <View className='screen screen--detail referral-page'>
      <PageHeader eyebrow='不使用定位权限' title='把你连接到人工与专业支持' subtitle='当前只有省级查询提示与权威入口，不内置未经核验的城市级门诊名单。资源会变化，公开上线前需再次逐项核验。' />

      <View className='card province-card'>
        <Text className='field-label'>手动选择省级地区</Text>
        <Button
          data-testid='province-picker'
          className='picker-field province-picker-trigger'
          aria-label={`选择省级地区，当前为${province}`}
          onClick={() => setSelectorOpen((current) => !current)}
        >
          <Text>{province}</Text>
          <Text aria-hidden='true'>{selectorOpen ? '收起' : '展开'}</Text>
        </Button>
        {selectorOpen && (
          <View className='province-options' role='group' aria-label='省级地区列表'>
            {PROVINCES.map((item) => (
              <Button
                key={item}
                className={`province-option${province === item ? ' province-option--selected' : ''}`}
                aria-selected={province === item}
                onClick={() => {
                  setProvince(item)
                  setSelectorOpen(false)
                }}
              >
                {item}
              </Button>
            ))}
          </View>
        )}
        <Text className='fine-print'>现有核验数据不足以诚实提供城市级目录。选择仅用于显示省级查询提示，保存在当前页面内；不申请定位，也不上传。</Text>
      </View>

      <Text className='section-title'>{province}地区可用查询方式</Text>
      <View className='stack'>
        <View className='card referral-item'>
          <View className='referral-item__tag'>官方目录</View>
          <Text className='referral-item__title'>中国戒烟平台</Text>
          <Text className='referral-item__text'>由中国疾控中心发布，汇集戒烟热线、戒烟门诊和在线资源。复制入口后，请按官方页面实际支持的地区层级查找，并在联系前确认机构、电话和服务时间。</Text>
          <Button className='button button--secondary' onClick={copyPlatform}>复制中国疾控官方入口</Button>
        </View>
        <View className='card referral-item'>
          <View className='referral-item__tag'>卫生服务咨询</View>
          <Text className='referral-item__title'>当地 12320 卫生热线</Text>
          <Text className='referral-item__text'>部分地区可提供卫生服务信息。是否能直接提供戒烟咨询因地区而异，拨打后请明确询问“戒烟门诊或戒烟热线”。</Text>
          <Button className='button button--secondary' onClick={() => Taro.makePhoneCall({ phoneNumber: '12320' })}>拨打 12320</Button>
        </View>
      </View>

      <View className='card card--warning urgent-card'>
        <Text className='field-label'>紧急情况不要等待线上回复</Text>
        <Text className='fine-print'>突发胸痛或严重呼吸困难请立即拨打 120。存在自伤危险时请联系 120、110、心理援助热线 12356，或立即请身边可信赖的人陪同就医。本产品不会监测危机。</Text>
      </View>
      <Text className='fine-print referral-check'>资源核验基线：2026-08-23。公开上线前必须再次核验链接、号码、地区覆盖与服务时间。</Text>
    </View>
  )
}
