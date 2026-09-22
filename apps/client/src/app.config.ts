import { appPagesForBuildTarget } from './appPages'

export default defineAppConfig({
  pages: appPagesForBuildTarget(process.env.TARO_ENV),
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
