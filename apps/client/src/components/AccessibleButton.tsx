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
  // The Harmony C-API Button host applies enabled/clickable changes but can
  // retain the previous class-derived visual style until the node is mounted
  // again. Include every dynamic semantic/style input in a Harmony-only key so
  // React replaces the native node when those inputs change.
  const harmonyRefreshKey = process.env.TARO_ENV === 'harmony_cpp'
    ? [
        role,
        disabled ? 'disabled' : 'enabled',
        String(props.className ?? ''),
        String(props['aria-checked'] ?? ''),
        String(props['aria-selected'] ?? ''),
        String(props['aria-pressed'] ?? ''),
      ].join('|')
    : undefined

  const handleKeyDown = (event: unknown) => {
    if (disabled) return
    onKeyDown?.(event)
    const keyboardEvent = event as { key?: string; defaultPrevented?: boolean; preventDefault?: () => void; currentTarget?: { click?: () => void }; target?: { click?: () => void } }
    if (!keyboardEvent.defaultPrevented && (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ')) {
      keyboardEvent.preventDefault?.()
      if (onClick) onClick(event as never)
      // A Picker handles the bubbling click on its own host. Its child button
      // still needs native-like keyboard activation even without an onClick prop.
      else (keyboardEvent.currentTarget ?? keyboardEvent.target)?.click?.()
    }
  }

  return (
    <SemanticButton
      {...(harmonyRefreshKey ? { key: harmonyRefreshKey } : {})}
      {...props}
      {...(disabled ? { disabled: true, 'aria-disabled': true } : {})}
      role={role}
      tabIndex={disabled ? -1 : tabIndex}
      {...(onClick ? { onClick } : {})}
      onKeyDown={handleKeyDown}
    />
  )
}
