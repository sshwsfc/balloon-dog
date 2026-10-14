import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { HeaderRefreshButton } from '@/components/HeaderRefreshButton'
import { QrBlock } from '@/components/onboarding/QrBlock'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  CheckCircle2,
  Copy,
  Crown,
  Gift,
  Info,
  Loader2,
  QrCode,
  Share2,
  Ticket,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import type {
  ReferralCoupon,
  ReferralInvitee,
  ReferralOverview,
  ReferralReward,
  ReferralWithdrawal,
  WithdrawChannel,
} from '@/types'

/**
 * 分享提成（`/referral`）。
 *
 * 几处刻意与参考截图不同，都是为了让家长少问客服：
 *  1. 截图把「提现」放在总收益旁边，点下去才知道自己不满足条件。这里把**提现门槛
 *     做成一张可见的清单**（哪条已达成、当前值是多少），家长一眼看得见差在哪。
 *  2. 截图的分享只能「点一下跳微信」。纯网页没有微信 JS-SDK 授权时那是不可能的，
 *     与其做一个点了没反应的按钮，不如给**二维码 + 复制邀请文案**两条真正能用的路径。
 *  3. 阶梯比例做成**当前档位高亮 + 还差几人到下一档**。截图只是一段文字说明，
 *     家长算不出来「我现在是几档」。
 *
 * 金额一律以「分」从服务端取，前端只做展示换算。
 */

const TABS = [
  { key: 'invitees', label: '邀请记录' },
  { key: 'rewards', label: '返现明细' },
  { key: 'withdrawals', label: '提现记录' },
  { key: 'coupons', label: '我的优惠券' },
] as const

type TabKey = (typeof TABS)[number]['key']

function yuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

/** 去掉小数末尾的 0：¥50.00 → ¥50，¥11.25 → ¥11.25 */
function trimYuan(cents: number): string {
  return yuan(cents).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 继续走下面的兜底：非安全上下文（http 局域网）下 clipboard 会被浏览器拒绝
  }
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}

