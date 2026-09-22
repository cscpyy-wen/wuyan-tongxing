import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HarmonyPrivacyPolicyEntry,
  PrivacyPolicyModal,
} from '../components/PrivacyPolicyModal'
import {
  LOCAL_PRIVACY_POLICY_SECTIONS,
  LOCAL_PRIVACY_POLICY_TEXT,
} from './privacyPolicy'

vi.mock('@tarojs/components', async () => {
  const { createElement } = await import('react')
  const element = (tag: string) => ({ children, scrollY: _scrollY, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
    createElement(tag, props, children)
  )
  return {
    Button: element('button'),
    ScrollView: element('div'),
    Text: element('span'),
    View: element('div'),
  }
})

describe('Harmony local privacy policy', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('bundles a complete local-only first-release policy without placeholders or external URLs', () => {
    expect(LOCAL_PRIVACY_POLICY_SECTIONS).toHaveLength(11)
    expect(LOCAL_PRIVACY_POLICY_TEXT).toContain('cn.wuyantongxing.personal')
    expect(LOCAL_PRIVACY_POLICY_TEXT).toContain('单独同意本机处理敏感健康信息')
    expect(LOCAL_PRIVACY_POLICY_TEXT).toContain('不申请互联网')
    expect(LOCAL_PRIVACY_POLICY_TEXT).toContain('不将戒烟计划或记录上传')
    expect(LOCAL_PRIVACY_POLICY_TEXT).toContain('删除所有数据')
    expect(LOCAL_PRIVACY_POLICY_TEXT).toContain('应用详情页公示的实名认证开发者')
    expect(LOCAL_PRIVACY_POLICY_TEXT).not.toMatch(/https?:\/\//i)
    expect(LOCAL_PRIVACY_POLICY_TEXT).not.toMatch(/待填写|待确认|\[[^\]]*待/)
  })

  it('does not mount the dialog before an entry is activated', () => {
    render(createElement(PrivacyPolicyModal, { open: false, onClose: vi.fn() }))

    expect(screen.queryByRole('dialog', { name: '无烟同行隐私政策全文' })).toBeNull()
  })

  it('reports pre-consent policy activation to the owning page without mounting a dialog', () => {
    const onOpen = vi.fn()
    render(createElement(HarmonyPrivacyPolicyEntry, { placement: 'onboarding', onOpen }))

    expect(screen.getByText(/打开政策不代表同意/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '在同意前查看完整隐私政策' }))
    expect(onOpen).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: '无烟同行隐私政策全文' })).toBeNull()
  })

  it('renders and closes the controlled full policy above the native tab bar', () => {
    const onClose = vi.fn()
    render(createElement(PrivacyPolicyModal, {
      open: true,
      onClose,
      reserveNativeTabBar: true,
    }))

    const dialog = screen.getByRole('dialog', { name: '无烟同行隐私政策全文' })
    expect(dialog).toBeTruthy()
    expect(dialog.className).toContain('privacy-policy-modal--above-tabbar')
    for (const section of LOCAL_PRIVACY_POLICY_SECTIONS) {
      expect(screen.getByText(section.heading)).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('button', { name: '关闭隐私政策弹层' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps a separately labelled permanent entry callback for Profile', () => {
    const onOpen = vi.fn()
    render(createElement(HarmonyPrivacyPolicyEntry, { placement: 'profile', onOpen }))

    expect(screen.getByText('政策全文内置在本机，无需登录、联网或跳转外部网页。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看完整隐私政策' }))
    expect(onOpen).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: '无烟同行隐私政策全文' })).toBeNull()
  })
})
