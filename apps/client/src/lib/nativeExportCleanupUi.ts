import Taro from '@tarojs/taro'
import {
  acknowledgeNativeSelectedDocumentCleanup,
  acknowledgePendingNativeExportOutcome,
  forgetNativeCorruptExportOutcome,
  purgeNativePendingExports,
  type NativeExportCleanupIssue,
} from './runtime'
import { runAppModal } from './modalCoordinator'

let pendingIssue: NativeExportCleanupIssue | undefined
let pendingFilename: string | undefined
let activeIssue: NativeExportCleanupIssue | undefined
let drainPromise: Promise<boolean> | undefined

function issueFacets(issue: NativeExportCleanupIssue): { selected: boolean; local: boolean; saved: boolean; outcome: boolean } {
  return {
    selected: issue === 'selected-document' || issue === 'both',
    local: issue === 'local-temporary' || issue === 'both' || issue === 'saved-local-temporary',
    saved: issue === 'saved-local-temporary',
    outcome: issue === 'export-outcome' || issue === 'pending-export-outcome',
  }
}

function mergeIssue(left: NativeExportCleanupIssue | undefined, right: NativeExportCleanupIssue): NativeExportCleanupIssue {
  if (!left) return right
  if (left === 'export-outcome' || right === 'export-outcome') return 'export-outcome'
  if (left === 'pending-export-outcome' || right === 'pending-export-outcome') return 'pending-export-outcome'
  const leftFacets = issueFacets(left)
  const rightFacets = issueFacets(right)
  // The corrupt durable outcome must be resolved before any lower-level file
  // cleanup can be interpreted safely. Other durable warnings remain in the
  // native journal and will be offered on the next foreground probe.
  const selected = leftFacets.selected || rightFacets.selected
  const local = leftFacets.local || rightFacets.local
  if (selected && local) return 'both'
  if (selected) return 'selected-document'
  if (leftFacets.saved || rightFacets.saved) return 'saved-local-temporary'
  return 'local-temporary'
}

function subsumes(left: NativeExportCleanupIssue, right: NativeExportCleanupIssue): boolean {
  if (left === 'export-outcome') return right === 'export-outcome' || right === 'pending-export-outcome'
  if (left === 'pending-export-outcome') return right === 'pending-export-outcome'
  if (right === 'export-outcome' || right === 'pending-export-outcome') return false
  const a = issueFacets(left)
  const b = issueFacets(right)
  return (!b.selected || a.selected)
    && (!b.local || a.local)
    && (!b.saved || a.saved)
    && (!b.outcome || a.outcome)
}

