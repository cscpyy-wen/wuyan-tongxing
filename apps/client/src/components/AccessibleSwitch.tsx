import { Switch } from '@tarojs/components'

interface AccessibleSwitchProps {
  checked: boolean
  disabled?: boolean
  label: string
  onChange(checked: boolean): void
}

/**
 * Android/H5 keeps a real light-DOM checkbox as the 58 x 44 accessibility and
 * hit-test node. The visual track is presentation-only. WeChat retains its
 * native Switch so the mini-program does not emulate a platform control.
 */
export function AccessibleSwitch({ checked, disabled = false, label, onChange }: AccessibleSwitchProps) {
  if (process.env.TARO_ENV === 'h5') {
    return (
      <label className={`accessible-switch ${disabled ? 'accessible-switch--disabled' : ''}`}>
        <input
          aria-label={label}
          checked={checked}
          className='accessible-switch__input'
          disabled={disabled}
          type='checkbox'
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span className='accessible-switch__track' aria-hidden='true' />
      </label>
    )
  }

  return (
    <Switch
      checked={checked}
      className='setting-switch'
      color='#176B55'
      disabled={disabled}
      aria-label={label}
      nativeProps={{ 'aria-checked': checked, 'aria-label': label }}
      onChange={(event) => onChange(event.detail.value)}
    />
  )
}
