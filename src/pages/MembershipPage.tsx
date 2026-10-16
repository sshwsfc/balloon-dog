import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { HeaderRefreshButton } from '@/components/HeaderRefreshButton'
import { QrBlock } from '@/components/onboarding/QrBlock'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Check,
  CreditCard,
  Crown,
  FileText,
  Info,
  QrCode,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react'
import { api, paymentsApi, toUserMessage } from '@/services/api'
import { refreshMembership, useMembership } from '@/hooks/useMembership'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import type {
  MembershipPlanQuote,
  MembershipTierQuotes,
  PaymentChannelKey,
  PaymentIntent,
  PaymentOrderView,
  PaymentsCatalog,
  PurchasableTier,
  ReferralCoupon,
} from '@/types'

/**
 * 会员中心（`/membership`）。
 *
 * 三条硬规则：
 *  1. **价格永远以服务端返回的 `tiers` 为准**。前端只负责把 `adjustments` 讲清楚
 *     （「为什么是这个价」），本地不做任何乘法 —— 否则改一下 JS 就能一分钱开会员。
 *  2. **能不能真付钱由服务端目录说了算**（`GET /api/payments/catalog`）。渠道没配就
 *     如实显示「未配置」并列出缺哪个环境变量，绝不画一个扫不出来的二维码；
 *     后端还开着模拟支付时才退化成模拟下单，而且必须显著标注「不会真的扣款」。
 *  3. 订单状态**只从服务端读**（`GET /api/payments/orders`）：家长点「我已完成支付」
 *     只是让前端重新拉一次，订单是不是已支付由渠道回调决定，前端不自己置位。
 */

/**
 * 渠道外观。**能不能用不在这里判断** —— 那是服务端目录（`catalog.channels`）的事，
 * 前端擅自认为「微信支付能用」就会画出一个扫不出来的二维码。
 */
const CHANNEL_META: Record<string, { label: string; className: string }> = {
  alipay: { label: '支付宝', className: 'bg-[#1677ff]' },
  wechat: { label: '微信支付', className: 'bg-[#07c160]' },
  fake: { label: '测试支付渠道', className: 'bg-gray-500' },
}