export function ReferralPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [overview, setOverview] = useState<ReferralOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const [tab, setTab] = useState<TabKey>('invitees')
  const [invitees, setInvitees] = useState<ReferralInvitee[]>([])
  const [rewards, setRewards] = useState<ReferralReward[]>([])
  const [withdrawals, setWithdrawals] = useState<ReferralWithdrawal[]>([])
  const [coupons, setCoupons] = useState<ReferralCoupon[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [couponFilter, setCouponFilter] = useState<'all' | 'unused' | 'used' | 'expired'>('all')

  const [qrOpen, setQrOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [withdrawOpen, setWithdrawOpen] = useState(false)

  const shareUrl = useMemo(
    () => (overview ? `${window.location.origin}${overview.linkPath}` : ''),
    [overview],
  )

  const loadOverview = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true)
    try {
      const data = await api.getReferral()
      setOverview(data)
      setError('')
    } catch (err: unknown) {
      setError(toUserMessage(err, t('邀请返现加载失败，请稍后重试')))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [t])

  const loadList = useCallback(
    async (key: TabKey) => {
      setListLoading(true)
      try {
        if (key === 'invitees') {
          const res = await api.getReferralInvitees({ pageSize: 50 })
          setInvitees(res.items ?? [])
        } else if (key === 'rewards') {
          const res = await api.getReferralRewards({ pageSize: 50 })
          setRewards(res.items ?? [])
        } else if (key === 'withdrawals') {
          const res = await api.getReferralWithdrawals({ pageSize: 50 })
          setWithdrawals(res.items ?? [])
        } else {
          const res = await api.getReferralCoupons(couponFilter)
          setCoupons(res.items ?? [])
        }
      } catch (err: unknown) {
        toast.error(toUserMessage(err, t('列表加载失败，请稍后重试')))
      } finally {
        setListLoading(false)
      }
    },
    [couponFilter, t],
  )

  useEffect(() => {
    // 推进微任务：load* 会同步 setLoading(true)，直接在 effect 体里调会被
    // react-hooks/set-state-in-effect 拦下（仓库里 useAsyncData 同样这么处理）。
    void Promise.resolve().then(() => loadOverview())
  }, [loadOverview])

  useEffect(() => {
    void Promise.resolve().then(() => loadList(tab))
  }, [loadList, tab])

  const handleRefresh = () => {
    setRefreshing(true)
    void loadOverview({ silent: true })
    void loadList(tab)
  }

  const handleCopy = async (text: string, message: string) => {
    const ok = await copyText(text)
    if (ok) toast.success(message)
    else toast.error(t('复制失败，请长按输入框手动复制'))
  }

  const handleShare = async (channel: 'wechat' | 'moments') => {
    const text = t('{{v0}}\n{{v1}}\n{{v2}}', {
      v0: overview?.config.title ?? t('邀请新用户，返现 50%'),
      v1: overview?.config.subtitle ?? '',
      v2: shareUrl,
    })
    const ok = await copyText(text)
    if (!ok) {
      toast.error(t('复制失败，请长按输入框手动复制'))
      return
    }
    toast.success(
      channel === 'wechat'
        ? t('邀请文案已复制，去微信粘贴发给好友')
        : t('邀请文案已复制，去微信粘贴发朋友圈'),
    )
  }

  // ---------------- 提现 ----------------

  const [channel, setChannel] = useState<WithdrawChannel>('alipay')
  const [account, setAccount] = useState('')
  const [amountInput, setAmountInput] = useState('')
  const [realName, setRealName] = useState('')
  const [idCard, setIdCard] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const openWithdraw = () => {
    if (!overview) return
    setAmountInput(yuan(overview.withdraw.availableCents))
    setRealName(overview.identity.realName)
    setWithdrawOpen(true)
  }

  const handleVerify = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      await api.verifyReferralIdentity(realName.trim(), idCard.trim())
      toast.success(t('实名认证成功'))
      setIdCard('')
      await loadOverview({ silent: true })
    } catch (err: unknown) {
      toast.error(toUserMessage(err, t('实名认证失败，请检查后重试')))
    } finally {
      setSubmitting(false)
    }
  }

  const handleWithdraw = async () => {
    if (submitting) return
    const amountCents = Math.round(Number(amountInput) * 100)
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      toast.error(t('请输入正确的提现金额'))
      return
    }
    if (!account.trim()) {
      toast.error(t('请填写收款账号'))
      return
    }
    setSubmitting(true)
    try {
      await api.requestReferralWithdrawal({ amountCents, channel, account: account.trim() })
      toast.success(t('提现申请已提交，审核通过后 7 个工作日内到账'))
      setWithdrawOpen(false)
      setAccount('')
      await loadOverview({ silent: true })
      setTab('withdrawals')
      await loadList('withdrawals')
    } catch (err: unknown) {
      toast.error(toUserMessage(err, t('提现申请失败，请稍后重试')))
    } finally {
      setSubmitting(false)
    }
  }

  // ---------------- 渲染 ----------------

  if (loading && !overview) {
    return (
      <div className="page-shell page-shell--center">
        <div className="flex flex-col items-center text-gray-400">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="mt-3 text-sm">{t('加载中…')}</p>
        </div>
      </div>
    )
  }

  if (error && !overview) {
    return (
      <div className="page-shell page-shell--center">
        <div className="flex flex-col items-center px-8 text-center">
          <AlertTriangle className="h-8 w-8 text-amber-500" />
          <p className="mt-3 text-sm text-gray-600">{error}</p>
          <Button className="mt-4" onClick={handleRefresh}>
            {t('重新加载')}
          </Button>
        </div>
      </div>
    )
  }

  if (!overview) return null

  const { stats, config, withdraw, identity } = overview

  return (
    <div className="page-shell">
      <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="mr-2 rounded-full p-1.5 hover:bg-gray-100 active:bg-gray-200"
          aria-label={t('返回')}
        >
          <ArrowLeft className="h-5 w-5 text-gray-700" />
        </button>
        <h1 className="flex-1 text-base font-medium text-gray-900">{t('邀请返现')}</h1>
        <HeaderRefreshButton onRefresh={handleRefresh} disabled={refreshing} />
      </div>

      {/* ---------- 活动标题 ---------- */}
      <div className="px-3 pt-3">
        <div className="rounded-2xl bg-gradient-to-br from-orange-500 via-orange-500 to-rose-500 px-4 py-5 text-white shadow-sm">
          <div className="flex items-center gap-2">
            <Gift className="h-5 w-5" />
            <h2 className="text-lg font-semibold">{t(config.title)}</h2>
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-white/85">{t(config.subtitle)}</p>
          <div className="mt-4 flex items-center gap-3 rounded-xl bg-white/15 px-3 py-2.5">
            <div className="flex-1">
              <p className="text-[11px] text-white/70">{t('我的邀请码')}</p>
              <p className="font-mono text-xl font-bold tracking-[0.2em]">{overview.inviteCode}</p>
            </div>
            <button
              type="button"
              className="rounded-lg bg-white/20 px-3 py-2 text-xs font-medium active:bg-white/30"
              onClick={() => handleCopy(overview.inviteCode, t('邀请码已复制'))}
            >
              {t('复制')}
            </button>
          </div>
        </div>
      </div>

      {/* ---------- 邀请链接与分享 ---------- */}
      <div className="px-3 pt-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-gray-500">{t('邀请链接')}</p>
            <div className="mt-2 flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2.5 ring-1 ring-gray-200">
              <span className="min-w-0 flex-1 truncate text-[12px] text-gray-600">{shareUrl}</span>
              <button
                type="button"
                className="shrink-0 rounded-lg bg-[#07c160] p-1.5 text-white active:bg-[#06ad56]"
                onClick={() => handleCopy(shareUrl, t('邀请链接已复制'))}
                aria-label={t('复制邀请链接')}
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
              {t('复制链接发送给好友，对方点击后直接跳转注册页，注册时自动带上你的邀请码')}
            </p>

            <div className="mt-4 grid grid-cols-3 gap-3">
              <button
                type="button"
                className="flex flex-col items-center gap-2 rounded-xl bg-gray-50 py-3 active:bg-gray-100"
                onClick={() => handleShare('wechat')}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#07c160] text-white">
                  <Share2 className="h-5 w-5" />
                </span>
                <span className="text-[11px] text-gray-600">{t('分享微信')}</span>
              </button>
              <button
                type="button"
                className="flex flex-col items-center gap-2 rounded-xl bg-gray-50 py-3 active:bg-gray-100"
                onClick={() => handleShare('moments')}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#12b7f5] text-white">
                  <Users className="h-5 w-5" />
                </span>
                <span className="text-[11px] text-gray-600">{t('分享朋友圈')}</span>
              </button>
              <button
                type="button"
                className="flex flex-col items-center gap-2 rounded-xl bg-gray-50 py-3 active:bg-gray-100"
                onClick={() => setQrOpen((v) => !v)}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-800 text-white">
                  <QrCode className="h-5 w-5" />
                </span>
                <span className="text-[11px] text-gray-600">{t('当面扫码')}</span>
              </button>
            </div>

            {qrOpen && (
              <div className="mt-4 border-t border-gray-100 pt-4">
                <QrBlock
                  value={shareUrl}
                  caption="扫码注册即自动绑定邀请关系"
                  hint="好友用微信扫一扫即可打开注册页"
                  size={180}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------- 收益卡 ---------- */}
      <div className="px-3 pt-3">
        <div className="rounded-2xl bg-gradient-to-br from-blue-600 to-blue-500 px-4 py-4 text-white shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] text-white/70">{t('总收益（元）')}</p>
              <p className="mt-0.5 text-3xl font-bold leading-none">{yuan(stats.rewardTotalCents)}</p>
              <p className="mt-1.5 text-[11px] text-white/70">
                {t('其中待发放 ¥{{v0}}', { v0: yuan(stats.pendingCents) })}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] text-white/70">{t('已提现（元）')}</p>
              <p className="text-lg font-semibold leading-tight">{yuan(stats.withdrawnCents)}</p>
              <p className="mt-1 text-[11px] text-white/70">{t('待提现（元）')}</p>
              <p className="text-lg font-semibold leading-tight">{yuan(stats.availableCents)}</p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/20 pt-3">
            <div>
              <p className="text-[11px] text-white/70">{t('邀请人数')}</p>
              <p className="text-lg font-semibold">{stats.invitedCount}</p>
            </div>
            <div>
              <p className="text-[11px] text-white/70">{t('已充值人数')}</p>
              <p className="text-lg font-semibold">{stats.validCount}</p>
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className={cn(
                'flex-1 rounded-xl py-2.5 text-sm font-medium',
                withdraw.eligible ? 'bg-white text-blue-600 active:bg-white/90' : 'bg-white/20 text-white/80',
              )}
              onClick={openWithdraw}
            >
              {t('提现')}
            </button>
            <button
              type="button"
              className="flex-1 rounded-xl bg-white/20 py-2.5 text-sm font-medium text-white active:bg-white/30"
              onClick={() => {
                setTab('coupons')
                setCouponFilter('unused')
              }}
            >
              {t('查看优惠券')}
            </button>
            <button
              type="button"
              className="flex-1 rounded-xl bg-white/20 py-2.5 text-sm font-medium text-white active:bg-white/30"
              onClick={() => setRulesOpen((v) => !v)}
            >
              {t('查看详情')}
            </button>
          </div>
          {stats.pendingWithdrawCents > 0 && (
            <p className="mt-2 text-[11px] text-white/70">
              {t('有 ¥{{v0}} 的提现申请正在审核中', { v0: yuan(stats.pendingWithdrawCents) })}
            </p>
          )}
        </div>
      </div>

      {/* ---------- 阶梯与提现门槛 ---------- */}
      <div className="px-3 pt-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
                <Crown className="h-4 w-4 text-amber-500" />
                {t('我的返现档位')}
              </h3>
              {overview.currentTier && (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-600">
                  {t('当前 {{v0}}%', { v0: overview.currentTier.ratePercent })}
                </span>
              )}
            </div>

            <div className="mt-3 space-y-2">
              {overview.tiers.map((tier) => (
                <div
                  key={`${tier.minInvitees}-${tier.maxInvitees ?? 'max'}`}
                  className={cn(
                    'flex items-center justify-between rounded-xl border px-3 py-2.5',
                    tier.current ? 'border-amber-300 bg-amber-50' : 'border-gray-100 bg-gray-50',
                  )}
                >
                  <div className="flex items-center gap-2">
                    {tier.current ? (
                      <BadgeCheck className="h-4 w-4 text-amber-500" />
                    ) : (
                      <span className="h-4 w-4 rounded-full border border-gray-300" />
                    )}
                    <span className={cn('text-xs', tier.current ? 'font-medium text-amber-700' : 'text-gray-600')}>
                      {tier.maxInvitees === null
                        ? t('邀请 {{v0}} 人及以上', { v0: tier.minInvitees })
                        : t('邀请 {{v0}}-{{v1}} 人', { v0: tier.minInvitees, v1: tier.maxInvitees })}
                    </span>
                  </div>
                  <span className={cn('text-sm font-semibold', tier.current ? 'text-amber-600' : 'text-gray-500')}>
                    {t('返现 {{v0}}%', { v0: tier.ratePercent })}
                  </span>
                </div>
              ))}
            </div>

            {overview.nextTier ? (
              <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-[11px] leading-relaxed text-blue-700">
                {/* 说「还差几人」而不是「再邀请几人就能升档」：规则里人越多比例越低，
                    写成像奖励会误导家长多拉人反而降比例。只陈述下一档的门槛与比例。 */}
                {t('邀请满 {{v0}} 名有效充值用户后，返现比例按 {{v1}}% 计算', {
                  v0: overview.nextTier.minInvitees,
                  v1: overview.nextTier.ratePercent,
                })}
              </p>
            ) : (
              <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
                {t('你已在最高档位上')}
              </p>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
              {t('月卡、季卡保底返现 {{v0}}%，年卡及以上单笔最高返现 ¥{{v1}}；奖励按当月统计，次月 {{v2}}-{{v3}} 日发放', {
                v0: config.shortPeriodMinRatePercent,
                v1: trimYuan(config.longPeriodCapCents),
                v2: config.settleDayStart,
                v3: config.settleDayEnd,
              })}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ---------- 提现门槛清单（截图里没有，但这是最有用的信息） ---------- */}
      <div className="px-3 pt-3">
        <Card>
          <CardContent className="p-4">
            <h3 className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
              <Wallet className="h-4 w-4 text-blue-500" />
              {t('提现条件')}
            </h3>
            <div className="mt-3 space-y-2">
              {withdraw.requirements.map((req) => (
                <div key={req.key} className="flex items-center gap-2.5">
                  {req.met ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-[#07c160]" />
                  ) : (
                    <span className="h-4 w-4 shrink-0 rounded-full border-2 border-gray-300" />
                  )}
                  <span className={cn('flex-1 text-xs', req.met ? 'text-gray-500' : 'text-gray-700')}>
                    {t(req.label)}
                  </span>
                  <span className={cn('text-[11px]', req.met ? 'text-[#07c160]' : 'text-gray-400')}>
                    {req.current}
                  </span>
                </div>
              ))}
            </div>
            {!withdraw.eligible && withdraw.blockedReason && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
                {t('还差一点：')}
                {t(withdraw.blockedReason)}
              </p>
            )}
            {!identity.verified && (
              <Button
                variant="outline"
                className="mt-3 w-full"
                onClick={() => {
                  setTab('withdrawals')
                  openWithdraw()
                }}
              >
                {t('去完成实名认证')}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------- 明细 ---------- */}
      <div className="px-3 pt-3">
        <Card>
          <CardContent className="p-0">
            <div className="flex overflow-x-auto border-b border-gray-100">
              {TABS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={cn(
                    'shrink-0 px-4 py-3 text-xs font-medium transition-colors',
                    tab === item.key ? 'border-b-2 border-[#07c160] text-[#07c160]' : 'text-gray-500',
                  )}
                  onClick={() => setTab(item.key)}
                >
                  {t(item.label)}
                </button>
              ))}
            </div>

            {tab === 'coupons' && (
              <div className="flex gap-2 border-b border-gray-100 px-3 py-2">
                {(['all', 'unused', 'used', 'expired'] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={cn(
                      'rounded-full px-2.5 py-1 text-[11px]',
                      couponFilter === key ? 'bg-[#07c160] text-white' : 'bg-gray-100 text-gray-500',
                    )}
                    onClick={() => setCouponFilter(key)}
                  >
                    {t(
                      key === 'all' ? '全部' : key === 'unused' ? '未使用' : key === 'used' ? '已使用' : '已过期',
                    )}
                  </button>
                ))}
              </div>
            )}

            <div className="min-h-[8rem]">
              {listLoading ? (
                <div className="flex items-center justify-center py-10 text-gray-400">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : (
                <>
                  {tab === 'invitees' &&
                    (invitees.length === 0 ? (
                      <EmptyState icon={<Users className="h-6 w-6" />} text={t('还没有邀请记录')} hint={t('把邀请链接发给好友，对方注册充值后就能拿到返现')} />
                    ) : (
                      invitees.map((item) => (
                        <div key={item.id} className="flex items-center gap-3 border-b border-gray-50 px-4 py-3 last:border-0">
                          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gray-100 text-xs text-gray-500">
                            {(item.nickname || '家').slice(0, 1)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium text-gray-900">
                              {item.nickname || t('家长用户')}
                            </p>
                            <p className="mt-0.5 text-[11px] text-gray-400">
                              {item.phone} · {formatDateTime(item.boundAt)}
                            </p>
                          </div>
                          <div className="text-right">
                            <span
                              className={cn(
                                'rounded-full px-2 py-0.5 text-[11px]',
                                item.status === 'valid'
                                  ? 'bg-green-50 text-[#07c160]'
                                  : item.status === 'invalid'
                                    ? 'bg-red-50 text-red-500'
                                    : 'bg-gray-100 text-gray-500',
                              )}
                            >
                              {t(item.statusLabel)}
                            </span>
                            {item.rewardCents > 0 && (
                              <p className="mt-1 text-[11px] text-gray-500">
                                {t('返现 ¥{{v0}}', { v0: yuan(item.rewardCents) })}
                              </p>
                            )}
                          </div>
                        </div>
                      ))
                    ))}

                  {tab === 'rewards' &&
                    (rewards.length === 0 ? (
                      <EmptyState icon={<Wallet className="h-6 w-6" />} text={t('还没有返现记录')} hint={t('好友首次充值或续费后，返现将按当月统计并在次月发放')} />
                    ) : (
                      rewards.map((item) => (
                        <div key={item.rewardNo} className="border-b border-gray-50 px-4 py-3 last:border-0">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-gray-900">{t(item.kindLabel)}</span>
                            <span className="text-sm font-semibold text-[#07c160]">
                              +¥{yuan(item.amountCents)}
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] text-gray-400">
                            {t('好友 {{v0}} 充值 ¥{{v1}} × {{v2}}%', {
                              v0: item.inviteeName || t('家长用户'),
                              v1: yuan(item.baseAmountCents),
                              v2: item.ratePercent,
                            })}
                            {item.capApplied ? t('（已达单笔上限）') : ''}
                          </p>
                          <div className="mt-1.5 flex items-center justify-between">
                            <span
                              className={cn(
                                'rounded-full px-2 py-0.5 text-[11px]',
                                item.status === 'settled'
                                  ? 'bg-green-50 text-[#07c160]'
                                  : item.status === 'cancelled'
                                    ? 'bg-red-50 text-red-500'
                                    : 'bg-amber-50 text-amber-600',
                              )}
                            >
                              {t(item.statusLabel)}
                            </span>
                            <span className="text-[11px] text-gray-400">
                              {item.settleMonth} · {formatDateTime(item.createdAt)}
                            </span>
                          </div>
                          {item.cancelReason && (
                            <p className="mt-1 text-[11px] text-red-400">{t(item.cancelReason)}</p>
                          )}
                        </div>
                      ))
                    ))}

                  {tab === 'withdrawals' &&
                    (withdrawals.length === 0 ? (
                      <EmptyState icon={<Wallet className="h-6 w-6" />} text={t('还没有提现记录')} hint={t('满足提现条件后即可申请')} />
                    ) : (
                      withdrawals.map((item) => (
                        <div key={item.withdrawNo} className="border-b border-gray-50 px-4 py-3 last:border-0">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-semibold text-gray-900">
                              ¥{yuan(item.amountCents)}
                            </span>
                            <span
                              className={cn(
                                'rounded-full px-2 py-0.5 text-[11px]',
                                item.status === 'paid' || item.status === 'approved'
                                  ? 'bg-green-50 text-[#07c160]'
                                  : item.status === 'rejected'
                                    ? 'bg-red-50 text-red-500'
                                    : 'bg-amber-50 text-amber-600',
                              )}
                            >
                              {t(item.statusLabel)}
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] text-gray-400">
                            {t(item.channelLabel)} · {item.account} · {item.realName}
                          </p>
                          <p className="mt-1 text-[11px] text-gray-400">
                            {t('申请于 {{v0}}', { v0: formatDateTime(item.createdAt) })}
                          </p>
                          {item.reviewNote && (
                            <p className="mt-1 text-[11px] text-gray-500">
                              {t('审核备注：{{v0}}', { v0: item.reviewNote })}
                            </p>
                          )}
                        </div>
                      ))
                    ))}

                  {tab === 'coupons' &&
                    (coupons.length === 0 ? (
                      <EmptyState icon={<Ticket className="h-6 w-6" />} text={t('还没有优惠券')} hint={t('邀请满 3 人即送 5 元券，可用于购买会员时抵扣')} />
                    ) : (
                      coupons.map((item) => (
                        <div
                          key={item.id}
                          className={cn(
                            'flex items-center gap-3 border-b border-gray-50 px-4 py-3 last:border-0',
                            !item.usable && 'opacity-60',
                          )}
                        >
                          <div className="flex h-11 w-14 shrink-0 flex-col items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-rose-500 text-white">
                            <span className="text-[10px] leading-none">¥</span>
                            <span className="text-base font-bold leading-tight">{trimYuan(item.amountCents)}</span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-gray-900">{t('邀请返现优惠券')}</p>
                            <p className="mt-0.5 text-[11px] text-gray-400">
                              {item.expiresAt
                                ? t('有效期至 {{v0}}', { v0: formatDateTime(item.expiresAt) })
                                : t('长期有效')}
                            </p>
                            {item.usedOrderNo && (
                              <p className="mt-0.5 text-[11px] text-gray-400">
                                {t('已用于订单 {{v0}}', { v0: item.usedOrderNo })}
                              </p>
                            )}
                          </div>
                          <span
                            className={cn(
                              'rounded-full px-2 py-0.5 text-[11px]',
                              item.status === 'unused'
                                ? 'bg-green-50 text-[#07c160]'
                                : 'bg-gray-100 text-gray-500',
                            )}
                          >
                            {t(item.statusLabel)}
                          </span>
                        </div>
                      ))
                    ))}
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---------- 活动说明 ---------- */}
      <div className="px-3 pt-3 pb-6">
        <Card>
          <CardContent className="p-4">
            <h3 className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
              <Info className="h-4 w-4 text-gray-400" />
              {t('邀请奖励说明')}
            </h3>
            <ol className="mt-3 space-y-2">
              {config.noticeLines.map((line, index) => (
                <li key={line} className="flex gap-2 text-[11px] leading-relaxed text-gray-500">
                  <span className="shrink-0 text-gray-400">{index + 1}.</span>
                  <span>{t(line)}</span>
                </li>
              ))}
            </ol>
            {!config.enabled && (
              <p className="mt-3 rounded-lg bg-gray-100 px-3 py-2 text-[11px] text-gray-500">
                {t('活动当前已暂停，暂停期间新产生的充值不再计算返现')}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------- 提现 / 实名认证弹层 ---------- */}
      {withdrawOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
          <div className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-medium text-gray-900">
                {identity.verified ? t('申请提现') : t('实名认证')}
              </h3>
              <button
                type="button"
                className="rounded-full p-1 text-gray-400 hover:bg-gray-100"
                onClick={() => setWithdrawOpen(false)}
                aria-label={t('关闭')}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {!identity.verified ? (
              <>
                <p className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-[11px] leading-relaxed text-blue-700">
                  {t('按活动规则，申请提现前需完成实名认证。身份证号仅用于本次认证校验，服务端只保存哈希值，不保留明文。')}
                </p>
                <div className="mt-4 space-y-3">
                  <div>
                    <label className="text-xs text-gray-500">{t('真实姓名')}</label>
                    <input
                      className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-[#07c160]"
                      value={realName}
                      onChange={(e) => setRealName(e.target.value)}
                      placeholder={t('请输入身份证上的姓名')}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">{t('身份证号')}</label>
                    <input
                      className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm uppercase outline-none focus:border-[#07c160]"
                      value={idCard}
                      onChange={(e) => setIdCard(e.target.value)}
                      placeholder={t('18 位身份证号')}
                      maxLength={18}
                    />
                  </div>
                </div>
                <Button
                  className="mt-5 w-full bg-[#07c160] hover:bg-[#06ad56]"
                  disabled={submitting}
                  onClick={handleVerify}
                >
                  {submitting ? t('提交中…') : t('提交实名认证')}
                </Button>
              </>
            ) : (
              <>
                <div className="mt-3 rounded-xl bg-gray-50 px-3 py-2.5">
                  <p className="text-[11px] text-gray-500">
                    {t('可提现余额')}
                  </p>
                  <p className="text-2xl font-bold text-gray-900">¥{yuan(withdraw.availableCents)}</p>
                  <p className="mt-0.5 text-[11px] text-gray-400">
                    {t('已实名：{{v0}} {{v1}}', { v0: identity.realName, v1: identity.idCardMasked })}
                  </p>
                </div>

                <div className="mt-4 space-y-3">
                  <div>
                    <label className="text-xs text-gray-500">{t('提现金额（元）')}</label>
                    <input
                      className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-[#07c160]"
                      value={amountInput}
                      onChange={(e) => setAmountInput(e.target.value)}
                      inputMode="decimal"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">{t('提现方式')}</label>
                    <div className="mt-1 grid grid-cols-3 gap-2">
                      {(['alipay', 'wechat', 'bank'] as const).map((key) => (
                        <button
                          key={key}
                          type="button"
                          className={cn(
                            'rounded-xl border py-2 text-xs',
                            channel === key
                              ? 'border-[#07c160] bg-green-50 text-[#07c160]'
                              : 'border-gray-200 text-gray-600',
                          )}
                          onClick={() => setChannel(key)}
                        >
                          {t(key === 'alipay' ? '支付宝' : key === 'wechat' ? '微信' : '银行卡')}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">
                      {t(channel === 'bank' ? '银行卡号' : '收款账号')}
                    </label>
                    <input
                      className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-[#07c160]"
                      value={account}
                      onChange={(e) => setAccount(e.target.value)}
                      placeholder={t(channel === 'bank' ? '请输入银行卡号' : '请输入支付宝/微信绑定的手机号或账号')}
                    />
                  </div>
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-gray-400">
                  {t('提交后进入人工审核，审核通过后 7 个工作日内到账。')}
                </p>
                <Button
                  className="mt-4 w-full bg-[#07c160] hover:bg-[#06ad56]"
                  disabled={submitting}
                  onClick={handleWithdraw}
                >
                  {submitting ? t('提交中…') : t('提交提现申请')}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---------- 「查看详情」弹层：奖励规则速查 ---------- */}
      {rulesOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
          <div className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-medium text-gray-900">{t('收益详情')}</h3>
              <button
                type="button"
                className="rounded-full p-1 text-gray-400 hover:bg-gray-100"
                onClick={() => setRulesOpen(false)}
                aria-label={t('关闭')}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-4 space-y-2.5">
              {[
                [t('累计返现'), `¥${yuan(stats.rewardTotalCents)}`],
                [t('待发放'), `¥${yuan(stats.pendingCents)}`],
                [t('已发放'), `¥${yuan(stats.settledCents)}`],
                [t('已提现'), `¥${yuan(stats.withdrawnCents)}`],
                [t('审核中'), `¥${yuan(stats.pendingWithdrawCents)}`],
                [t('已取消'), `¥${yuan(stats.cancelledCents)}`],
                [t('可用优惠券'), t('{{v0}} 张 / ¥{{v1}}', { v0: stats.couponUnusedCount, v1: yuan(stats.couponUnusedCents) })],
                [t('本月已产生'), `¥${yuan(Number(stats.currentMonthCents))}（${stats.currentMonthLabel}）`],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between border-b border-gray-50 pb-2 last:border-0">
                  <span className="text-xs text-gray-500">{label}</span>
                  <span className="text-sm font-medium text-gray-900">{value}</span>
                </div>
              ))}
            </div>
            <Button variant="outline" className="mt-5 w-full" onClick={() => setRulesOpen(false)}>
              {t('知道了')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyState({
  icon,
  text,
  hint,
}: {
  icon: React.ReactNode
  text: string
  hint: string
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center px-8 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-gray-400">
        {icon}
      </div>
      <p className="mt-3 text-sm text-gray-600">{t(text)}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-gray-400">{t(hint)}</p>
    </div>
  )
}
