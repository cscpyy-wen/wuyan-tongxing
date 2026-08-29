import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppErrorBoundary } from './AppErrorBoundary'

function ThrowOnRender(): never {
  throw new Error('cold-start render failure')
}

describe('AppErrorBoundary cold-start recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('releases the inert Android bootstrap when a child fails before effects commit', () => {
    document.body.innerHTML = [
      '<div id="wuyan-android-bootstrap"></div>',
      '<div id="app" inert aria-hidden="true"><div id="test-root"></div></div>',
    ].join('')
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(
      createElement(AppErrorBoundary, undefined, createElement(ThrowOnRender)),
      { container: document.getElementById('test-root')! },
    )

    expect(screen.getByText('页面暂时没有正常打开')).toBeTruthy()
    expect(document.getElementById('wuyan-android-bootstrap')).toBeNull()
    expect(document.getElementById('app')?.hasAttribute('inert')).toBe(false)
    expect(document.getElementById('app')?.hasAttribute('aria-hidden')).toBe(false)
  })
})