interface ChannelOption {
  key: PaymentChannelKey
  label: string
  className: string
  /** 服务端说这个渠道配好了 */
  configured: boolean
  missing: string[]
  note: string
}

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
  const [channel, setChannel] = useState<PaymentChannelKey>('alipay')
  const [submitting, setSubmitting] = useState(false)
  const [orders, setOrders] = useState<PaymentOrderView[]>([])
  const [ordersLoading, setOrdersLoading] = useState(true)
  /** 渠道目录（能不能真付钱、缺什么、退款窗口）。拉不到就按「都还没配」处理。 */
  const [catalog, setCatalog] = useState<PaymentsCatalog | null>(null)
  /** 已经向渠道下过单的订单 + 渠道给的预支付信息（显示二维码用） */
  const [intent, setIntent] = useState<{ orderNo: string; payment: PaymentIntent } | null>(null)
  const [refundTarget, setRefundTarget] = useState<PaymentOrderView | null>(null)
  const [refundReason, setRefundReason] = useState('')
  const [invoiceTarget, setInvoiceTarget] = useState<PaymentOrderView | null>(null)
  const [invoiceForm, setInvoiceForm] = useState({ title: '', taxNo: '', email: '' })

  // 邀请返现发的抵扣券。只在支付弹层打开时拉一次 —— 平时没必要带着这份数据。
  const [coupons, setCoupons] = useState<ReferralCoupon[]>([])
  const [couponId, setCouponId] = useState<string | null>(null)

  const loadOrders = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setOrdersLoading(true)
    try {
      // 走支付管线视图而不是会员模块的订单接口：多了退款单号 / 发票 / 能不能退，
      // 界面就不必自己按状态猜「这单现在能做什么」。
      const res = await paymentsApi.myOrders({ pageSize: 10 })
      setOrders(res.orders ?? [])
    } catch {
      // 订单列表是辅助信息，拉不到不该把整页变成错误态
    } finally {
      setOrdersLoading(false)
    }
  }, [])

  const loadCatalog = useCallback(async () => {
    try {
      setCatalog(await paymentsApi.catalog())
    } catch {
      // 目录拉不到不阻塞页面：下面 channelOptions 会是空数组，
      // 会员概览里的 mockPay 仍然决定收银台走不走模拟支付。
    }
  }, [])

  useEffect(() => {
    // 推进微任务里再调用：loadOrders 会同步 setOrdersLoading(true)，
    // 直接在 effect 体里调会被 react-hooks/set-state-in-effect 拦下。
    // 仓库里 src/admin/hooks/useAsyncData.ts 出于同一原因也是这么处理的。
    void Promise.resolve().then(() => loadOrders())
  }, [loadOrders])

  useEffect(() => {
    void Promise.resolve().then(() => loadCatalog())
  }, [loadCatalog])

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

  const activeQuotes: MembershipTierQuotes | undefined = useMemo(
    () => tiers.find((item) => item.tier === activeTier),
    [tiers, activeTier],
  )

  /**
   * 可选渠道：服务端目录里的渠道，加上测试环境才出现的假渠道。
   * 未配置的渠道**照样列出来**并标「未配置」—— 藏起来家长只会以为产品坏了。
   */
  const channelOptions: ChannelOption[] = useMemo(() => {
    const list: ChannelOption[] = (catalog?.channels ?? []).map((item) => ({
      key: item.key,
      label: CHANNEL_META[item.key]?.label ?? item.label,
      className: CHANNEL_META[item.key]?.className ?? 'bg-gray-400',
      configured: item.configured,
      missing: item.missing,
      note: item.note,
    }))
    if (catalog?.fakeAvailable && !list.some((item) => item.key === 'fake')) {
      list.push({
        key: 'fake',
        label: CHANNEL_META.fake.label,
        className: CHANNEL_META.fake.className,
        configured: true,
        missing: [],
        note: '仅测试环境：走完整的下单 / 回调 / 退款管线，但不联网、不扣款',
      })
    }
    return list
  }, [catalog])

  // 目录还没回来、或者选中的渠道消失了（例如测试环境换了配置），就退回第一个可选渠道。
  const activeChannel: ChannelOption | undefined =
    channelOptions.find((item) => item.key === channel) ?? channelOptions[0]

  /** 模拟支付：后端开着 `MEMBERSHIP_MOCK_PAY` 时，直接把订单置为已支付。 */
  const mockPayOrder = async (orderNo: string) => {
    const paid = await api.payMembershipOrder(orderNo, 'success')
    await refreshMembership()
    await loadOrders({ silent: true })
    setIntent(null)
    setPayingPlan(null)
    setCouponId(null)
    toast.success(t('支付成功，已开通{{v0}}', { v0: paid.order.periodLabel }))
  }

  const handlePay = async () => {
    if (!payingPlan || !activeChannel || submitting) return
    setSubmitting(true)
    try {
      const created = await api.createMembershipOrder(
        payingPlan.code,
        activeChannel.key,
        couponId ?? undefined,
      )
      const orderNo = created.order.orderNo

      // 渠道没配、后端还开着模拟支付：明确走模拟，不必去调渠道（调了也是 503）。
      if (catalog?.mockPay && !activeChannel.configured) {
        await mockPayOrder(orderNo)
        return
      }

      const result = await paymentsApi.createPayment(orderNo)
      if (result.payment.mode === 'mock') {
        // 渠道没配但后端允许模拟：后端已经如实标了 mock，这里跟着走模拟。
        await mockPayOrder(orderNo)
        return
      }
      // 真渠道：把渠道返回的预支付信息显示出来（二维码 / 跳转参数）。
      setIntent({ orderNo, payment: result.payment })
      await loadOrders({ silent: true })
    } catch (err: unknown) {
      toast.error(toUserMessage(err, t('支付失败，请稍后重试')))
      console.error('会员支付失败：', err)
    } finally {
      setSubmitting(false)
    }
  }

  /**
   * 「我已完成支付」：**只重新拉订单状态**，绝不自己把订单置为已支付 ——
   * 钱到没到由渠道回调（`POST /api/payments/notify/:channel`）决定。
   */
  const handleCheckPaid = async () => {
    if (!intent || submitting) return
    setSubmitting(true)
    try {
      const { order } = await paymentsApi.orderDetail(intent.orderNo)
      if (order.status === 'paid') {
        await refreshMembership()
        await loadOrders({ silent: true })
        setIntent(null)
        setPayingPlan(null)
        setCouponId(null)
        toast.success(t('支付成功，会员已开通'))
      } else {
        await loadOrders({ silent: true })
        toast.message(t('还没有收到渠道的支付结果，稍等一会儿再试'))
      }
    } catch (err: unknown) {
      toast.error(toUserMessage(err, t('查询失败，请稍后重试')))
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = async (orderNo: string) => {
    if (submitting) return
    setSubmitting(true)
    try {
      await api.cancelMembershipOrder(orderNo)
      await loadOrders({ silent: true })
      toast.success(t('订单已取消'))
    } catch (err: unknown) {
      toast.error(toUserMessage(err, t('取消失败，请稍后重试')))
    } finally {
      setSubmitting(false)
    }
  }

  const handleRefund = async () => {
    if (!refundTarget || submitting) return
    const reason = refundReason.trim()
    if (!reason) {
      toast.error(t('请填写退款原因'))
      return
    }
    setSubmitting(true)
    try {
      const res = await paymentsApi.requestRefund(refundTarget.orderNo, reason)
      await refreshMembership()
      await loadOrders({ silent: true })
      setRefundTarget(null)
      setRefundReason('')
      toast.success(
        res.membershipRevoked ? t('已退款，这单开通的会员已收回') : t('已提交退款，退款单号见订单'),
      )
    } catch (err: unknown) {
      toast.error(toUserMessage(err, t('退款失败，请稍后重试')))
    } finally {
      setSubmitting(false)
    }
  }

  const handleInvoice = async () => {
    if (!invoiceTarget || submitting) return
    const title = invoiceForm.title.trim()
    const email = invoiceForm.email.trim()
    if (!title) {
      toast.error(t('请填写发票抬头'))
      return
    }
    if (!email) {
      toast.error(t('请填写接收发票的邮箱'))
      return
    }
    setSubmitting(true)
    try {
      await paymentsApi.requestInvoice({
        orderNo: invoiceTarget.orderNo,
        title,
        email,
        ...(invoiceForm.taxNo.trim() ? { taxNo: invoiceForm.taxNo.trim() } : {}),
      })
      await loadOrders({ silent: true })
      setInvoiceTarget(null)
      setInvoiceForm({ title: '', taxNo: '', email: '' })
      toast.success(t('开票申请已提交，我们会尽快处理'))
    } catch (err: unknown) {
      toast.error(toUserMessage(err, t('提交失败，请稍后重试')))
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

        {/* 渠道实况。文案直接来自服务端目录：『已配置的渠道：微信支付』或者
            『还没有配置微信支付或支付宝…』—— 家长端唯一能知道「到底能不能真付钱」
            的地方，所以不能由前端编，也不能只在控制台里说。 */}
        {catalog?.notice && (
          <div className="flex items-start space-x-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-500" />
            <div className="flex-1">
              <p className="text-xs leading-relaxed text-gray-600">{t(catalog.notice)}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {channelOptions.map((item) => (
                  <span
                    key={item.key}
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[10px]',
                      item.configured
                        ? 'bg-green-50 text-[#07c160]'
                        : 'bg-amber-50 text-amber-700',
                    )}
                  >
                    {t(item.label)}
                    {item.configured ? '' : ` · ${t('未配置')}`}
                  </span>
                ))}
              </div>
              {catalog.available.length === 0 && catalog.mockPay && (
                <p className="mt-1 text-xs leading-relaxed text-amber-700">
                  {t('下面列出的渠道都还没有配置，只能先把流程跑通。')}
                </p>
              )}
            </div>
          </div>
        )}

        {mockPay && (
          <div className="flex items-start space-x-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
            <p className="flex-1 text-xs leading-relaxed text-amber-700">
              {t('当前是模拟支付环境：点「确认支付」会直接开通，不会真的扣款。')}
            </p>
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
                      {plan.adjustments.length > 0 && (
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
            <p className="mt-0.5 text-xs text-gray-500">
              {t('支付后 {{v0}} 天内可以自助退款；已经申请发票的订单要先冲红，请联系客服。', {
                v0: catalog?.refundWindowDays ?? 7,
              })}
            </p>
          </div>
          {ordersLoading && orders.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-gray-400">{t('加载中...')}</p>
          ) : orders.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-gray-400">{t('还没有充值记录')}</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {orders.map((order) => (
                <div key={order.orderNo} className="px-4 py-3">
                  <div className="flex items-center">
                    <div className="flex-1 pr-3">
                      <p className="text-sm text-gray-900">
                        {t(order.tier === 'super' ? '超级会员' : '会员')} · {t(order.periodLabel)}
                      </p>
                      <p className="mt-0.5 text-[11px] text-gray-400">
                        {formatDateTime(order.createdAt)} · {t(order.payChannelLabel)}
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] text-gray-300">{order.orderNo}</p>
                      {order.refundNo && (
                        <p className="mt-0.5 font-mono text-[10px] text-gray-300">
                          {t('退款单号')} {order.refundNo}
                        </p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-gray-900">￥{trimYuan(order.amountCents)}</p>
                      {/* 状态文案由服务端给（订单状态机只有一处定义），这里只上色 */}
                      <p
                        className={cn(
                          'mt-0.5 text-[11px]',
                          order.status === 'paid'
                            ? 'text-[#07c160]'
                            : order.status === 'pending' || order.status === 'refunding'
                              ? 'text-amber-600'
                              : 'text-gray-400',
                        )}
                      >
                        {t(order.statusLabel)}
                      </p>
                      {order.invoice && (
                        <p className="mt-0.5 text-[10px] text-gray-400">
                          {t('发票')} · {t(order.invoice.statusLabel)}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* 这一单能做什么由服务端算（canPay / canRefund / 发票状态），
                      前端不按状态自己猜 —— 猜错就是「按钮在但点了报错」。 */}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {order.canPay && (
                      <button
                        type="button"
                        onClick={() => void handleCancel(order.orderNo)}
                        className="rounded-lg border border-gray-200 px-2.5 py-1 text-[11px] text-gray-600 active:bg-gray-50"
                      >
                        {t('取消订单')}
                      </button>
                    )}
                    {order.canRefund && (
                      <button
                        type="button"
                        onClick={() => {
                          setRefundTarget(order)
                          setRefundReason('')
                        }}
                        className="flex items-center rounded-lg border border-gray-200 px-2.5 py-1 text-[11px] text-gray-600 active:bg-gray-50"
                      >
                        <RotateCcw className="mr-1 h-3 w-3" />
                        {t('申请退款')}
                      </button>
                    )}
                    {order.status === 'paid' && !order.invoice && (
                      <button
                        type="button"
                        onClick={() => {
                          setInvoiceTarget(order)
                          setInvoiceForm({ title: '', taxNo: '', email: '' })
                        }}
                        className="flex items-center rounded-lg border border-gray-200 px-2.5 py-1 text-[11px] text-gray-600 active:bg-gray-50"
                      >
                        <FileText className="mr-1 h-3 w-3" />
                        {t('申请开票')}
                      </button>
                    )}
                    {order.status === 'refunding' && (
                      <span className="text-[11px] text-amber-600">
                        {t('退款处理中：渠道确认后到账（未收到会自动重试）')}
                      </span>
                    )}
                    {order.status === 'paid' && order.invoice?.status === 'pending' && (
                      <span className="text-[11px] text-amber-600">
                        {t('发票处理中：这段时间不能自助退款')}
                      </span>
                    )}
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

            {/* 渠道列表来自服务端目录：没配的也列出来并写明缺哪个环境变量，
                但模拟支付也关掉时直接不可选 —— 点了只会拿到 503。 */}
            <p className="mt-3 text-xs text-gray-500">{t('支付方式')}</p>
            <div className="mt-1.5 space-y-2">
              {channelOptions.map((item) => {
                const disabled = !item.configured && !catalog?.mockPay
                const selected = activeChannel?.key === item.key
                return (
                  <button
                    key={item.key}
                    type="button"
                    disabled={disabled}
                    onClick={() => setChannel(item.key)}
                    className={cn(
                      'flex w-full items-center rounded-xl border p-3 text-left',
                      selected ? 'border-[#07c160] bg-green-50/50' : 'border-gray-200',
                      disabled && 'opacity-50',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded-lg text-white',
                        item.className,
                      )}
                    >
                      {item.key === 'fake' ? (
                        <QrCode className="h-4 w-4" />
                      ) : (
                        <CreditCard className="h-4 w-4" />
                      )}
                    </span>
                    <span className="ml-3 flex-1">
                      <span className="block text-sm text-gray-900">
                        {t(item.label)}
                        {!item.configured && (
                          <span className="ml-1 text-[11px] text-amber-700">{t('未配置')}</span>
                        )}
                      </span>
                      <span className="block text-[11px] text-gray-500">
                        {item.configured
                          ? item.note
                            ? t(item.note)
                            : t('真实渠道：扫码或唤起 App 完成支付')
                          : t('缺少：{{v0}}', { v0: item.missing.join('、') || '—' })}
                      </span>
                    </span>
                    {selected && <Check className="h-5 w-5 text-[#07c160]" />}
                  </button>
                )
              })}
            </div>

            {intent ? (
              /* 渠道已经下单，这里有二维码 / 跳转参数。**不在这里宣布成功**：
                 点「我已完成支付」只是去核一次订单状态，钱到没到由渠道回调说了算。 */
              <div className="mt-3 rounded-xl border border-gray-200 p-3">
                <p className="flex items-center text-sm text-gray-900">
                  <QrCode className="mr-1.5 h-4 w-4 text-[#07c160]" />
                  {t('用{{v0}}完成支付', { v0: t(intent.payment.channelLabel) })}
                </p>
                {intent.payment.codeUrl && (
                  <div className="mt-2">
                    <QrBlock value={intent.payment.codeUrl} caption="扫码支付" size={176} />
                  </div>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
                  {t('支付完成后点下面的按钮核对结果。订单状态以渠道回调为准，没收到回调时不会开通。')}
                </p>
                <Button
                  className="mt-3 h-10 w-full bg-[#07c160] text-white hover:bg-[#06ad56]"
                  disabled={submitting}
                  onClick={handleCheckPaid}
                >
                  {submitting ? t('查询中...') : t('我已完成支付')}
                </Button>
              </div>
            ) : (
              <Button
                className="mt-4 h-11 w-full bg-[#07c160] text-white hover:bg-[#06ad56]"
                disabled={submitting}
                onClick={handlePay}
              >
                {submitting ? t('支付中...') : t('确认支付 ￥{{v0}}', { v0: trimYuan(payableCents) })}
              </Button>
            )}
            <p className="mt-2 text-center text-[11px] text-gray-400">
              {t('开通即表示同意《会员服务协议》，虚拟商品不支持退款')}
            </p>
          </div>
        </div>
      )}

      {/* ── 申请退款 ───────────────────────────────────────── */}
      {refundTarget && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
          <div className="w-full max-w-md rounded-t-2xl bg-white p-4 sm:rounded-2xl">
            <p className="text-base font-medium text-gray-900">{t('申请退款')}</p>
            <p className="mt-1 text-xs text-gray-500">
              {t('订单 {{v0}}，可退 ￥{{v1}}', {
                v0: refundTarget.orderNo,
                v1: trimYuan(refundTarget.amountCents),
              })}
            </p>
            <textarea
              value={refundReason}
              onChange={(event) => setRefundReason(event.target.value)}
              rows={3}
              maxLength={200}
              placeholder={t('请说明退款原因（客服会看到）')}
              className="mt-3 w-full rounded-xl border border-gray-200 p-3 text-sm focus:border-[#07c160] focus:outline-none"
            />
            <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
              {t('退款成功后，这笔订单开通的会员会被收回；已经使用的权益不折算。')}
            </p>
            <div className="mt-3 flex space-x-2">
              <Button
                variant="outline"
                className="h-11 flex-1"
                disabled={submitting}
                onClick={() => {
                  setRefundTarget(null)
                  setRefundReason('')
                }}
              >
                {t('再想想')}
              </Button>
              <Button
                className="h-11 flex-1 bg-[#07c160] text-white hover:bg-[#06ad56]"
                disabled={submitting}
                onClick={handleRefund}
              >
                {submitting ? t('提交中...') : t('确认退款')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── 申请开票 ───────────────────────────────────────── */}
      {invoiceTarget && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
          <div className="w-full max-w-md rounded-t-2xl bg-white p-4 sm:rounded-2xl">
            <p className="text-base font-medium text-gray-900">{t('申请开票')}</p>
            <p className="mt-1 text-xs text-gray-500">
              {t('订单 {{v0}}，开票金额 ￥{{v1}}', {
                v0: invoiceTarget.orderNo,
                v1: trimYuan(invoiceTarget.amountCents),
              })}
            </p>
            <div className="mt-3 space-y-2">
              <input
                value={invoiceForm.title}
                onChange={(event) =>
                  setInvoiceForm((prev) => ({ ...prev, title: event.target.value }))
                }
                placeholder={t('发票抬头（个人姓名或公司名称）')}
                className="w-full rounded-xl border border-gray-200 p-3 text-sm focus:border-[#07c160] focus:outline-none"
              />
              <input
                value={invoiceForm.taxNo}
                onChange={(event) =>
                  setInvoiceForm((prev) => ({ ...prev, taxNo: event.target.value }))
                }
                placeholder={t('公司税号（公司抬头必填）')}
                className="w-full rounded-xl border border-gray-200 p-3 text-sm focus:border-[#07c160] focus:outline-none"
              />
              <input
                value={invoiceForm.email}
                onChange={(event) =>
                  setInvoiceForm((prev) => ({ ...prev, email: event.target.value }))
                }
                placeholder={t('接收发票的邮箱')}
                className="w-full rounded-xl border border-gray-200 p-3 text-sm focus:border-[#07c160] focus:outline-none"
              />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
              {t('提交后由人工开具；开票期间这张订单不能自助退款，需要先冲红。')}
            </p>
            <div className="mt-3 flex space-x-2">
              <Button
                variant="outline"
                className="h-11 flex-1"
                disabled={submitting}
                onClick={() => setInvoiceTarget(null)}
              >
                {t('取消')}
              </Button>
              <Button
                className="h-11 flex-1 bg-[#07c160] text-white hover:bg-[#06ad56]"
                disabled={submitting}
                onClick={handleInvoice}
              >
                {submitting ? t('提交中...') : t('提交申请')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
