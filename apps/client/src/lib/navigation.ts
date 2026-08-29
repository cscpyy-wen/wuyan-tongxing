import Taro from '@tarojs/taro'

const SOS_URL = '/pages/sos/index'
const TODAY_URL = '/pages/today/index'

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
