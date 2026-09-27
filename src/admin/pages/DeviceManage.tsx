import { useState } from 'react'
import { toast } from 'sonner'
import { Eye, Link2Off, Loader2, RefreshCw, Search, Trash2 } from 'lucide-react'
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
import {
  api,
  errorMessageOf,
  formatDateTime,
  formatRelative,
  type DeviceDetail,
  type DeviceRow,
} from '../api'
import { useAsyncData, useFilters } from '../hooks/useAsyncData'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { CommandStatusBadge, DataState, OnlineBadge, PageHeader, Pagination, ToneBadge } from '../components/ui-kit'

export default function DeviceManagePage() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({
    q: '',
    bound: '',
    status: '',
    locked: '',
  })

  const { data: rows, loading, error, reload: load } = useAsyncData(
    () =>
      api.devices.list({
        q: filters.q.trim() || undefined,
        bound: filters.bound || undefined,
        status: filters.status || undefined,
        locked: filters.locked || undefined,
        page,
        pageSize,
      }),
    { deps: [filters.q, filters.bound, filters.status, filters.locked, page, pageSize], debounceMs: 250 },
  )

  const [detail, setDetail] = useState<DeviceDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [unbindTarget, setUnbindTarget] = useState<DeviceRow | null>(null)
  const [removeTarget, setRemoveTarget] = useState<DeviceRow | null>(null)
  const [removeTyped, setRemoveTyped] = useState('')
  const [working, setWorking] = useState(false)

  const openDetail = async (row: DeviceRow) => {
    setDetailLoading(true)
    try {
      setDetail(await api.devices.get(row.id))
    } catch (e) {
      toast.error(errorMessageOf(e, '设备详情加载失败'))
    } finally {
      setDetailLoading(false)
    }
  }

  const doUnbind = async () => {
    if (!unbindTarget) return
    setWorking(true)
    try {
      await api.devices.unbind(unbindTarget.id)
      toast.success(`已解绑「${unbindTarget.name}」，该设备现在可被其他账号认领`)
      setUnbindTarget(null)
      load()
    } catch (e) {
      toast.error(errorMessageOf(e, '解绑失败'))
    } finally {
      setWorking(false)
    }
  }

  const doRemove = async () => {
    if (!removeTarget) return
    setWorking(true)
    try {
      const res = await api.devices.remove(removeTarget.id)
      toast.success(
        res.removedMediaFiles > 0 ? `已删除设备，同时清理 ${res.removedMediaFiles} 个媒体文件` : '设备已删除',
      )
      setRemoveTarget(null)
      setRemoveTyped('')
      load()
    } catch (e) {
      toast.error(errorMessageOf(e, '删除失败'))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="设备管理"
        description="全平台的孩子设备。待认领 = 孩子已装好客户端但家长还没输入绑定码。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      <Card className="mb-3">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filters.q}
              onChange={(e) => setFilter('q', e.target.value)}
              placeholder="搜索设备名 / 型号 / 绑定码"
              className="pl-9"
            />
          </div>
          <Select value={filters.bound} onChange={(e) => setFilter('bound', e.target.value)} className="w-32">
            <option value="">绑定状态</option>
            <option value="true">已认领</option>
            <option value="false">待认领</option>
          </Select>
          <Select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} className="w-28">
            <option value="">在线状态</option>
            <option value="online">在线</option>
            <option value="offline">离线</option>
          </Select>
          <Select value={filters.locked} onChange={(e) => setFilter('locked', e.target.value)} className="w-28">
            <option value="">锁定状态</option>
            <option value="true">已锁定</option>
            <option value="false">未锁定</option>
          </Select>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <DataState
          loading={loading && !rows}
          error={error}
          empty={(rows?.items.length ?? 0) === 0}
          emptyText="没有符合条件的设备"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>设备</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>归属家长</TableHead>
                  <TableHead>电量</TableHead>
                  <TableHead>活跃</TableHead>
                  <TableHead>数据量</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows?.items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="font-medium text-foreground">{row.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.model} · {row.os}
                      </div>
                      <div className="font-mono text-[11px] text-muted-foreground">{row.deviceCode}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <OnlineBadge online={row.online} locked={row.locked} />
                        {!row.bound ? <ToneBadge tone="amber">待认领</ToneBadge> : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      {row.owner ? (
                        <>
                          <div className="text-sm text-foreground">{row.owner.nickname}</div>
                          <div className="text-xs text-muted-foreground">{row.owner.phone || `#${row.owner.id}`}</div>
                        </>
                      ) : (
                        <span className="text-sm text-muted-foreground">未认领</span>
                      )}
                    </TableCell>
                    <TableCell>{row.battery}%</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatRelative(row.lastActiveAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      指令 {row.counts.commands} · 媒体 {row.counts.media}
                      <br />
                      位置 {row.counts.locations} · 答题 {row.counts.quizRecords}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openDetail(row)} title="查看详情">
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!row.bound}
                          onClick={() => setUnbindTarget(row)}
                          title="强制解绑"
                        >
                          <Link2Off className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => {
                            setRemoveTarget(row)
                            setRemoveTyped('')
                          }}
                          title="删除设备"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
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

      {/* 详情 */}
      <Dialog open={Boolean(detail) || detailLoading} onOpenChange={(open) => (!open ? setDetail(null) : null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>设备详情</DialogTitle>
            <DialogDescription>
              展示管控配置与执行统计。出于隐私考虑，后台不提供孩子的位置轨迹与照片内容查看。
            </DialogDescription>
          </DialogHeader>

          {detailLoading || !detail ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载中…
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">设备名</div>
                  <div className="font-medium text-foreground">{detail.device.name}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">设备 ID</div>
                  <div className="truncate font-mono text-xs text-foreground">{detail.device.id}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">型号 / 系统</div>
                  <div className="text-foreground">
                    {detail.device.model} · {detail.device.os}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">客户端版本</div>
                  <div className="text-foreground">{detail.device.agentVersion || '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">状态</div>
                  <div className="flex gap-1">
                    <OnlineBadge online={detail.device.online} locked={detail.device.locked} />
                    {!detail.device.bound ? <ToneBadge tone="amber">待认领</ToneBadge> : null}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">归属家长</div>
                  <div className="text-foreground">
                    {detail.owner ? `${detail.owner.nickname}（${detail.owner.phone || `#${detail.owner.id}`}）` : '未认领'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">认领时间</div>
                  <div className="text-foreground">{formatDateTime(detail.device.boundAt)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">最近活跃</div>
                  <div className="text-foreground">{formatRelative(detail.device.lastActiveAt)}</div>
                </div>
              </div>

              {detail.device.tempUnlockUntil ? (
                <div className="rounded-lg bg-green-50 p-3 text-sm text-green-700">
                  临时解锁至 {formatDateTime(detail.device.tempUnlockUntil)}
                </div>
              ) : null}

              {/* 管控配置快照 */}
              <div className="space-y-2">
                <div className="text-sm font-medium">管控配置</div>
                <div className="rounded-lg bg-muted p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">每日时长</span>
                    <span className="text-foreground">
                      {detail.timePlan
                        ? detail.timePlan.dailyLimitMinutes > 0
                          ? `${detail.timePlan.usedTodayMinutes} / ${detail.timePlan.dailyLimitMinutes} 分钟`
                          : '未限制'
                        : '—'}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-muted-foreground">答题解锁</span>
                    <span className="text-foreground">
                      {detail.quizConfig?.enabled
                        ? `已开启（${detail.quizConfig.quizType} · ${detail.quizConfig.grade} · 奖励 ${detail.quizConfig.correctRewardMinutes} 分钟）`
                        : '未开启'}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-muted-foreground">待审核应用</span>
                    <span className="text-foreground">{detail.pendingAuditCount} 个</span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(detail.features).map(([key, enabled]) => (
                    <ToneBadge key={key} tone={enabled ? 'green' : 'gray'}>
                      {key}
                    </ToneBadge>
                  ))}
                </div>

                {detail.appLimits.length > 0 ? (
                  <div className="rounded-lg bg-muted p-3 text-sm">
                    <div className="mb-1 text-xs text-muted-foreground">应用限制</div>
                    {detail.appLimits.map((a) => (
                      <div key={a.appName} className="flex justify-between">
                        <span className="text-foreground">{a.appName}</span>
                        <span className={a.enabled ? 'text-foreground' : 'text-muted-foreground line-through'}>
                          {a.dailyLimitMinutes} 分钟
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}

                {detail.blockedUrls.length > 0 ? (
                  <div className="rounded-lg bg-muted p-3 text-sm">
                    <div className="mb-1 text-xs text-muted-foreground">网址拦截（{detail.blockedUrls.length}）</div>
                    <div className="flex flex-wrap gap-1.5">
                      {detail.blockedUrls.map((u) => (
                        <span key={u} className="rounded bg-card px-2 py-0.5 font-mono text-xs text-foreground">
                          {u}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              <div>
                <div className="mb-2 text-sm font-medium">最近指令</div>
                {detail.recentCommands.length === 0 ? (
                  <p className="text-sm text-muted-foreground">暂无指令记录</p>
                ) : (
                  <div className="space-y-1.5">
                    {detail.recentCommands.map((c) => (
                      <div key={c.id} className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
                        <div className="min-w-0">
                          <span className="text-foreground">{c.label}</span>
                          {c.error ? (
                            <span className="ml-2 text-xs text-destructive">{c.error}</span>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-xs text-muted-foreground">{formatDateTime(c.createdAt)}</span>
                          <CommandStatusBadge status={c.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 强制解绑 */}
      <ConfirmDialog
        open={Boolean(unbindTarget)}
        onOpenChange={(open) => (!open ? setUnbindTarget(null) : null)}
        title="强制解绑设备"
        description={
          <>
            将解除「{unbindTarget?.name}」与家长「{unbindTarget?.owner?.nickname}」的绑定关系。
            设备记录会保留，孩子手机上的客户端仍可继续运行并等待新的家长认领；原家长将立即失去对这台设备的控制权。
          </>
        }
        confirmText="确认解绑"
        destructive={false}
        loading={working}
        onConfirm={doUnbind}
      />

      {/* 删除设备 */}
      <ConfirmDialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null)
            setRemoveTyped('')
          }
        }}
        title="删除设备"
        description={
          <>
            将永久删除「{removeTarget?.name}」及其 {removeTarget?.counts.commands} 条指令、
            {removeTarget?.counts.media} 个媒体文件、{removeTarget?.counts.locations} 条位置记录。
            删除后孩子手机上的客户端需要重新配对才能再次接入。
          </>
        }
        confirmText="永久删除"
        loading={working}
        requireText={removeTarget?.deviceCode}
        typedText={removeTyped}
        onTypedTextChange={setRemoveTyped}
        onConfirm={doRemove}
      />
    </div>
  )
}
