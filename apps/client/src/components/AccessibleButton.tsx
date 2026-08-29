import { Button } from '@tarojs/components'
import type { ComponentProps, ComponentType } from 'react'

type AccessibleButtonProps = ComponentProps<typeof Button> & {
  role?: 'button' | 'checkbox' | 'radio' | 'switch' | 'tab'
  tabIndex?: number
  'aria-checked'?: boolean
  'aria-selected'?: boolean
  'aria-pressed'?: boolean
  'aria-disabled'?: boolean
  onKeyDown?: (event: unknown) => void
}

const SemanticButton = Button as unknown as ComponentType<AccessibleButtonProps>

/**
 * Taro mini-program buttons already support activation. These explicit H5
 * semantics keep the same interaction keyboard-operable after cross-platform
 * compilation, including custom choice-card styling.
 */
export function AccessibleButton({
  disabled,
  onClick,
  onKeyDown,
  role = 'button',
  tabIndex = 0,
  ...props
}: AccessibleButtonProps) {
  const handleKeyDown = (event: unknown) => {
    if (disabled) return
    onKeyDown?.(event)
    const keyboardEvent = event as { key?: string; preventDefault?: () => void }
    if ((keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') && onClick) {
      keyboardEvent.preventDefault?.()
      onClick(event as never)
    }
  }

  return (
    <SemanticButton
      {...props}
      {...(disabled ? { disabled: true, 'aria-disabled': true } : {})}
      role={role}
      tabIndex={disabled ? -1 : tabIndex}
      {...(onClick ? { onClick } : {})}
      onKeyDown={handleKeyDown}
    />
  )
}
