import { Input, Picker, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useRef, useState } from 'react'
import { AccessibleButton as Button } from '../../components/AccessibleButton'
import { AccessibleSwitch } from '../../components/AccessibleSwitch'
import { LoadingScreen } from '../../components/LoadingScreen'
import { PageHeader } from '../../components/PageHeader'
import { HarmonyScrollablePage } from '../../components/HarmonyScrollablePage'
import { HarmonyPrivacyPolicyEntry, PrivacyPolicyModal } from '../../components/PrivacyPolicyModal'
import { HEALTH_CONTENT_ENABLED } from '../../lib/healthContentGate'
import { addDays, toLocalDate, validateQuitDate } from '../../lib/model'
import { openOnboardingAsRoot } from '../../lib/navigation'
import { getAppCapabilities } from '../../lib/platformCapabilities'
import {
  acknowledgePendingNativeExportOutcome,
  cancelDailyReminder,
  isDailyReminderScheduled,
  nativeExportCleanupIssue,
  nativeExportCleanupFilename,
  openNativeNotificationSettings,
  reconcileDailyReminderAfterSystemChange,
  requestNativeQuickRecordTile,
  requestNativeQuickRecordWidget,
  rescheduleDailyReminderForLocalTime,
  saveNativeJsonFile,
  scheduleDailyReminder,
} from '../../lib/runtime'
import { showNativeExportCleanupIssue } from '../../lib/nativeExportCleanupUi'
import { requestNativeBackupRestoreSelection } from '../../lib/nativeBackupRestoreSelection'
import { useRequireOnboarding } from '../../hooks/useRequireOnboarding'
import { useMinuteClock } from '../../hooks/useMinuteClock'
import { useAppState } from '../../state/AppState'
import type { QuitPath } from '../../types'
import { recoverReminderPermissionAfterSettings } from './reminderPermissionRecovery'
import { useReminderReconciliation } from './useReminderReconciliation'
import './index.scss'

