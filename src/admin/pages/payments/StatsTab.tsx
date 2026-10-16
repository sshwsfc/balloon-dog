import { FileText, Loader2, Receipt, RefreshCw, ShieldAlert, TestTube2, ToggleLeft, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { api, type PaymentsStats } from '../../api'
import { useAsyncData } from '../../hooks/useAsyncData'
import { DataState, PageHeader, ToneBadge } from '../../components/ui-kit'
import { formatCents } from './shared'

function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'text-primary',
}: {
  icon: typeof Wallet
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

/** 近 30 天收款柱状图（纯 SVG，不引图表库，和会员后台 / 数据看板同一做法）。 */
function DailyChart({ points }: { points: PaymentsStats['byDay'] }) {
  const max = Math.max(1, ...points.map((p) => p.cents))
  const total = points.reduce((s, p) => s + p.cents, 0)
  const W = 560
  const H = 120
  const gap = 2
  const barW = points.length > 0 ? Math.max(1, (W - gap * (points.length - 1)) / points.length) : 1

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <span>近 30 天每日收款</span>
          <span className="text-xs font-normal text-muted-foreground">区间合计 {formatCents(total)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {points.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">近 30 天没有收款记录</p>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="h-[120px] w-full"
              preserveAspectRatio="none"
              role="img"
              aria-label="每日收款"
            >
              {points.map((p, i) => {
                const h = p.cents === 0 ? 1 : Math.max(2, (p.cents / max) * (H - 8))
                return (
                  <rect
                    key={p.day}
                    x={i * (barW + gap)}
                    y={H - h}
                    width={barW}
                    height={h}
                    rx={1.5}
                    fill="#07c160"
                    opacity={p.cents === 0 ? 0.15 : 0.85}
                  >
                    <title>{`${p.day}：${formatCents(p.cents)}（${p.count} 笔）`}</title>
                  </rect>
                )
              })}
            </svg>
            <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
              <span>{points[0]?.day ?? ''}</span>
              <span>{points[points.length - 1]?.day ?? ''}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** 按渠道分布：横向条形列表（不引图表库，条形宽度按金额归一化）。 */
function ChannelDistribution({ rows }: { rows: PaymentsStats['byChannel'] }) {
  const max = Math.max(1, ...rows.map((r) => r.cents))
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">按渠道分布</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {rows.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">还没有成功收款的订单</p>
        ) : (
          rows.map((r) => (
            <div key={r.channel}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-foreground">
                  {r.label} · {r.count} 笔
                </span>
                <span className="font-mono text-foreground">{formatCents(r.cents)}</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.max(2, (r.cents / max) * 100)}%` }}
                />
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

/**
 * 收款统计。
 *
 * 这一页回答的是「钱进来了没有、能不能收、有没有收错」：
 * 渠道配置体检（缺哪个环境变量）和坏签名回调数比总金额更值得盯 ——
 * 少了环境变量，家长会点到一个永远付不成功的下单按钮。
 */
export function StatsTab() {
  const { data, loading, error, reload: load } = useAsyncData(() => api.payments.stats(), { deps: [] })

  return (
    <div>
      <PageHeader
        title="收款统计"
        description="金额均为已成功支付的订单。坏签名回调与未配置的渠道都会让「下单成功、收款失败」，所以这两项单独列出来。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      <DataState loading={loading && !data} error={error} empty={!data} onRetry={load}>
        {data ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <KpiCard
                icon={Wallet}
                label="已支付金额"
                value={formatCents(data.paidCents)}
                hint={`${data.paidOrders} 笔`}
              />
              <KpiCard
                icon={Receipt}
                label="已退款金额"
                value={formatCents(data.refundedCents)}
                hint={`${data.refundedOrders} 笔`}
                tone="text-blue-600"
              />
              <KpiCard
                icon={FileText}
                label="待处理开票"
                value={`${data.pendingInvoices}`}
                hint="张"
                tone={data.pendingInvoices > 0 ? 'text-amber-600' : 'text-muted-foreground'}
              />
              <KpiCard
                icon={ShieldAlert}
                label="坏签名回调"
                value={`${data.badSignatures}`}
                hint={data.badSignatures > 0 ? '渠道密钥/证书可能配错' : '验签全部通过'}
                tone={data.badSignatures > 0 ? 'text-destructive' : 'text-muted-foreground'}
              />
              <KpiCard
                icon={TestTube2}
                label="测试渠道订单"
                value={`${data.mockPayOrders}`}
                hint={data.mockPayOrders > 0 ? '这些订单没有真的收钱' : '没有走过测试渠道'}
                tone={data.mockPayOrders > 0 ? 'text-amber-600' : 'text-muted-foreground'}
              />
            </div>

            <Card>
              <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4 text-sm">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ToggleLeft className="h-3.5 w-3.5" />
                  运行开关
                </span>
                <ToneBadge tone={data.mockPay ? 'amber' : 'gray'}>
                  模拟支付：{data.mockPay ? '开启' : '关闭'}
                </ToneBadge>
                <ToneBadge tone={data.fakeProvider ? 'amber' : 'gray'}>
                  测试渠道：{data.fakeProvider ? '开启' : '关闭'}
                </ToneBadge>
                <span className="text-xs text-muted-foreground">
                  模拟支付开启时不会调用真实渠道，只用于联调；测试渠道的订单不算真实收入。
                </span>
              </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <DailyChart points={data.byDay} />
              <ChannelDistribution rows={data.byChannel} />
            </div>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">支付渠道配置</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 pt-0 sm:grid-cols-2">
                {data.channels.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground sm:col-span-2">
                    后端没有返回任何支付渠道
                  </p>
                ) : (
                  data.channels.map((channel) => (
                    <div key={channel.key} className="rounded-lg border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">{channel.label}</span>
                        <ToneBadge tone={channel.configured ? 'green' : 'amber'}>
                          {channel.configured ? '已配置' : '未配置'}
                        </ToneBadge>
                      </div>
                      {channel.missing.length > 0 ? (
                        <div className="mt-2">
                          <p className="text-xs text-muted-foreground">
                            缺少 {channel.missing.length} 个环境变量：
                          </p>
                          <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-destructive">
                            {channel.missing.map((name) => (
                              <li key={name}>{name}</li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-muted-foreground">
                          环境变量齐全，这个渠道可以向家长收款。
                        </p>
                      )}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DataState>
    </div>
  )
}
