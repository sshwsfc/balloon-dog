import { Loader2, RefreshCw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input, Select } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, formatDateTime } from '../../api'
import { useAsyncData, useFilters } from '../../hooks/useAsyncData'
import { DataState, PageHeader, Pagination, ToneBadge } from '../../components/ui-kit'
import { DateRangeFilter } from './parts'
import { REFERRAL_STATUS_OPTIONS, REFERRAL_STATUS_TONE, dayEnd, dayStart, formatCents, totalPagesOf } from './shared'

/** 邀请关系列表：谁邀请了谁、什么时候、有没有转成有效邀请。 */
export function InviteesTab() {
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
      api.referral.invitees.list({
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
        title="邀请记录"
        description="每一条邀请关系：家长 A 通过邀请码拉来家长 B。绑定即产生记录（已注册），B 首次付费后转为有效邀请，作弊或退款会被作废。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      <Card className="mb-3 border-dashed">
        <CardContent className="p-3 text-xs text-muted-foreground">
          邀请记录接口不返回按状态的合计（返现 / 优惠券 / 提现三个列表才返回 <code>summary</code>），
          所以这里没有状态计数行。要看待审核、有效、作废的总量请到「统计概览」。
        </CardContent>
      </Card>

      <Card className="mb-3">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="搜索邀请码 / 邀请人 / 被邀请人"
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
            {REFERRAL_STATUS_OPTIONS.map((o) => (
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
          emptyText="没有符合条件的邀请记录"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">邀请码</TableHead>
                  <TableHead>邀请人</TableHead>
                  <TableHead>被邀请人</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-32">绑定时间</TableHead>
                  <TableHead className="w-32">转为有效</TableHead>
                  <TableHead className="w-28 text-right">该被邀请人累计返现</TableHead>
                  <TableHead className="w-40">作废原因</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">{row.code}</TableCell>
                    <TableCell className="text-sm text-foreground">{row.inviterLabel}</TableCell>
                    <TableCell className="text-sm text-foreground">{row.inviteeLabel}</TableCell>
                    <TableCell>
                      <ToneBadge tone={REFERRAL_STATUS_TONE[row.status] ?? 'gray'}>{row.statusLabel}</ToneBadge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(row.boundAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.validAt ? formatDateTime(row.validAt) : '—'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      <span className={row.rewardCents > 0 ? 'text-primary' : 'text-muted-foreground'}>
                        {formatCents(row.rewardCents)}
                      </span>
                      <span className="ml-1 text-[11px] text-muted-foreground">({row.rewardCount} 笔)</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.invalidReason || '—'}</TableCell>
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
