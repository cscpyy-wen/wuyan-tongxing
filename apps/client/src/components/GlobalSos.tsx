import { openSosPage } from '../lib/navigation'
import { AccessibleButton as Button } from './AccessibleButton'

export function GlobalSos() {
  return (
    <Button
      className='sos-header'
      aria-label='烟瘾来了，立即打开急救练习'
      onClick={() => void openSosPage()}
    >
      急救
    </Button>
  )
}
