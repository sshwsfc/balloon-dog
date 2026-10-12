import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Lightbulb, X } from 'lucide-react'
import { useFeatureTip, type TipId } from '@/hooks/useFeatureTips'

/**
 * 功能小提示。
 *
 * 首次进入某个功能页时在**下方**浮出一条说明（用户的原话是「在下方有个功能小提示」），
 * 位置固定在底部导航之上；宽屏下导航变成左侧栏，所以左边要让出侧栏宽度。
 *
 * 交互刻意做得「随时可关」：
 *  - 右上角 × 立刻关掉；
 *  - 「知道了」关掉；
 *  - 两者都只关当前这一条，其它提示不受影响；
 *  - 全部提示可以在「我的 → 重置功能提示」里恢复。
 *
 * z-index 低于导航（z-50）高于页面内容，且 `pointer-events-none` 包一层、
 * 内部卡片再打开事件，这样浮层不会挡住底下的按钮。
 */
export function FeatureTip({ id, text }: { id: TipId; text: string }) {
  const { t } = useTranslation()
  const { visible, dismiss } = useFeatureTip(id)
  const [closing, setClosing] = useState(false)

  if (!visible) return null

  return (
    <div
      // 位置要跟着「当前有没有底部导航 / 侧栏」走：
      //  - 有导航时抬到导航之上（4.75rem），宽屏还要让出左侧栏的宽度；
      //  - 沉浸式页面（答题、媒体、引导）没有导航，就贴底居中，否则会平白
      //    空出一条导航的高度、并在宽屏上被 left-56 推得偏右。
      // `.has-nav` 由 App.tsx 挂在应用根节点上，这里用任意变体选择它。
      className="pointer-events-none fixed inset-x-0 bottom-4 z-40 px-3 [.has-nav_&]:bottom-[4.75rem] [.has-nav_&]:lg:bottom-6 [.has-nav_&]:lg:left-56"
      role="note"
      aria-live="polite"
    >
      <div
        className={`pointer-events-auto mx-auto flex max-w-md items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 shadow-lg transition-opacity duration-200 ${
          closing ? 'opacity-0' : 'opacity-100'
        }`}
      >
        <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-amber-900">{text}</p>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="rounded-md px-1.5 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100"
            onClick={() => {
              setClosing(true)
              dismiss()
            }}
          >
            {t('知道了')}
          </button>
          <button
            type="button"
            aria-label={t('关闭提示')}
            className="rounded-md p-0.5 text-amber-500 hover:bg-amber-100"
            onClick={() => {
              setClosing(true)
              dismiss()
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
