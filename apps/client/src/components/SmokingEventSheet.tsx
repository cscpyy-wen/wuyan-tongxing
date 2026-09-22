import { Picker, ScrollView, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addDays, toLocalDate } from '../lib/model'
import { runAppModal } from '../lib/modalCoordinator'
import { openSosPage } from '../lib/navigation'
import { isHarmonyApp } from '../lib/platformCapabilities'
import { registerNativeBackHandler } from '../lib/runtime'
import {
  formatSmokingTime,
  shanghaiDateTimeToIso,
  SMOKING_TIMEZONE_LABEL,
  SMOKING_TRIGGER_OPTIONS,
  toShanghaiTime,
} from '../lib/smokingLogs'
import {
  cigaretteLogAdditionConsequences,
  cigaretteLogMutationConsequences,
} from '../lib/smokingLogConsequences'
import { useAppState } from '../state/AppState'
import type { ClientCigaretteLog, CravingLevel, Trigger } from '../types'
import { AccessibleButton as Button } from './AccessibleButton'
import { AccessibleRadio } from './AccessibleRadio'
import './SmokingEventSheet.scss'

const INTENSITIES: ReadonlyArray<{ value: CravingLevel; label: string }> = [
  { value: 1, label: '很轻' },
  { value: 2, label: '较轻' },
  { value: 3, label: '明显' },
  { value: 4, label: '很强' },
  { value: 5, label: '难忍' },
]

// A rapid tap sequence can outlive the button that opened this sheet. Keep an
// invisible entry guard until no residual tap has arrived for this interval.
// 650 ms covers the 150–500 ms repeated-tap range without delaying the sheet's
// visual response; an intentional choice made after the sequence is unaffected.
const ENTRY_INPUT_QUIET_MS = 650

interface SmokingEventSheetProps {
  open: boolean
  capturedAt?: string | undefined
  editing?: ClientCigaretteLog | undefined
  allowTimeEdit?: boolean | undefined
  onClose(): void
  onSaved?(id: string, smokedAt: string): void
}

