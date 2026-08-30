(() => {
  'use strict'

  const STATE_KEY = 'wuyan-tongxing/client-state/v1'
  const BACKUP_KEY = `${STATE_KEY}/last-known-good`
  const DELETION_KEY = `${STATE_KEY}/deletion-in-progress`
  const IMPORT_MARKER_FIELD = '_androidBootstrapImportTransactionId'
  const IMPORT_JOURNAL_KEY = 'wuyan-tongxing/android-bootstrap-import-journal/v1'
  const SUMMARY_FIELD = '_androidBootstrapSummary'
  const RESTORE_INTENT_KEY = 'wuyan-tongxing/android-backup-restore-intent/v1'
  const QUEUE_KEY = 'wuyan-tongxing/android-bootstrap-cigarettes/v1'
  const QUEUE_EVENT = 'wuyan:bootstrap-cigarette'
  const MAX_QUEUE_RAW_CHARACTERS = 65_536
  const MAX_CORE_WRAPPER_CHARACTERS = 3 * 1024 * 1024
  const MAX_NATIVE_CORE_CHARACTERS = 4 * 1024 * 1024
  const RELEASE_EVENT = 'wuyan:bootstrap-release'
  const CANCEL_EVENT = 'wuyan:bootstrap-cancel'
  const allowedTriggers = new Set([
    'work', 'meal', 'toilet', 'stress', 'social', 'alcohol',
    'exercise', 'boredom', 'morning', 'coffee', 'habit',
  ])
  const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

  const root = document.getElementById('wuyan-android-bootstrap')
  const application = document.getElementById('app')
  const background = document.getElementById('wuyan-bootstrap-background')
  const loading = document.getElementById('wuyan-bootstrap-loading')
  const ready = document.getElementById('wuyan-bootstrap-ready')
  const count = document.getElementById('wuyan-bootstrap-count')
  const begin = document.getElementById('wuyan-bootstrap-begin')
  const sheet = document.getElementById('wuyan-bootstrap-sheet')
  const cancel = document.getElementById('wuyan-bootstrap-cancel')
  const save = document.getElementById('wuyan-bootstrap-save')
  const error = document.getElementById('wuyan-bootstrap-error')
  const dialog = sheet?.querySelector('[role="dialog"]')
  if (!root || !application || !background || !loading || !ready || !count || !begin || !sheet || !dialog || !cancel || !save || !error) return
  application.setAttribute('inert', '')
  application.setAttribute('aria-hidden', 'true')

  function readTaroStorage(key) {
    const raw = localStorage.getItem(key)
    if (raw === null) return { status: 'missing' }
    if (raw.length > MAX_CORE_WRAPPER_CHARACTERS) return { status: 'corrupt' }
    try {
      const wrapper = JSON.parse(raw)
      if (!wrapper || typeof wrapper !== 'object' || !Object.prototype.hasOwnProperty.call(wrapper, 'data')) {
        return { status: 'corrupt' }
      }
      return { status: 'readable', data: wrapper.data }
    } catch {
      return { status: 'corrupt' }
    }
  }

  function nativeDurableStore() {
    const candidate = globalThis.WuyanDurableStore
    return candidate
      && typeof candidate.hasValue === 'function'
      && typeof candidate.readValue === 'function'
      && typeof candidate.readRawValue === 'function'
      && typeof candidate.writeValue === 'function'
      && typeof candidate.removeValue === 'function'
      ? candidate
      : undefined
  }

  function readCoreRaw(key) {
    const durable = nativeDurableStore()
    try {
      if (durable?.hasValue(key)) return durable.readRawValue(key)
    } catch {
      return undefined
    }
    return localStorage.getItem(key)
  }

  function readCoreStorage(key) {
    const durable = nativeDurableStore()
    if (!durable) return readTaroStorage(key)
    try {
      if (!durable.hasValue(key)) return readTaroStorage(key)
      const raw = durable.readValue(key)
      if (typeof raw !== 'string' || raw.length > MAX_NATIVE_CORE_CHARACTERS) return { status: 'corrupt' }
      return { status: 'readable', data: JSON.parse(raw) }
    } catch {
      // A present but unreadable native value is authoritative; never fall
      // back to a stale WebView copy after a failed/crash-interrupted write.
      return { status: 'corrupt' }
    }
  }

  function writeCrashSafeValue(key, value) {
    const durable = nativeDurableStore()
    if (durable) {
      durable.writeValue(key, value)
      // Native writeValue already completes fsync + atomic replace + exact
      // readback. A second bridge read could turn a committed event into an
      // ambiguous UI failure and invite a duplicate retry.
      try { localStorage.removeItem(key) } catch { /* native value is authoritative */ }
      return
    }
    localStorage.setItem(key, value)
    if (localStorage.getItem(key) !== value) throw new Error('本机记录写入后校验失败')
  }

  function eligibleState(value) {
    const summary = value?.[SUMMARY_FIELD]
    const summaryKeys = summary && typeof summary === 'object' ? Object.keys(summary).sort() : []
    const validSummary = summaryKeys.length === 4
      && summaryKeys[0] === 'count'
      && summaryKeys[1] === 'date'
      && summaryKeys[2] === 'planId'
      && summaryKeys[3] === 'version'
      && summary.version === 1
      && summary.planId === value?.plan?.id
      && /^\d{4}-\d{2}-\d{2}$/.test(summary.date)
      && Number.isSafeInteger(summary.count)
      && summary.count >= 0
      && summary.count <= 5_000_000
    return value
      && typeof value === 'object'
      && value.version === 1
      && value.onboarded === true
      && value.settings?.sensitiveHealthData === true
      && typeof value.plan?.id === 'string'
      && value.plan.id.length > 0
      && value.plan.id.length <= 128
      && Array.isArray(value.cigarettes)
      && validSummary
      ? value
      : undefined
  }

  function validQueuedEvent(value) {
    return value
      && typeof value === 'object'
      && typeof value.id === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
      && validTimestamp(value.smokedAt)
      && typeof value.attemptId === 'string'
      && value.attemptId.length > 0
      && value.attemptId.length <= 128
      && allowedTriggers.has(value.trigger)
      && Number.isInteger(value.cravingIntensity)
      && value.cravingIntensity >= 1
      && value.cravingIntensity <= 5
  }

  function daysInGregorianMonth(year, month) {
    if (month === 2) {
      const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      return leapYear ? 29 : 28
    }
    return [4, 6, 9, 11].includes(month) ? 30 : 31
  }

  function validTimestamp(value) {
    if (typeof value !== 'string' || value.length > 64) return false
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
    if (!match) return false
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const hour = Number(match[4])
    const minute = Number(match[5])
    const second = Number(match[6])
    if (year < 1
      || month < 1 || month > 12
      || day < 1 || day > daysInGregorianMonth(year, month)
      || hour > 23 || minute > 59 || second > 59) return false
    const offset = match[8]
    if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) return false
    return Number.isFinite(new Date(value).getTime())
  }

  function readValidatedQueue() {
    const raw = readCoreRaw(QUEUE_KEY)
    if (raw === null) return []
    if (typeof raw !== 'string') throw new Error('待处理记录异常，请等待页面加载后重试')
    if (raw.length > MAX_QUEUE_RAW_CHARACTERS) {
      throw new Error('待处理记录异常，请等待页面加载后重试')
    }
    let wrapper
    try {
      wrapper = JSON.parse(raw)
    } catch {
      throw new Error('待处理记录异常，请等待页面加载后重试')
    }
    if (!wrapper || !Array.isArray(wrapper.data) || wrapper.data.length > 20) {
      throw new Error('待处理记录异常，请等待页面加载后重试')
    }
    const ids = new Set()
    for (const item of wrapper.data) {
      if (!validQueuedEvent(item) || ids.has(item.id)) {
        throw new Error('待处理记录异常，请等待页面加载后重试')
      }
      ids.add(item.id)
    }
    return wrapper.data
  }

  function shanghaiDay(value) {
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) return undefined
    const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS)
    const year = shifted.getUTCFullYear()
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
    const day = String(shifted.getUTCDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  function uuid() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  function exactDeletionIntent(entry) {
    if (entry.status !== 'readable' || !entry.data || typeof entry.data !== 'object') return false
    const keys = Object.keys(entry.data)
    return keys.length === 2
      && entry.data.version === 1
      && entry.data.intent === 'delete-all-local-health-data'
  }

  // A durable deletion intent is written before asynchronous native/storage
  // cleanup. The quota-safe form may occupy the backup slot. Never expose
  // quick logging while either exact marker is awaiting continuation. A
  // present but corrupt dedicated key is not treated as consent, but stays
  // locked until React presents the recovery UI.
  const deletion = readCoreStorage(DELETION_KEY)
  // Native core storage has a dedicated atomic deletion key and never needs
  // to sacrifice its backup slot. Only inspect the legacy WebView backup for
  // a pre-migration quota-fallback marker; avoid copying a large native backup.
  const backupRaw = nativeDurableStore()
    ? localStorage.getItem(BACKUP_KEY)
    : readCoreRaw(BACKUP_KEY)
  // The quota-safe deletion marker is tiny. Do not JSON.parse a normal backup
  // (up to 9 MiB) unless the primary is actually absent and fallback is needed.
  const backupDeletionCandidate = typeof backupRaw === 'string' && backupRaw.length <= 512
    ? (nativeDurableStore() ? readTaroStorage(BACKUP_KEY) : readCoreStorage(BACKUP_KEY))
    : { status: backupRaw === null ? 'missing' : 'deferred' }
  if (exactDeletionIntent(deletion)
    || exactDeletionIntent(backupDeletionCandidate)
    || deletion.status !== 'missing') return

  // The system picker can outlive the WebView process. Until its result is
  // fully consumed, a quick log could otherwise be written against the old
  // plan and then overwritten by the restored backup.
  if (readCoreRaw(RESTORE_INTENT_KEY) !== null) return
  // Every valid cross-store import marker has a write-ahead journal. Locking
  // on the small raw journal avoids parsing both large core slots just to find
  // a marker; React validates or removes an orphan before it exposes state.
  if (readCoreRaw(IMPORT_JOURNAL_KEY) !== null) return

  const primary = readCoreStorage(STATE_KEY)
  // A matching import journal is completed by React before it exposes the
  // imported plan. Never accept a static quick log against the intermediate
  // primary while that transaction marker is present.
  if (primary.status === 'readable'
    && primary.data
    && typeof primary.data === 'object'
    && Object.prototype.hasOwnProperty.call(primary.data, IMPORT_MARKER_FIELD)) return
  if (primary.status === 'readable'
    && primary.data
    && typeof primary.data === 'object'
    && (primary.data.onboarded !== true || primary.data.settings?.sensitiveHealthData !== true)) return
  const primaryState = primary.status === 'readable' ? eligibleState(primary.data) : undefined
  // A readable primary that lacks the co-committed summary is an older or
  // partially normalized value, not permission to expose a different backup
  // plan. Let the strict React repository choose/recover it first. Only an
  // absent primary may fall back to the verified backup slot. A corrupt
  // primary remains immutable recovery evidence until React obtains an
  // explicit user decision, so static quick logging must stay closed.
  if (primary.status === 'readable' && !primaryState) return
  if (primary.status === 'corrupt') return
  const backup = primary.status === 'missing' ? readCoreStorage(BACKUP_KEY) : undefined
  const state = primaryState || (backup?.status === 'readable' ? eligibleState(backup.data) : undefined)
  if (!state) return

  function countForToday(queue, now = new Date()) {
    const today = shanghaiDay(now)
    const committed = state[SUMMARY_FIELD].date === today ? state[SUMMARY_FIELD].count : 0
    if (queue.length === 0) return committed
    // The queue is capped at 20. Track only those candidate IDs while scanning
    // the potentially 50k-item history instead of allocating a second full
    // copy of every committed identifier during cold start.
    const uncommittedIds = new Set(queue.map((item) => item.id))
    if (Array.isArray(state.deletedCigaretteIds)) {
      for (const id of state.deletedCigaretteIds) {
        if (uncommittedIds.size === 0) break
        if (typeof id === 'string' && id.length > 0 && id.length <= 128) uncommittedIds.delete(id)
      }
    }
    for (const item of state.cigarettes) {
      if (uncommittedIds.size === 0) break
      if (item && typeof item.id === 'string') uncommittedIds.delete(item.id)
    }
    return committed + queue.filter((item) => (
      uncommittedIds.has(item.id)
      && item.attemptId === state.plan.id
      && shanghaiDay(item.smokedAt) === today
    )).length
  }

  let initialQueue = []
  try {
    initialQueue = readValidatedQueue()
  } catch {
    // Keep the committed count visible. A save attempt gives the explicit
    // recovery message while React validates/quarantines the damaged queue.
  }
  let countDay = shanghaiDay(new Date())
  let todayCount = countForToday(initialQueue)
  let smokedAt
  let selectedTrigger
  let selectedIntensity
  let pendingEvent
  let ambiguousWrite = false

  function refreshCount() {
    count.textContent = `今日 ${todayCount} 支`
  }

  function setBusy(busy) {
    root.dataset.wuyanBootstrapBusy = busy ? 'true' : 'false'
  }

  function release() {
    setBusy(false)
    root.dispatchEvent(new Event(RELEASE_EVENT))
  }

  function select(buttons, selected) {
    for (const button of buttons) {
      const active = button === selected
      button.classList.toggle('wuyan-bootstrap-choice--selected', active)
      button.setAttribute('aria-pressed', String(active))
    }
  }

  function updateSave() {
    save.disabled = !selectedTrigger || !selectedIntensity
  }

  const triggerButtons = [...sheet.querySelectorAll('[data-wuyan-trigger]')]
  const intensityButtons = [...sheet.querySelectorAll('[data-wuyan-intensity]')]
  for (const button of triggerButtons) {
    button.addEventListener('click', () => {
      if (ambiguousWrite) return
      const value = button.getAttribute('data-wuyan-trigger')
      if (!allowedTriggers.has(value)) return
      selectedTrigger = value
      select(triggerButtons, button)
      updateSave()
    })
  }
  for (const button of intensityButtons) {
    button.addEventListener('click', () => {
      if (ambiguousWrite) return
      const value = Number(button.getAttribute('data-wuyan-intensity'))
      if (!Number.isInteger(value) || value < 1 || value > 5) return
      selectedIntensity = value
      select(intensityButtons, button)
      updateSave()
    })
  }

  begin.addEventListener('click', () => {
    const currentDay = shanghaiDay(new Date())
    if (currentDay !== countDay) {
      countDay = currentDay
      try {
        todayCount = countForToday(readValidatedQueue())
      } catch {
        todayCount = 0
      }
      refreshCount()
    }
    smokedAt = new Date().toISOString()
    pendingEvent = undefined
    ambiguousWrite = false
    cancel.disabled = false
    for (const button of [...triggerButtons, ...intensityButtons]) button.disabled = false
    selectedTrigger = undefined
    selectedIntensity = undefined
    error.hidden = true
    select(triggerButtons)
    select(intensityButtons)
    updateSave()
    setBusy(true)
    background.setAttribute('inert', '')
    background.setAttribute('aria-hidden', 'true')
    sheet.hidden = false
    triggerButtons[0]?.focus()
  })

  function closeSheet() {
    sheet.hidden = true
    background.removeAttribute('inert')
    background.removeAttribute('aria-hidden')
  }

  function cancelQuickLog() {
    if (sheet.hidden) return
    if (ambiguousWrite) {
      error.textContent = '保存结果待确认，请重试当前记录'
      error.hidden = false
      save.focus()
      return
    }
    closeSheet()
    release()
    begin.focus()
  }

  cancel.addEventListener('click', cancelQuickLog)
  root.addEventListener(CANCEL_EVENT, cancelQuickLog)
  sheet.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelQuickLog()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...dialog.querySelectorAll('button:not([disabled])')]
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault()
      first.focus()
    }
  })

  save.addEventListener('click', () => {
    if (!smokedAt || !allowedTriggers.has(selectedTrigger) || !Number.isInteger(selectedIntensity)) return
    save.disabled = true
    let writeAttempted = false
    try {
      const queue = readValidatedQueue()
      const event = pendingEvent ?? {
        id: uuid(),
        smokedAt,
        attemptId: state.plan.id,
        trigger: selectedTrigger,
        cravingIntensity: selectedIntensity,
      }
      pendingEvent = event
      const existing = queue.find((item) => item.id === event.id)
      if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new Error('待处理记录标识冲突，请等待页面加载后重试')
      }
      if (!existing) {
        if (queue.length >= 20) throw new Error('待处理记录已满，请等待页面加载后重试')
        writeAttempted = true
        writeCrashSafeValue(QUEUE_KEY, JSON.stringify({ data: [...queue, event] }))
      }
      // smokedAt is captured from this click and the bounded queue write just
      // succeeded. Keep the common path O(1), while a sheet held open across
      // Shanghai midnight rolls the visible day forward without miscounting.
      const currentDay = shanghaiDay(new Date())
      if (currentDay !== countDay) {
        countDay = currentDay
        todayCount = 0
      }
      if (shanghaiDay(smokedAt) === currentDay) todayCount += 1
      refreshCount()
      closeSheet()
      window.dispatchEvent(new CustomEvent(QUEUE_EVENT, { detail: { id: event.id } }))
      pendingEvent = undefined
      ambiguousWrite = false
      cancel.disabled = false
      for (const button of [...triggerButtons, ...intensityButtons]) button.disabled = false
      release()
      begin.focus()
    } catch (caught) {
      ambiguousWrite = ambiguousWrite || writeAttempted
      cancel.disabled = ambiguousWrite
      for (const button of [...triggerButtons, ...intensityButtons]) button.disabled = ambiguousWrite
      if (!ambiguousWrite) pendingEvent = undefined
      error.textContent = ambiguousWrite
        ? '保存结果待确认，请重试当前记录'
        : caught instanceof Error ? caught.message : '保存失败，请重试'
      error.hidden = false
      save.disabled = false
    }
  })

  refreshCount()
  loading.hidden = true
  ready.hidden = false
  root.dataset.wuyanQuickLogReady = 'true'
})()
