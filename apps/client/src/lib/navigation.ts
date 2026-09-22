import Taro from '@tarojs/taro'

const SOS_URL = '/pages/sos/index'
const TODAY_URL = '/pages/today/index'
const PROGRESS_URL = '/pages/progress/index'
const ONBOARDING_URL = '/pages/onboarding/index'
const HARMONY_TABBAR_ROOT_URL = '/taro_tabbar'
const HARMONY_PROGRESS_PAGE = 'pages/progress/index'

/** H5/Android exposes SOS as a real tab so WebView hit testing is native to Taro. */
export function openSosPage() {
  return process.env.TARO_ENV === 'h5'
    ? Taro.switchTab({ url: SOS_URL })
    : Taro.navigateTo({ url: SOS_URL })
}

/** A tab page has no reliable navigateBack target after Android process restore. */
export function leaveSosPage() {
  return process.env.TARO_ENV === 'h5'
    ? Taro.switchTab({ url: TODAY_URL })
    : Taro.navigateBack()
}

/** Taro Harmony 4.2.1 does not implement reLaunch; replace the current page instead. */
export function openOnboardingAsRoot() {
  return process.env.TARO_ENV === 'harmony_cpp'
    ? Taro.redirectTo({ url: ONBOARDING_URL })
    : Taro.reLaunch({ url: ONBOARDING_URL })
}

/** Harmony compiles all tab pages into the real taro_tabbar system route. */
export function openTodayAsRoot() {
  return process.env.TARO_ENV === 'harmony_cpp'
    ? Taro.redirectTo({ url: HARMONY_TABBAR_ROOT_URL })
    : Taro.reLaunch({ url: TODAY_URL })
}

/**
 * Harmony's tab pages live inside one native `taro_tabbar` route. Taro 4.2.1
 * incorrectly sends `switchTab` to an unregistered child route when it is
 * called from a detail page. Select Progress on the still-live tab controller,
 * then return by its known native root URL so every intervening detail route is
 * removed. The Harmony route bridge supports this URL even though the
 * cross-platform Taro type only declares `delta`.
 */
export async function openProgressAfterLapseSave(): Promise<void> {
  if (process.env.TARO_ENV !== 'harmony_cpp') {
    await Taro.switchTab({ url: PROGRESS_URL })
    return
  }

  Taro.eventCenter.trigger('__taroSwitchTab', {
    url: HARMONY_TABBAR_ROOT_URL,
    params: { $page: HARMONY_PROGRESS_PAGE },
  })
  await Taro.navigateBack({
    url: HARMONY_TABBAR_ROOT_URL,
  } as Parameters<typeof Taro.navigateBack>[0])
}
