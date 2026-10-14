import { Loader2, RefreshCw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input, Select } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, formatDateTime } from '../../api'
import { useAsyncData, useFilters } from '../../hooks/useAsyncData'
import { DataState, PageHeader, Pagination, ToneBadge } from '../../components/ui-kit'
import { DateRangeFilter, StatusCountRow } from './parts'
import {
  COUPON_SOURCE_LABEL,
  COUPON_STATUS_OPTIONS,
  COUPON_STATUS_TONE,
  dayEnd,
  dayStart,
  formatCents,
  totalPagesOf,
} from './shared'

/**
 * 优惠券发放记录。
 *
 * 券由「邀请里程碑」规则自动发放（见「规则与阶梯」页），这里只看已发出的券：
 * 未使用 / 已使用 / 已过期。券本身不能重置，误发只能靠调整规则止损。
 */
export function CouponsTab() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({
    q: '',
    status: '',
    from: '',
    to: '',
  })

  const {
    data,
    loading,
    error,
    reload: load,
  } = useAsyncData(
    () =>
      api.referral.coupons.list({
        q: filters.q.trim() || undefined,
        status: filters.status || undefined,
        from: dayStart(filters.from),
        to: dayEnd(filters.to),
        page,
        pageSize,
      }),
    { deps: [filters, page, pageSize], debounceMs: 250 },
  )

  return (
    <div>
      <PageHeader
        title="优惠券"
        description="邀请达到里程碑时自动发到家长账户的首充抵扣券。未核销的券是未来的成本，统计概览里的「优惠券未核销总额」就是这个数。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      <StatusCountRow options={COUPON_STATUS_OPTIONS} tones={COUPON_STATUS_TONE} counts={data?.summary?.statusCounts} />

      <Card className="mb-3">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="搜索家长手机号 / 昵称"
              value={filters.q}
              onChange={(e) => setFilter('q', e.target.value)}
            />
          </div>
          <Select
            className="w-32"
            value={filters.status}
            onChange={(e) => setFilter('status', e.target.value)}
          >
            <option value="">全部状态</option>
            {COUPON_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <DateRangeFilter
            from={filters.from}
            to={filters.to}
            onFromChange={(v) => setFilter('from', v)}
            onToChange={(v) => setFilter('to', v)}
          />
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <DataState
          loading={loading && !data}
          error={error}
          empty={(data?.items.length ?? 0) === 0}
          emptyText="没有符合条件的优惠券"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>所属家长</TableHead>
                  <TableHead className="w-28 text-right">面额</TableHead>
                  <TableHead className="w-32">来源</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-32">有效期至</TableHead>
                  <TableHead className="w-32">使用时间</TableHead>
                  <TableHead className="w-36">抵扣订单</TableHead>
                  <TableHead className="w-32">发放时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-sm text-foreground">{row.userLabel}</TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold text-foreground">
                      {formatCents(row.amountCents)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {COUPON_SOURCE_LABEL[row.source] ?? row.source}
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={COUPON_STATUS_TONE[row.status] ?? 'gray'}>{row.statusLabel}</ToneBadge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.expiresAt ? formatDateTime(row.expiresAt) : '长期有效'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.usedAt ? formatDateTime(row.usedAt) : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.usedOrderNo || '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(row.createdAt)}
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
              totalPages={totalPagesOf(data)}
              onPageChange={setPage}
              onPageSizeChange={changePageSize}
            />
          ) : null}
        </DataState>
      </Card>
    </div>
  )
}
