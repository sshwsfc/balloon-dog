import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { MembershipGate } from '@/components/MembershipGate'
import { useMembership } from '@/hooks/useMembership'

/**
 * 「整页归会员」的包装器。
 *
 * 为什么做成包装器、而不是在每个页面里各加一段 `if (!isMember) return <Gate/>`：
 * 包装器拦在**页面组件挂载之前**，被包住的页面连一个请求都不会发。
 * 在页面内部判断的话，`useEffect` 早就跑过了，服务端会回一串 403，
 * 家长在 Network 面板里看到一屏红，我们在 console 里收到一屏日志。
 *
 * 用在路由层最自然：
 * ```tsx
 * <MemberOnlyPage entitlementKey="remoteMonitor" title="媒体">
 *   <MediaPage />
 * </MemberOnlyPage>
 * ```
 */
export function MemberOnlyPage({
  entitlementKey,
  title,
  gateTitle,
  gateDescription,
  children,
}: {
  entitlementKey: string
  /** 标题栏文字，用来在未开通时也能给出正确的页面身份 */
  title: string
  gateTitle?: string
  gateDescription?: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { isMember, loading, loaded } = useMembership()

  // 还没拉到会员状态时先给出页面骨架：直接放行会让非会员闪一下真实内容，
  // 直接拦又会把会员闪一下升级卡片，两者都难看。
  if (loading && !loaded) {
    return (
      <div className="page-shell">
        <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-xl font-medium text-gray-900 flex-1">{t(title)}</h1>
        </div>
        <div className="px-6 py-20 text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-b-2 border-[#07c160]" />
          <p className="mt-2 text-sm text-gray-500">{t('加载中...')}</p>
        </div>
      </div>
    )
  }

  if (!isMember) {
    return (
      <div className="page-shell">
        <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-xl font-medium text-gray-900 flex-1">{t(title)}</h1>
        </div>
        <div className="px-3 py-4 sm:px-4">
          <MembershipGate
            entitlementKey={entitlementKey}
            title={gateTitle}
            description={gateDescription}
          />
        </div>
      </div>
    )
  }

  return <>{children}</>
}
