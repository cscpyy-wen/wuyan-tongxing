import { Text, View } from '@tarojs/components'
import { Component, type ErrorInfo, type PropsWithChildren } from 'react'
import { AccessibleButton as Button } from './AccessibleButton'
import { dismissAndroidBootstrap } from '../lib/androidBootstrap'
import { openSosPage } from '../lib/navigation'

interface AppErrorBoundaryState {
  failed: boolean
}

/**
 * Last-resort local recovery surface. It deliberately sends no error payload:
 * rendered state may be health information and must not become telemetry.
 */
export class AppErrorBoundary extends Component<PropsWithChildren, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // No remote logging in the local-only candidate.
    // This boundary sits outside AppStateProvider. If a child fails before its
    // effects commit, it is the only owner able to release the native startup
    // surface and make this local fallback focusable.
    dismissAndroidBootstrap()
  }

  private retry = () => this.setState({ failed: false })

  private openSos = () => {
    this.setState({ failed: false }, () => void openSosPage())
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <View className='screen screen--detail app-error'>
        <Text className='eyebrow'>本地错误恢复</Text>
        <Text className='page-title'>页面暂时没有正常打开</Text>
        <Text className='page-subtitle'>你的本机记录不会因此被删除，也不会自动上传错误内容。可以重试，或先进入离线烟瘾急救。</Text>
        <View className='card stack app-error__actions' role='alert'>
          <Button className='button' onClick={this.retry}>重试当前页面</Button>
          <Button className='button button--secondary' onClick={this.openSos}>打开离线烟瘾急救</Button>
        </View>
      </View>
    )
  }
}
