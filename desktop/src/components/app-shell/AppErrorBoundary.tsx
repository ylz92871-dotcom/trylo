import { Component, type ReactNode, type ErrorInfo } from 'react'
import { dismissStartupScreenImmediately } from '../../runtime/startup-screen'

/** Keep a recoverable screen when a renderer fails instead of leaving a white window. */
export class AppErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly error: Error | null }
> {
  override state: { readonly error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    dismissStartupScreenImmediately()
    console.error('Trylo 页面加载失败', error, info.componentStack)
  }
  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <main style={{ padding: 32, color: 'var(--fg)', background: 'var(--bg)', height: '100%' }}>
        <h2>页面加载失败</h2>
        <p>重新加载可以恢复当前工作区。</p>
        <button type="button" onClick={() => window.location.reload()}>
          重新加载
        </button>
        <details>
          <summary>查看错误详情</summary>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.error.message}</pre>
        </details>
      </main>
    )
  }
}
