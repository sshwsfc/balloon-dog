import { useState } from 'react'
import { Loader2, RefreshCw, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { DataState, PageHeader, Pagination } from '../../components/ui-kit'
import { api, errorMessageOf, formatDateTime, type AlertAckRow } from '../../api'
import { useAsyncData, useFilters } from '../../hooks/useAsyncData'
import { formatMetricValue, formatThreshold, snapshotNumber } from './shared'

/**
 * 确认记录。
 *
 * 每条记录都带**确认当时的快照**（由服务端在确认那一刻算），撤销是删除这条记录
 * 而不是标记失效 —— 所以这里同时提供「撤销」入口。
 */
export function AcksTab() {
  const { page, setPage, pageSize, changePageSize } = useFilters({})

  const { data, loading, error, reload: load } = useAsyncData(
    () => api.alerts.acks({ page, pageSize }),
    { deps: [page, pageSize] },
  )

  const [revokeFor, setRevokeFor] = useState<AlertAckRow | null>(null)
  const [revokeSaving, setRevokeSaving] = useState(false)

  const confirmRevoke = async () => {
    if (!revokeFor) return
    setRevokeSaving(true)
    try {
      await api.alerts.removeAck(revokeFor.id)
      toast.success('已撤销确认')
      setRevokeFor(null)
      load()
    } catch (err: unknown) {
      toast.error(errorMessageOf(err, '撤销失败，请稍后重试'))
      console.error('撤销确认失败：', err)
    } finally {
      setRevokeSaving(false)
    }
  }

  const acks = data?.items ?? []

  return (
    <div>
      <PageHeader
        title="确认记录"
        description="谁、在什么时候、以什么备注确认了哪条告警，以及确认那一刻的指标快照。撤销即删除该条记录。"
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
          empty={acks.length === 0}
          emptyText="还没有任何确认记录"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-52">规则</TableHead>
                  <TableHead className="w-28">对象</TableHead>
                  <TableHead className="w-32">确认人</TableHead>
                  <TableHead className="w-64">备注</TableHead>
                  <TableHead className="w-44">确认时快照</TableHead>
                  <TableHead className="w-36">确认时间</TableHead>
                  <TableHead className="w-28 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {acks.map((ack) => {
                  const value = snapshotNumber(ack.snapshot, 'value')
                  const threshold = snapshotNumber(ack.snapshot, 'threshold')
                  const numerator = snapshotNumber(ack.snapshot, 'numerator')
                  const denominator = snapshotNumber(ack.snapshot, 'denominator')
                  return (
                    <TableRow key={ack.id}>
                      <TableCell>
                        <div className="text-sm text-foreground">{ack.label}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{ack.key}</div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {ack.subject ? ack.subject : '全局'}
                      </TableCell>
                      <TableCell className="text-xs text-foreground">{ack.adminName || '管理员'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{ack.note || '（无）'}</TableCell>
                      <TableCell className="text-xs">
                        <span className="tabular-nums text-foreground">{formatMetricValue(value, '%')}</span>
                        {threshold !== null ? (
                          <div className="text-[11px] text-muted-foreground">
                            阈值 ≥ {formatThreshold(threshold, '%')}
                          </div>
                        ) : null}
                        {numerator !== null && denominator !== null ? (
                          <div className="font-mono text-[11px] text-muted-foreground">
                            分子 {numerator} / 分母 {denominator}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDateTime(ack.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" onClick={() => setRevokeFor(ack)}>
                          <Undo2 className="h-3.5 w-3.5" />
                          撤销
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
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

      <ConfirmDialog
        open={Boolean(revokeFor)}
        onOpenChange={(open) => (!open ? setRevokeFor(null) : null)}
        title="撤销确认"
        description={
          revokeFor
            ? `将删除「${revokeFor.label}」的这条确认记录。删除后大盘上这条告警会回到未确认状态。`
            : undefined
        }
        confirmText="撤销确认"
        loading={revokeSaving}
        onConfirm={confirmRevoke}
      >
        {revokeFor ? (
          <div className="space-y-1 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
            <div>确认人：{revokeFor.adminName || '管理员'}</div>
            <div>确认时间：{formatDateTime(revokeFor.createdAt)}</div>
            <div>备注：{revokeFor.note || '（无）'}</div>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}