export function SmokingEventSheet({ open, capturedAt, editing, allowTimeEdit = false, onClose, onSaved }: SmokingEventSheetProps) {
  const { state, actions } = useAppState()
  const harmony = isHarmonyApp()
  const SheetPanel = harmony ? ScrollView : View
  const [trigger, setTrigger] = useState<Trigger>()
  const [intensity, setIntensity] = useState<CravingLevel>()
  const [submitting, setSubmitting] = useState(false)
  const [interactionReady, setInteractionReady] = useState(false)
  const interactionTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const initialTime = editing?.createdAt ?? capturedAt
  const canKeepDetailsEmpty = Boolean(editing
    && editing.trigger === undefined && editing.cravingIntensity === undefined)
  const detailsValid = Boolean(trigger && intensity)
    || (canKeepDetailsEmpty && trigger === undefined && intensity === undefined)
  const [smokedDate, setSmokedDate] = useState(() => initialTime ? toLocalDate(initialTime) : toLocalDate(new Date()))
  const [smokedTime, setSmokedTime] = useState(() => initialTime ? toShanghaiTime(initialTime) : toShanghaiTime(new Date()))
  const effectiveAt = useMemo(() => {
    if (!allowTimeEdit) return initialTime
    if (
      editing
      && smokedDate === toLocalDate(editing.createdAt)
      && smokedTime === toShanghaiTime(editing.createdAt)
    ) return editing.createdAt
    return shanghaiDateTimeToIso(smokedDate, smokedTime)
  }, [allowTimeEdit, editing, initialTime, smokedDate, smokedTime])

  useEffect(() => {
    if (!open) return
    setTrigger(editing?.trigger)
    setIntensity(editing?.cravingIntensity)
    if (initialTime) {
      setSmokedDate(toLocalDate(initialTime))
      setSmokedTime(toShanghaiTime(initialTime))
    }
    setSubmitting(false)
  }, [editing, initialTime, open])

  const armInteractionGuard = useCallback(() => {
    if (interactionTimerRef.current !== undefined) clearTimeout(interactionTimerRef.current)
    setInteractionReady(false)
    interactionTimerRef.current = setTimeout(() => {
      interactionTimerRef.current = undefined
      setInteractionReady(true)
    }, ENTRY_INPUT_QUIET_MS)
  }, [])

  useEffect(() => {
    if (!open) {
      if (interactionTimerRef.current !== undefined) clearTimeout(interactionTimerRef.current)
      interactionTimerRef.current = undefined
      setInteractionReady(false)
      return undefined
    }
    armInteractionGuard()
    return () => {
      if (interactionTimerRef.current !== undefined) clearTimeout(interactionTimerRef.current)
      interactionTimerRef.current = undefined
    }
  }, [armInteractionGuard, open])

  useEffect(() => {
    if (!open) return
    // Harmony's native tab-bar bridge currently replaces the active TARO-PAGE
    // when hideTabBar is called from an overlay. The sheet nodes are created,
    // then the page is detached and the user sees an empty route. Keep the
    // tab bar mounted on Harmony; the sheet itself provides the modal layer.
    const toggleTabBar = !harmony
    if (toggleTabBar) void Taro.hideTabBar({ animation: false }).catch(() => undefined)
    const unregisterBackHandler = registerNativeBackHandler(onClose)
    return () => {
      unregisterBackHandler()
      if (toggleTabBar) void Taro.showTabBar({ animation: false }).catch(() => undefined)
    }
  }, [harmony, onClose, open])

  useEffect(() => {
    // The Harmony C-API renderer exposes a lightweight Taro document, but it
    // does not provide browser DOM constructors such as HTMLElement. Focus
    // isolation is an H5-only enhancement; touching those browser globals in
    // Harmony tears down the page as soon as this sheet opens.
    if (!open || process.env.TARO_ENV !== 'h5' || typeof document === 'undefined') return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const hiddenSiblings: Array<{
      element: HTMLElement
      ariaHidden: string | null
      inert: boolean
    }> = []
    const timer = setTimeout(() => {
      const overlay = document.querySelector<HTMLElement>('.smoking-sheet')
      const parent = overlay?.parentElement
      if (overlay && parent) {
        for (const sibling of Array.from(parent.children)) {
          if (sibling === overlay || !(sibling instanceof HTMLElement)) continue
          hiddenSiblings.push({
            element: sibling,
            ariaHidden: sibling.getAttribute('aria-hidden'),
            inert: sibling.inert,
          })
          sibling.setAttribute('aria-hidden', 'true')
          sibling.inert = true
        }
      }
      document.querySelector<HTMLElement>('.smoking-sheet__close')?.focus()
    }, 0)
    return () => {
      clearTimeout(timer)
      for (const { element, ariaHidden, inert } of hiddenSiblings) {
        if (ariaHidden === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', ariaHidden)
        element.inert = inert
      }
      previouslyFocused?.focus()
    }
  }, [open])

  if (!open || !initialTime || !effectiveAt) return null

  const save = async () => {
    if (!detailsValid || submitting) return
    if (
      editing
      && effectiveAt === editing.createdAt
      && trigger === editing.trigger
      && intensity === editing.cravingIntensity
    ) {
      onClose()
      Taro.showToast({ title: '没有更改', icon: 'none' })
      return
    }
    if (new Date(effectiveAt).getTime() > Date.now() + 60_000) {
      Taro.showToast({ title: '吸烟时间不能晚于现在', icon: 'none' })
      return
    }
    setSubmitting(true)
    try {
      const consequences = editing
        ? cigaretteLogMutationConsequences(state, editing, effectiveAt)
        : cigaretteLogAdditionConsequences(state, effectiveAt)
      const related = [
        consequences.affectedCheckInCount > 0
          ? `撤销 ${consequences.affectedCheckInCount} 条受影响日期的日终确认`
          : undefined,
        consequences.linkedLapseCount > 0
          ? `同步更新 ${consequences.linkedLapseCount} 条关联复盘的时间和原因`
          : undefined,
      ].filter(Boolean)
      if (related.length > 0) {
        const confirmation = await runAppModal(() => Taro.showModal({
          title: editing ? '保存这些修改？' : '记录这支烟？',
          content: `${related.join('；')}。`,
          confirmText: editing ? '确认修改' : '确认记录',
          cancelText: editing ? '继续编辑' : '先不记录',
        }))
        if (!confirmation.confirm) {
          return
        }
      }
      const saved = editing
        ? actions.editCigarette(editing.id, {
            smokedAt: effectiveAt,
            ...(trigger && intensity ? { trigger, cravingIntensity: intensity } : {}),
          })
        : trigger && intensity
          ? actions.recordCigarette({ smokedAt: effectiveAt, trigger, cravingIntensity: intensity })
          : undefined
      const id = typeof saved === 'string' ? saved : editing?.id
      if (!saved || !id) return
      onSaved?.(id, effectiveAt)
      onClose()
      const savedLabel = editing ? '已修改' : allowTimeEdit ? '已补记' : '已记录'
      const savedTime = allowTimeEdit ? `${toLocalDate(effectiveAt)} ${formatSmokingTime(effectiveAt)}` : formatSmokingTime(effectiveAt)
      Taro.showToast({ title: `${savedLabel} · ${savedTime}`, icon: 'none', duration: 2000 })
    } catch {
      Taro.showToast({ title: '无法打开确认框，请重试', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  const openSos = () => {
    onClose()
    void openSosPage()
  }

  return (
      <View
        className={`smoking-sheet ${harmony ? 'smoking-sheet--harmony' : ''}`}
        onClick={(event) => {
          // Harmony's synthetic event currently reports the overlay as both
          // target and currentTarget for clicks originating on child buttons.
          // Keep the explicit close button there instead of treating every
          // option selection as a backdrop dismissal.
          if (!harmony && event.target === event.currentTarget) onClose()
        }}
      >
        <SheetPanel
          className={`smoking-sheet__panel ${harmony ? 'smoking-sheet__panel--harmony' : ''}`}
          role='dialog'
          aria-modal='true'
          aria-label='记录这一支烟'
          scrollY={harmony}
        >
        <View className='smoking-sheet__handle' aria-hidden='true' />
        <View className='smoking-sheet__header'>
          <View className='grow'>
            <Text className='smoking-sheet__eyebrow'>{SMOKING_TIMEZONE_LABEL} {formatSmokingTime(effectiveAt)}</Text>
            <Text className='smoking-sheet__title'>{editing ? '编辑记录' : allowTimeEdit ? '补记 1 支' : '记录 1 支'}</Text>
          </View>
          <Button className='smoking-sheet__close' aria-label='关闭吸烟记录面板' onClick={onClose}>×</Button>
        </View>

        {allowTimeEdit ? (
          <View className='smoking-time-row' aria-label='吸烟时间'>
            <Picker mode='date' value={smokedDate} start={addDays(new Date(), -90)} end={toLocalDate(new Date())} onChange={(event) => setSmokedDate(event.detail.value)}>
              <View className='smoking-time-field' aria-label={`吸烟日期 ${smokedDate}`}>{smokedDate}</View>
            </Picker>
            <Picker mode='time' value={smokedTime} onChange={(event) => setSmokedTime(event.detail.value)}>
              <View className='smoking-time-field' aria-label={`吸烟时间 ${smokedTime}`}>{smokedTime}</View>
            </Picker>
          </View>
        ) : null}

        <Text className='smoking-sheet__question'>原因</Text>
        <View className='smoking-reason-grid' role='radiogroup' aria-label='选择本次吸烟原因'>
          {SMOKING_TRIGGER_OPTIONS.map((option) => (
            <AccessibleRadio
              key={option.value}
              className={`smoking-reason ${trigger === option.value ? 'smoking-reason--active' : ''}`}
              checked={trigger === option.value}
              groupName='smoking-trigger'
              label={`吸烟原因：${option.label}`}
              value={option.value}
              onSelect={() => setTrigger(option.value)}
            >
              {option.shortLabel}
            </AccessibleRadio>
          ))}
        </View>

        <Text className='smoking-sheet__question'>烟瘾</Text>
        <View className='smoking-intensity' role='radiogroup' aria-label='选择本次烟瘾强度'>
          {INTENSITIES.map((option) => (
            <AccessibleRadio
              key={option.value}
              className={`smoking-intensity__choice ${intensity === option.value ? 'smoking-intensity__choice--active' : ''}`}
              checked={intensity === option.value}
              groupName='smoking-intensity'
              label={`烟瘾强度 ${option.value}，${option.label}`}
              value={String(option.value)}
              onSelect={() => setIntensity(option.value)}
            >
              <Text className='smoking-intensity__number'>{option.value}</Text>
              {option.value === 1 || option.value === 5 ? (
                <Text className='smoking-intensity__label'>{option.value === 1 ? '轻' : '强'}</Text>
              ) : null}
            </AccessibleRadio>
          ))}
        </View>

        <View className='smoking-sheet__actions'>
          <Button className='button smoking-sheet__save' aria-label='保存' disabled={!detailsValid || submitting} onClick={() => void save()}>
            {submitting ? '保存中…' : '保存'}
          </Button>
          {!editing && !allowTimeEdit ? <Button className='button button--ghost smoking-sheet__sos' onClick={openSos}>还没吸，先急救</Button> : null}
        </View>
        </SheetPanel>
        {!interactionReady ? (
          <View
            className='smoking-sheet__entry-guard'
            aria-hidden='true'
            onTouchStart={(event) => {
              event.stopPropagation()
              armInteractionGuard()
            }}
            onClick={(event) => {
              event.stopPropagation()
              armInteractionGuard()
            }}
          />
        ) : null}
      </View>
  )
}
