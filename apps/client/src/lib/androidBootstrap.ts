function markInteractive(ownerDocument: Document): void {
  if (ownerDocument.documentElement?.dataset.wuyanAppReady === 'true') return
  if (ownerDocument.documentElement) ownerDocument.documentElement.dataset.wuyanAppReady = 'true'
  const ownerPerformance = ownerDocument.defaultView?.performance
  if (ownerPerformance && typeof ownerPerformance.mark === 'function') {
    ownerPerformance.mark('wuyan-app-interactive')
  }
}

function removeBootstrap(ownerDocument: Document): void {
  const bootstrap = ownerDocument.getElementById('wuyan-android-bootstrap')
  if (!bootstrap) return
  const application = ownerDocument.getElementById('app')
  markInteractive(ownerDocument)
  application?.removeAttribute?.('inert')
  application?.removeAttribute?.('aria-hidden')
  bootstrap?.remove()

  const focusTarget = application?.querySelector?.<HTMLElement>(
    '[data-wuyan-main-focus], [role="heading"], main, button, a[href]',
  )
  if (!focusTarget) return
  if (!focusTarget.hasAttribute('tabindex')) {
    focusTarget.setAttribute('tabindex', '-1')
    focusTarget.dataset.wuyanBootstrapFocus = 'true'
    focusTarget.addEventListener('blur', () => {
      if (focusTarget.dataset.wuyanBootstrapFocus !== 'true') return
      focusTarget.removeAttribute('tabindex')
      delete focusTarget.dataset.wuyanBootstrapFocus
    }, { once: true })
  }
  focusTarget.focus({ preventScroll: true })
}

function removeBootstrapWhenIdle(ownerDocument: Document): void {
  const bootstrap = ownerDocument.getElementById('wuyan-android-bootstrap')
  if (bootstrap?.dataset?.wuyanBootstrapBusy === 'true') {
    bootstrap.addEventListener('wuyan:bootstrap-release', () => removeBootstrap(ownerDocument), { once: true })
    return
  }
  removeBootstrap(ownerDocument)
}

export function consumeAndroidBootstrapBack(ownerDocument?: Document): boolean {
  if (typeof document === 'undefined' && !ownerDocument) return false
  const target = ownerDocument ?? document
  const bootstrap = target.getElementById('wuyan-android-bootstrap')
  if (bootstrap?.dataset?.wuyanBootstrapBusy !== 'true') return false
  bootstrap.dispatchEvent(new Event('wuyan:bootstrap-cancel'))
  return true
}

/**
 * A pending Android backup restore means local state hydration already
 * completed, but React intentionally keeps ordinary pages behind its own
 * recovery screen. Release the static bootstrap so the file confirmation can
 * be seen and cancelled after a process restart.
 */
export function shouldDismissAndroidBootstrap(
  ready: boolean,
  hasLoadFailure: boolean,
  backupRestorePending: boolean,
): boolean {
  return ready || hasLoadFailure || backupRestorePending
}

/**
 * The Android package places a static, offline SOS/loading surface next to
 * Taro's React root. It must outlive React's initial root replacement and only
 * disappear once the correct persisted route is ready to paint.
 */
export function dismissAndroidBootstrap(ownerDocument?: Document): void {
  if (typeof document === 'undefined' && !ownerDocument) return
  const target = ownerDocument ?? document
  const view = target.defaultView
  if (!view?.requestAnimationFrame) {
    removeBootstrapWhenIdle(target)
    return
  }
  view.requestAnimationFrame(() => {
    view.requestAnimationFrame(() => removeBootstrapWhenIdle(target))
  })
}
