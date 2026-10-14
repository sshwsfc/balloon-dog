import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { HeaderRefreshButton } from '@/components/HeaderRefreshButton'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Check,
  CreditCard,
  Crown,
  Gift,
  Info,
  Sparkles,
  X,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import { refreshMembership, useMembership } from '@/hooks/useMembership'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import type {
  MembershipOrder,
  MembershipPlanQuote,
  MembershipTierQuotes,
  PayChannel,
  PurchasableTier,
  ReferralCoupon,
} from '@/types'

/**
 * 会员中心（`/membership`）。
 *
 * 两条硬规则：
 *  1. **价格永远以服务端返回的 `tiers` 为准**。前端只负责把 `adjustments` 讲清楚
 *     （「为什么是这个价」），本地不做任何乘法 —— 否则改一下 JS 就能一分钱开会员。
 *  2. 支付是**模拟**的（后端 `MEMBERSHIP_MOCK_PAY`）。页面上必须显著标注，
 *     不然内测家长会真的以为钱付掉了。
 */

const CHANNELS: { key: PayChannel; label: string; desc: string; className: string }[] = [
  { key: 'alipay', label: '支付宝', desc: '模拟支付，不会真扣款', className: 'bg-[#1677ff]' },
  { key: 'wechat', label: '微信支付', desc: '模拟支付，不会真扣款', className: 'bg-[#07c160]' },
]

function yuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