async function showOneNativeExportCleanupIssue(issue: NativeExportCleanupIssue, filename?: string): Promise<boolean> {
  if (issue === 'pending-export-outcome') {
    let decision: { confirm?: boolean }
    try {
      decision = await runAppModal(() => Taro.showModal({
        title: '上次副本已保存',
        content: '请先核对刚才保存的 JSON 文件。确认文件存在后再继续新的导出。',
        confirmText: '已核对',
        cancelText: '稍后',
      }))
    } catch {
      return false
    }
    if (!decision.confirm) return false
    try {
      await acknowledgePendingNativeExportOutcome()
      await Taro.showToast({ title: '可以重新导出了', icon: 'success' })
      return true
    } catch {
      await Taro.showToast({ title: '状态未释放，请稍后重试', icon: 'none' }).catch(() => undefined)
      return false
    }
  }
  if (issue === 'export-outcome') {
    let decision: { confirm?: boolean }
    try {
      decision = await runAppModal(() => Taro.showModal({
        title: '核对上次导出',
        content: '上次导出的完成状态已损坏，应用无法自动确认文件是否保存。请到刚才选择的位置核对 JSON 文件，确认后再释放这个状态。',
        confirmText: '已核对',
        cancelText: '稍后',
      }))
    } catch {
      try {
        await Taro.showToast({ title: '请核对上次导出的 JSON 文件', icon: 'none' })
      } catch {
        // The durable native warning will be offered again later.
      }
      return false
    }
    if (!decision.confirm) return false
    try {
      await forgetNativeCorruptExportOutcome()
      await Taro.showToast({ title: '导出状态已释放', icon: 'success' })
    } catch {
      try {
        await Taro.showToast({ title: '状态未释放，请稍后重试', icon: 'none' })
      } catch {
        // The durable native warning will be offered again later.
      }
    }
    return false
  }

  if (issue === 'selected-document') {
    let decision: { confirm?: boolean }
    try {
      decision = await runAppModal(() => Taro.showModal({
        title: '确认文件已处理',
        content: filename
          ? `请先到保存位置检查“${filename}”。确认已删除不完整文件，或确认它是需要保留的完整副本后，再点“已处理”。`
          : '请先到刚才的保存位置检查对应 JSON 文件。确认已删除不完整文件，或确认它是需要保留的完整副本后，再点“已处理”。',
        confirmText: '已处理',
        cancelText: '稍后',
      }))
    } catch {
      try {
        await Taro.showToast({ title: '仍有不完整文件待手动删除', icon: 'none' })
      } catch {
        // The durable native warning will be offered again later.
      }
      return false
    }
    if (!decision.confirm) return false
    try {
      await acknowledgeNativeSelectedDocumentCleanup()
      await Taro.showToast({ title: '文件清理状态已确认', icon: 'success' })
    } catch {
      try {
        await Taro.showToast({ title: '确认未保存，请稍后重试', icon: 'none' })
      } catch {
        // The durable native warning will be offered again later.
      }
    }
    return false
  }

  const content = issue === 'both'
    ? `${filename ? `请先检查并处理“${filename}”。` : '请先检查刚才保存位置中的 JSON 文件。'}确认后会同时重试清理本机私有暂存。`
    : issue === 'saved-local-temporary'
      ? '数据副本已经保存。本机私有暂存仍未清理；应用会在每次回到前台时自动重试，也可现在重试。'
      : '暂存仍在应用私有目录，不会进入系统备份或被其他应用读取。应用会在每次回到前台时自动重试，也可现在重试。'
  const title = issue === 'both'
    ? '两处清理都未完成'
    : issue === 'saved-local-temporary'
      ? '文件已保存'
      : '本机暂存仍需清理'
  let decision: { confirm?: boolean }
  try {
    decision = await runAppModal(() => Taro.showModal({
      title,
      content,
      confirmText: issue === 'both' ? '已处理' : '重试清理',
      cancelText: '稍后',
    }))
  } catch {
    try {
      await Taro.showToast({
        title: issue === 'saved-local-temporary' ? '副本已保存，本机暂存待清理' : '本机暂存仍待清理',
        icon: 'none',
      })
      return issue === 'saved-local-temporary'
    } catch {
      // The durable native warning will be offered again later.
      return false
    }
  }
  const savedOutcomeVisible = issue === 'saved-local-temporary'
  if (!decision.confirm) return savedOutcomeVisible
  try {
    let cleanupError: unknown
    if (issue === 'both') {
      try {
        await acknowledgeNativeSelectedDocumentCleanup()
      } catch (error) {
        cleanupError = error
      }
    }
    try {
      await purgeNativePendingExports()
    } catch (error) {
      if (cleanupError === undefined) cleanupError = error
    }
    if (cleanupError !== undefined) throw cleanupError
    try {
      await Taro.showToast({ title: '本机暂存已清理', icon: 'success' })
    } catch {
      // Cleanup already succeeded; a failed confirmation toast is harmless.
    }
  } catch {
    try {
      await Taro.showToast({ title: '仍未清理，将自动重试', icon: 'none' })
    } catch {
      // The durable native warning drives the next retry.
    }
  }
  return savedOutcomeVisible
}

export function showNativeExportCleanupIssue(issue: NativeExportCleanupIssue, filename?: string): Promise<boolean> {
  if (activeIssue && subsumes(activeIssue, issue)) return drainPromise ?? Promise.resolve(false)
  pendingIssue = mergeIssue(pendingIssue, issue)
  if (filename) pendingFilename = filename
  if (drainPromise) return drainPromise
  drainPromise = (async () => {
    // Both the restored-result listener and the persisted-warning probe run at
    // startup. One microtask lets their concurrent signals collapse into the
    // strongest single dialog before any modal is shown.
    let savedOutcomeVisible = false
    await Promise.resolve()
    while (pendingIssue) {
      const next = pendingIssue
      const nextFilename = pendingFilename
      pendingIssue = undefined
      pendingFilename = undefined
      activeIssue = next
      try {
        savedOutcomeVisible = await showOneNativeExportCleanupIssue(next, nextFilename) || savedOutcomeVisible
      } finally {
        activeIssue = undefined
      }
    }
    return savedOutcomeVisible
  })().finally(() => {
    drainPromise = undefined
  })
  return drainPromise
}
