import { type ReactNode } from 'react'
import { Loader2, Power } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useFeatureToggle } from '@/hooks/useFeatureToggle'
import { useTranslation } from 'react-i18next'

/**
 * 功能开关的「就地开启」门禁。
 *
 * <p>为什么需要它：有一批能力（远程协助、电话短信、屏幕洞察取屏…）在服务端被
 * `requireFeatureEnabled` 拦着，开关没开就一律 400「请先开启「远程协助」功能」。
 * 开关只长在首页的开关列表里，于是家长在 `/remote-help` 点一下 → 报错 → 自己
 * 琢磨出「要去首页找那个开关」→ 回首页 → 再进来。这是一次典型的「跳来跳去」。
 *
 * <p>所以把开关搬到功能自己的页面上：没开就在原地给一张卡片，点「开启」直接
 * 调同一个接口，开完立刻渲染真实内容。首页那份开关保持不动（它管全局总览）。
 *
 * <p>开关状态的读取与开启放在 `@/hooks/useFeatureToggle`（单独成文件是因为
 * `react-refresh/only-export-components`：组件文件里导出 hook 会让 HMR 退化）。
 */

/** 未开启时那张「原地开启」的卡片。状态由调用方从 useFeatureToggle 拿到。 */
export function FeatureEnableCard({
  title,
  hint,
  enabling,
  onEnable,
}: {
  title: string
  hint: string
  enabling: boolean
  onEnable: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start gap-2">
        <Power className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-900">{title}</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-800">{hint}</p>
        </div>
      </div>
      <Button className="mt-3 w-full" disabled={enabling} onClick={onEnable}>
        {enabling ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('正在开启…')}
          </>
        ) : (
          t('开启')
        )}
      </Button>
    </div>
  )
}

export function FeatureGate({
  feature,
  title,
  hint,
  variant = 'page',
  children,
}: {
  /** 后端功能标识，见 server/src/features/devices/devices.constants.ts 的 FEATURE_DEFS */
  feature: string
  /** 未开启时的标题，一句话说清缺什么，例如「远程协助还没开启」 */
  title: string
  /** 未开启时的一句话说明：开它能干什么 */
  hint: string
  /**
   * `page`：整个页面级门禁，自己带 `px-3 pt-3` 外边距，直接放在页面根节点下。
   * `inline`：只门禁页面里的某一小块（卡片内部的一行），不带外边距，
   *           由调用方的容器负责间距。
   */
  variant?: 'page' | 'inline'
  children: ReactNode
}) {
  const { state, enabling, enable } = useFeatureToggle(feature)

  // `page` 变体带一层外边距；`inline` 变体把间距交给调用方，免得在卡片里多出一圈空白
  const frame = (node: ReactNode) =>
    variant === 'page' ? <div className="px-3 pt-3">{node}</div> : <>{node}</>

  if (state === 'loading') {
    return frame(
      <div className="flex items-center justify-center rounded-lg border border-gray-200 bg-white p-6">
        <Loader2 className="h-5 w-5 animate-spin text-[#07c160]" />
      </div>,
    )
  }

  if (state === 'off') {
    return frame(
      <FeatureEnableCard title={title} hint={hint} enabling={enabling} onEnable={() => void enable()} />,
    )
  }

  return <>{children}</>
}
