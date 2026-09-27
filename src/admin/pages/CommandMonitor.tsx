import { useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Ban, Loader2, RefreshCw, Search } from 'lucide-react'
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
import { api, errorMessageOf, formatDateTime, type CommandView } from '../api'
import { useAsyncData, useFilters } from '../hooks/useAsyncData'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { CommandStatusBadge, DataState, PageHeader, Pagination, ToneBadge } from '../components/ui-kit'

/** 只列常用指令类型，避免下拉框过长；后端仍接受任意合法类型。 */
const COMMAND_TYPES = [
  { value: '', label: '全部类型' },
  { value: 'lock', label: '锁屏' },
  { value: 'unlock', label: '解锁' },
  { value: 'temp_unlock', label: '临时解锁' },
  { value: 'cancel_temp_unlock', label: '取消临时解锁' },
  { value: 'remote_photo', label: '远程拍照' },
  { value: 'screenshot', label: '屏幕截图' },
  { value: 'start_recording', label: '开始录像' },
  { value: 'stop_recording', label: '停止录像' },
  { value: 'start_audio', label: '开始录音' },
  { value: 'stop_audio', label: '停止录音' },
  { value: 'fetch_location', label: '获取位置' },
  { value: 'sync_config', label: '同步配置' },
]

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '等待设备响应' },
  { value: 'dispatched', label: '设备执行中' },
  { value: 'succeeded', label: '已完成' },
  { value: 'failed', label: '执行失败' },
  { value: 'expired', label: '已超时' },
  { value: 'cancelled', label: '已撤销' },
]

export default function CommandMonitorPage() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({
    status: '',
    type: '',
    deviceId: '',
    onlyFailed: false,
  })

  const { data: rows, loading, error, reload: load } = useAsyncData(
    () =>
      api.commands.list({
        status: filters.status || undefined,
        type: filters.type || undefined,
        onlyFailed: filters.onlyFailed ? 'true' : undefined,
        deviceId: filters.deviceId.trim() || undefined,
        page,
        pageSize,
      }),
    {
      deps: [filters.status, filters.type, filters.onlyFailed, filters.deviceId, page, pageSize],
      debounceMs: 250,
    },
  )

  const [detail, setDetail] = useState<CommandView | null>(null)
  const [cancelTarget, setCancelTarget] = useState<CommandView | null>(null)
  const [working, setWorking] = useState(false)

  const doCancel = async () => {
    if (!cancelTarget) return
    setWorking(true)
    try {
      const res = await api.commands.cancel(cancelTarget.id)
      toast.success(res.cancelled ? '指令已撤销' : '该指令已被设备领取，无法撤销')
      setCancelTarget(null)
      load()
    } catch (e) {
      toast.error(errorMessageOf(e, '撤销失败'))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="指令监控"
        description="平台全量指令。指令由家长下发、设备端 Agent 执行后回报，「已完成」才代表设备真的执行了。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      <Card className="mb-3">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <Select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} className="w-40">
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select value={filters.type} onChange={(e) => setFilter('type', e.target.value)} className="w-36">
            {COMMAND_TYPES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filters.deviceId}
              onChange={(e) => setFilter('deviceId', e.target.value)}
              placeholder="按设备 ID 精确筛选"
              className="pl-9"
            />
          </div>
          <Button
            variant={filters.onlyFailed ? 'destructive' : 'outline'}
            size="sm"
            onClick={() => setFilter('onlyFailed', !filters.onlyFailed)}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            只看失败/超时
          </Button>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <DataState
          loading={loading && !rows}
          error={error}
          empty={(rows?.items.length ?? 0) === 0}
          emptyText="没有符合条件的指令"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>指令</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>设备 / 家长</TableHead>
                  <TableHead>下发时间</TableHead>
                  <TableHead>耗时</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows?.items.map((row) => {
                  const cost =
                    row.dispatchedAt && row.finishedAt
                      ? `${Math.max(0, (new Date(row.finishedAt).getTime() - new Date(row.dispatchedAt).getTime()) / 1000).toFixed(1)}s`
                      : row.status === 'pending'
                        ? '等待领取'
                        : '—'
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="font-medium text-foreground">{row.label}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{row.type}</div>
                        {row.error ? <div className="mt-0.5 text-xs text-destructive">{row.error}</div> : null}
                      </TableCell>
                      <TableCell>
                        <CommandStatusBadge status={row.status} />
                      </TableCell>
                      <TableCell>
                        <div className="text-sm text-foreground">{row.deviceName || '—'}</div>
                        <div className="text-xs text-muted-foreground">
                          {row.owner ? row.owner.phone || row.owner.nickname : '未认领'}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(row.createdAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{cost}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setDetail(row)}>
                            详情
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={row.status !== 'pending'}
                            onClick={() => setCancelTarget(row)}
                            title={row.status === 'pending' ? '撤销指令' : '仅等待中的指令可撤销'}
                          >
                            <Ban className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          {rows ? (
            <Pagination
              page={rows.page}
              pageSize={rows.pageSize}
              total={rows.total}
              totalPages={rows.totalPages}
              onPageChange={setPage}
              onPageSizeChange={changePageSize}
            />
          ) : null}
        </DataState>
      </Card>

      {/* 指令详情 */}
      <Dialog open={Boolean(detail)} onOpenChange={(open) => (!open ? setDetail(null) : null)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>指令详情</DialogTitle>
            <DialogDescription className="font-mono text-xs">{detail?.id}</DialogDescription>
          </DialogHeader>
          {detail ? (
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">类型</span>
                <span className="text-foreground">
                  {detail.label}（<span className="font-mono text-xs">{detail.type}</span>）
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">状态</span>
                <CommandStatusBadge status={detail.status} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">设备</span>
                <span className="text-foreground">{detail.deviceName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">下发</span>
                <span className="text-foreground">{formatDateTime(detail.createdAt)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">设备领取</span>
                <span className="text-foreground">{formatDateTime(detail.dispatchedAt)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">执行完成</span>
                <span className="text-foreground">{formatDateTime(detail.finishedAt)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">过期时间</span>
                <span className="text-foreground">{formatDateTime(detail.expiresAt)}</span>
              </div>
              {detail.error ? (
                <div className="rounded-lg bg-destructive/10 p-3 text-destructive">{detail.error}</div>
              ) : null}
              <div>
                <div className="mb-1 text-xs text-muted-foreground">指令参数</div>
                <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs text-foreground">
                  {JSON.stringify(detail.payload ?? {}, null, 2)}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-xs text-muted-foreground">设备回报</div>
                <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs text-foreground">
                  {JSON.stringify(detail.result ?? null, null, 2)}
                </pre>
              </div>
              {detail.status === 'pending' ? (
                <p className="text-xs text-amber-600">
                  该指令仍在等待设备领取。设备离线时会一直排队，直到超过过期时间。
                </p>
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

      <ConfirmDialog
        open={Boolean(cancelTarget)}
        onOpenChange={(open) => (!open ? setCancelTarget(null) : null)}
        title="撤销指令"
        description={
          <>
            将撤销「{cancelTarget?.label}」指令。如果该指令会改变设备状态（如临时解锁），
            服务端的期望状态会一并回滚。
          </>
        }
        confirmText="撤销"
        loading={working}
        onConfirm={doCancel}
      />

      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
        <ToneBadge tone="amber">等待设备响应</ToneBadge>
        <span>= 已下发但设备还没领取（设备离线时会一直排队直到超时）</span>
      </div>
    </div>
  )
}
