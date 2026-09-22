import { ScrollView, View } from '@tarojs/components'
import type { ReactNode } from 'react'
import { isHarmonyApp } from '../lib/platformCapabilities'
import './HarmonyScrollablePage.scss'

interface HarmonyScrollablePageProps {
  children: ReactNode
  className: string
  /** Tab pages reserve the generated 56vp native bar; detail pages use the full viewport. */
  viewport: 'tab' | 'full'
  /** Preserve the caller's non-Harmony root element; most pages use a View. */
  fallback?: 'view' | 'scroll'
  /** Keeps fixed overlays outside the native ScrollView while preserving the old DOM elsewhere. */
  overlay?: ReactNode
}

export function HarmonyScrollablePage({
  children,
  className,
  viewport,
  fallback = 'view',
  overlay,
}: HarmonyScrollablePageProps) {
  if (!isHarmonyApp()) {
    if (fallback === 'scroll') {
      return (
        <>
          <ScrollView className={className} scrollY>{children}</ScrollView>
          {overlay}
        </>
      )
    }

    return <View className={className}>{children}{overlay}</View>
  }

  return (
    <View className={`harmony-page-frame harmony-page-frame--${viewport}`}>
      <ScrollView
        className={`${className} harmony-page-scroll harmony-page-scroll--${viewport}`}
        scrollY
      >
        {children}
      </ScrollView>
      {overlay}
    </View>
  )
}
