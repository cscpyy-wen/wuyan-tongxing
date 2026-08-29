import type { ReactNode } from 'react'
import { AccessibleButton } from './AccessibleButton'

interface AccessibleRadioProps {
  checked: boolean
  children: ReactNode
  className: string
  groupName: string
  label: string
  onSelect: () => void
  value: string
}

/**
 * Keep a real radio in the light DOM on H5/Android. Taro's radio puts its
 * input inside a custom-element shadow root, which some Android WebViews
 * expose without a reliable checked state. Mini-program builds retain the
 * button-shaped control with explicit radio semantics.
 */
export function AccessibleRadio({
  checked,
  children,
  className,
  groupName,
  label,
  onSelect,
  value,
}: AccessibleRadioProps) {
  // Add an audible suffix to the selected item so the chosen value remains
  // unambiguous in WebViews that expose only a reduced accessibility mode.
  const accessibleLabel = `${label}${checked ? '，已选' : ''}`

  if (process.env.TARO_ENV === 'h5') {
    return (
      <label className={`accessible-radio ${className}`}>
        <input
          aria-label={accessibleLabel}
          checked={checked}
          className='accessible-choice-input'
          name={groupName}
          type='radio'
          value={value}
          onChange={onSelect}
        />
        {children}
      </label>
    )
  }

  return (
    <AccessibleButton
      aria-checked={checked}
      aria-label={accessibleLabel}
      className={className}
      role='radio'
      onClick={onSelect}
    >
      {children}
    </AccessibleButton>
  )
}
