import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 全局错误边界。
 *
 * 原实现没有任何 ErrorBoundary：接口失败后页面仍继续渲染，
 * 访问 null 的 device/features 直接抛异常 → 用户看到纯白页，
 * 连「加载失败」的提示都被吞掉。这里至少给出可操作的兜底界面。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('页面渲染出错：', error, info.componentStack)
  }

  private handleReload = () => {
    this.setState({ error: null })
    window.location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center px-6">
        <div className="w-full max-w-sm text-center">
          <AlertTriangle className="w-12 h-12 text-orange-400 mx-auto mb-3" />
          <h1 className="text-lg font-medium text-gray-900">页面出了点问题</h1>
          <p className="text-sm text-gray-500 mt-2">
            我们已经记录了这个问题，你可以刷新重试。
          </p>
          <pre className="mt-4 text-left text-xs text-gray-400 bg-white rounded-lg p-3 overflow-auto max-h-32">
            {error.message}
          </pre>
          <Button className="mt-4 w-full bg-[#07c160] hover:bg-[#06a050]" onClick={this.handleReload}>
            刷新页面
          </Button>
        </div>
      </div>
    )
  }
}
