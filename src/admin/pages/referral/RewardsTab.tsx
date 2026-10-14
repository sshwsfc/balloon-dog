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
  REWARD_KIND_OPTIONS,
  REWARD_KIND_TONE,
  REWARD_STATUS_OPTIONS,
  REWARD_STATUS_TONE,
  dayEnd,
  dayStart,
  formatCents,
  totalPagesOf,
} from './shared'

/**
 * 返现明细。
 *
 * 每一行都是一笔「该发给谁多少钱」的账，金额 = 订单实付 × 阶梯比例，封顶时会被截断，
 * 所以表里同时给出基数、比例和结果 —— 运营对账时要能当场验算，而不是只看到一个数。
 */
export function RewardsTab() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({
    q: '',
    status: '',
    kind: '',
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
      api.referral.rewards.list({
        q: filters.q.trim() || undefined,
        status: filters.status || undefined,
        kind: filters.kind || undefined,
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
        title="返现明细"
        description="首充返现与续费返现的逐笔台账。待发放按当月统计，到结算窗口后统一置为已发放；订单退款或判定作弊会置为已取消（不计入总返现额）。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      <StatusCountRow options={REWARD_STATUS_OPTIONS} tones={REWARD_STATUS_TONE} counts={data?.summary?.statusCounts} />

      <Card className="mb-3">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="搜索返现单号 / 订单号 / 家长"
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
            {REWARD_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select className="w-32" value={filters.kind} onChange={(e) => setFilter('kind', e.target.value)}>
            <option value="">全部类型</option>
            {REWARD_KIND_OPTIONS.map((o) => (
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
          emptyText="没有符合条件的返现记录"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-36">返现单号</TableHead>
                  <TableHead>邀请人 → 被邀请人</TableHead>
                  <TableHead className="w-36">关联订单</TableHead>
                  <TableHead className="w-24">类型</TableHead>
                  <TableHead className="w-52 text-right">计算过程</TableHead>
                  <TableHead className="w-28 text-right">返现额</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-24">结算月</TableHead>
                  <TableHead className="w-32">创建时间</TableHead>
                  <TableHead className="w-32">取消原因</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">{row.rewardNo}</TableCell>
                    <TableCell className="text-sm text-foreground">
                      {row.inviterLabel}
                      <span className="mx-1 text-muted-foreground">→</span>
                      {row.inviteeLabel}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.orderNo || '—'}
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={REWARD_KIND_TONE[row.kind] ?? 'gray'}>{row.kindLabel}</ToneBadge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {formatCents(row.baseAmountCents)} × {row.ratePercent}%
                      {row.capApplied ? (
                        <span className="ml-1 text-amber-600" title="该笔命中单笔返现上限，已按上限发放">
                          · 封顶
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold text-primary">
                      {formatCents(row.amountCents)}
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={REWARD_STATUS_TONE[row.status] ?? 'gray'}>{row.statusLabel}</ToneBadge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{row.settleMonth || '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(row.createdAt)}
                      {row.settledAt ? (
                        <span className="block">发放：{formatDateTime(row.settledAt)}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.cancelReason || '—'}</TableCell>
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
