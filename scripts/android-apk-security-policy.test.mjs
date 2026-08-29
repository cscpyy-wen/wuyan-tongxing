import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  assertBinaryManifestSecurity,
  assertCapacitorRuntimeSecurity,
  assertStrictAndroidCsp,
} from './android-apk-security-policy.mjs'

const inlineScript = 'document.documentElement.dataset.ready="true"'
const inlineHash = createHash('sha256').update(inlineScript).digest('base64')
const strictCsp = `default-src 'self'; script-src 'self' 'sha256-${inlineHash}'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'`
const index = (csp = strictCsp) => `<html><head><meta name="wuyan-runtime" content="android-local"><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${inlineScript}</script></head><body><script src="/js/app.js"></script></body></html>`
const manifest = (debuggable = '') => `N: android=http://schemas.android.com/apk/res/android\n  E: manifest (line=2)\n      E: application (line=20)\n        A: http://schemas.android.com/apk/res/android:usesCleartextTraffic(0x010104ec)=false\n${debuggable}          E: activity (line=32)\n`
const capacitor = () => ({
  loggingBehavior: 'none',
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
    loggingBehavior: 'none',
    useLegacyBridge: false,
    resolveServiceWorkerRequests: false,
  },
  server: { hostname: 'localhost', androidScheme: 'https', cleartext: false, allowNavigation: [] },
})

test('accepts the exact offline CSP, effective non-debuggable binary manifest and hardened Capacitor config', () => {
  assert.deepEqual(assertStrictAndroidCsp(index()), { directiveCount: 12, inlineScriptHashCount: 1 })
  assert.equal(assertBinaryManifestSecurity(manifest()).debuggable, false)
  assert.deepEqual(assertCapacitorRuntimeSecurity(capacitor()), {
    webContentsDebuggingEnabled: false,
    loggingBehavior: 'none',
  })
})

test('rejects a debuggable binary manifest and unresolved cleartext state', () => {
  assert.throws(
    () => assertBinaryManifestSecurity(manifest('        A: http://schemas.android.com/apk/res/android:debuggable(0x0101000f)=true\n')),
    /debuggable 不是 false/,
  )
  assert.throws(() => assertBinaryManifestSecurity(manifest().replace('=false', '=@0x7f010001')), /usesCleartextTraffic=false/)
})

test('rejects WebView debugging, logging and navigation relaxation', () => {
  const debugging = capacitor()
  debugging.android.webContentsDebuggingEnabled = true
  assert.throws(() => assertCapacitorRuntimeSecurity(debugging), /webContentsDebuggingEnabled/)
  const logging = capacitor()
  logging.loggingBehavior = 'debug'
  assert.throws(() => assertCapacitorRuntimeSecurity(logging), /loggingBehavior/)
  const navigation = capacitor()
  navigation.server.allowNavigation = ['*']
  assert.throws(() => assertCapacitorRuntimeSecurity(navigation), /allowNavigation/)
})

test('rejects CSP unsafe execution, network expansion, duplicates and missing directives', () => {
  assert.throws(() => assertStrictAndroidCsp(index(strictCsp.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"))), /script-src/)
  assert.throws(() => assertStrictAndroidCsp(index(strictCsp.replace("connect-src 'self'", 'connect-src *'))), /connect-src/)
  assert.throws(() => assertStrictAndroidCsp(index(`${strictCsp}; connect-src 'self'`)), /指令重复/)
  assert.throws(() => assertStrictAndroidCsp(index(strictCsp.replace("; object-src 'none'", ''))), /object-src/)
  assert.throws(() => assertStrictAndroidCsp(`${index()}<meta http-equiv="Content-Security-Policy" content="${strictCsp}">`), /只能包含一个/)
  assert.throws(() => assertStrictAndroidCsp(index(strictCsp.replace(inlineHash, 'YWJjZA=='))), /不精确一致/)
})
