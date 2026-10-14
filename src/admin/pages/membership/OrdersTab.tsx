import { useState } from 'react'
import { Loader2, RefreshCw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api, formatDateTime, type MembershipOrderRow } from '../../api'
import { useAsyncData, useFilters } from '../../hooks/useAsyncData'
import { DataState, PageHeader, Pagination, ToneBadge } from '../../components/ui-kit'
import {
  CHANNEL_OPTIONS,
  CHANNEL_TONE,
  ORDER_STATUS_OPTIONS,
  ORDER_STATUS_TONE,
  PERIOD_OPTIONS,
  TIER_OPTIONS,
  TIER_TONE,
  formatCents,
} from './shared'

/**
 * 订单流水。
 *
 * 每笔订单都存了**下单那一刻**的规则快照（adjustments），
 * 所以即使运营后来改了规则或套餐价，这里的「当时为什么便宜了 3 元」永远解释得清。
 */
export function OrdersTab() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({
    q: '',
    status: '',
    tier: '',
    period: '',
    payChannel: '',
  })

  const { data, loading, error, reload: load } = useAsyncData(
    () =>
      api.membership.orders.list({
        q: filters.q.trim() || undefined,
        status: filters.status || undefined,
        tier: filters.tier || undefined,
        period: filters.period || undefined,
        payChannel: filters.payChannel || undefined,
        page,
        pageSize,
      }),
    { deps: [filters.q, filters.status, filters.tier, filters.period, filters.payChannel, page, pageSize], debounceMs: 250 },
  )

  const [detail, setDetail] = useState<MembershipOrderRow | null>(null)
  const summary = data?.summary

  return (
    <div>
      <PageHeader
        title="会员订单"
        description="每笔订单都保存了下单时的规则快照，事后改规则或改价都不会影响历史订单的解释。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      {/* 小计跟随筛选条件：换一个筛选就能看到那部分订单的金额合计 */}
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {ORDER_STATUS_OPTIONS.map((s) => {
          const hit = summary?.statusCounts[s.value]
          return (
            <Card key={s.value}>
              <CardContent className="p-3">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="mt-1 font-mono text-lg font-semibold text-foreground">{hit?.count ?? 0}</p>
                <p className="text-[11px] text-muted-foreground">{formatCents(hit?.amountCents ?? 0)}</p>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Card className="mb-3">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filters.q}
              onChange={(e) => setFilter('q', e.target.value)}
              placeholder="搜索订单号或家长手机号"
              className="pl-9"
            />
          </div>
          <Select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} className="w-32">
            <option value="">全部状态</option>
            {ORDER_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select value={filters.tier} onChange={(e) => setFilter('tier', e.target.value)} className="w-32">
            <option value="">全部档位</option>
            {TIER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select value={filters.period} onChange={(e) => setFilter('period', e.target.value)} className="w-32">
            <option value="">全部周期</option>
            {PERIOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select value={filters.payChannel} onChange={(e) => setFilter('payChannel', e.target.value)} className="w-32">
            <option value="">全部渠道</option>
            {CHANNEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <DataState
          loading={loading && !data}
          error={error}
          empty={(data?.items.length ?? 0) === 0}
          emptyText="没有符合条件的订单"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">订单号</TableHead>
                  <TableHead className="w-36">家长</TableHead>
                  <TableHead className="w-40">套餐</TableHead>
                  <TableHead className="w-24 text-right">原价</TableHead>
                  <TableHead className="w-24 text-right">实付</TableHead>
                  <TableHead className="w-24">渠道</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-40">下单时间</TableHead>
                  <TableHead className="w-16 text-right">详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {order.orderNo}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-foreground">{order.user.nickname || '—'}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {order.user.phone || `#${order.user.id}`}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <ToneBadge tone={TIER_TONE[order.tier] ?? 'gray'}>{order.tierLabel}</ToneBadge>
                        <span className="text-xs text-muted-foreground">{order.periodLabel}</span>
                      </div>
                      <div className="font-mono text-[11px] text-muted-foreground">{order.planCode}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono text-xs text-muted-foreground line-through">
                      {formatCents(order.originalCents)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <span className="font-mono text-sm font-medium text-foreground">
                        {formatCents(order.amountCents)}
                      </span>
                      {order.discountCents > 0 ? (
                        <div className="text-[11px] text-primary">−{formatCents(order.discountCents)}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={CHANNEL_TONE[order.payChannel] ?? 'gray'}>
                        {order.payChannelLabel}
                      </ToneBadge>
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={ORDER_STATUS_TONE[order.status] ?? 'gray'}>
                        {ORDER_STATUS_OPTIONS.find((o) => o.value === order.status)?.label ?? order.status}
                      </ToneBadge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(order.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => setDetail(order)}>
                        查看
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {data ? (
            <Pagination
              page={data.page}
              pageSize={pageSize}
              total={data.total}
              totalPages={data.totalPages}
              onPageChange={setPage}
              onPageSizeChange={changePageSize}
            />
          ) : null}
        </DataState>
      </Card>

      <Dialog open={Boolean(detail)} onOpenChange={(open) => (!open ? setDetail(null) : null)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>订单 {detail?.orderNo}</DialogTitle>
            <DialogDescription>
              下单时的规则快照。之后运营改了规则或套餐价，都不会改变这里的记录。
            </DialogDescription>
          </DialogHeader>

          {detail ? (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-muted-foreground">家长</div>
                  <div className="text-foreground">
                    {detail.user.nickname || '—'}{' '}
                    <span className="font-mono text-xs text-muted-foreground">
                      {detail.user.phone || `#${detail.user.id}`}
                    </span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">套餐</div>
                  <div className="flex items-center gap-1.5">
                    <ToneBadge tone={TIER_TONE[detail.tier] ?? 'gray'}>{detail.tierLabel}</ToneBadge>
                    <span className="text-foreground">{detail.periodLabel}</span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">支付渠道</div>
                  <div className="text-foreground">{detail.payChannelLabel}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">状态</div>
                  <ToneBadge tone={ORDER_STATUS_TONE[detail.status] ?? 'gray'}>
                    {ORDER_STATUS_OPTIONS.find((o) => o.value === detail.status)?.label ?? detail.status}
                  </ToneBadge>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">下单时间</div>
                  <div className="text-foreground">{formatDateTime(detail.createdAt)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">支付时间</div>
                  <div className="text-foreground">{detail.paidAt ? formatDateTime(detail.paidAt) : '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">生效区间</div>
                  <div className="text-xs text-foreground">
                    {detail.startsAt ? formatDateTime(detail.startsAt) : '—'} →{' '}
                    {detail.expiresAt ? formatDateTime(detail.expiresAt) : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">连续包月</div>
                  <div className="text-foreground">{detail.autoRenew ? '已开通' : '未开通'}</div>
                </div>
              </div>

              <div className="rounded-lg bg-muted p-3">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>原价</span>
                  <span className="font-mono">{formatCents(detail.originalCents)}</span>
                </div>
                {Array.isArray(detail.adjustments) && detail.adjustments.length > 0 ? (
                  detail.adjustments.map((a, i) => (
                    <div key={`${a.ruleId}-${i}`} className="mt-1 flex justify-between text-xs">
                      <span className="text-foreground">{a.name}</span>
                      <span className="font-mono text-primary">−{formatCents(a.amountCents)}</span>
                    </div>
                  ))
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">没有命中优惠</p>
                )}
                <div className="mt-2 flex justify-between border-t pt-2 text-sm">
                  <span className="text-foreground">实付</span>
                  <span className="font-mono font-semibold text-primary">{formatCents(detail.amountCents)}</span>
                </div>
              </div>

              {detail.transactionId ? (
                <div>
                  <div className="text-xs text-muted-foreground">渠道流水号</div>
                  <div className="font-mono text-xs text-foreground">{detail.transactionId}</div>
                </div>
              ) : null}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
