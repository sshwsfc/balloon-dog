import { useState } from 'react'
import { BadgeCheck, Ban, Loader2, RefreshCw, Search, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, errorMessageOf, formatDateTime, type ReferralWithdrawalRow } from '../../api'
import { useAsyncData, useFilters } from '../../hooks/useAsyncData'
import { DataState, PageHeader, Pagination, ToneBadge } from '../../components/ui-kit'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { DateRangeFilter, StatusCountRow } from './parts'
import {
  WITHDRAWAL_STATUS_OPTIONS,
  WITHDRAWAL_STATUS_TONE,
  WITHDRAW_CHANNEL_OPTIONS,
  WITHDRAW_CHANNEL_TONE,
  dayEnd,
  dayStart,
  formatCents,
  totalPagesOf,
} from './shared'

type ReviewAction = 'approve' | 'reject' | 'pay'

const ACTION_META: Record<
  ReviewAction,
  { title: string; confirmText: string; destructive: boolean; hint: string }
> = {
  approve: {
    title: '通过提现申请',
    confirmText: '通过',
    destructive: false,
    hint: '通过后申请进入「待打款」，真正转出后仍需再点一次「标记打款」。',
  },
  reject: {
    title: '驳回提现申请',
    confirmText: '驳回',
    destructive: true,
    hint: '驳回是不可逆的，该申请不会再有后续动作；备注会展示给申请人。',
  },
  pay: {
    title: '标记为已打款',
    confirmText: '确认已打款',
    destructive: false,
    hint: '请先在支付宝 / 微信 / 银行完成转账，再确认。这一步只记账，不会真的发起转账。',
  },
}

/** 提现审核：单向状态机 pending → approved → paid，或 pending → rejected。 */
export function WithdrawalsTab() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({
    q: '',
    status: '',
    channel: '',
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
      api.referral.withdrawals.list({
        q: filters.q.trim() || undefined,
        status: filters.status || undefined,
        channel: filters.channel || undefined,
        from: dayStart(filters.from),
        to: dayEnd(filters.to),
        page,
        pageSize,
      }),
    { deps: [filters, page, pageSize], debounceMs: 250 },
  )

  const [review, setReview] = useState<{ row: ReferralWithdrawalRow; action: ReviewAction } | null>(null)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)

  const openReview = (row: ReferralWithdrawalRow, action: ReviewAction) => {
    setReview({ row, action })
    setNote('')
    setReviewError(null)
  }

  const closeReview = () => {
    setReview(null)
    setNote('')
    setReviewError(null)
  }

  const confirmReview = async () => {
    if (!review) return
    setSaving(true)
    setReviewError(null)
    try {
      await api.referral.withdrawals.review(review.row.id, {
        action: review.action,
        note: note.trim() || undefined,
      })
      toast.success(`${ACTION_META[review.action].title}：${review.row.withdrawNo} 已处理`)
      closeReview()
      // 静默重拉：列表已有数据时不会闪 loading，但状态与统计会立刻同步
      load()
    } catch (error: unknown) {
      const message = errorMessageOf(error, '审核失败，请稍后重试')
      setReviewError(message)
      toast.error(message)
      console.error('提现审核失败：', error)
    } finally {
      setSaving(false)
    }
  }

  const statusCounts = data?.summary?.statusCounts

  return (
    <div>
      <PageHeader
        title="提现审核"
        description="家长把已发放的返现余额提现到这里审核。状态只能单向流转：待审核 → 通过 → 已打款，或 待审核 → 已驳回；不可逆、不可回退。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      <StatusCountRow
        options={WITHDRAWAL_STATUS_OPTIONS}
        tones={WITHDRAWAL_STATUS_TONE}
        counts={statusCounts}
      />

      <Card className="mb-3">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="搜索提现单号 / 家长手机号"
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
            {WITHDRAWAL_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select
            className="w-28"
            value={filters.channel}
            onChange={(e) => setFilter('channel', e.target.value)}
          >
            <option value="">全部渠道</option>
            {WITHDRAW_CHANNEL_OPTIONS.map((o) => (
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
          emptyText="没有符合条件的提现申请"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">提现单号</TableHead>
                  <TableHead>申请人</TableHead>
                  <TableHead className="w-36">收款账号</TableHead>
                  <TableHead>实名信息</TableHead>
                  <TableHead className="w-28">渠道</TableHead>
                  <TableHead className="w-28 text-right">金额</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-32">申请时间</TableHead>
                  <TableHead className="w-56">备注</TableHead>
                  <TableHead className="w-44 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.withdrawNo}
                    </TableCell>
                    <TableCell className="text-sm text-foreground">{row.userLabel}</TableCell>
                    <TableCell className="font-mono text-xs text-foreground">{row.account}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.realName || '未实名'}
                      {row.idCardTail ? ` · 尾号 ${row.idCardTail}` : ''}
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={WITHDRAW_CHANNEL_TONE[row.channel] ?? 'gray'}>
                        {row.channelLabel}
                      </ToneBadge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold text-foreground">
                      {formatCents(row.amountCents)}
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={WITHDRAWAL_STATUS_TONE[row.status] ?? 'gray'}>
                        {row.statusLabel}
                      </ToneBadge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(row.createdAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div className="space-y-0.5">
                        <p>家长：{row.userNote || '—'}</p>
                        <p>审核：{row.reviewNote || '—'}</p>
                        {row.paidAt ? <p>打款：{formatDateTime(row.paidAt)}</p> : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {row.status === 'pending' ? (
                          <>
                            <Button variant="outline" size="sm" onClick={() => openReview(row, 'approve')}>
                              <BadgeCheck className="h-3.5 w-3.5" />
                              通过
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => openReview(row, 'reject')}>
                              <Ban className="h-3.5 w-3.5" />
                              驳回
                            </Button>
                          </>
                        ) : null}
                        {row.status === 'approved' ? (
                          <Button variant="outline" size="sm" onClick={() => openReview(row, 'pay')}>
                            <Send className="h-3.5 w-3.5" />
                            标记打款
                          </Button>
                        ) : null}
                        {row.status === 'paid' || row.status === 'rejected' ? (
                          <span className="px-2 text-xs text-muted-foreground">已完结</span>
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
              totalPages={totalPagesOf(data)}
              onPageChange={setPage}
              onPageSizeChange={changePageSize}
            />
          ) : null}
        </DataState>
      </Card>

      {/*
        审核确认框。用通用的 ConfirmDialog 而不是自己拼 Dialog：确认按钮的禁用、
        加载态、危险色都已经在里面，这里只需要把「审核备注」塞进 children。
      */}
      <ConfirmDialog
        open={Boolean(review)}
        onOpenChange={(open) => (!open ? closeReview() : null)}
        title={review ? ACTION_META[review.action].title : ''}
        description={
          review
            ? `${review.row.userLabel} · ${formatCents(review.row.amountCents)} · ${review.row.channelLabel} ${review.row.account}。${ACTION_META[review.action].hint}`
            : undefined
        }
        confirmText={review ? ACTION_META[review.action].confirmText : '确认'}
        destructive={review ? ACTION_META[review.action].destructive : false}
        loading={saving}
        onConfirm={confirmReview}
      >
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">审核备注（选填，驳回时建议填写原因）</span>
          <Textarea
            rows={3}
            maxLength={200}
            placeholder="例如：已核对实名与收款账号一致"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {reviewError ? <p className="text-xs text-destructive">{reviewError}</p> : null}
      </ConfirmDialog>
    </div>
  )
}
