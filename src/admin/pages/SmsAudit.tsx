import { useState } from 'react'
import { toast } from 'sonner'
import { Eraser, Loader2, RefreshCw, Search, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, errorMessageOf, formatDateTime } from '../api'
import { useAsyncData, useFilters } from '../hooks/useAsyncData'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { DataState, PageHeader, Pagination, ToneBadge } from '../components/ui-kit'
import { SMS_PURPOSE_LABEL, SMS_STATE_VIEW } from '../components/status'

export default function SmsAuditPage() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({
    phone: '',
    purpose: '',
    state: '',
  })

  const { data: rows, loading, error, reload: load } = useAsyncData(
    () =>
      api.smsCodes.list({
        phone: filters.phone.trim() || undefined,
        purpose: filters.purpose || undefined,
        state: filters.state || undefined,
        page,
        pageSize,
      }),
    { deps: [filters.phone, filters.purpose, filters.state, page, pageSize], debounceMs: 250 },
  )

  const [purgeOpen, setPurgeOpen] = useState(false)
  const [purging, setPurging] = useState(false)

  const doPurge = async () => {
    setPurging(true)
    try {
      const res = await api.smsCodes.purge()
      toast.success(`已清理 ${res.deleted} 条历史验证码记录`)
      setPurgeOpen(false)
      load()
    } catch (e) {
      toast.error(errorMessageOf(e, '清理失败'))
    } finally {
      setPurging(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="验证码审计"
        description="短信验证码的发送与使用记录，用于排查「收不到验证码」「被短信轰炸」类问题。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              刷新
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPurgeOpen(true)}>
              <Eraser className="h-3.5 w-3.5" />
              清理历史记录
            </Button>
          </>
        }
      />

      <Card className="mb-3 border-amber-200 bg-amber-50">
        <CardContent className="flex items-start gap-2 p-3 text-xs text-amber-800">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            验证码在数据库中只保存 HMAC 哈希，后台<strong>无法查看验证码明文</strong> —— 这是刻意的设计：
            审计表不能成为破解入口。若家长反馈收不到验证码，请结合「发送次数」与「失败尝试次数」判断。
          </p>
        </CardContent>
      </Card>

      {rows && rows.distribution.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {rows.distribution.map((d) => (
            <ToneBadge key={d.purpose} tone="blue">
              {SMS_PURPOSE_LABEL[d.purpose] ?? d.purpose}：{d.count} 条
            </ToneBadge>
          ))}
        </div>
      ) : null}

      <Card className="mb-3">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filters.phone}
              onChange={(e) => setFilter('phone', e.target.value)}
              placeholder="按手机号搜索"
              className="pl-9"
            />
          </div>
          <Select value={filters.purpose} onChange={(e) => setFilter('purpose', e.target.value)} className="w-36">
            <option value="">全部用途</option>
            <option value="register">注册</option>
            <option value="login">验证码登录</option>
            <option value="bind">绑定手机号</option>
          </Select>
          <Select value={filters.state} onChange={(e) => setFilter('state', e.target.value)} className="w-32">
            <option value="">全部状态</option>
            <option value="pending">未使用</option>
            <option value="consumed">已使用</option>
            <option value="expired">已过期</option>
          </Select>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <DataState
          loading={loading && !rows}
          error={error}
          empty={(rows?.items.length ?? 0) === 0}
          emptyText="没有符合条件的验证码记录"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>手机号</TableHead>
                  <TableHead>用途</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>失败尝试</TableHead>
                  <TableHead>发送时间</TableHead>
                  <TableHead>过期 / 使用时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows?.items.map((row) => {
                  const view = SMS_STATE_VIEW[row.state] ?? { label: row.state, tone: 'gray' as const }
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-sm text-foreground">{row.phone}</TableCell>
                      <TableCell>
                        <ToneBadge tone="blue">{SMS_PURPOSE_LABEL[row.purpose] ?? row.purpose}</ToneBadge>
                      </TableCell>
                      <TableCell>
                        <ToneBadge tone={view.tone}>{view.label}</ToneBadge>
                      </TableCell>
                      <TableCell>
                        {row.attempts > 0 ? (
                          <span className={row.attempts >= 5 ? 'font-medium text-destructive' : 'text-amber-600'}>
                            {row.attempts} 次
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDateTime(row.createdAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {row.consumedAt ? `已用于 ${formatDateTime(row.consumedAt)}` : `过期于 ${formatDateTime(row.expiresAt)}`}
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

      <ConfirmDialog
        open={purgeOpen}
        onOpenChange={setPurgeOpen}
        title="清理历史验证码记录"
        description="将删除所有「已被使用」和「已过期」的验证码记录。未使用且未过期的验证码会保留，家长仍可正常完成验证。"
        confirmText="确认清理"
        destructive={false}
        loading={purging}
        onConfirm={doPurge}
      />
    </div>
  )
}
