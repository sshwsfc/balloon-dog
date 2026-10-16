import { useState } from 'react'
import { Loader2, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { api, errorMessageOf, formatDateTime, type InvoiceRow } from '../../api'
import { useAsyncData, useFilters } from '../../hooks/useAsyncData'
import { DataState, PageHeader, Pagination, ToneBadge } from '../../components/ui-kit'
import { INVOICE_STATUS_OPTIONS, INVOICE_STATUS_TONE, formatCents, labelOf } from './shared'

type Pending = { row: InvoiceRow; action: 'issue' | 'reject' }

/**
 * 开票申请。
 *
 * 「标为已开具」必须带发票号码：没有号码的「已开具」等于什么都没做，
 * 家长那边拿不到凭证，财务那边也对不上账 —— 后端也是这么校验的（422），
 * 前端先拦一次只是为了让运营少跑一个来回。
 */
export function InvoicesTab() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({ status: '' })

  const { data, loading, error, reload: load } = useAsyncData(
    () => api.payments.invoices({ status: filters.status || undefined, page, pageSize }),
    { deps: [filters.status, page, pageSize] },
  )

  const [pending, setPending] = useState<Pending | null>(null)
  const [invoiceNo, setInvoiceNo] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const open = (row: InvoiceRow, action: Pending['action']) => {
    setPending({ row, action })
    setInvoiceNo('')
    setNote('')
    setFormError('')
  }

  const confirm = async () => {
    if (!pending) return
    const status = pending.action === 'issue' ? 'issued' : 'rejected'
    const trimmedNo = invoiceNo.trim()

    // 本地拦一道：发票号码为空就不发请求
    if (status === 'issued' && !trimmedNo) {
      setFormError('标记为已开具时必须填写发票号码')
      return
    }

    setSaving(true)
    setFormError('')
    try {
      const res = await api.payments.updateInvoice(pending.row.id, {
        status,
        invoiceNo: trimmedNo || undefined,
        note: note.trim() || undefined,
      })
      toast.success(
        status === 'issued'
          ? `已标记为已开具${res.invoice.invoiceNo ? `（${res.invoice.invoiceNo}）` : ''}`
          : '开票申请已驳回',
      )
      setPending(null)
      load()
    } catch (err: unknown) {
      setFormError(errorMessageOf(err, '操作失败，请稍后重试'))
      console.error('更新开票申请失败：', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="开票申请"
        description="家长端提交的发票申请。「已开具」必须填发票号码；「已驳回」建议写清原因，家长那边看不到备注，但运营复查时要靠它。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      <Card className="mb-3">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} className="w-36">
            <option value="">全部状态</option>
            {INVOICE_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <DataState
          loading={loading && !data}
          error={error}
          empty={(data?.items.length ?? 0) === 0}
          emptyText="没有符合条件的开票申请"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">订单号</TableHead>
                  <TableHead className="w-36">用户</TableHead>
                  <TableHead className="w-40">抬头</TableHead>
                  <TableHead className="w-36">税号</TableHead>
                  <TableHead className="w-40">邮箱</TableHead>
                  <TableHead className="w-24 text-right">金额</TableHead>
                  <TableHead className="w-28">状态</TableHead>
                  <TableHead className="w-36">发票号码</TableHead>
                  <TableHead className="w-32">申请时间</TableHead>
                  <TableHead className="w-40">备注</TableHead>
                  <TableHead className="w-40 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {row.orderNo}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-foreground">{row.userNickname || '—'}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {row.userPhone || `#${row.userId}`}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-foreground">{row.title || '—'}</TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      {row.taxNo || '—'}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      {row.email || '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono text-sm text-foreground">
                      {formatCents(row.amountCents)}
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={INVOICE_STATUS_TONE[row.status] ?? 'gray'}>
                        {row.statusLabel || labelOf(INVOICE_STATUS_OPTIONS, row.status)}
                      </ToneBadge>
                      {row.issuedAt ? (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {formatDateTime(row.issuedAt)}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-foreground">
                      {row.invoiceNo || '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(row.createdAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.note || '—'}</TableCell>
                    <TableCell className="text-right">
                      {row.status === 'pending' ? (
                        <div className="flex justify-end gap-1">
                          <Button variant="outline" size="sm" onClick={() => open(row, 'issue')}>
                            标为已开具
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => open(row, 'reject')}>
                            驳回
                          </Button>
                        </div>
                      ) : (
                        <span className="px-2 text-xs text-muted-foreground">已完结</span>
                      )}
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

      <ConfirmDialog
        open={Boolean(pending)}
        onOpenChange={(open2) => (!open2 ? setPending(null) : null)}
        title={pending?.action === 'issue' ? '标记为已开具' : '驳回开票申请'}
        description={
          pending
            ? `${pending.row.orderNo} · ${pending.row.title || '未填抬头'} · ${formatCents(pending.row.amountCents)}`
            : undefined
        }
        confirmText={pending?.action === 'issue' ? '确认已开具' : '确认驳回'}
        destructive={pending?.action === 'reject'}
        loading={saving}
        onConfirm={confirm}
      >
        <div className="space-y-3">
          {pending?.action === 'issue' ? (
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">发票号码（必填）</span>
              <Input
                value={invoiceNo}
                onChange={(e) => setInvoiceNo(e.target.value)}
                placeholder="例如：044021900111"
              />
            </label>
          ) : null}
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">
              {pending?.action === 'issue' ? '备注（选填）' : '驳回原因（选填，建议填写）'}
            </span>
            <Textarea
              rows={3}
              maxLength={200}
              placeholder={pending?.action === 'issue' ? '例如：已在电子税局开具并发送到邮箱' : '例如：抬头与订单主体不一致'}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
        </div>
      </ConfirmDialog>
    </div>
  )
}
