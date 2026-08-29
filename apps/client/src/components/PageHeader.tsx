import { Text, View } from '@tarojs/components'
import { GlobalSos } from './GlobalSos'

interface PageHeaderProps {
  eyebrow?: string
  title: string
  subtitle?: string
  showSos?: boolean
  compact?: boolean
}

export function PageHeader({ eyebrow, title, subtitle, showSos = false, compact = false }: PageHeaderProps) {
  // Taro's View typings expose only the platform-specific ariaRole/ariaLabel
  // aliases. Keep the standards-based level attribute in the spread so the
  // H5 custom element is a complete heading while mini-program builds retain
  // their supported aliases.
  const headingLevel = {
    'aria-level': 1,
  } as const

  if (compact) {
    return (
      <View className='page-header page-header--compact'>
        <View className='page-header__compact-row'>
          <View
            className='page-title'
            role='heading'
            ariaRole='heading'
            ariaLabel={title}
            {...headingLevel}
          >{title}</View>
          {showSos && process.env.TARO_ENV !== 'h5' ? <GlobalSos /> : null}
        </View>
        {subtitle ? <Text className='page-subtitle'>{subtitle}</Text> : null}
      </View>
    )
  }

  return (
    <View className={`page-header ${showSos ? 'page-header--with-sos' : ''}`}>
      <View className='page-header__meta'>
        {eyebrow ? <Text className='eyebrow'>{eyebrow}</Text> : null}
        {showSos && process.env.TARO_ENV !== 'h5' ? <GlobalSos /> : null}
      </View>
      <View
        className='page-title'
        role='heading'
        ariaRole='heading'
        ariaLabel={title}
        {...headingLevel}
      >{title}</View>
      {subtitle ? <Text className='page-subtitle'>{subtitle}</Text> : null}
    </View>
  )
}