/** 去掉小数末尾的 0：39.00 → 39，39.90 → 39.9 */
function trimYuan(cents: number): string {
  return yuan(cents).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

function TierIcon({ tier, className }: { tier: PurchasableTier; className?: string }) {
  const Icon = tier === 'super' ? Sparkles : Crown
  return <Icon className={className} />
}

export function MembershipPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const membership = useMembership()
  const { status, tiers, entitlements, mockPay, loading, error } = membership

  // 用户点过的 tab；null 表示「跟着当前档位走」。
  // 不写成 useEffect 同步 activeTier 是因为派生状态放进 effect 会多一次渲染，
  // 而且 react-hooks/set-state-in-effect 会拦下来。
  const [tierOverride, setTierOverride] = useState<PurchasableTier | null>(null)
  const activeTier: PurchasableTier =
    tierOverride ?? (status?.tier === 'member' ? 'super' : 'member')
  const [payingPlan, setPayingPlan] = useState<MembershipPlanQuote | null>(null)
  const [channel, setChannel] = useState<PayChannel>('alipay')
  const [submitting, setSubmitting] = useState(false)
  const [orders, setOrders] = useState<MembershipOrder[]>([])
  const [ordersLoading, setOrdersLoading] = useState(true)

  // 邀请返现发的抵扣券。只在支付弹层打开时拉一次 —— 平时没必要带着这份数据。
  const [coupons, setCoupons] = useState<ReferralCoupon[]>([])
  const [couponId, setCouponId] = useState<string | null>(null)

  const loadOrders = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setOrdersLoading(true)
    try {
      const res = await api.getMembershipOrders({ pageSize: 10 })
      setOrders(res.orders ?? [])
    } catch {
      // 订单列表是辅助信息，拉不到不该把整页变成错误态
    } finally {
      setOrdersLoading(false)
    }
  }, [])

  useEffect(() => {
    // 推进微任务里再调用：loadOrders 会同步 setOrdersLoading(true)，
    // 直接在 effect 体里调会被 react-hooks/set-state-in-effect 拦下。
    // 仓库里 src/admin/hooks/useAsyncData.ts 出于同一原因也是这么处理的。
    void Promise.resolve().then(() => loadOrders())
  }, [loadOrders])

  useEffect(() => {
    if (!payingPlan) return
    // 同 loadOrders：微任务里再调，避免 effect 体内同步 setState。
    void Promise.resolve()
      .then(() => api.getReferralCoupons('unused'))
      .then((res) => setCoupons(res.items ?? []))
      .catch(() => setCoupons([]))
  }, [payingPlan])

  /** 券不能超过应付金额：服务端也是这么兜的，这里同步一次只为把数字显示对。 */
  const selectedCoupon = coupons.find((item) => item.id === couponId) ?? null
  const couponCents = payingPlan
    ? Math.min(selectedCoupon?.amountCents ?? 0, payingPlan.finalCents)
    : 0
  const payableCents = payingPlan ? Math.max(0, payingPlan.finalCents - couponCents) : 0

  /*
    受邀用户定价是**账号级**属性（是否被邀请注册），所以各档套餐的 applicable 必然一致，
    取任意一张卡上的那份即可。全部套餐都读不到时（还没加载完）就不显示说明条。
  */
  const referralInfo = useMemo(() => {
    for (const tier of tiers) {
      const found = tier.plans.find((p) => p.referral)?.referral
      if (found) return found
    }
    return null
  }, [tiers])

  const activeQuotes: MembershipTierQuotes | undefined = useMemo(
    () => tiers.find((item) => item.tier === activeTier),
    [tiers, activeTier],
  )

  const handlePay = async () => {
    if (!payingPlan || submitting) return
    setSubmitting(true)
    try {
      const created = await api.createMembershipOrder(payingPlan.code, channel, couponId ?? undefined)
      const paid = await api.payMembershipOrder(created.order.orderNo, 'success')
      await refreshMembership()
      await loadOrders({ silent: true })
      setPayingPlan(null)
      toast.success(
        t('支付成功，已开通{{v0}}', { v0: paid.order.periodLabel }),
      )
    } catch (err: unknown) {
      toast.error(toUserMessage(err, t('支付失败，请稍后重试')))
      console.error('会员支付失败：', err)
    } finally {
      setSubmitting(false)
    }
  }

  const handleAutoRenew = async (enabled: boolean) => {
    try {
      await api.setMembershipAutoRenew(enabled)
      await refreshMembership()
      toast.success(enabled ? t('已开启连续包月') : t('已关闭连续包月'))
    } catch (err: unknown) {
      toast.error(toUserMessage(err, t('操作失败，请稍后重试')))
    }
  }

  const header = (
    <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
      <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
        <ArrowLeft className="w-5 h-5" />
      </Button>
      <h1 className="text-xl font-medium text-gray-900 flex-1">{t('会员中心')}</h1>
      <HeaderRefreshButton
        onRefresh={async () => {
          await refreshMembership()
          await loadOrders({ silent: true })
        }}
      />
    </div>
  )

  if (loading && !status) {
    return (
      <div className="page-shell page-shell--center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]" />
          <p className="mt-2 text-gray-500 text-sm">{t('加载中...')}</p>
        </div>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="page-shell">
        {header}
        <div className="p-4">
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-start space-x-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-700 flex-1">
              {error ?? t('会员信息加载失败，请下拉刷新重试')}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-shell">
      {header}

      <div className="space-y-3 p-3 sm:p-4">
        {/* ── 当前状态 ───────────────────────────────────────── */}
        <Card className="overflow-hidden border-0">
          <div
            className={cn(
              'px-4 py-4 text-white',
              status.tier === 'super'
                ? 'bg-gradient-to-br from-amber-500 to-amber-600'
                : status.tier === 'member'
                  ? 'bg-gradient-to-br from-[#07c160] to-[#059c4d]'
                  : 'bg-gradient-to-br from-gray-500 to-gray-600',
            )}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                {status.tier !== 'ordinary' && <TierIcon tier={status.tier} className="w-5 h-5" />}
                <span className="text-lg font-medium">{t(status.tierLabel)}</span>
              </div>
              {status.active && status.daysLeft !== null && (
                <span className="rounded-full bg-white/20 px-2.5 py-1 text-xs">
                  {t('剩余 {{v0}} 天', { v0: status.daysLeft })}
                </span>
              )}
            </div>

            {status.active ? (
              <p className="mt-2 text-xs text-white/90">
                {status.expiresAt
                  ? t('有效期至 {{v0}}', { v0: formatDateTime(status.expiresAt) })
                  : t('长期有效')}
                {status.autoRenew && status.renewTier
                  ? t('（到期自动续费{{v0}}）', { v0: t(status.renewTier === 'super' ? '超级会员' : '会员') })
                  : ''}
              </p>
            ) : (
              <p className="mt-2 text-xs text-white/90">
                {t('开通会员解锁答题解锁、远程监控与多设备绑定')}
              </p>
            )}

            {status.totalPaidCents > 0 && (
              <p className="mt-1 text-[11px] text-white/70">
                {t('累计充值 ￥{{v0}}', { v0: trimYuan(status.totalPaidCents) })}
              </p>
            )}
          </div>

          {status.nextTier && status.nextTier.missing.length > 0 && (
            <div className="flex items-start space-x-2 border-t border-gray-100 px-4 py-3">
              <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
              <p className="flex-1 text-xs leading-relaxed text-gray-600">
                {t('升级到{{v0}}可再解锁：{{v1}}', {
                  v0: t(status.nextTier.label),
                  v1: status.nextTier.missing.map((m) => t(m.label)).join('、'),
                })}
              </p>
            </div>
          )}

          {status.active && status.renewTier && (
            <button
              type="button"
              onClick={() => handleAutoRenew(!status.autoRenew)}
              className="flex w-full items-center justify-between border-t border-gray-100 px-4 py-3 text-left active:bg-gray-50"
            >
              <div>
                <p className="text-sm text-gray-900">{t('连续包月')}</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {t('开启后到期自动续费，可随时关闭')}
                </p>
              </div>
              <span
                className={cn(
                  'relative ml-2 flex h-6 w-11 flex-shrink-0 rounded-full',
                  status.autoRenew ? 'bg-[#07c160]' : 'bg-gray-300',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
                    status.autoRenew ? 'right-0.5' : 'left-0.5',
                  )}
                />
              </span>
            </button>
          )}
        </Card>

        {mockPay && (
          <div className="flex items-start space-x-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
            <p className="flex-1 text-xs leading-relaxed text-amber-700">
              {t('当前是模拟支付环境：点「确认支付」会直接开通，不会真的扣款。')}
            </p>
          </div>
        )}

        {/*
          受邀用户定价的说明条。
          只在一个地方讲「你的价格和是否被邀请有关」：散到每张套餐卡上会变成
          六行重复的小字，而家长真正需要知道的是「为什么我的价格和别人的不一样」。
          具体上浮了多少仍然由每张卡上的规则 chip 与支付弹层负责。
        */}
        {referralInfo && (
          <div
            className={cn(
              'flex items-start space-x-2 rounded-lg border px-3 py-2',
              referralInfo.applied
                ? 'border-orange-200 bg-orange-50'
                : 'border-gray-200 bg-gray-50',
            )}
          >
            <Gift
              className={cn(
                'mt-0.5 h-4 w-4 flex-shrink-0',
                referralInfo.applied ? 'text-orange-500' : 'text-gray-400',
              )}
            />
            <div className="flex-1">
              <p
                className={cn(
                  'text-xs font-medium',
                  referralInfo.applied ? 'text-orange-700' : 'text-gray-700',
                )}
              >
                {referralInfo.applied
                  ? t('受邀用户定价已生效（本单多付 ￥{{v0}}）', {
                      v0: trimYuan(referralInfo.surchargeCents),
                    })
                  : t('受邀用户定价')}
              </p>
              <p
                className={cn(
                  'mt-0.5 text-[11px] leading-relaxed',
                  referralInfo.applied ? 'text-orange-600' : 'text-gray-500',
                )}
              >
                {t(referralInfo.reason)}
                {referralInfo.note ? ` · ${t(referralInfo.note)}` : ''}
              </p>
            </div>
          </div>
        )}

        {/* ── 选档 ───────────────────────────────────────────── */}
        <div className="flex rounded-xl bg-gray-100 p-1">
          {(['member', 'super'] as PurchasableTier[]).map((tier) => (
            <button
              key={tier}
              type="button"
              onClick={() => setTierOverride(tier)}
              className={cn(
                'flex flex-1 items-center justify-center space-x-1.5 rounded-lg py-2 text-sm transition-all',
                activeTier === tier
                  ? 'bg-white font-medium text-gray-900 shadow-sm'
                  : 'text-gray-500',
              )}
            >
              <TierIcon
                tier={tier}
                className={cn('w-4 h-4', activeTier === tier && tier === 'super' && 'text-amber-500')}
              />
              <span>{t(tier === 'super' ? '超级会员' : '会员')}</span>
            </button>
          ))}
        </div>

        {/* ── 套餐 ───────────────────────────────────────────── */}
        {activeQuotes ? (
          <div className="space-y-2">
            {activeQuotes.plans.map((plan) => {
              const isCurrent =
                status.active &&
                status.renewTier === plan.tier &&
                plan.period === 'auto_monthly' &&
                status.autoRenew
              return (
                <button
                  key={plan.code}
                  type="button"
                  onClick={() => setPayingPlan(plan)}
                  className={cn(
                    'relative w-full rounded-xl border bg-white p-4 text-left transition-all active:bg-gray-50',
                    plan.recommended ? 'border-[#07c160]' : 'border-gray-200',
                  )}
                >
                  {plan.recommended && (
                    <span className="absolute -top-2 right-3 rounded-full bg-[#07c160] px-2 py-0.5 text-[10px] text-white">
                      {t('推荐')}
                    </span>
                  )}
                  <div className="flex items-start justify-between">
                    <div className="flex-1 pr-3">
                      <p className="text-sm font-medium text-gray-900">{t(plan.name)}</p>
                      <p className="mt-0.5 text-xs text-gray-500">{t(plan.description)}</p>
                      {(plan.adjustments.length > 0 || plan.referral.applied) && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {plan.adjustments.map((adj) => (
                            <span
                              key={adj.ruleId}
                              className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700"
                            >
                              {t(adj.name)}
                              {adj.amountCents > 0
                                ? t(' -￥{{v0}}', { v0: trimYuan(adj.amountCents) })
                                : ''}
                            </span>
                          ))}
                          {/*
                            受邀加价不走 adjustments —— 那是一份「逐条相加 == 实际优惠」的
                            优惠清单，把正数混进去会让这条恒等式变成假的。所以单独列一行，
                            用灰色而不是优惠的琥珀色：它是要家长多付的，别混在优惠里。
                          */}
                          {plan.referral.applied && (
                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                              {t(plan.referral.ruleName)}
                              {t(' +￥{{v0}}', { v0: trimYuan(plan.referral.surchargeCents) })}
                            </span>
                          )}
                        </div>
                      )}
                      {isCurrent && (
                        <p className="mt-1.5 flex items-center text-[11px] text-[#07c160]">
                          <Check className="mr-0.5 h-3 w-3" />
                          {t('当前生效中')}
                        </p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-medium text-[#07c160]">
                        <span className="text-sm">￥</span>
                        {trimYuan(plan.finalCents)}
                      </p>
                      {plan.finalCents < plan.originalCents && (
                        <p className="text-xs text-gray-400 line-through">
                          ￥{trimYuan(plan.originalCents)}
                        </p>
                      )}
                      <p className="mt-0.5 text-[11px] text-gray-500">
                        {plan.period === 'auto_monthly'
                          ? t('每月自动续费')
                          : t('折合 ￥{{v0}}/月', { v0: trimYuan(plan.monthlyEquivalentCents) })}
                      </p>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        ) : (
          <Card className="p-6 text-center text-sm text-gray-500">
            {t('暂时没有可购买的套餐')}
          </Card>
        )}

        {/* ── 权益对照 ───────────────────────────────────────── */}
        <Card className="overflow-hidden">
          <div className="border-b border-gray-100 px-4 py-3">
            <p className="text-sm font-medium text-gray-900">{t('功能对照')}</p>
            <p className="mt-0.5 text-xs text-gray-500">
              {t('普通账号可用的基础管控不受影响，下面是会员专属部分。')}
            </p>
          </div>
          <div className="divide-y divide-gray-100">
            {entitlements.map((item) => {
              const unlocked = membership.has(item.key)
              return (
                <div key={item.key} className="flex items-start px-4 py-3">
                  <div className="flex-1 pr-3">
                    <p className="text-sm text-gray-900">{t(item.label)}</p>
                    <p className="mt-0.5 text-xs text-gray-500">{t(item.description)}</p>
                  </div>
                  {unlocked ? (
                    <span className="flex items-center text-xs text-[#07c160]">
                      <BadgeCheck className="mr-0.5 h-4 w-4" />
                      {t('已解锁')}
                    </span>
                  ) : (
                    <span className="flex items-center whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                      <Crown className="mr-1 h-3 w-3" />
                      {t(item.minTier === 'super' ? '超级会员' : '会员')}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </Card>

        {/* ── 充值记录 ───────────────────────────────────────── */}
        <Card className="overflow-hidden">
          <div className="border-b border-gray-100 px-4 py-3">
            <p className="text-sm font-medium text-gray-900">{t('充值记录')}</p>
          </div>
          {ordersLoading && orders.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-gray-400">{t('加载中...')}</p>
          ) : orders.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-gray-400">{t('还没有充值记录')}</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {orders.map((order) => (
                <div key={order.orderNo} className="flex items-center px-4 py-3">
                  <div className="flex-1 pr-3">
                    <p className="text-sm text-gray-900">
                      {t(order.tier === 'super' ? '超级会员' : '会员')} · {t(order.periodLabel)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-gray-400">
                      {formatDateTime(order.createdAt)} ·{' '}
                      {t(order.payChannel === 'alipay' ? '支付宝' : '微信支付')}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] text-gray-300">{order.orderNo}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-gray-900">￥{trimYuan(order.amountCents)}</p>
                    <p
                      className={cn(
                        'mt-0.5 text-[11px]',
                        order.status === 'paid'
                          ? 'text-[#07c160]'
                          : order.status === 'pending'
                            ? 'text-amber-600'
                            : 'text-gray-400',
                      )}
                    >
                      {t(
                        order.status === 'paid'
                          ? '已支付'
                          : order.status === 'pending'
                            ? '待支付'
                            : order.status === 'cancelled'
                              ? '已取消'
                              : order.status === 'expired'
                                ? '已过期'
                                : '支付失败',
                      )}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ── 模拟收银台 ─────────────────────────────────────── */}
      {payingPlan && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
          <div className="w-full max-w-md rounded-t-2xl bg-white p-4 sm:rounded-2xl">
            <div className="flex items-center justify-between">
              <p className="text-base font-medium text-gray-900">{t('确认支付')}</p>
              <button
                type="button"
                onClick={() => {
                  setPayingPlan(null)
                  setCouponId(null)
                }}
                className="p-1"
              >
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>

            <div className="mt-3 rounded-xl bg-gray-50 p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">
                  {t(payingPlan.tier === 'super' ? '超级会员' : '会员')} · {t(payingPlan.name)}
                </span>
                <span className="text-gray-900">￥{trimYuan(payingPlan.originalCents)}</span>
              </div>
              {payingPlan.adjustments.map((adj) => (
                <div key={adj.ruleId} className="mt-1.5 flex items-center justify-between text-xs">
                  <span className="text-amber-700">
                    {t(adj.name)}
                    {adj.note ? ` · ${t(adj.note)}` : ''}
                  </span>
                  <span className="text-amber-700">-￥{trimYuan(adj.amountCents)}</span>
                </div>
              ))}
              {couponCents > 0 && (
                <div className="mt-1.5 flex items-center justify-between text-xs">
                  <span className="text-amber-700">{t('优惠券抵扣')}</span>
                  <span className="text-amber-700">-￥{trimYuan(couponCents)}</span>
                </div>
              )}
              <div className="mt-2 flex items-center justify-between border-t border-gray-200 pt-2">
                <span className="text-sm text-gray-900">{t('应付金额')}</span>
                <span className="text-xl font-medium text-[#07c160]">
                  ￥{trimYuan(payableCents)}
                </span>
              </div>
            </div>

            {coupons.length > 0 && (
              <>
                <p className="mt-3 text-xs text-gray-500">
                  {t('优惠券（{{v0}} 张可用）', { v0: coupons.length })}
                </p>
                <div className="mt-1.5 max-h-40 space-y-2 overflow-y-auto">
                  {coupons.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setCouponId(couponId === item.id ? null : item.id)}
                      className={cn(
                        'flex w-full items-center rounded-xl border p-2.5 text-left',
                        couponId === item.id ? 'border-[#07c160] bg-green-50/50' : 'border-gray-200',
                      )}
                    >
                      <span className="flex h-9 w-14 shrink-0 flex-col items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-rose-500 text-white">
                        <span className="text-[9px] leading-none">￥</span>
                        <span className="text-sm font-bold leading-tight">{trimYuan(item.amountCents)}</span>
                      </span>
                      <span className="ml-3 flex-1">
                        <span className="block text-sm text-gray-900">{t('邀请返现优惠券')}</span>
                        <span className="block text-[11px] text-gray-500">
                          {item.expiresAt
                            ? t('有效期至 {{v0}}', { v0: formatDateTime(item.expiresAt) })
                            : t('长期有效')}
                        </span>
                      </span>
                      {couponId === item.id && <Check className="h-5 w-5 text-[#07c160]" />}
                    </button>
                  ))}
                </div>
              </>
            )}

            <p className="mt-3 text-xs text-gray-500">{t('支付方式')}</p>
            <div className="mt-1.5 space-y-2">
              {CHANNELS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setChannel(item.key)}
                  className={cn(
                    'flex w-full items-center rounded-xl border p-3 text-left',
                    channel === item.key ? 'border-[#07c160] bg-green-50/50' : 'border-gray-200',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-lg text-white',
                      item.className,
                    )}
                  >
                    <CreditCard className="h-4 w-4" />
                  </span>
                  <span className="ml-3 flex-1">
                    <span className="block text-sm text-gray-900">{t(item.label)}</span>
                    <span className="block text-[11px] text-gray-500">{t(item.desc)}</span>
                  </span>
                  {channel === item.key && <Check className="h-5 w-5 text-[#07c160]" />}
                </button>
              ))}
            </div>

            <Button
              className="mt-4 h-11 w-full bg-[#07c160] text-white hover:bg-[#06ad56]"
              disabled={submitting}
              onClick={handlePay}
            >
              {submitting ? t('支付中...') : t('确认支付 ￥{{v0}}', { v0: trimYuan(payableCents) })}
            </Button>
            <p className="mt-2 text-center text-[11px] text-gray-400">
              {t('开通即表示同意《会员服务协议》，虚拟商品不支持退款')}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
