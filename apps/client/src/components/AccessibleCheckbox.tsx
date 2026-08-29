import type { ReactNode } from 'react'
import { AccessibleButton } from './AccessibleButton'

interface AccessibleCheckboxProps {
  checked: boolean
  children: ReactNode
  className: string
  label: string
  onToggle: () => void
  value: string
}

/**
 * Keep one real checkbox in the H5/Android light DOM as both the full-size
 * touch target and the accessibility node. Mini-program builds retain the
 * button-shaped control with explicit checkbox semantics.
 */
export function AccessibleCheckbox({
  checked,
  children,
  className,
  label,
  onToggle,
  value,
}: AccessibleCheckboxProps) {
  const accessibleLabel = `${label}，${checked ? '已选' : '未选'}`

  if (process.env.TARO_ENV === 'h5') {
    return (
      <label className={`accessible-checkbox ${className}`}>
        <input
          aria-label={accessibleLabel}
          checked={checked}
          className='accessible-choice-input'
          type='checkbox'
          value={value}
          onChange={onToggle}
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
      role='checkbox'
      onClick={onToggle}
    >
      {children}
    </AccessibleButton>
  )
}
