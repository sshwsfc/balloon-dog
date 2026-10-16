import { useState, type ReactNode } from 'react'
import { Loader2, RefreshCw, RotateCcw, ScrollText, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
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
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { api, errorMessageOf, formatDateTime, type PaymentOrderRow } from '../../api'
import { useAsyncData, useFilters } from '../../hooks/useAsyncData'
import { DataState, PageHeader, Pagination, ToneBadge } from '../../components/ui-kit'
import {
  PAY_CHANNEL_OPTIONS,
  PAY_CHANNEL_TONE,
  PAY_STATUS_OPTIONS,
  PAY_STATUS_TONE,
  PERIOD_LABELS,
  TIER_LABELS,
  centsToYuan,
  eventTone,
  formatCents,
  isBadSignature,
  labelOf,
  resultLabel,
  yuanToCents,
} from './shared'

/**
 * 一笔订单现在还退得了多少。
 * 用订单金额减去已经退掉的部分：部分退款之后再退一次时必须按余额校验，
 * 否则第二次提交会被后端拒绝（前端先说清楚更好）。
 */
function refundableCentsOf(order: PaymentOrderRow): number {
  return Math.max(0, order.amountCents - order.refundCents)
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="break-all font-mono text-xs text-foreground">{children}</div>
    </div>
  )
}

/**
 * 支付订单。
 *
 * 「查看流水」是这一页的主要用途：家长说「我付了但没到账」时，
 * 唯一能解释清楚的就是这笔订单的渠道交互记录（含验签失败的回调）。
 */
