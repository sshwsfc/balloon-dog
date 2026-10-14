import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useTranslation } from 'react-i18next'
import { Crown, Lock, Sparkles } from 'lucide-react'
import { useMembership } from '@/hooks/useMembership'
import { cn } from '@/lib/utils'

/**
 * 会员升级引导卡片。
 *
 * 用在「整页/整块功能归会员所有」的地方（洞察页、答题解锁页……）。
 * 为什么要有一个统一组件：这些地方原来各写各的，文案和入口五花八门，
 * 有的甚至只是 toast 一闪而过，家长根本不知道该去哪开通。
 */

const TIER_NAME: Record<string, string> = { member: '会员', super: '超级会员' }

export function MembershipGate({
  entitlementKey,
  title,
  description,
  className,
}: {
  /** 缺的权益 key，用来查需要哪一档；查不到就按超级会员写 */
  entitlementKey: string
  title?: string
  description?: string
  className?: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { requiredTierOf, isSuper } = useMembership()

  const requiredTier = requiredTierOf(entitlementKey) ?? 'super'
  const tierName = t(TIER_NAME[requiredTier])
  const Icon = requiredTier === 'super' ? Sparkles : Crown

  return (
    <div
      className={cn(
        'rounded-xl border border-amber-200 bg-gradient-to-b from-amber-50 to-white px-4 py-6 text-center',
        className,
      )}
    >
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
        <Icon className="h-6 w-6 text-amber-600" />
      </div>
      <p className="text-base font-medium text-gray-900">
        {title ?? t('「{{v0}}」专属功能', { v0: tierName })}
      </p>
      <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-gray-500">
        {description ?? t('开通{{v0}}后即可使用，随时可以取消。', { v0: tierName })}
      </p>
      {isSuper ? (
        // 已经是超级会员还走到这里，说明是「权益没解锁」以外的原因（比如后端没配好）。
        // 直接说清楚，别再劝人充值 —— 那会变成骗钱。
        <p className="mt-4 text-xs text-gray-400">{t('你的账号已解锁全部功能，请联系客服反馈。')}</p>
      ) : (
        <Button
          className="mt-4 h-9 bg-[#07c160] px-6 text-sm text-white hover:bg-[#06ad56]"
          onClick={() => navigate('/membership')}
        >
          <Crown className="mr-1.5 h-4 w-4" />
          {t('去开通{{v0}}', { v0: tierName })}
        </Button>
      )}
    </div>
  )
}

/**
 * 行内上锁提示：用在开关、按钮旁边，尺寸要小，不能喧宾夺主。
 */
export function MemberLockHint({
  entitlementKey,
  className,
}: {
  entitlementKey: string
  className?: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { has, requiredTierOf } = useMembership()
  if (has(entitlementKey)) return null

  const requiredTier = requiredTierOf(entitlementKey) ?? 'super'
  const tierName = t(TIER_NAME[requiredTier])

  return (
    <button
      type="button"
      onClick={() => navigate('/membership')}
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 active:bg-amber-100',
        className,
      )}
    >
      <Lock className="h-3 w-3" />
      {t('{{v0}}功能', { v0: tierName })}
    </button>
  )
}

/** 档位徽标：普通账号不显示，避免满屏「普通」。 */
export function MembershipBadge({ className }: { className?: string }) {
  const { t } = useTranslation()
  const { tier, isSuper } = useMembership()
  if (tier === 'ordinary') return null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        isSuper ? 'bg-amber-100 text-amber-700' : 'bg-green-50 text-[#07c160]',
        className,
      )}
    >
      {isSuper ? <Sparkles className="h-3 w-3" /> : <Crown className="h-3 w-3" />}
      {t(isSuper ? '超级会员' : '会员')}
    </span>
  )
}