const HOURS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`)

function switchAccessibilityLabel(label: string, checked: boolean): string {
  return `${label}，${checked ? '已开启' : '已关闭'}`
}

export default function ProfilePage() {
  const { state, ready } = useRequireOnboarding()
  const { actions } = useAppState()
  const today = toLocalDate(useMinuteClock())
  const [newAttemptOpen, setNewAttemptOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [newAttemptPath, setNewAttemptPath] = useState<QuitPath>('abrupt')
  const [newAttemptDate, setNewAttemptDate] = useState(() => addDays(new Date(), 7))
  const [newAttemptCigarettes, setNewAttemptCigarettes] = useState(10)
  const [newAttemptPrice, setNewAttemptPrice] = useState(25)
  const [reminderBusy, setReminderBusy] = useState(false)
  const [quickAccessBusy, setQuickAccessBusy] = useState(false)
  const [widgetHelpVisible, setWidgetHelpVisible] = useState(false)
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const reminderSettingsReturnPending = useRef(false)
  const resumeReminderIntentRef = useRef<() => void | Promise<void>>()
  const capabilities = getAppCapabilities()
  const nativeAndroid = capabilities.platform === 'android'
  const nativeMobile = nativeAndroid || capabilities.platform === 'ios'
  const harmony = capabilities.platform === 'harmony'
  const {
    reminderActive,
    publishReminderActive,
    runReminderMutation: runReminderReconciliationMutation,
  } = useReminderReconciliation({
    enabled: nativeMobile,
    locallyEnabled: state.settings.inAppReminder,
    checkSystemState: isDailyReminderScheduled,
    onSystemDisabled: async () => {
      const platformLease = await actions.beginDataPlatformMutation()
      if (!platformLease || !platformLease.isCurrent()) return
      try {
        await reconcileDailyReminderAfterSystemChange(() => {
          actions.updateSettings({ inAppReminder: false })
        })
      } finally {
        platformLease.release()
      }
    },
    onAppResume: () => resumeReminderIntentRef.current?.(),
  })

  const runPlatformReminderMutation = async <T,>(operation: () => Promise<T>): Promise<T> => {
    const platformLease = await actions.beginDataPlatformMutation()
    if (!platformLease || !platformLease.isCurrent()) throw new Error('数据操作已失效')
    try {
      return await runReminderReconciliationMutation(operation)
    } finally {
      platformLease.release()
    }
  }

  resumeReminderIntentRef.current = async () => {
    if (!reminderSettingsReturnPending.current) return
    reminderSettingsReturnPending.current = false
    setReminderBusy(true)
    try {
      const outcome = await runPlatformReminderMutation(() => recoverReminderPermissionAfterSettings(
        state.settings.reminderHour,
        {
          reschedule: rescheduleDailyReminderForLocalTime,
          cancel: cancelDailyReminder,
          enableLocal: () => actions.updateSettings({ inAppReminder: true }),
          publish: publishReminderActive,
        },
      ))
      Taro.showToast({
        title: outcome === 'scheduled'
          ? '每日提醒已恢复'
          : outcome === 'denied' ? '通知权限仍未开启' : '提醒恢复失败',
        icon: outcome === 'scheduled' ? 'success' : 'none',
      })
    } catch {
      publishReminderActive(false)
      Taro.showToast({ title: '提醒恢复失败', icon: 'none' })
    } finally {
      setReminderBusy(false)
    }
  }

  if (!ready || !state.plan || !state.baseline) return <LoadingScreen />
  const reminderSwitchChecked = Boolean(state.settings.inAppReminder && reminderActive)

  const chooseNewAttemptPath = (path: QuitPath) => {
    setNewAttemptPath(path)
    setNewAttemptDate(addDays(today, path === 'abrupt' ? 7 : 14))
  }

  const openNewAttempt = () => {
    setNewAttemptCigarettes(state.plan!.baselineCigarettesPerDay)
    setNewAttemptPrice(state.plan!.baselinePricePerPack)
    setNewAttemptOpen(true)
  }

  const confirmNewAttempt = async () => {
    const submitToday = toLocalDate(new Date())
    if (!validateQuitDate(newAttemptPath, submitToday, newAttemptDate)) {
      Taro.showToast({ title: '请选择允许范围内的日期', icon: 'none' })
      return
    }
    const result = await Taro.showModal({
      title: `开始第 ${state.plan!.attemptNumber + 1} 次尝试？`,
      content: '当前计划将归档，已有记录保留。一次滑倒通常无需重开。',
      confirmText: '确认开始',
      cancelText: '再想想',
    })
    if (!result.confirm) return
    if (!actions.startNewAttempt(newAttemptPath, newAttemptDate, {
      cigarettesPerDay: newAttemptCigarettes,
      pricePerPack: newAttemptPrice,
    })) return
    setNewAttemptOpen(false)
    Taro.showToast({ title: '新计划已开始', icon: 'none' })
    Taro.switchTab({ url: '/pages/today/index' })
  }

  const askCloudConsent = async (enabled: boolean) => {
    if (!capabilities.cloudSyncControls) return
    if (!enabled) {
      if (actions.updateSettings({ cloudSync: false, syncConsentAt: undefined })) {
        Taro.showToast({ title: '云同步同意已撤回', icon: 'none' })
      }
      return
    }
    const result = await Taro.showModal({
      title: '单独同意云同步',
      content: '开启后，戒烟计划和健康记录将通过随机/平台标识加密同步。不会索取手机号、头像或昵称。当前版本不会上传到云端。',
      confirmText: '单独同意',
      cancelText: '暂不开启',
    })
    if (result.confirm) actions.updateSettings({ cloudSync: true, syncConsentAt: new Date().toISOString() })
  }

  const restoreReminderSchedule = async (scheduled: boolean, hour: number) => {
    if (!nativeMobile) return
    if (!scheduled) {
      await cancelDailyReminder()
      publishReminderActive(false)
      return
    }
    const result = await scheduleDailyReminder(hour)
    publishReminderActive(result === 'scheduled')
  }

  const revokeHealthConsent = async (enabled: boolean) => {
    if (enabled) return
    if (exporting) {
      Taro.showToast({ title: '请先完成或取消当前数据导出', icon: 'none' })
      return
    }
    const result = await Taro.showModal({
      title: '撤回敏感健康信息处理同意？',
      content: harmony
        ? '撤回会清除 App 内计划、记录与设置，且无法在 App 内撤销。HarmonyOS 首版没有云端副本，也不提供数据导出或恢复。'
        : '撤回会清除 App 内计划、记录与设置，且无法在 App 内撤销。个人版没有云端副本；你另行导出的 JSON 不会被删除，仍可用于恢复。',
      confirmText: '撤回删除',
      confirmColor: '#B34232',
      cancelText: '继续保留',
    })
    if (result.confirm) {
      if (await actions.deleteAllData()) {
        publishReminderActive(false)
        openOnboardingAsRoot()
      }
    }
  }

  const askAnalyticsConsent = async (enabled: boolean) => {
    if (!capabilities.outcomeAnalyticsControls) return
    if (!enabled) {
      if (actions.updateSettings({ outcomeAnalytics: false, analyticsConsentAt: undefined })) {
        Taro.showToast({ title: '成效统计同意已撤回', icon: 'none' })
      }
      return
    }
    const result = await Taro.showModal({
      title: '单独同意成效统计',
      content: '仅使用独立随机 ID 处理假名化的使用与自报结局数据，不能与微信 OpenID 联表。当前版本不会上传到云端。',
      confirmText: '单独同意',
      cancelText: '暂不开启',
    })
    if (result.confirm) actions.updateSettings({ outcomeAnalytics: true, analyticsConsentAt: new Date().toISOString() })
  }

  const askSubscriptionConsent = async (enabled: boolean) => {
    if (capabilities.reminder !== 'wechat-subscription') return
    if (!enabled) {
      if (actions.updateSettings({ subscriptionEnabled: false, subscriptionStatus: 'denied' })) {
        Taro.showToast({ title: '订阅消息同意已撤回', icon: 'none' })
      }
      return
    }
    const result = await Taro.showModal({
      title: '单独同意订阅消息',
      content: '订阅消息是可选增强，拒绝不影响应用内今日任务。当前使用 touristappid 且没有正式模板，只会记录模拟同意，不会向微信发起真实授权。',
      confirmText: '单独同意',
      cancelText: '暂不开启',
    })
    actions.updateSettings(result.confirm
      ? { subscriptionEnabled: true, subscriptionStatus: 'simulated' }
      : { subscriptionEnabled: false, subscriptionStatus: 'denied' })
  }

  const changeDailyReminder = async (enabled: boolean) => {
    if (!nativeMobile || reminderBusy) return
    if (!enabled) reminderSettingsReturnPending.current = false
    setReminderBusy(true)
    try {
      await runPlatformReminderMutation(async () => {
        if (!enabled) {
          const reminderWasScheduled = await isDailyReminderScheduled().catch(() => Boolean(reminderActive))
          try {
            await cancelDailyReminder()
            if (!actions.updateSettings({ inAppReminder: false })) {
              await restoreReminderSchedule(reminderWasScheduled, state.settings.reminderHour)
              return
            }
            publishReminderActive(false)
            Taro.showToast({ title: '系统提醒已关闭', icon: 'none' })
          } catch {
            publishReminderActive(await isDailyReminderScheduled().catch(() => reminderWasScheduled))
            Taro.showToast({ title: '系统提醒关闭失败', icon: 'none' })
          }
          return
        }
        try {
          const result = await scheduleDailyReminder(state.settings.reminderHour)
          if (result === 'denied') {
            actions.updateSettings({ inAppReminder: false })
            publishReminderActive(false)
            const permissionChoice = await Taro.showModal({
              title: '通知权限未开启',
              content: '请先在系统中允许通知，再回到这里开启提醒。',
              showCancel: true,
              confirmText: '打开设置',
              cancelText: '暂不开启',
            })
            if (permissionChoice.confirm) {
              reminderSettingsReturnPending.current = true
              try {
                const opened = await openNativeNotificationSettings()
                if (!opened) {
                  reminderSettingsReturnPending.current = false
                  Taro.showToast({ title: '无法打开系统设置', icon: 'none' })
                }
              } catch {
                reminderSettingsReturnPending.current = false
                Taro.showToast({ title: '无法打开系统设置', icon: 'none' })
              }
            }
            return
          }
          if (!actions.updateSettings({ inAppReminder: true })) {
            await cancelDailyReminder()
            return
          }
          reminderSettingsReturnPending.current = false
          publishReminderActive(true)
          Taro.showToast({ title: '系统提醒已开启', icon: 'success' })
        } catch {
          reminderSettingsReturnPending.current = false
          try {
            await cancelDailyReminder()
          } catch {
            // The next lifecycle reconciliation still prevents a false active UI.
          }
          publishReminderActive(false)
          actions.updateSettings({ inAppReminder: false })
          Taro.showToast({ title: '系统提醒设置失败', icon: 'none' })
        }
      })
    } finally {
      setReminderBusy(false)
    }
  }

  const changeReminderHour = async (hour: number) => {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || reminderBusy) return
    if (!state.settings.inAppReminder || !reminderActive) {
      actions.updateSettings({ reminderHour: hour })
      return
    }
    setReminderBusy(true)
    try {
      await runPlatformReminderMutation(async () => {
        try {
          const result = await scheduleDailyReminder(hour)
          if (result !== 'scheduled' || !actions.updateSettings({ reminderHour: hour })) {
            await scheduleDailyReminder(state.settings.reminderHour)
            return
          }
          Taro.showToast({ title: `当地约 ${HOURS[hour]}`, icon: 'none' })
        } catch {
          try {
            await scheduleDailyReminder(state.settings.reminderHour)
          } catch {
            publishReminderActive(false)
          }
          Taro.showToast({ title: '提醒时间修改失败', icon: 'none' })
        }
      })
    } finally {
      setReminderBusy(false)
    }
  }

  const showWidgetHelp = () => Taro.showModal({
    title: '手动添加小组件',
    content: '小米手机：回到桌面，双指捏合 → 添加小部件 → 搜索 → 安卓小部件 → 无烟同行 → 记录一支烟，添加到桌面。\n\n其他桌面：长按空白处 → 小部件 → 无烟同行。',
    showCancel: false,
    confirmText: '知道了',
  })

  const addQuickRecordWidget = async () => {
    if (!nativeAndroid || quickAccessBusy) return
    setQuickAccessBusy(true)
    setWidgetHelpVisible(true)
    try {
      const result = await requestNativeQuickRecordWidget()
      // A true result only reports launcher support. It cannot prove that the
      // launcher displayed a confirmation window or that the user added it.
      if (result.requested) {
        Taro.showToast({ title: '已发送添加请求', icon: 'none' })
      } else {
        await showWidgetHelp()
      }
    } catch {
      await showWidgetHelp()
    } finally {
      setQuickAccessBusy(false)
    }
  }

  const addQuickRecordTile = async () => {
    if (!nativeAndroid || quickAccessBusy) return
    setQuickAccessBusy(true)
    try {
      const result = await requestNativeQuickRecordTile()
      const title = result === 'added'
        ? '锁屏下拉入口已添加'
        : result === 'already-added'
          ? '锁屏下拉入口已存在'
          : result === 'not-added'
            ? '已取消添加'
            : '请从控制中心编辑添加'
      Taro.showToast({ title, icon: 'none' })
    } catch {
      Taro.showToast({ title: '无法添加快捷入口', icon: 'none' })
    } finally {
      setQuickAccessBusy(false)
    }
  }

  const exportData = async () => {
    if (capabilities.backupExport === 'none') return
    const confirmation = await Taro.showModal({
      title: '导出敏感健康数据副本？',
      content: nativeMobile
        ? '副本包含你的戒烟计划与记录。确认后会打开安卓系统“另存为”，由你选择文件名与保存位置；请只保存到你信任的位置。'
        : '副本包含你的戒烟计划与记录。复制到系统剪贴板后，可能被你允许访问剪贴板的其他应用读取；请只粘贴到你信任的位置并及时清除。',
      // Taro/WeChat showModal limits each action label to four Chinese
      // characters. Longer labels reject the call before any dialog appears.
      confirmText: nativeMobile ? '选择位置' : '确认复制',
      cancelText: '取消',
    })
    if (!confirmation.confirm) return
    if (exporting) return
    setExporting(true)
    try {
      if (nativeMobile) {
        const saved = await saveNativeJsonFile(actions.exportData())
        await Taro.showToast({ title: saved ? '数据副本已保存' : '已取消保存', icon: saved ? 'success' : 'none' })
        if (saved) {
          await actions.offerAndroidBootstrapRecoveryRotationAfterExport()
          try {
            await acknowledgePendingNativeExportOutcome()
          } catch {
            // A later foreground probe will repeat the success notice and ack.
          }
        }
      } else {
        await Taro.setClipboardData({ data: actions.exportData() })
        Taro.showToast({ title: '数据副本已复制', icon: 'success' })
        await actions.offerAndroidBootstrapRecoveryRotationAfterExport()
      }
    } catch (error) {
      const cleanupIssue = nativeExportCleanupIssue(error)
      if (cleanupIssue) {
        const savedOutcomeVisible = await showNativeExportCleanupIssue(cleanupIssue, nativeExportCleanupFilename(error))
        if (cleanupIssue === 'saved-local-temporary' && savedOutcomeVisible) {
          await acknowledgePendingNativeExportOutcome().catch(() => false)
        }
      } else {
        Taro.showToast({ title: nativeMobile ? '保存失败，请稍后再试' : '复制失败，请稍后再试', icon: 'none' })
      }
    } finally {
      setExporting(false)
    }
  }

  const importData = async () => {
    if (capabilities.backupRestore !== 'native-file' || !nativeMobile || exporting) return
    setExporting(true)
    try {
      await requestNativeBackupRestoreSelection()
    } finally {
      setExporting(false)
    }
  }

  const deleteData = async () => {
    if (exporting) {
      Taro.showToast({ title: '请先完成或取消当前数据导出', icon: 'none' })
      return
    }
    const result = await Taro.showModal({
      title: '删除本机全部数据？',
      content: harmony
        ? '这会清除 App 内计划、记录和设置，且无法在 App 内撤销。HarmonyOS 首版没有云端副本，也不提供数据恢复。'
        : '这会清除 App 内计划、记录和设置，且无法在 App 内撤销。个人版没有云端副本；你另行导出的 JSON 不会被删除，仍可用于恢复。',
      confirmText: '确认删除',
      confirmColor: '#B34232',
      cancelText: '保留数据',
    })
    if (result.confirm) {
      if (await actions.deleteAllData()) {
        publishReminderActive(false)
        openOnboardingAsRoot()
      }
    }
  }

  return (
    <HarmonyScrollablePage
      className='screen profile-page'
      viewport='tab'
      fallback='scroll'
      overlay={(
        <PrivacyPolicyModal
          open={privacyOpen}
          onClose={() => setPrivacyOpen(false)}
          reserveNativeTabBar
        />
      )}
    >
      <PageHeader title='我的' showSos compact />

      <Text className='section-title'>计划</Text>
      <View className='card profile-plan'>
        <View className='row row--between'>
          <View>
            <Text className='profile-plan__title'>{state.plan.path === 'abrupt' ? '直接戒断' : '限期减量'}</Text>
            <Text className='muted'>戒烟日 {state.plan.quitDate}</Text>
          </View>
          <Text className='pill'>第 {state.plan.attemptNumber} 次尝试</Text>
        </View>
        <View className='divider' />
        <View className='profile-links'>
          <Button className='profile-link' onClick={() => Taro.navigateTo({ url: '/pages/partner/index' })}>伙伴支持 <Text>›</Text></Button>
          {HEALTH_CONTENT_ENABLED ? <>
            <Button className='profile-link' onClick={() => Taro.navigateTo({ url: '/pages/medicine/index' })}>戒烟药物 <Text>›</Text></Button>
            <Button className='profile-link' onClick={() => Taro.navigateTo({ url: '/pages/referral/index' })}>专业支持 <Text>›</Text></Button>
            <Button className='profile-link' onClick={() => Taro.navigateTo({ url: '/pages/faq/index' })}>常见问题 <Text>›</Text></Button>
          </> : null}
        </View>
      </View>

      <Text className='section-title'>新计划</Text>
      <View className='card stack'>
        {state.archivedPlans.length > 0 ? <Text className='muted'>已归档 {state.archivedPlans.length} 个</Text> : null}
        {!newAttemptOpen ? (
          <Button className='button button--secondary' onClick={openNewAttempt}>开始新计划</Button>
        ) : (
          <View className='stack new-attempt' aria-label='新戒烟尝试设置'>
            <View className='choice-grid'>
              <Button className={`choice ${newAttemptPath === 'abrupt' ? 'choice--active' : ''}`} onClick={() => chooseNewAttemptPath('abrupt')}>直接戒断</Button>
              <Button className={`choice ${newAttemptPath === 'reduction' ? 'choice--active' : ''}`} onClick={() => chooseNewAttemptPath('reduction')}>限期减量</Button>
            </View>
            <View>
              <Text className='field-label'>戒烟日</Text>
              <Picker
                mode='date'
                value={newAttemptDate}
                start={addDays(today, newAttemptPath === 'abrupt' ? 0 : 7)}
                end={addDays(today, newAttemptPath === 'abrupt' ? 14 : 28)}
                onChange={(event) => setNewAttemptDate(event.detail.value)}
              >
                <View className='picker-field'>{newAttemptDate}</View>
              </Picker>
            </View>
            <View className='new-attempt-baseline'>
              <View className='new-attempt-baseline__field'>
                <Text className='field-label'>当前日均</Text>
                <Input
                  className='input'
                  type='number'
                  aria-label='新计划当前日均支数'
                  nativeProps={{ 'aria-label': '新计划当前日均支数' }}
                  value={String(newAttemptCigarettes)}
                  onInput={(event) => setNewAttemptCigarettes(Math.max(1, Math.min(100, Math.trunc(Number(event.detail.value) || 1))))}
                />
              </View>
              <View className='new-attempt-baseline__field'>
                <Text className='field-label'>每包价格</Text>
                <Input
                  className='input'
                  type='digit'
                  aria-label='新计划每包价格'
                  nativeProps={{ 'aria-label': '新计划每包价格' }}
                  value={String(newAttemptPrice)}
                  onInput={(event) => setNewAttemptPrice(Math.max(0, Math.min(10_000, Number(event.detail.value) || 0)))}
                />
              </View>
            </View>
            <Button className='button' onClick={() => void confirmNewAttempt()}>开始</Button>
            <Button className='button button--ghost' onClick={() => setNewAttemptOpen(false)}>取消</Button>
          </View>
        )}
      </View>

      {nativeAndroid ? <>
        <Text className='section-title'>快捷记录</Text>
        <View className='card profile-links'>
          <Button className='profile-link' disabled={quickAccessBusy} onClick={() => void addQuickRecordWidget()}>桌面小组件 <Text>›</Text></Button>
          {widgetHelpVisible ? <Button className='profile-widget-help' onClick={() => void showWidgetHelp()}>没有弹窗？查看手动添加方法</Button> : null}
          <Button className='profile-link' disabled={quickAccessBusy} onClick={() => void addQuickRecordTile()}>锁屏下拉入口 <Text>›</Text></Button>
        </View>
      </> : null}

      {(capabilities.reminder === 'android-system' || capabilities.reminder === 'ios-system') ? <>
      <Text className='section-title'>提醒</Text>
      <View className='card settings-list'>
        <View className='setting-row'>
          <View className='grow'>
            <Text className='setting-row__title'>系统通知</Text>
          </View>
          <AccessibleSwitch
            checked={reminderSwitchChecked}
            disabled={reminderBusy || reminderActive === undefined}
            label={switchAccessibilityLabel('每日系统通知', reminderSwitchChecked)}
            onChange={(checked) => void changeDailyReminder(checked)}
          />
        </View>
        <View className={`setting-row ${!state.settings.inAppReminder || !reminderActive ? 'setting-row--disabled' : ''}`}>
          <View className='grow'>
            <Text className='setting-row__title'>提醒时间（当地）</Text>
          </View>
          <Picker mode='selector' range={HOURS} value={state.settings.reminderHour} disabled={reminderBusy || !state.settings.inAppReminder || !reminderActive} onChange={(event) => void changeReminderHour(Number(event.detail.value))}>
            <View className='setting-picker'>约 {HOURS[state.settings.reminderHour]}</View>
          </Picker>
        </View>
      </View>
      </> : capabilities.reminder === 'wechat-subscription' ? <>
        <Text className='section-title'>提醒</Text>
        <View className='card settings-list'>
          <View className='setting-row'>
            <View className='grow'><Text className='setting-row__title'>微信提醒</Text></View>
            <AccessibleSwitch
              checked={state.settings.subscriptionEnabled}
              label={switchAccessibilityLabel('微信订阅消息', state.settings.subscriptionEnabled)}
              onChange={(checked) => void askSubscriptionConsent(checked)}
            />
          </View>
        </View>
      </> : <>
        <Text className='section-title'>提醒</Text>
        <View className='card settings-list'>
          <View className='setting-row'>
            <View className='grow'>
              <Text className='setting-row__title'>HarmonyOS 首版暂未启用系统通知</Text>
              <Text className='muted'>今日任务仍可在应用内查看；本版本不会申请通知权限。</Text>
            </View>
          </View>
        </View>
      </>}

      <Text className='section-title'>数据</Text>
      <View className='card settings-list profile-data'>
        <View className='setting-row'>
          <View className='grow'>
            <Text className='setting-row__title'>健康记录</Text>
            <Text className='muted'>{nativeMobile || harmony ? '仅本机' : '本机处理'}</Text>
          </View>
          <AccessibleSwitch
            checked={state.settings.sensitiveHealthData}
            disabled={exporting}
            label={switchAccessibilityLabel('本机处理敏感健康信息', state.settings.sensitiveHealthData)}
            onChange={(checked) => void revokeHealthConsent(checked)}
          />
        </View>
        {capabilities.cloudSyncControls ? <View className='setting-row'>
          <View className='grow'>
            <Text className='setting-row__title'>云端同步</Text>
          </View>
          <AccessibleSwitch
            checked={state.settings.cloudSync}
            label={switchAccessibilityLabel('云端同步', state.settings.cloudSync)}
            onChange={(checked) => void askCloudConsent(checked)}
          />
        </View> : null}
        {capabilities.outcomeAnalyticsControls ? <View className='setting-row'>
          <View className='grow'>
            <Text className='setting-row__title'>成效统计</Text>
          </View>
          <AccessibleSwitch
            checked={state.settings.outcomeAnalytics}
            label={switchAccessibilityLabel('假名化成效统计', state.settings.outcomeAnalytics)}
            onChange={(checked) => void askAnalyticsConsent(checked)}
          />
        </View> : null}
        <View className='profile-data-actions'>
          {capabilities.backupExport !== 'none' ? <Button className='button button--secondary' disabled={exporting} onClick={exportData}>{exporting ? '处理中…' : '导出副本'}</Button> : null}
          {capabilities.backupRestore === 'native-file' ? <Button className='button button--secondary' disabled={exporting} onClick={() => void importData()}>恢复备份</Button> : null}
          <View className='profile-danger-action'>
            <Button className='button button--danger' disabled={exporting} onClick={deleteData}>删除所有数据</Button>
          </View>
        </View>
        {nativeMobile ? <Button
          className='profile-link'
          aria-label='查看数据与隐私说明'
          onClick={() => void Taro.showModal({
            title: '数据与隐私',
            content: '无需登录，健康记录只保存在本机，不自动上传。\n\n导出的 JSON 包含完整记录，未加密，请自行保管；分享给其他应用由你确认。\n\n删除所有数据或撤回健康记录同意会清除应用内数据，但不会删除你已导出的副本。\n\n系统通知仅在你开启后使用；桌面小组件上的数字可能被能查看你屏幕的人看到。',
            showCancel: false,
            confirmText: '关闭',
          })}
        >数据与隐私 <Text>›</Text></Button> : null}
      </View>

      {harmony ? <>
        <Text className='section-title'>关于与隐私</Text>
        <View className='card'>
          <HarmonyPrivacyPolicyEntry placement='profile' onOpen={() => setPrivacyOpen(true)} />
        </View>
      </> : null}
    </HarmonyScrollablePage>
  )
}
