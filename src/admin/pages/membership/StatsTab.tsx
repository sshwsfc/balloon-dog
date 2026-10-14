import { useState } from 'react'
import {
  BarChart3,
  CalendarClock,
  Coins,
  CreditCard,
  Crown,
  Loader2,
  RefreshCw,
  Repeat,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, formatRate } from '../../api'
import { useAsyncData } from '../../hooks/useAsyncData'
import { DataState, PageHeader, ToneBadge } from '../../components/ui-kit'
import { ORDER_STATUS_OPTIONS, ORDER_STATUS_TONE, formatCents } from './shared'

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

/** 极简柱状趋势图（纯 SVG，不引图表库，和 Dashboard 保持一致的做法）。 */
function RevenueChart({ points }: { points: { date: string; amountCents: number; count: number }[] }) {
  const max = Math.max(1, ...points.map((p) => p.amountCents))
  const total = points.reduce((s, p) => s + p.amountCents, 0)
  const W = 560
  const H = 120
  const gap = 2
  const barW = points.length > 0 ? Math.max(1, (W - gap * (points.length - 1)) / points.length) : 1

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <span>每日收入</span>
          <span className="text-xs font-normal text-muted-foreground">区间合计 {formatCents(total)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-[120px] w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label="每日收入"
        >
          {points.map((p, i) => {
            const h = p.amountCents === 0 ? 1 : Math.max(2, (p.amountCents / max) * (H - 8))
            return (
              <rect
                key={p.date}
                x={i * (barW + gap)}
                y={H - h}
                width={barW}
                height={h}
                rx={1.5}
                fill="#07c160"
                opacity={p.amountCents === 0 ? 0.15 : 0.85}
              >
                <title>{`${p.date}：${formatCents(p.amountCents)}（${p.count} 笔）`}</title>
              </rect>
            )
          })}
        </svg>
        <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
          <span>{points[0]?.date ?? ''}</span>
          <span>{points[points.length - 1]?.date ?? ''}</span>
        </div>
      </CardContent>
    </Card>
  )
}

/** 会员统计：收入、付费用户、档位分布、每日收入与套餐排行。 */
export function StatsTab({ active }: { active: boolean }) {
  const [days, setDays] = useState(30)

  const { data, loading, error, reload: load } = useAsyncData(() => api.membership.stats({ days }), {
    deps: [days],
    enabled: active,
  })

  const users = data?.users

  return (
    <div>
      <PageHeader
        title="会员统计"
        description="「有效会员」按到期时间实时判定，与家长端看到的状态一致；「字段档位」是库里的原始值，含已过期但还没被惰性降级的账号。"
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
        {data ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <KpiCard
                icon={Coins}
                label="累计收入"
                value={formatCents(data.totals.paidAmountCents)}
                hint={`近 ${data.days} 天 ${formatCents(data.series.reduce((s, p) => s + p.amountCents, 0))}`}
              />
              <KpiCard
                icon={CreditCard}
                label="付费订单"
                value={String(data.totals.paidCount)}
                hint={`待支付 ${data.byStatus.pending?.count ?? 0} 笔`}
              />
              <KpiCard
                icon={Users}
                label="付费用户"
                value={String(data.totals.payingUsers)}
                hint={`全部注册 ${data.totals.totalUsers} 人`}
              />
              <KpiCard
                icon={BarChart3}
                label="客单价"
                value={formatCents(data.totals.averageOrderCents)}
                hint="已支付订单的平均实付"
              />
              <KpiCard
                icon={Crown}
                label="付费转化率"
                value={formatRate(data.users.paidConversion)}
                hint="付过费的人 / 全部注册用户"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                icon={Crown}
                label="有效会员"
                value={String(users?.activeMember ?? 0)}
                hint={`超级会员 ${users?.activeSuper ?? 0} 人`}
                tone="text-blue-600"
              />
              <KpiCard
                icon={Users}
                label="普通账号"
                value={String(users?.ordinary ?? 0)}
                hint="未开通或不含有效期的账号"
                tone="text-muted-foreground"
              />
              <KpiCard
                icon={CalendarClock}
                label="7 天内到期"
                value={String(users?.expiringIn7Days ?? 0)}
                hint="可以做续费提醒"
                tone="text-amber-600"
              />
              <KpiCard
                icon={Repeat}
                label="连续包月"
                value={String(users?.autoRenew ?? 0)}
                hint={`启用套餐 ${data.config.enabledPlans} · 启用规则 ${data.config.enabledRules}`}
                tone="text-purple-600"
              />
            </div>

            <RevenueChart points={data.series} />

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">订单状态分布</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>状态</TableHead>
                        <TableHead className="text-right">订单数</TableHead>
                        <TableHead className="text-right">金额</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ORDER_STATUS_OPTIONS.map((s) => {
                        const hit = data.byStatus[s.value]
                        return (
                          <TableRow key={s.value}>
                            <TableCell>
                              <ToneBadge tone={ORDER_STATUS_TONE[s.value] ?? 'gray'}>{s.label}</ToneBadge>
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm text-foreground">
                              {hit?.count ?? 0}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground">
                              {formatCents(hit?.amountCents ?? 0)}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">套餐销售排行</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  {data.planPerformance.length === 0 ? (
                    <p className="py-6 text-center text-xs text-muted-foreground">还没有已支付的订单</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>套餐编码</TableHead>
                          <TableHead className="text-right">销量</TableHead>
                          <TableHead className="text-right">金额</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.planPerformance.map((p) => (
                          <TableRow key={p.planCode}>
                            <TableCell className="font-mono text-xs text-foreground">{p.planCode}</TableCell>
                            <TableCell className="text-right font-mono text-sm text-foreground">{p.count}</TableCell>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground">
                              {formatCents(p.amountCents)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">档位明细</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="admin-table-scroll">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>档位</TableHead>
                        <TableHead className="text-right">有效（按到期时间）</TableHead>
                        <TableHead className="text-right">字段值（含未降级）</TableHead>
                        <TableHead>说明</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[
                        { key: 'member', label: '会员', tone: 'blue' as const },
                        { key: 'super', label: '超级会员', tone: 'purple' as const },
                        { key: 'ordinary', label: '普通账号', tone: 'gray' as const },
                      ].map((t) => (
                        <TableRow key={t.key}>
                          <TableCell>
                            <ToneBadge tone={t.tone}>{t.label}</ToneBadge>
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm text-foreground">
                            {users?.activeTierCounts?.[t.key] ?? 0}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm text-muted-foreground">
                            {users?.storedTierCounts?.[t.key] ?? 0}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {t.key === 'ordinary'
                              ? '有效值 = 总用户 − 有效会员 − 有效超级会员'
                              : users && (users.storedTierCounts?.[t.key] ?? 0) > (users.activeTierCounts?.[t.key] ?? 0)
                                ? '有已过期但尚未被自动降级的账号，家长下次打开会员页时会收敛'
                                : '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DataState>
    </div>
  )
}
