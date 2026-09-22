import { Text, View } from '@tarojs/components'
import { isHarmonyApp } from '../lib/platformCapabilities'
import { openSosPage } from '../lib/navigation'
import { AccessibleButton as Button } from './AccessibleButton'
import './GlobalSos.scss'

export function GlobalSos() {
  const label = '烟瘾来了，立即打开急救练习'
  const open = () => void openSosPage()

  // Harmony's native Button expands to the full compact-header row even when
  // width/height styles are present. A semantic View keeps the same action and
  // accessibility label within the intended 76 x 52vp touch target.
  if (isHarmonyApp()) {
    return (
      <View
        className='sos-header sos-header--harmony'
        role='button'
        ariaRole='button'
        ariaLabel={label}
        onClick={open}
      >
        <Text>急救</Text>
      </View>
    )
  }

  return (
    <Button
      className='sos-header'
      aria-label={label}
      onClick={open}
    >
      急救
    </Button>
  )
}