export function OrdersTab() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({
    status: '',
    channel: '',
    orderNo: '',
    userId: '',
  })

  const { data, loading, error, reload: load } = useAsyncData(
    () =>
      api.payments.orders({
        status: filters.status || undefined,
        channel: filters.channel || undefined,
        orderNo: filters.orderNo.trim() || undefined,
        userId: filters.userId.trim() ? Number(filters.userId.trim()) : undefined,
        page,
        pageSize,
      }),
    { deps: [filters.status, filters.channel, filters.orderNo, filters.userId, page, pageSize], debounceMs: 250 },
  )

  const [eventsFor, setEventsFor] = useState<PaymentOrderRow | null>(null)
  const [refundFor, setRefundFor] = useState<PaymentOrderRow | null>(null)
  const [refundYuan, setRefundYuan] = useState('')
  const [refundReason, setRefundReason] = useState('')
  const [refundError, setRefundError] = useState('')
  const [refundSaving, setRefundSaving] = useState(false)

  const {
    data: eventData,
    loading: eventsLoading,
    error: eventsError,
  } = useAsyncData(() => api.payments.orderEvents(eventsFor?.orderNo ?? ''), {
    deps: [eventsFor?.orderNo ?? ''],
    enabled: Boolean(eventsFor),
  })

  const openRefund = (order: PaymentOrderRow) => {
    setRefundFor(order)
    setRefundYuan(centsToYuan(refundableCentsOf(order)))
    setRefundReason('')
    setRefundError('')
  }

  const confirmRefund = async () => {
    if (!refundFor) return
    const cents = yuanToCents(refundYuan)
    const reason = refundReason.trim()
    const max = refundableCentsOf(refundFor)

    // 先在本地拦一遍：金额与原因后端都会校验（422），但让运营看到中文原因更直接
    if (cents <= 0) {
      setRefundError('退款金额必须大于 0')
      return
    }
    if (cents > max) {
      setRefundError(`退款金额不能超过可退金额 ${formatCents(max)}`)
      return
    }
    if (reason.length < 2) {
      setRefundError('请填写退款原因（至少 2 个字）')
      return
    }
    if (reason.length > 200) {
      setRefundError('退款原因不能超过 200 个字')
      return
    }

    setRefundSaving(true)
    setRefundError('')
    try {
      const res = await api.payments.refund({ orderNo: refundFor.orderNo, amountCents: cents, reason })
      toast.success(
        res.membershipRevoked
          ? `退款已发起，该家长的会员权益已同时收回（${formatCents(cents)}）`
          : `退款已发起（${formatCents(cents)}）`,
      )
      setRefundFor(null)
      load()
    } catch (err: unknown) {
      setRefundError(errorMessageOf(err, '退款失败，请稍后重试'))
      console.error('发起退款失败：', err)
    } finally {
      setRefundSaving(false)
    }
  }

  const events = eventData?.events ?? []

  return (
    <div>
      <PageHeader
        title="支付订单"
        description="所有渠道的订单（含未支付与已退款）。「查看流水」里能看到渠道回调的验签结果，坏签名的记录会标红。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      <Card className="mb-3">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filters.orderNo}
              onChange={(e) => setFilter('orderNo', e.target.value)}
              placeholder="订单号"
              className="pl-9"
            />
          </div>
          <Input
            value={filters.userId}
            onChange={(e) => setFilter('userId', e.target.value.replace(/[^\d]/g, ''))}
            placeholder="用户 id"
            inputMode="numeric"
            className="w-32"
          />
          <Select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} className="w-32">
            <option value="">全部状态</option>
            {PAY_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select value={filters.channel} onChange={(e) => setFilter('channel', e.target.value)} className="w-32">
            <option value="">全部渠道</option>
            {PAY_CHANNEL_OPTIONS.map((o) => (
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
          emptyText="没有符合条件的订单"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">订单号</TableHead>
                  <TableHead className="w-36">用户</TableHead>
                  <TableHead className="w-36">套餐 / 档位 / 周期</TableHead>
                  <TableHead className="w-28 text-right">金额</TableHead>
                  <TableHead className="w-24">渠道</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-32">支付时间</TableHead>
                  <TableHead className="w-40">渠道流水号</TableHead>
                  <TableHead className="w-36">退款单号</TableHead>
                  <TableHead className="w-40 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((order) => (
                  <TableRow key={order.orderNo}>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {order.orderNo}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-foreground">{order.userNickname || '—'}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {order.userPhone || `#${order.userId}`}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <ToneBadge tone={order.tier === 'super' ? 'purple' : 'blue'}>
                          {TIER_LABELS[order.tier] ?? order.tier}
                        </ToneBadge>
                        <span className="text-xs text-muted-foreground">
                          {PERIOD_LABELS[order.period] ?? order.period}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-muted-foreground">{order.planCode}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <span className="font-mono text-sm font-medium text-foreground">
                        {formatCents(order.amountCents)}
                      </span>
                      {order.originalCents > order.amountCents ? (
                        <div className="font-mono text-[11px] text-muted-foreground">
                          原价 {formatCents(order.originalCents)}
                        </div>
                      ) : null}
                      {order.couponCents > 0 ? (
                        <div className="font-mono text-[11px] text-primary">
                          券抵 −{formatCents(order.couponCents)}
                        </div>
                      ) : null}
                      {order.refundCents > 0 ? (
                        <div className="font-mono text-[11px] text-blue-600">
                          已退 −{formatCents(order.refundCents)}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={PAY_CHANNEL_TONE[order.payChannel] ?? 'gray'}>
                        {order.payChannelLabel}
                      </ToneBadge>
                      {order.missingConfig.length > 0 ? (
                        <div
                          className="mt-1 text-[11px] text-destructive"
                          title={`缺少环境变量：${order.missingConfig.join('、')}`}
                        >
                          渠道未配置
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={PAY_STATUS_TONE[order.status] ?? 'gray'}>
                        {order.statusLabel || labelOf(PAY_STATUS_OPTIONS, order.status)}
                      </ToneBadge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {order.paidAt ? formatDateTime(order.paidAt) : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      {order.transactionId || '—'}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      {order.refundNo || '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setEventsFor(order)}>
                          <ScrollText className="h-3.5 w-3.5" />
                          查看流水
                        </Button>
                        {order.status === 'paid' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!order.canRefund}
                            title={
                              order.canRefund
                                ? '发起退款'
                                : order.invoice?.id
                                  ? '该订单已申请开票，不能退款'
                                  : '已超出退款窗口，不能退款'
                            }
                            onClick={() => openRefund(order)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            退款
                          </Button>
                        ) : null}
                      </div>
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

      {/* 渠道流水：一笔订单的失败原因基本都能在这里读出来 */}
      <Dialog open={Boolean(eventsFor)} onOpenChange={(open) => (!open ? setEventsFor(null) : null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>订单流水 {eventsFor?.orderNo}</DialogTitle>
            <DialogDescription>
              渠道回调与下单记录。验签失败的回调同样落库：家长付了钱而系统不认，原因一般就在这里。
            </DialogDescription>
          </DialogHeader>

          {eventsFor ? (
            <div className="grid grid-cols-2 gap-3 rounded-lg bg-muted p-3 sm:grid-cols-3">
              <Field label="渠道流水号">{eventsFor.transactionId || '—'}</Field>
              <Field label="预支付单号">{eventsFor.prepayId || '—'}</Field>
              <Field label="回调单号">{eventsFor.notifiedOrderNo || '—'}</Field>
              <Field label="退款单号">{eventsFor.refundNo || '—'}</Field>
              <Field label="退款截止">{formatDateTime(eventsFor.refundDeadline)}</Field>
              <Field label="有效期">
                {formatDateTime(eventsFor.startsAt)} → {formatDateTime(eventsFor.expiresAt)}
              </Field>
              <Field label="发票">
                {eventsFor.invoice
                  ? `${eventsFor.invoice.statusLabel}${eventsFor.invoice.invoiceNo ? ` · ${eventsFor.invoice.invoiceNo}` : ''}`
                  : '未申请'}
              </Field>
              <Field label="可支付 / 可退款">
                {eventsFor.canPay ? '可支付' : '不可支付'} / {eventsFor.canRefund ? '可退款' : '不可退款'}
              </Field>
              <Field label="渠道缺配置">
                {eventsFor.missingConfig.length > 0 ? eventsFor.missingConfig.join('、') : '无'}
              </Field>
            </div>
          ) : null}

          <DataState
            loading={eventsLoading}
            error={eventsError}
            empty={events.length === 0}
            emptyText="这笔订单还没有渠道流水"
          >
            <div className="space-y-2">
              {events.map((event) => {
                const bad = isBadSignature(event)
                return (
                  <div
                    key={event.id}
                    className={
                      bad
                        ? 'rounded-lg border border-destructive/40 bg-destructive/5 p-2.5'
                        : 'rounded-lg border border-border p-2.5'
                    }
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium text-foreground">{event.provider}</span>
                      <span className="font-mono text-muted-foreground">{event.kind}</span>
                      <ToneBadge tone={bad ? 'red' : 'green'}>{event.signatureOk ? '验签通过' : '验签失败'}</ToneBadge>
                      <ToneBadge tone={eventTone(event)}>{event.result}</ToneBadge>
                      {resultLabel(event.result) ? (
                        <span className={bad ? 'text-destructive' : 'text-muted-foreground'}>
                          {resultLabel(event.result)}
                        </span>
                      ) : null}
                      <span className="ml-auto text-muted-foreground">{formatDateTime(event.createdAt)}</span>
                    </div>
                    {event.detail ? (
                      <p
                        className={`mt-1 break-all font-mono text-[11px] ${
                          bad ? 'text-destructive' : 'text-muted-foreground'
                        }`}
                      >
                        {event.detail}
                      </p>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </DataState>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEventsFor(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        退款确认框。金额默认填「还能退的全额」——运营点退款通常就是要全退，
        但如果只退一部分（协商退款），改数字即可；原因必填，它会被写进审计。
      */}
      <ConfirmDialog
        open={Boolean(refundFor)}
        onOpenChange={(open) => (!open ? setRefundFor(null) : null)}
        title="发起退款"
        description={
          refundFor
            ? `${refundFor.orderNo} · ${refundFor.userNickname || `#${refundFor.userId}`} · 订单金额 ${formatCents(
                refundFor.amountCents,
              )} · 可退 ${formatCents(refundableCentsOf(refundFor))}`
            : undefined
        }
        confirmText="确认退款"
        loading={refundSaving}
        onConfirm={confirmRefund}
      >
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">退款金额（元，最多两位小数）</span>
            <Input
              value={refundYuan}
              onChange={(e) => setRefundYuan(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">退款原因（必填，2–200 字）</span>
            <Textarea
              rows={3}
              maxLength={200}
              placeholder="例如：家长反馈重复支付，经客服确认全额退回"
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
            />
          </label>
          {refundError ? <p className="text-xs text-destructive">{refundError}</p> : null}
        </div>
      </ConfirmDialog>
    </div>
  )
}
