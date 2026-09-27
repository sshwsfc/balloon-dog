import { useState } from 'react'
import { toast } from 'sonner'
import { Eye, Loader2, RefreshCw, Search, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/input'
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
  formatRate,
  formatRelative,
  type UserDetail,
  type UserRow,
} from '../api'
import { useAsyncData, useFilters } from '../hooks/useAsyncData'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { CommandStatusBadge, DataState, OnlineBadge, PageHeader, Pagination, ToneBadge } from '../components/ui-kit'

export default function UserManagePage() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({
    q: '',
    status: '',
  })

  const { data: rows, loading, error, reload: load } = useAsyncData(
    () =>
      api.users.list({
        q: filters.q.trim() || undefined,
        status: filters.status || undefined,
        page,
        pageSize,
      }),
    { deps: [filters.q, filters.status, page, pageSize], debounceMs: 250 },
  )

  const [detail, setDetail] = useState<UserDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [removeTarget, setRemoveTarget] = useState<UserRow | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeTyped, setRemoveTyped] = useState('')

  const openDetail = async (row: UserRow) => {
    setDetailLoading(true)
    try {
      setDetail(await api.users.get(row.id))
    } catch (e) {
      toast.error(errorMessageOf(e, '账号详情加载失败'))
    } finally {
      setDetailLoading(false)
    }
  }

  const toggleStatus = async (row: UserRow) => {
    const next = row.status === 'disabled' ? 'active' : 'disabled'
    setBusyId(row.id)
    try {
      await api.users.setStatus(row.id, next, next === 'disabled' ? '后台手工禁用' : undefined)
      toast.success(next === 'disabled' ? `已禁用 ${row.nickname}` : `已启用 ${row.nickname}`)
      load()
    } catch (e) {
      toast.error(errorMessageOf(e, '操作失败'))
    } finally {
      setBusyId(null)
    }
  }

  const confirmRemove = async () => {
    if (!removeTarget) return
    setRemoving(true)
    try {
      const res = await api.users.remove(removeTarget.id)
      toast.success(
        res.removedMediaFiles > 0
          ? `已删除账号，同时清理 ${res.removedMediaFiles} 个媒体文件`
          : '账号已删除',
      )
      setRemoveTarget(null)
      setRemoveTyped('')
      load()
    } catch (e) {
      toast.error(errorMessageOf(e, '删除失败'))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="家长账号"
        description="平台上的家长账号。禁用后该账号的令牌会立即失效，家长端会被登出。"
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
              placeholder="搜索手机号 / 邮箱 / 昵称"
              className="pl-9"
            />
          </div>
          <Select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} className="w-32">
            <option value="">全部状态</option>
            <option value="active">正常</option>
            <option value="disabled">已禁用</option>
          </Select>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <DataState
          loading={loading && !rows}
          error={error}
          empty={(rows?.items.length ?? 0) === 0}
          emptyText={filters.q || filters.status ? '没有符合条件的账号' : '暂无家长账号'}
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>账号</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>设备</TableHead>
                  <TableHead>指令</TableHead>
                  <TableHead>答题</TableHead>
                  <TableHead>注册时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows?.items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="font-medium text-foreground">{row.nickname}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.phone || row.email || `#${row.id}`}
                        {row.wechatBound ? ' · 已绑定微信' : ''}
                      </div>
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={row.status === 'disabled' ? 'red' : 'green'}>
                        {row.status === 'disabled' ? '已禁用' : '正常'}
                      </ToneBadge>
                    </TableCell>
                    <TableCell>{row.deviceCount}</TableCell>
                    <TableCell>{row.commandCount}</TableCell>
                    <TableCell>{row.quizRecordCount}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(row.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openDetail(row)} title="查看详情">
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyId === row.id}
                          onClick={() => toggleStatus(row)}
                          title={row.status === 'disabled' ? '启用' : '禁用'}
                        >
                          {busyId === row.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : row.status === 'disabled' ? (
                            <ShieldCheck className="h-3.5 w-3.5" />
                          ) : (
                            <ShieldOff className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => {
                            setRemoveTarget(row)
                            setRemoveTyped('')
                          }}
                          title="删除账号"
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
            <DialogTitle>家长账号详情</DialogTitle>
            <DialogDescription>仅展示平台运营所需的信息，不包含孩子的位置、照片等内容。</DialogDescription>
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
                  <div className="text-xs text-muted-foreground">昵称</div>
                  <div className="font-medium text-foreground">{detail.user.nickname}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">账号 ID</div>
                  <div className="font-mono text-foreground">#{detail.user.id}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">手机号</div>
                  <div className="text-foreground">{detail.user.phone || '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">邮箱</div>
                  <div className="text-foreground">{detail.user.email || '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">状态</div>
                  <ToneBadge tone={detail.user.status === 'disabled' ? 'red' : 'green'}>
                    {detail.user.status === 'disabled' ? '已禁用' : '正常'}
                  </ToneBadge>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">注册时间</div>
                  <div className="text-foreground">{formatDateTime(detail.user.createdAt)}</div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted p-3 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">设备</div>
                  <div className="font-medium">
                    {detail.stats.deviceCount}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      （在线 {detail.stats.onlineDeviceCount}）
                    </span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">指令</div>
                  <div className="font-medium">
                    {detail.stats.commandTotal}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      （失败 {detail.stats.commandFailed}）
                    </span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">答题正确率</div>
                  <div className="font-medium">{formatRate(detail.stats.quizAccuracy)}</div>
                </div>
              </div>

              <div>
                <div className="mb-2 text-sm font-medium">绑定设备</div>
                {detail.devices.length === 0 ? (
                  <p className="text-sm text-muted-foreground">该账号还没有绑定任何设备</p>
                ) : (
                  <div className="space-y-2">
                    {detail.devices.map((d) => (
                      <div key={d.id} className="flex items-center justify-between rounded-lg border border-border p-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{d.name}</span>
                            <OnlineBadge online={d.status === 'online'} locked={d.locked} />
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {d.model} · {d.os} · 电量 {d.battery}% · 活跃 {formatRelative(d.lastActiveAt)}
                          </div>
                          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                            绑定码 {d.deviceCode}
                          </div>
                        </div>
                        <div className="shrink-0 text-right text-xs text-muted-foreground">
                          <div>指令 {d.counts.commands}</div>
                          <div>媒体 {d.counts.media}</div>
                          <div>位置 {d.counts.locations}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="mb-2 text-sm font-medium">最近指令</div>
                {detail.recentCommands.length === 0 ? (
                  <p className="text-sm text-muted-foreground">暂无指令记录</p>
                ) : (
                  <div className="space-y-1.5">
                    {detail.recentCommands.map((c) => (
                      <div key={c.id} className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
                        <span className="text-foreground">{c.label}</span>
                        <div className="flex items-center gap-2">
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

      {/* 删除确认：要求输入昵称，避免误删 */}
      <ConfirmDialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null)
            setRemoveTyped('')
          }
        }}
        title="删除家长账号"
        description={
          <>
            将永久删除「{removeTarget?.nickname}」及其名下的 {removeTarget?.deviceCount} 台设备记录、
            {removeTarget?.commandCount} 条指令、{removeTarget?.quizRecordCount} 条答题记录。
            设备与孩子手机上客户端的数据不会自动清除，但会立即失去远程控制能力。
          </>
        }
        confirmText="永久删除"
        loading={removing}
        requireText={removeTarget?.nickname}
        typedText={removeTyped}
        onTypedTextChange={setRemoveTyped}
        onConfirm={confirmRemove}
      />
    </div>
  )
}
