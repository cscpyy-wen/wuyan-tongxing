export default defineAppConfig({
  pages: [
    'pages/today/index',
    'pages/onboarding/index',
    'pages/lesson/index',
    'pages/records/index',
    'pages/progress/index',
    'pages/profile/index',
    'pages/sos/index',
    'pages/lapse/index',
    'pages/partner/index',
    'pages/medicine/index',
    'pages/faq/index',
    'pages/referral/index',
    'pages/followup/index',
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#F6F7F5',
    navigationBarTitleText: '无烟同行',
    navigationBarTextStyle: 'black',
    backgroundColor: '#F6F7F5',
  },
  tabBar: {
    color: '#53625C',
    selectedColor: '#176B55',
    backgroundColor: '#FFFFFF',
    borderStyle: 'white',
    list: process.env.TARO_ENV === 'h5'
      ? [
          { pagePath: 'pages/today/index', text: '今日' },
          { pagePath: 'pages/records/index', text: '记录' },
          { pagePath: 'pages/sos/index', text: '急救' },
          { pagePath: 'pages/progress/index', text: '进展' },
          { pagePath: 'pages/profile/index', text: '我的' },
        ]
      : [
          { pagePath: 'pages/today/index', text: '今日' },
          { pagePath: 'pages/records/index', text: '记录' },
          { pagePath: 'pages/progress/index', text: '进展' },
          { pagePath: 'pages/profile/index', text: '我的' },
        ],
  },
})
