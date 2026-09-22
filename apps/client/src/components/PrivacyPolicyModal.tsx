import { ScrollView, Text, View } from '@tarojs/components'
import {
  LOCAL_PRIVACY_POLICY_SECTIONS,
  LOCAL_PRIVACY_POLICY_UPDATED_AT,
  LOCAL_PRIVACY_POLICY_VERSION,
} from '../lib/privacyPolicy'
import { AccessibleButton as Button } from './AccessibleButton'
import './PrivacyPolicyModal.scss'

export type PrivacyPolicyEntryPlacement = 'onboarding' | 'profile'

interface PrivacyPolicyModalProps {
  open: boolean
  onClose: () => void
  reserveNativeTabBar?: boolean
}

interface HarmonyPrivacyPolicyEntryProps {
  placement: PrivacyPolicyEntryPlacement
  onOpen: () => void
}

export function PrivacyPolicyModal({ open, onClose, reserveNativeTabBar = false }: PrivacyPolicyModalProps) {
  if (!open) return null

  return (
    <View
      className={`privacy-policy-modal ${reserveNativeTabBar ? 'privacy-policy-modal--above-tabbar' : ''}`}
      role='dialog'
      aria-modal='true'
      aria-label='无烟同行隐私政策全文'
    >
      <View className='privacy-policy-modal__panel'>
        <View className='privacy-policy-modal__header'>
          <View className='grow'>
            <Text className='eyebrow'>内置本地政策</Text>
            <Text className='privacy-policy-modal__title'>无烟同行隐私政策</Text>
          </View>
          <Button className='privacy-policy-modal__close' aria-label='关闭隐私政策弹层' onClick={onClose}>×</Button>
        </View>

        <ScrollView className='privacy-policy-modal__scroll' scrollY>
          <View className='privacy-policy-modal__content'>
            <Text className='privacy-policy-modal__meta'>HarmonyOS 版 · 版本 {LOCAL_PRIVACY_POLICY_VERSION} · 文本更新 {LOCAL_PRIVACY_POLICY_UPDATED_AT}</Text>
            <Text className='privacy-policy-modal__lead'>本政策全文随应用安装在本机。打开和阅读不需要登录、联网或跳转外部网页，也不代表你已经同意处理敏感健康信息。</Text>

            {LOCAL_PRIVACY_POLICY_SECTIONS.map((section) => (
              <View className='privacy-policy-modal__section' key={section.heading}>
                <Text className='privacy-policy-modal__heading'>{section.heading}</Text>
                {section.paragraphs.map((paragraph) => (
                  <Text className='privacy-policy-modal__paragraph' key={paragraph}>{paragraph}</Text>
                ))}
                {section.bullets?.map((bullet) => (
                  <View className='privacy-policy-modal__bullet-row' key={bullet}>
                    <Text className='privacy-policy-modal__bullet' aria-hidden='true'>•</Text>
                    <Text className='privacy-policy-modal__paragraph privacy-policy-modal__bullet-text'>{bullet}</Text>
                  </View>
                ))}
              </View>
            ))}

          </View>
        </ScrollView>
        <View className='privacy-policy-modal__footer'>
          <Button className='button privacy-policy-modal__done' onClick={onClose}>关闭隐私政策</Button>
        </View>
      </View>
    </View>
  )
}

export function HarmonyPrivacyPolicyEntry({ placement, onOpen }: HarmonyPrivacyPolicyEntryProps) {
  const onboarding = placement === 'onboarding'

  return (
    <View className={`privacy-policy-entry privacy-policy-entry--${placement}`}>
      <Text className='privacy-policy-entry__description'>
        {onboarding
          ? '请先查看本机内置的政策全文。打开政策不代表同意；关闭后仍需单独选择是否允许本机处理敏感健康信息。'
          : '政策全文内置在本机，无需登录、联网或跳转外部网页。'}
      </Text>
      <Button
        className='button button--secondary privacy-policy-entry__button'
        aria-label={onboarding ? '在同意前查看完整隐私政策' : '查看完整隐私政策'}
        onClick={onOpen}
      >
        {onboarding ? '查看完整《隐私政策》' : '隐私政策全文'}
      </Button>
    </View>
  )
}
