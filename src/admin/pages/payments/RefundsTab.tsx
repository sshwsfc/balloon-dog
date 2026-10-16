import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, formatDateTime } from '../../api'
import { useAsyncData, useFilters } from '../../hooks/useAsyncData'
import { DataState, PageHeader, Pagination, ToneBadge } from '../../components/ui-kit'
import { PAY_STATUS_OPTIONS, PAY_STATUS_TONE, formatCents, labelOf } from './shared'

/**
 * 退款记录。
 *
 * 同时列 `refunding`（已发起、渠道还没回执）和 `refunded`（渠道确认到账）：
 * 只显示成功的那部分，运营会以为退款结束了，而家长的钱可能还在路上。
 */
export function RefundsTab() {
  const { page, setPage, pageSize, changePageSize } = useFilters({})

  const { data, loading, error, reload: load } = useAsyncData(
    () => api.payments.refunds({ page, pageSize }),
    { deps: [page, pageSize] },
  )

  return (
    <div>
      <PageHeader
        title="退款记录"
        description="「退款中」表示已经向渠道发起、还没收到成功回执；「已退款」是渠道确认退回。两种都要盯着。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      <Card className="overflow-hidden">
        <DataState
          loading={loading && !data}
          error={error}
          empty={(data?.items.length ?? 0) === 0}
          emptyText="还没有退款记录"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">退款单号</TableHead>
                  <TableHead className="w-44">订单号</TableHead>
                  <TableHead className="w-36">用户</TableHead>
                  <TableHead className="w-28 text-right">退款金额</TableHead>
                  <TableHead className="w-52">原因</TableHead>
                  <TableHead className="w-32">发起时间</TableHead>
                  <TableHead className="w-32">退款时间</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((row) => (
                  <TableRow key={row.refundNo ?? row.orderNo}>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {row.refundNo || '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {row.orderNo}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-foreground">{row.userNickname || '—'}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {row.userPhone || `#${row.userId}`}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <span className="font-mono text-sm font-medium text-foreground">
                        {formatCents(row.refundCents)}
                      </span>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        订单 {formatCents(row.amountCents)}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.refundReason || '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(row.createdAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(row.refundedAt)}
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={PAY_STATUS_TONE[row.status] ?? 'gray'}>
                        {row.statusLabel || labelOf(PAY_STATUS_OPTIONS, row.status)}
                      </ToneBadge>
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
    </div>
  )
}
