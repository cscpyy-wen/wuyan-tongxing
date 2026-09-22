export default definePageConfig({
  navigationBarTitleText: '无烟同行',
  navigationStyle: process.env.TARO_ENV === 'harmony_cpp' ? 'default' : 'custom',
  disableScroll: false,
})
