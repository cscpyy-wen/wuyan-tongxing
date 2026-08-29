import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const requireFromClient = createRequire(resolve(root, 'apps/client/package.json'))
const { JSDOM } = requireFromClient('jsdom')
const runtime = await readFile(resolve(root, 'apps/android-shell/scripts/android-bootstrap-runtime.js'), 'utf8')

function bootstrapSummary(planId, count) {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const date = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`
  return { version: 1, planId, date, count }
}

function bootstrapDom() {
  return new JSDOM(`<!doctype html><html><body>
    <main id="wuyan-android-bootstrap">
      <div id="wuyan-bootstrap-background">
        <div id="wuyan-bootstrap-loading"></div>
        <section id="wuyan-bootstrap-ready" hidden>
          <span id="wuyan-bootstrap-count" role="status" aria-live="polite" aria-atomic="true"></span>
          <button id="wuyan-bootstrap-begin"></button>
        </section>
      </div>
      <div id="wuyan-bootstrap-sheet" hidden>
        <section role="dialog">
          <button id="wuyan-bootstrap-cancel"></button>
          <span id="wuyan-bootstrap-trigger-label">原因</span>
          <div role="group" aria-labelledby="wuyan-bootstrap-trigger-label"><button data-wuyan-trigger="work" aria-pressed="false"></button></div>
          <span id="wuyan-bootstrap-intensity-label">烟瘾强度</span>
          <div role="group" aria-labelledby="wuyan-bootstrap-intensity-label"><button data-wuyan-intensity="4" aria-pressed="false"></button></div>
          <button id="wuyan-bootstrap-save" disabled></button>
          <span id="wuyan-bootstrap-error" hidden></span>
        </section>
      </div>
    </main>
    <div id="app"><button id="react-control">React control</button></div>
  </body></html>`, {
    url: 'https://localhost/',
    runScripts: 'outside-only',
    storageQuota: 20 * 1024 * 1024,
  })
}

function installDurableStore(dom, values) {
  Object.defineProperty(dom.window, 'WuyanDurableStore', {
    configurable: true,
    value: {
      hasValue: (key) => values.has(key),
      readValue: (key) => values.get(key) ?? null,
      readRawValue: (key) => values.get(key) ?? null,
      writeValue: (key, value) => { values.set(key, value) },
      removeValue: (key) => { values.delete(key) },
    },
  })
}

test('Android static bootstrap appends to the durable queue and never forks a legacy authority', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  const values = new Map()
  installDurableStore(dom, values)
  values.set('wuyan-tongxing/client-state/v1', JSON.stringify({
    version: 1,
    onboarded: true,
    settings: { sensitiveHealthData: true },
    plan: { id: 'plan-current' },
    cigarettes: [],
    _androidBootstrapSummary: bootstrapSummary('plan-current', 0),
  }))
  values.set('wuyan-tongxing/android-bootstrap-cigarettes/v1', JSON.stringify({
    data: [{
      id: '71717171-7171-4171-8171-717171717171',
      smokedAt: new Date().toISOString(),
      attemptId: 'plan-current',
      trigger: 'work',
      cravingIntensity: 3,
    }],
  }))

  dom.window.eval(runtime)
  dom.window.document.getElementById('wuyan-bootstrap-begin').click()
  dom.window.document.querySelector('[data-wuyan-trigger="work"]').click()
  dom.window.document.querySelector('[data-wuyan-intensity="4"]').click()
  dom.window.document.getElementById('wuyan-bootstrap-save').click()

  const queue = JSON.parse(values.get('wuyan-tongxing/android-bootstrap-cigarettes/v1'))
  assert.equal(queue.data.length, 2)
  assert.equal(dom.window.localStorage.getItem('wuyan-tongxing/android-bootstrap-cigarettes/v1'), null)
  dom.window.close()
})

test('Android static bootstrap stays locked on a durable backup-restore intent', () => {
  const dom = bootstrapDom()
  const values = new Map()
  installDurableStore(dom, values)
  values.set('wuyan-tongxing/android-backup-restore-intent/v1', JSON.stringify({ version: 1, intent: 'restore-backup' }))
  values.set('wuyan-tongxing/client-state/v1', JSON.stringify({
    version: 1,
    onboarded: true,
    settings: { sensitiveHealthData: true },
    plan: { id: 'plan-current' },
    cigarettes: [],
    _androidBootstrapSummary: bootstrapSummary('plan-current', 0),
  }))

  dom.window.eval(runtime)

  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-ready').hidden, true)
  dom.window.close()
})

test('Android static bootstrap shares the four MiB native core boundary', () => {
  const maximum = 4 * 1024 * 1024
  const state = {
    version: 1,
    onboarded: true,
    settings: { sensitiveHealthData: true },
    plan: { id: 'plan-current' },
    cigarettes: [],
    _androidBootstrapSummary: bootstrapSummary('plan-current', 0),
    padding: '',
  }
  const base = JSON.stringify(state)
  state.padding = 'x'.repeat(maximum - base.length)
  const exact = JSON.stringify(state)
  assert.equal(exact.length, maximum)

  const exactDom = bootstrapDom()
  installDurableStore(exactDom, new Map([['wuyan-tongxing/client-state/v1', exact]]))
  exactDom.window.eval(runtime)
  assert.equal(exactDom.window.document.getElementById('wuyan-bootstrap-ready').hidden, false)
  exactDom.window.close()

  const oversizedDom = bootstrapDom()
  installDurableStore(oversizedDom, new Map([['wuyan-tongxing/client-state/v1', `${exact} `]]))
  oversizedDom.window.eval(runtime)
  assert.equal(oversizedDom.window.document.getElementById('wuyan-bootstrap-ready').hidden, true)
  oversizedDom.window.close()
})

test('Android static bootstrap reuses one event id after a ghost-committed native write', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  const values = new Map()
  let failAfterQueueCommit = true
  Object.defineProperty(dom.window, 'WuyanDurableStore', {
    configurable: true,
    value: {
      hasValue: (key) => values.has(key),
      readValue: (key) => values.get(key) ?? null,
      readRawValue: (key) => values.get(key) ?? null,
      writeValue: (key, value) => {
        values.set(key, value)
        if (key.includes('bootstrap-cigarettes/v1') && failAfterQueueCommit) {
          failAfterQueueCommit = false
          throw new Error('bridge result lost after commit')
        }
      },
      removeValue: (key) => { values.delete(key) },
    },
  })
  values.set('wuyan-tongxing/client-state/v1', JSON.stringify({
    version: 1,
    onboarded: true,
    settings: { sensitiveHealthData: true },
    plan: { id: 'plan-current' },
    cigarettes: [],
    _androidBootstrapSummary: bootstrapSummary('plan-current', 0),
  }))

  dom.window.eval(runtime)
  dom.window.document.getElementById('wuyan-bootstrap-begin').click()
  dom.window.document.querySelector('[data-wuyan-trigger="work"]').click()
  dom.window.document.querySelector('[data-wuyan-intensity="4"]').click()
  const save = dom.window.document.getElementById('wuyan-bootstrap-save')
  save.click()
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-cancel').disabled, true)
  save.click()

  const queue = JSON.parse(values.get('wuyan-tongxing/android-bootstrap-cigarettes/v1'))
  assert.equal(queue.data.length, 1)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-count').textContent, '今日 1 支')
  dom.window.close()
})

test('Android static bootstrap locks an ambiguous pre-commit retry to one event and one payload', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  const values = new Map()
  let failBeforeQueueCommit = true
  let firstAttempt
  Object.defineProperty(dom.window, 'WuyanDurableStore', {
    configurable: true,
    value: {
      hasValue: (key) => values.has(key),
      readValue: (key) => values.get(key) ?? null,
      readRawValue: (key) => values.get(key) ?? null,
      writeValue: (key, value) => {
        if (key.includes('bootstrap-cigarettes/v1') && failBeforeQueueCommit) {
          firstAttempt = JSON.parse(value).data[0]
          failBeforeQueueCommit = false
          throw new Error('bridge failed before commit')
        }
        values.set(key, value)
      },
      removeValue: (key) => { values.delete(key) },
    },
  })
  values.set('wuyan-tongxing/client-state/v1', JSON.stringify({
    version: 1,
    onboarded: true,
    settings: { sensitiveHealthData: true },
    plan: { id: 'plan-current' },
    cigarettes: [],
    _androidBootstrapSummary: bootstrapSummary('plan-current', 0),
  }))

  dom.window.eval(runtime)
  const rootElement = dom.window.document.getElementById('wuyan-android-bootstrap')
  const sheet = dom.window.document.getElementById('wuyan-bootstrap-sheet')
  const trigger = dom.window.document.querySelector('[data-wuyan-trigger="work"]')
  const intensity = dom.window.document.querySelector('[data-wuyan-intensity="4"]')
  const save = dom.window.document.getElementById('wuyan-bootstrap-save')
  dom.window.document.getElementById('wuyan-bootstrap-begin').click()
  trigger.click()
  intensity.click()
  save.click()

  assert.equal(sheet.hidden, false)
  assert.equal(trigger.disabled, true)
  assert.equal(intensity.disabled, true)
  rootElement.dispatchEvent(new dom.window.Event('wuyan:bootstrap-cancel'))
  assert.equal(sheet.hidden, false)
  sheet.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  assert.equal(sheet.hidden, false)

  save.click()
  const queue = JSON.parse(values.get('wuyan-tongxing/android-bootstrap-cigarettes/v1'))
  assert.equal(queue.data.length, 1)
  assert.equal(queue.data[0].id, firstAttempt.id)
  assert.equal(queue.data[0].trigger, firstAttempt.trigger)
  assert.equal(queue.data[0].cravingIntensity, firstAttempt.cravingIntensity)
  assert.equal(sheet.hidden, true)
  dom.window.close()
})

test('Android static bootstrap records through a bounded Taro-compatible queue before React', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', JSON.stringify({
    data: {
      version: 1,
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-current' },
      cigarettes: [],
      _androidBootstrapSummary: bootstrapSummary('plan-current', 0),
    },
  }))
  let queuedEvents = 0
  let releases = 0
  dom.window.addEventListener('wuyan:bootstrap-cigarette', () => { queuedEvents += 1 })
  dom.window.document.getElementById('wuyan-android-bootstrap')
    .addEventListener('wuyan:bootstrap-release', () => { releases += 1 })

  dom.window.eval(runtime)
  const ready = dom.window.document.getElementById('wuyan-bootstrap-ready')
  const rootElement = dom.window.document.getElementById('wuyan-android-bootstrap')
  assert.equal(ready.hidden, false)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-count').getAttribute('aria-live'), 'polite')
  assert.equal(dom.window.document.querySelector('[data-wuyan-trigger]').parentElement.getAttribute('role'), 'group')
  assert.equal(dom.window.document.querySelector('[data-wuyan-intensity]').parentElement.getAttribute('role'), 'group')
  assert.equal(rootElement.dataset.wuyanQuickLogReady, 'true')
  const application = dom.window.document.getElementById('app')
  assert.equal(application.hasAttribute('inert'), true)
  assert.equal(application.getAttribute('aria-hidden'), 'true')

  dom.window.document.getElementById('wuyan-bootstrap-begin').click()
  assert.equal(rootElement.dataset.wuyanBootstrapBusy, 'true')
  const background = dom.window.document.getElementById('wuyan-bootstrap-background')
  assert.equal(background.hasAttribute('inert'), true)
  assert.equal(background.getAttribute('aria-hidden'), 'true')
  dom.window.document.querySelector('[data-wuyan-trigger="work"]').click()
  dom.window.document.querySelector('[data-wuyan-intensity="4"]').click()
  const save = dom.window.document.getElementById('wuyan-bootstrap-save')
  assert.equal(save.disabled, false)

  save.focus()
  save.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  assert.equal(dom.window.document.activeElement, dom.window.document.getElementById('wuyan-bootstrap-cancel'))
  dom.window.document.getElementById('wuyan-bootstrap-cancel').dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
  }))
  assert.equal(dom.window.document.activeElement, save)
  save.click()

  const wrapper = JSON.parse(dom.window.localStorage.getItem('wuyan-tongxing/android-bootstrap-cigarettes/v1'))
  assert.equal(wrapper.data.length, 1)
  assert.match(wrapper.data[0].id, /^[0-9a-f-]{36}$/u)
  assert.equal(wrapper.data[0].trigger, 'work')
  assert.equal(wrapper.data[0].attemptId, 'plan-current')
  assert.equal(wrapper.data[0].cravingIntensity, 4)
  assert.equal(rootElement.dataset.wuyanBootstrapBusy, 'false')
  assert.equal(background.hasAttribute('inert'), false)
  assert.equal(background.hasAttribute('aria-hidden'), false)
  assert.equal(queuedEvents, 1)
  assert.equal(releases, 1)
  dom.window.close()
})

test('Android static bootstrap does not count a sheet opened before Shanghai midnight as the new day', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  const RealDate = dom.window.Date
  let current = '2026-08-28T15:59:59.000Z'
  class FakeDate extends RealDate {
    constructor(value) {
      super(value === undefined ? current : value)
    }
    static now() { return new RealDate(current).getTime() }
  }
  dom.window.Date = FakeDate
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', JSON.stringify({
    data: {
      version: 1,
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-current' },
      cigarettes: [],
      _androidBootstrapSummary: { version: 1, planId: 'plan-current', date: '2026-08-28', count: 0 },
    },
  }))

  dom.window.eval(runtime)
  dom.window.document.getElementById('wuyan-bootstrap-begin').click()
  current = '2026-08-28T16:00:01.000Z'
  dom.window.document.querySelector('[data-wuyan-trigger="work"]').click()
  dom.window.document.querySelector('[data-wuyan-intensity="4"]').click()
  dom.window.document.getElementById('wuyan-bootstrap-save').click()

  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-count').textContent, '今日 0 支')
  const queued = JSON.parse(dom.window.localStorage.getItem('wuyan-tongxing/android-bootstrap-cigarettes/v1'))
  assert.equal(queued.data[0].smokedAt, '2026-08-28T15:59:59.000Z')
  dom.window.close()
})

test('Android static bootstrap does not double-count a committed event awaiting queue acknowledgement', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  const now = new Date().toISOString()
  const duplicate = {
    id: '77777777-7777-4777-8777-777777777777',
    smokedAt: now,
    attemptId: 'plan-current',
    trigger: 'work',
    cravingIntensity: 4,
  }
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', JSON.stringify({
    data: {
      version: 1,
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-current' },
      cigarettes: [{ id: duplicate.id, createdAt: now, attemptId: 'plan-current', count: 1 }],
      _androidBootstrapSummary: bootstrapSummary('plan-current', 1),
    },
  }))
  dom.window.localStorage.setItem('wuyan-tongxing/android-bootstrap-cigarettes/v1', JSON.stringify({
    data: [duplicate],
  }))

  dom.window.eval(runtime)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-count').textContent, '今日 1 支')
  dom.window.close()
})

test('Android static bootstrap suppresses a deleted event left in the crash-recovery queue', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  const now = new Date().toISOString()
  const deleted = {
    id: '78787878-7878-4878-8878-787878787878',
    smokedAt: now,
    attemptId: 'plan-current',
    trigger: 'work',
    cravingIntensity: 4,
  }
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', JSON.stringify({
    data: {
      version: 1,
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-current' },
      cigarettes: [],
      deletedCigaretteIds: [deleted.id],
      _androidBootstrapSummary: bootstrapSummary('plan-current', 0),
    },
  }))
  dom.window.localStorage.setItem('wuyan-tongxing/android-bootstrap-cigarettes/v1', JSON.stringify({
    data: [deleted],
  }))

  dom.window.eval(runtime)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-count').textContent, '今日 0 支')
  dom.window.close()
})

test('Android static bootstrap refuses a twenty-first pending event without dropping an older record', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', JSON.stringify({
    data: {
      version: 1,
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-current' },
      cigarettes: [],
      _androidBootstrapSummary: bootstrapSummary('plan-current', 0),
    },
  }))
  const pending = Array.from({ length: 20 }, (_, index) => ({
    id: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    smokedAt: new Date().toISOString(),
    attemptId: 'plan-current',
    trigger: 'work',
    cravingIntensity: 4,
  }))
  dom.window.localStorage.setItem('wuyan-tongxing/android-bootstrap-cigarettes/v1', JSON.stringify({ data: pending }))

  dom.window.eval(runtime)
  dom.window.document.getElementById('wuyan-bootstrap-begin').click()
  dom.window.document.querySelector('[data-wuyan-trigger="work"]').click()
  dom.window.document.querySelector('[data-wuyan-intensity="4"]').click()
  dom.window.document.getElementById('wuyan-bootstrap-save').click()

  const after = JSON.parse(dom.window.localStorage.getItem('wuyan-tongxing/android-bootstrap-cigarettes/v1'))
  assert.deepEqual(after.data, pending)
  assert.match(dom.window.document.getElementById('wuyan-bootstrap-error').textContent, /已满/u)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-sheet').hidden, false)
  dom.window.close()
})

test('Android static bootstrap never parses a multi-megabyte damaged queue on the main thread', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', JSON.stringify({
    data: {
      version: 1,
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-current' },
      cigarettes: [],
      _androidBootstrapSummary: bootstrapSummary('plan-current', 0),
    },
  }))
  const oversized = JSON.stringify({ data: [{ payload: 'x'.repeat(2 * 1024 * 1024) }] })
  dom.window.localStorage.setItem('wuyan-tongxing/android-bootstrap-cigarettes/v1', oversized)
  const originalParse = dom.window.JSON.parse
  let parsedOversizedSource = false
  dom.window.JSON.parse = (value, reviver) => {
    if (value === oversized) parsedOversizedSource = true
    return originalParse(value, reviver)
  }

  dom.window.eval(runtime)

  assert.equal(parsedOversizedSource, false)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-count').textContent, '今日 0 支')
  dom.window.close()
})

test('Android static bootstrap stays non-interactive without an eligible local plan', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', JSON.stringify({
    data: { onboarded: false, settings: { sensitiveHealthData: false }, cigarettes: [] },
  }))

  dom.window.eval(runtime)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-ready').hidden, true)
  assert.equal(dom.window.document.getElementById('wuyan-android-bootstrap').dataset.wuyanQuickLogReady, undefined)
  dom.window.close()
})

test('Android static bootstrap waits for React when a legacy state has no verified count summary', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', JSON.stringify({
    data: {
      version: 1,
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-current' },
      cigarettes: [{
        id: 'legacy-without-attempt',
        createdAt: new Date().toISOString(),
        count: 1,
      }],
    },
  }))

  dom.window.eval(runtime)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-ready').hidden, true)
  assert.equal(dom.window.document.getElementById('wuyan-android-bootstrap').dataset.wuyanQuickLogReady, undefined)
  dom.window.close()
})

test('Android static bootstrap rejects an oversized core wrapper before JSON parsing', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  const oversized = JSON.stringify({ data: { padding: 'x'.repeat(10 * 1024 * 1024) } })
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', oversized)
  const originalParse = dom.window.JSON.parse
  let parsedOversizedCore = false
  dom.window.JSON.parse = (value, reviver) => {
    if (value === oversized) parsedOversizedCore = true
    return originalParse(value, reviver)
  }

  dom.window.eval(runtime)

  assert.equal(parsedOversizedCore, false)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-ready').hidden, true)
  dom.window.close()
})

test('Android static bootstrap never falls back to another plan when a readable primary lacks its summary', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', JSON.stringify({
    data: {
      version: 1,
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-primary' },
      cigarettes: [],
    },
  }))
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1/last-known-good', JSON.stringify({
    data: {
      version: 1,
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-backup' },
      cigarettes: [],
      _androidBootstrapSummary: bootstrapSummary('plan-backup', 7),
    },
  }))

  dom.window.eval(runtime)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-ready').hidden, true)
  assert.equal(dom.window.document.getElementById('wuyan-android-bootstrap').dataset.wuyanQuickLogReady, undefined)
  dom.window.close()
})

test('Android static bootstrap respects withdrawn health-data consent instead of reviving an eligible backup', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', JSON.stringify({
    data: {
      version: 1,
      onboarded: true,
      settings: { sensitiveHealthData: false },
      plan: { id: 'plan-current' },
      cigarettes: [],
    },
  }))
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1/last-known-good', JSON.stringify({
    data: {
      version: 1,
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-old' },
      cigarettes: [],
    },
  }))

  dom.window.eval(runtime)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-ready').hidden, true)
  assert.equal(dom.window.document.getElementById('wuyan-android-bootstrap').dataset.wuyanQuickLogReady, undefined)
  dom.window.close()
})

test('Android static bootstrap remains locked while crash-resumable deletion is pending', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1/deletion-in-progress', JSON.stringify({
    data: { version: 1, intent: 'delete-all-local-health-data' },
  }))
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', JSON.stringify({
    data: {
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-current' },
      cigarettes: [],
    },
  }))

  dom.window.eval(runtime)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-ready').hidden, true)
  assert.equal(dom.window.document.getElementById('wuyan-android-bootstrap').dataset.wuyanQuickLogReady, undefined)
  dom.window.close()
})

test('Android static bootstrap recognises the quota-safe deletion marker in the backup slot', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1/last-known-good', JSON.stringify({
    data: { version: 1, intent: 'delete-all-local-health-data' },
  }))
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', JSON.stringify({
    data: {
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-current' },
      cigarettes: [],
    },
  }))

  dom.window.eval(runtime)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-ready').hidden, true)
  assert.equal(dom.window.document.getElementById('wuyan-android-bootstrap').dataset.wuyanQuickLogReady, undefined)
  dom.window.close()
})

test('Android static bootstrap remains locked while a core import transaction awaits recovery', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', JSON.stringify({
    data: {
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-imported' },
      cigarettes: [],
      _androidBootstrapImportTransactionId: '11111111-1111-4111-8111-111111111111',
    },
  }))

  dom.window.eval(runtime)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-ready').hidden, true)
  assert.equal(dom.window.document.getElementById('wuyan-android-bootstrap').dataset.wuyanQuickLogReady, undefined)
  dom.window.close()
})

test('Android static bootstrap also locks when the matching import marker survives only in the backup slot', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', '{broken')
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1/last-known-good', JSON.stringify({
    data: {
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-imported' },
      cigarettes: [],
      _androidBootstrapImportTransactionId: '11111111-1111-4111-8111-111111111111',
    },
  }))

  dom.window.eval(runtime)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-ready').hidden, true)
  assert.equal(dom.window.document.getElementById('wuyan-android-bootstrap').dataset.wuyanQuickLogReady, undefined)
  dom.window.close()
})

test('Android static bootstrap remains locked while a system backup picker may restore after process death', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  dom.window.localStorage.setItem('wuyan-tongxing/android-backup-restore-intent/v1', JSON.stringify({
    version: 1,
    intent: 'restore-backup',
  }))
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', JSON.stringify({
    data: {
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-current' },
      cigarettes: [],
    },
  }))

  dom.window.eval(runtime)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-ready').hidden, true)
  assert.equal(dom.window.document.getElementById('wuyan-android-bootstrap').dataset.wuyanQuickLogReady, undefined)
  dom.window.close()
})

test('Android static bootstrap does not infer deletion consent from a corrupt dedicated marker', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1/deletion-in-progress', JSON.stringify({
    data: { version: 1 },
  }))
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', JSON.stringify({
    data: {
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-current' },
      cigarettes: [],
    },
  }))

  dom.window.eval(runtime)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-ready').hidden, true)
  assert.equal(dom.window.document.getElementById('wuyan-android-bootstrap').dataset.wuyanQuickLogReady, undefined)
  assert.ok(dom.window.localStorage.getItem('wuyan-tongxing/client-state/v1'))
  dom.window.close()
})

test('Android static bootstrap counts the largest event fixture under the four MiB native boundary', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  const values = new Map()
  installDurableStore(dom, values)
  const today = new Date().toISOString()
  const old = '2025-01-01T00:00:00.000Z'
  const eventCount = 46_615
  const cigarettes = Array.from({ length: eventCount }, (_, index) => ({
    id: `h${index.toString(36)}`,
    createdAt: index === eventCount - 1 ? today : old,
    attemptId: 'plan-current',
    count: 1,
  }))
  const serialized = JSON.stringify({
      version: 1,
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-current' },
      cigarettes,
      deletedCigaretteIds: [],
      _androidBootstrapSummary: bootstrapSummary('plan-current', 1),
  })
  assert.ok(serialized.length <= 4 * 1024 * 1024)
  values.set('wuyan-tongxing/client-state/v1', serialized)

  const started = performance.now()
  dom.window.eval(runtime)
  const elapsed = performance.now() - started

  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-count').textContent, '今日 1 支')
  assert.ok(elapsed < 1_500, `four-MiB cold-start count took ${elapsed.toFixed(1)} ms`)
  dom.window.close()
})

test('Android static bootstrap keeps a corrupt primary immutable instead of exposing an older backup', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1', '{broken')
  dom.window.localStorage.setItem('wuyan-tongxing/client-state/v1/last-known-good', JSON.stringify({
    data: {
      version: 1,
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-backup' },
      cigarettes: [],
      _androidBootstrapSummary: bootstrapSummary('plan-backup', 0),
    },
  }))
  const queuedRaw = JSON.stringify({ data: [] })
  dom.window.localStorage.setItem('wuyan-tongxing/android-bootstrap-cigarettes/v1', queuedRaw)

  dom.window.eval(runtime)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-ready').hidden, true)
  assert.equal(dom.window.document.getElementById('wuyan-android-bootstrap').dataset.wuyanQuickLogReady, undefined)
  assert.equal(dom.window.localStorage.getItem('wuyan-tongxing/client-state/v1'), '{broken')
  assert.equal(dom.window.localStorage.getItem('wuyan-tongxing/android-bootstrap-cigarettes/v1'), queuedRaw)
  dom.window.close()
})

test('Android static bootstrap does not parse a large backup when the primary is usable', () => {
  const dom = bootstrapDom()
  Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto })
  const values = new Map()
  installDurableStore(dom, values)
  const eventCount = 38_500
  const cigarettes = Array.from({ length: eventCount }, (_, index) => ({
    id: `dual${index.toString(36)}`,
    createdAt: '2025-01-01T00:00:00.000Z',
    attemptId: 'plan-current',
    count: 1,
  }))
  const wrapper = JSON.stringify({
      version: 1,
      onboarded: true,
      settings: { sensitiveHealthData: true },
      plan: { id: 'plan-current' },
      cigarettes,
      deletedCigaretteIds: Array.from({ length: eventCount }, (_, index) => `deleted-${index}`),
      _androidBootstrapSummary: bootstrapSummary('plan-current', 0),
  })
  assert.ok(wrapper.length <= 4 * 1024 * 1024)
  values.set('wuyan-tongxing/client-state/v1', wrapper)
  values.set('wuyan-tongxing/client-state/v1/last-known-good', wrapper)
  const originalParse = dom.window.JSON.parse
  let largeParseCount = 0
  dom.window.JSON.parse = (value, reviver) => {
    if (typeof value === 'string' && value.length > 100_000) largeParseCount += 1
    return originalParse(value, reviver)
  }

  dom.window.eval(runtime)

  assert.equal(largeParseCount, 1)
  assert.equal(dom.window.document.getElementById('wuyan-bootstrap-count').textContent, '今日 0 支')
  dom.window.close()
})
