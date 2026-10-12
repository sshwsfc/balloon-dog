import { useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

/**
 * 标题栏右上角的刷新按钮。
 *
 * 为什么要有这个组件：家长端的十来个页面标题栏里都有一个刷新图标，
 * 但刷新是 `silent` 的 —— 各页面刻意不翻 `loading`，免得整页闪一次骨架屏。
 * 结果就是**点下去什么反馈都没有**，家长不确定到底刷没刷。
 * 这个组件自己持有「正在刷新」的状态，把图标转起来。
 *
 * 两条约定：
 * 1. 转圈跟着 `onRefresh()` 返回的 Promise 走，接口慢就多转一会儿；
 * 2. 接口太快也要转满 `MIN_SPIN_MS`，否则一闪而过，等于没反馈。
 */
const MIN_SPIN_MS = 600

export function HeaderRefreshButton({
  onRefresh,
  disabled,
  className,
}: {
  /** 刷新动作。返回 Promise 时，转圈会一直持续到它 resolve/reject。 */
  onRefresh: () => void | Promise<unknown>
  disabled?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const [spinning, setSpinning] = useState(false)
  // 用 ref 而不是 state 挡重复点击：state 更新是异步的，连点两下会漏过一次
  const busyRef = useRef(false)

  const handleClick = () => {
    if (busyRef.current) return
    busyRef.current = true
    setSpinning(true)
    const startedAt = Date.now()
    void (async () => {
      try {
        await onRefresh()
      } catch {
        // 各页面自己会 toast 错误，这里只负责别让图标永远转下去
      } finally {
        const rest = MIN_SPIN_MS - (Date.now() - startedAt)
        if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest))
        busyRef.current = false
        setSpinning(false)
      }
    })()
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleClick}
      disabled={disabled || spinning}
      // `h-7 w-7` + `[&_svg]:size-5` 是为了跟改之前那个 28px 的纯 <button>
      // 保持一模一样的占位：Button 的 size="icon" 默认是 36px 高，会把
      // 所有 17 个页面的标题栏整体撑高 8px。`[&_svg]:size-5` 则是因为
      // Button 基础类里的 `[&_svg]:size-4` 比 `w-5 h-5` 优先级高，
      // 不显式覆盖的话图标会从 20px 缩成 16px（靠 twMerge 后者胜出）。
      className={`h-7 w-7 [&_svg]:size-5${className ? ` ${className}` : ''}`}
      aria-label={t('刷新')}
      aria-busy={spinning}
    >
      <RefreshCw className={`w-5 h-5 text-gray-400${spinning ? ' animate-spin' : ''}`} />
    </Button>
  )
}
