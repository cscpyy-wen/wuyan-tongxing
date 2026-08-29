import { Text, View } from '@tarojs/components'
import Taro, { useShareAppMessage } from '@tarojs/taro'
import { useState } from 'react'
import { AccessibleButton as Button } from '../../components/AccessibleButton'
import { PageHeader } from '../../components/PageHeader'
import { isNativeAndroidApp, shareNativeText } from '../../lib/runtime'
import './index.scss'

const TEMPLATES = [
  { id: 'invite', label: '邀请伙伴', title: '我在认真戒烟，想请你做我的支持伙伴', body: '当我发消息说烟瘾来了，请陪我聊三分钟，或提醒我先离开吸烟场景。你不需要监督我。' },
  { id: 'help', label: '现在帮我', title: '我现在有一阵烟瘾，可以陪我三分钟吗？', body: '不用劝说，也不用问我坚持了多久。陪我聊点别的，等这一阵过去就好。' },
  { id: 'milestone', label: '分享进展', title: '我完成了今天的无烟行动', body: '谢谢你的支持。一次小行动也值得被看见，我会继续照顾好下一次选择。' },
  { id: 'restart', label: '告诉重启', title: '我刚刚滑倒了，但正在继续计划', body: '这不是清零。我已经复盘了诱因，接下来会先完成一个恢复动作。请给我一点不评判的陪伴。' },
]

export default function PartnerPage() {
  const [selected, setSelected] = useState(TEMPLATES[0]!)
  const isWeapp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP
  const nativeAndroid = isNativeAndroidApp()

  useShareAppMessage(() => ({
    title: selected.title,
    path: '/pages/onboarding/index',
  }))

  const copy = async () => {
    await Taro.setClipboardData({ data: `${selected.title}\n\n${selected.body}\n\n——来自「无烟同行」` })
    Taro.showToast({ title: '文字版已复制', icon: 'success' })
  }

  const shareFromAndroid = async () => {
    const text = `${selected.title}\n\n${selected.body}\n\n——来自「无烟同行」个人版`
    try {
      await shareNativeText(selected.title, text)
    } catch {
      await copy()
      Taro.showToast({ title: '系统分享不可用，文字已复制', icon: 'none' })
    }
  }

  return (
    <View className='screen screen--detail partner-page'>
      <PageHeader eyebrow='由你预览、由你发送' title='请一个人这样支持你' subtitle='不读取通讯录，不建立站内好友，也不会自动通知任何人。' />

      <View className='template-tabs'>
        {TEMPLATES.map((template) => (
          <Button key={template.id} className={`template-tab ${selected.id === template.id ? 'template-tab--active' : ''}`} onClick={() => setSelected(template)}>{template.label}</Button>
        ))}
      </View>

      <Text className='section-title'>{nativeAndroid ? '伙伴支持卡预览' : '微信分享卡'}</Text>
      <View className='share-preview' aria-label={nativeAndroid ? '伙伴支持卡标题预览' : '微信分享卡标题预览'}>
        <View className='share-preview__brand'>可靠发送内容</View>
        <View className='share-preview__symbol'>仅标题</View>
        <Text className='share-preview__title'>{selected.title}</Text>
        <View className='share-preview__footer'>{nativeAndroid ? '由你通过系统分享面板主动发送' : '点击后打开「无烟同行」首次页面'}</View>
      </View>
      <Text className='fine-print share-boundary'>{nativeAndroid ? 'Android 个人版会先让你预览完整内容，再打开系统分享面板；应用不会自动发送，也不会读取通讯录。' : '这是内容语义预览，不是微信界面截图。微信分享卡只可靠发送上方标题和小程序页面路径，不会自动附带下面的详细话术。'}</Text>

      <Text className='section-title'>可复制文字版</Text>
      <View className='card copy-preview' aria-label='伙伴支持可复制文字版'>
        <Text className='copy-preview__title'>{selected.title}</Text>
        <Text className='copy-preview__body'>{selected.body}</Text>
      </View>

      <View className='card card--soft privacy-check'>
        <Text className='field-label'>分享前隐私检查</Text>
        <Text className='fine-print'>分享标题和详细文字默认都不含吸烟量、药物使用、戒烟日期、连续天数、账号或身份信息。请仍只发送给你信任的人。</Text>
      </View>

      {isWeapp ? (
        <Button className='button partner-send' openType='share'>发送仅含标题的微信卡</Button>
      ) : null}
      {nativeAndroid ? (
        <Button className='button partner-send' onClick={() => void shareFromAndroid()}>用系统分享发送详细文字</Button>
      ) : null}
      <Button className={`button partner-copy ${isWeapp || nativeAndroid ? 'button--secondary' : ''}`} onClick={copy}>复制详细文字版</Button>
    </View>
  )
}
