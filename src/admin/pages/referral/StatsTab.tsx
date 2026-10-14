import { useState } from 'react'
import {
  BadgePercent,
  Coins,
  Gift,
  Loader2,
  PiggyBank,
  RefreshCw,
  Ticket,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, formatDateTime, formatRate } from '../../api'
import { useAsyncData } from '../../hooks/useAsyncData'
import { DataState, PageHeader, ToneBadge } from '../../components/ui-kit'
import type { Tone } from '../../components/status'
import {
  REFERRAL_STATUS_OPTIONS,
  REFERRAL_STATUS_TONE,
  REWARD_STATUS_OPTIONS,
  REWARD_STATUS_TONE,
  WITHDRAWAL_STATUS_OPTIONS,
  WITHDRAWAL_STATUS_TONE,
  formatCents,
} from './shared'

const RANGE_OPTIONS = [7, 30, 90]

function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'text-primary',
}: {
  icon: typeof Coins
  label: string
  value: string
  hint?: string
  tone?: string
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1.5 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
            {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
          </div>
          <div className={`shrink-0 rounded-lg bg-muted p-2 ${tone}`}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * 极简柱状趋势图（纯 SVG，不引图表库，和 Dashboard / 会员统计保持一致的做法）。
 * 没有数据的那天也画一根 1px 的浅柱：服务端已经把日期补齐，折线不该把空档连成假斜线。
 */
function TrendBars<T extends { date: string }>({
  title,
  hint,
  points,
  series,
}: {
  title: string
  hint: string
  points: T[]
  series: { key: string; label: string; color: string; value: (p: T) => number }[]
}) {
  const W = 560
  const H = 120
  const gap = 2
  const barW = points.length > 0 ? Math.max(1, (W - gap * (points.length - 1)) / points.length) : 1
  const max = Math.max(1, ...points.flatMap((_, i) => series.map((s) => s.value(points[i]))))
  const inner = series.length
  const subW = Math.max(1, (barW - (inner - 1)) / inner)
  // 全 0 时那一排 1px 浅柱看起来就是一个空白面板，像页面坏了；直接换成一句说明。
  const allZero = points.length === 0 || points.every((p) => series.every((s) => s.value(p) === 0))

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
          <span>{title}</span>
          <span className="flex items-center gap-3 text-xs font-normal text-muted-foreground">
            {series.map((s) => (
              <span key={s.key} className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: s.color }} />
                {s.label}
              </span>
            ))}
            <span>{hint}</span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {allZero ? (
          <div className="flex h-[120px] items-center justify-center text-xs text-muted-foreground">
            所选区间内没有数据
          </div>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="h-[120px] w-full"
              preserveAspectRatio="none"
              role="img"
              aria-label={title}
            >
              {points.map((p, i) =>
                series.map((s, si) => {
                  const v = s.value(p)
                  const h = v === 0 ? 1 : Math.max(2, (v / max) * (H - 8))
                  return (
                    <rect
                      key={`${s.key}-${p.date}`}
                      x={i * (barW + gap) + si * subW}
                      y={H - h}
                      width={subW}
                      height={h}
                      rx={1.5}
                      fill={s.color}
                      opacity={v === 0 ? 0.15 : 0.85}
                    >
                      <title>{`${p.date} ${s.label}：${v}`}</title>
                    </rect>
                  )
                }),
              )}
            </svg>
            <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
              <span>{points[0]?.date ?? ''}</span>
              <span>{points[points.length - 1]?.date ?? ''}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** 一个「状态 → 条数 / 金额」的小分布表。 */
function StatusDistribution({
  title,
  options,
  tones,
  counts,
}: {
  title: string
  options: { value: string; label: string }[]
  tones: Record<string, Tone>
  counts: Record<string, number>
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">数量</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {options.map((s) => (
              <TableRow key={s.value}>
                <TableCell>
                  <ToneBadge tone={tones[s.value] ?? 'gray'}>{s.label}</ToneBadge>
                </TableCell>
                <TableCell className="text-right font-mono text-sm text-foreground">
                  {counts[s.value] ?? 0}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

/** 邀请返现统计：返现盘面、转化率、每日趋势、状态分布与邀请达人榜。 */
export function StatsTab() {
  const [days, setDays] = useState(30)

  const {
    data,
    loading,
    error,
    reload: load,
  } = useAsyncData(() => api.referral.stats(days), { deps: [days] })

  const totals = data?.totals

  return (
    <div>
      <PageHeader
        title="统计概览"
        description="「邀请转化率」= 有效邀请 / 全部邀请关系；「充值转化率」= 有付费行为的账号 / 全部账号。金额均为已发生口径，不含已取消的返现。"
        actions={
          <>
            <div className="flex overflow-hidden rounded-md border">
              {RANGE_OPTIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDays(d)}
                  className={`px-3 py-1.5 text-xs ${
                    days === d ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'
                  }`}
                >
                  近 {d} 天
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              刷新
            </Button>
          </>
        }
      />

      <DataState
        loading={loading && !data}
        error={error}
        empty={!data}
        emptyText="暂无统计数据"
        onRetry={load}
      >
        {data && totals ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <KpiCard
                icon={Coins}
                label="总返现额"
                value={formatCents(totals.rewardTotals.totalCents)}
                hint={`累计 ${totals.rewardTotals.count} 笔（不含已取消）`}
              />
              <KpiCard
                icon={PiggyBank}
                label="待发放"
                value={formatCents(totals.rewardTotals.pendingCents)}
                hint="按当月统计，次月结算窗口发放"
                tone="text-amber-600"
              />
              <KpiCard
                icon={BadgePercent}
                label="已发放"
                value={formatCents(totals.rewardTotals.settledCents)}
                hint={`已取消 ${formatCents(totals.rewardTotals.cancelledCents)}`}
                tone="text-blue-600"
              />
              <KpiCard
                icon={Wallet}
                label="已提现"
                value={formatCents(totals.withdrawalTotals.paidCents)}
                hint={`${totals.withdrawalTotals.paidCount} 笔打款 · 待审 ${totals.withdrawalTotals.pendingCount} 笔`}
                tone="text-purple-600"
              />
              <KpiCard
                icon={Ticket}
                label="优惠券未核销总额"
                value={formatCents(totals.couponTotals.outstandingCents)}
                hint={`已发出 ${totals.couponTotals.issued} 张（已用 ${totals.couponTotals.used} / 过期 ${totals.couponTotals.expired}）`}
                tone="text-muted-foreground"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <KpiCard
                icon={Users}
                label="邀请人数"
                value={String(totals.referrals)}
                hint={`近 ${data.days} 天新增 ${totals.invitedInRange} 人 · 有效 ${totals.validInRange} 人`}
              />
              <KpiCard
                icon={TrendingUp}
                label="邀请转化率"
                value={formatRate(totals.inviteConversion)}
                hint="有效邀请 / 全部邀请关系"
                tone="text-primary"
              />
              <KpiCard
                icon={Gift}
                label="充值转化率"
                value={formatRate(totals.payConversion)}
                hint={`${totals.paidUsers} / ${totals.totalUsers} 个账号有过付费`}
                tone="text-blue-600"
              />
            </div>

            <Card>
              <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-2">
                  活动状态：
                  <ToneBadge tone={data.config.enabled ? 'green' : 'gray'}>
                    {data.config.enabled ? '进行中' : '已停用'}
                  </ToneBadge>
                </span>
                <span>
                  活动名称：<span className="text-foreground">{data.config.title}</span>
                </span>
                <span>
                  时间：{formatDateTime(data.config.startedAt)} →{' '}
                  {data.config.endsAt ? formatDateTime(data.config.endsAt) : '长期有效'}
                </span>
                <span>
                  返现阶梯 <span className="font-mono text-foreground">{data.config.tierCount}</span> 档 · 券规则{' '}
                  <span className="font-mono text-foreground">{data.config.couponRuleCount}</span> 条
                </span>
                <span>
                  提现门槛：≥ {data.config.withdrawMinInvitees} 名有效邀请且累计返现 ≥{' '}
                  {formatCents(data.config.withdrawMinCents)}
                </span>
              </CardContent>
            </Card>

            <TrendBars
              title="每日返现"
              hint={`区间合计 ${formatCents(data.series.reduce((s, p) => s + p.rewardCents, 0))}`}
              points={data.series}
              series={[
                { key: 'reward', label: '返现额（分）', color: '#07c160', value: (p) => p.rewardCents },
              ]}
            />

            <TrendBars
              title="每日邀请"
              hint={`区间合计邀请 ${data.series.reduce((s, p) => s + p.invited, 0)} 人 · 有效 ${data.series.reduce((s, p) => s + p.valid, 0)} 人`}
              points={data.series}
              series={[
                { key: 'invited', label: '新绑定', color: '#3b82f6', value: (p) => p.invited },
                { key: 'valid', label: '转为有效', color: '#07c160', value: (p) => p.valid },
              ]}
            />

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <StatusDistribution
                title="邀请关系状态"
                options={REFERRAL_STATUS_OPTIONS}
                tones={REFERRAL_STATUS_TONE}
                counts={data.byStatus}
              />
              <StatusDistribution
                title="返现状态"
                options={REWARD_STATUS_OPTIONS}
                tones={REWARD_STATUS_TONE}
                counts={data.byRewardStatus}
              />
              <StatusDistribution
                title="提现状态"
                options={WITHDRAWAL_STATUS_OPTIONS}
                tones={WITHDRAWAL_STATUS_TONE}
                counts={data.byWithdrawalStatus}
              />
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">邀请达人榜</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="mb-2 text-xs text-muted-foreground">
                  按累计返现额排序，而不是按邀请人数 —— 拉来 100 个不充值的账号不该排第一。
                </p>
                {data.topInviters.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">还没有邀请记录</p>
                ) : (
                  <div className="admin-table-scroll">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-12 text-right">#</TableHead>
                          <TableHead>邀请人</TableHead>
                          <TableHead className="text-right">邀请人数</TableHead>
                          <TableHead className="text-right">有效人数</TableHead>
                          <TableHead className="text-right">累计返现</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.topInviters.map((u, i) => (
                          <TableRow key={u.userId}>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground">
                              {i + 1}
                            </TableCell>
                            <TableCell className="text-sm text-foreground">{u.label}</TableCell>
                            <TableCell className="text-right font-mono text-sm text-foreground">{u.count}</TableCell>
                            <TableCell className="text-right font-mono text-sm text-foreground">
                              {u.validCount}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm text-primary">
                              {formatCents(u.amountCents)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DataState>
    </div>
  )
}
