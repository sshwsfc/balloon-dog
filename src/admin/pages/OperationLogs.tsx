import { useState } from 'react'
import { AlertOctagon, Loader2, RefreshCw, Search } from 'lucide-react'
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
import { api, formatDateTime, type OperationLogRow } from '../api'
import { useAsyncData, useFilters } from '../hooks/useAsyncData'
import { DataState, PageHeader, Pagination, ToneBadge } from '../components/ui-kit'
import { METHOD_TONE } from '../components/status'

/** 把路径里的 id 段收敛成占位符，让「同一类操作」在列表里更好辨认。 */
function simplifyPath(path: string): string {
  return path
    .replace(/^\/api/, '')
    .replace(/\/\d+/g, '/:id')
    .replace(/\/c[a-z0-9]{20,}/gi, '/:id')
}

export default function OperationLogPage() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({
    action: '',
    status: '',
    onlyFailed: false,
  })

  const { data: rows, loading, error, reload: load } = useAsyncData(
    () =>
      api.logs.list({
        action: filters.action.trim() || undefined,
        onlyFailed: filters.onlyFailed ? 'true' : undefined,
        status: filters.status || undefined,
        page,
        pageSize,
      }),
    {
      deps: [filters.action, filters.onlyFailed, filters.status, page, pageSize],
      debounceMs: 250,
    },
  )

  const [detail, setDetail] = useState<OperationLogRow | null>(null)

  const prettyDetail = (raw: string | null): string => {
    if (!raw) return '—'
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      return raw
    }
  }

  return (
    <div>
      <PageHeader
        title="操作日志"
        description="每一次后台请求（含登录尝试）都会落库。密码、密钥、令牌等字段在写入前已脱敏。"
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
              value={filters.action}
              onChange={(e) => setFilter('action', e.target.value)}
              placeholder="搜索操作描述，如「禁用」「删除设备」"
              className="pl-9"
            />
          </div>
          <Select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} className="w-32">
            <option value="">全部结果</option>
            <option value="200">成功 (2xx)</option>
            <option value="400">参数错误 (400)</option>
            <option value="401">未授权 (401)</option>
            <option value="403">无权限 (403)</option>
            <option value="404">不存在 (404)</option>
            <option value="409">冲突 (409)</option>
            <option value="429">被限流 (429)</option>
            <option value="500">服务端错误 (500)</option>
          </Select>
          <Button
            variant={filters.onlyFailed ? 'destructive' : 'outline'}
            size="sm"
            onClick={() => setFilter('onlyFailed', !filters.onlyFailed)}
          >
            <AlertOctagon className="h-3.5 w-3.5" />
            只看失败
          </Button>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <DataState
          loading={loading && !rows}
          error={error}
          empty={(rows?.items.length ?? 0) === 0}
          emptyText="没有符合条件的操作日志"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">时间</TableHead>
                  <TableHead className="w-36">操作人</TableHead>
                  <TableHead>操作</TableHead>
                  <TableHead className="w-20">方法</TableHead>
                  <TableHead className="w-20">结果</TableHead>
                  <TableHead className="w-32">来源 IP</TableHead>
                  <TableHead className="w-16 text-right">详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows?.items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(row.createdAt)}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs text-foreground">{row.adminName || '—'}</span>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-foreground">{row.action}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">{simplifyPath(row.path)}</div>
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={METHOD_TONE[row.method] ?? 'gray'}>{row.method}</ToneBadge>
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={row.status < 400 ? 'green' : row.status < 500 ? 'amber' : 'red'}>
                        {row.status}
                      </ToneBadge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {row.ip || '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => setDetail(row)}>
                        查看
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {rows ? (
            <Pagination
              page={rows.page}
              pageSize={pageSize}
              total={rows.total}
              totalPages={rows.totalPages}
              onPageChange={setPage}
              onPageSizeChange={changePageSize}
            />
          ) : null}
        </DataState>
      </Card>

      <Dialog open={Boolean(detail)} onOpenChange={(open) => (!open ? setDetail(null) : null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detail?.action}</DialogTitle>
            <DialogDescription>
              {detail ? `${detail.method} ${detail.path}` : ''}
            </DialogDescription>
          </DialogHeader>
          {detail ? (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-muted-foreground">操作人</div>
                  <div className="font-mono text-foreground">
                    {detail.adminName || '—'}
                    {detail.adminId ? ` (#${detail.adminId})` : ''}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">响应状态</div>
                  <ToneBadge tone={detail.status < 400 ? 'green' : detail.status < 500 ? 'amber' : 'red'}>
                    {detail.status}
                  </ToneBadge>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">时间</div>
                  <div className="text-foreground">{formatDateTime(detail.createdAt)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">来源 IP</div>
                  <div className="font-mono text-foreground">{detail.ip || '—'}</div>
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs text-muted-foreground">
                  请求参数（密码 / 密钥 / 令牌已脱敏为 ***）
                </div>
                <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs text-foreground">
                  {prettyDetail(detail.detail)}
                </pre>
              </div>
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
