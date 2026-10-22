import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccessibleButton } from './AccessibleButton'

vi.mock('@tarojs/components', async () => {
  const { createElement } = await import('react')
  return {
    Button: (props: ComponentProps<'button'>) => createElement('button', props),
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const activationKeys = ['Enter', ' '] as const

describe('AccessibleButton keyboard activation', () => {
  it.each(activationKeys)('calls an explicit click handler exactly once for %j and cancels native default activation', (key) => {
    const onClick = vi.fn()
    const onKeyDown = vi.fn()
    render(createElement(AccessibleButton, { onClick, onKeyDown }, 'Save'))
    const button = screen.getByRole('button', { name: 'Save' })
    const nativeClick = vi.spyOn(button, 'click')

    const allowedDefault = fireEvent.keyDown(button, { key })
    fireEvent.keyUp(button, { key })

    expect(allowedDefault).toBe(false)
    expect(onKeyDown).toHaveBeenCalledOnce()
    expect(onClick).toHaveBeenCalledOnce()
    expect(onClick).toHaveBeenCalledWith(onKeyDown.mock.calls[0]![0])
    expect(onClick.mock.calls[0]![0].defaultPrevented).toBe(true)
    expect(onKeyDown.mock.invocationCallOrder[0]).toBeLessThan(onClick.mock.invocationCallOrder[0]!)
    expect(nativeClick).not.toHaveBeenCalled()
  })

  it.each(activationKeys)('bubbles one fallback click from a Picker child without onClick for %j', (key) => {
    const onPickerClick = vi.fn()
    render(createElement('div', { onClick: onPickerClick },
      createElement(AccessibleButton, {}, createElement('span', {}, 'Choose date')),
    ))
    const button = screen.getByRole('button', { name: 'Choose date' })
    const label = screen.getByText('Choose date')
    const nativeClick = vi.spyOn(button, 'click')
    const labelClick = vi.spyOn(label, 'click')

    // The originating target can be a nested label. Activation must click the
    // button currentTarget so the Picker sees the same bubbling host click.
    const allowedDefault = fireEvent.keyDown(label, { key })
    fireEvent.keyUp(label, { key })

    expect(allowedDefault).toBe(false)
    expect(nativeClick).toHaveBeenCalledOnce()
    expect(labelClick).not.toHaveBeenCalled()
    expect(onPickerClick).toHaveBeenCalledOnce()
    expect(onPickerClick.mock.calls[0]![0].type).toBe('click')
    expect(onPickerClick.mock.calls[0]![0].target).toBe(button)
  })

  it.each([true, false])('does not activate or invoke a supplied keyboard handler when disabled (onClick present: %s)', (hasOnClick) => {
    const onClick = vi.fn()
    const onKeyDown = vi.fn()
    const onPickerClick = vi.fn()
    render(createElement('div', { onClick: onPickerClick },
      createElement(AccessibleButton, {
        disabled: true,
        onKeyDown,
        ...(hasOnClick ? { onClick } : {}),
      }, 'Unavailable'),
    ))
    const button = screen.getByRole('button', { name: 'Unavailable' })
    const nativeClick = vi.spyOn(button, 'click')

    for (const key of activationKeys) {
      fireEvent.keyDown(button, { key })
      fireEvent.keyUp(button, { key })
    }

    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('tabindex')).toBe('-1')
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(onKeyDown).not.toHaveBeenCalled()
    expect(onClick).not.toHaveBeenCalled()
    expect(nativeClick).not.toHaveBeenCalled()
    expect(onPickerClick).not.toHaveBeenCalled()
  })

  it.each(['Tab', 'Escape', 'ArrowDown', 'a'])('forwards unrelated key %j without cancelling it or activating', (key) => {
    const onClick = vi.fn()
    const onKeyDown = vi.fn()
    render(createElement(AccessibleButton, { onClick, onKeyDown }, 'Save'))
    const button = screen.getByRole('button', { name: 'Save' })
    const nativeClick = vi.spyOn(button, 'click')

    expect(fireEvent.keyDown(button, { key })).toBe(true)

    expect(onKeyDown).toHaveBeenCalledOnce()
    expect(onKeyDown.mock.calls[0]![0].defaultPrevented).toBe(false)
    expect(onClick).not.toHaveBeenCalled()
    expect(nativeClick).not.toHaveBeenCalled()
  })

  it.each(activationKeys)('honors user onKeyDown preventDefault for %j with and without a click callback', (key) => {
    for (const hasOnClick of [true, false]) {
      const onClick = vi.fn()
      const onPickerClick = vi.fn()
      const onKeyDown = vi.fn((event: unknown) => {
        ;(event as { preventDefault(): void }).preventDefault()
      })
      const rendered = render(createElement('div', { onClick: onPickerClick },
        createElement(AccessibleButton, { onKeyDown, ...(hasOnClick ? { onClick } : {}) }, 'Choose date'),
      ))
      const button = screen.getByRole('button', { name: 'Choose date' })
      const nativeClick = vi.spyOn(button, 'click')

      expect(fireEvent.keyDown(button, { key })).toBe(false)

      expect(onKeyDown).toHaveBeenCalledOnce()
      expect(onClick).not.toHaveBeenCalled()
      expect(nativeClick).not.toHaveBeenCalled()
      expect(onPickerClick).not.toHaveBeenCalled()
      rendered.unmount()
    }
  })
})
