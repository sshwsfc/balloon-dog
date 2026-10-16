import { useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, Send, X } from 'lucide-react'
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
import { ConfirmDialog } from '../components/ConfirmDialog'
import { DataState, PageHeader, Pagination, ToneBadge } from '../components/ui-kit'
import {
  api,
  errorMessageOf,
  formatDateTime,
  type TicketPatch,
  type TicketPriority,
  type TicketRow,
  type TicketStatus,
} from '../api'
import { useAsyncData, useFilters } from '../hooks/useAsyncData'
import {
  TICKET_CATEGORY_OPTIONS,
  TICKET_PRIORITY_OPTIONS,
  TICKET_STATUS_OPTIONS,
  categoryLabelOf,
  parentTextOf,
  priorityLabelOf,
  priorityToneOf,
  statusLabelOf,
  statusToneOf,
} from './tickets/shared'

interface TicketFilters extends Record<string, unknown> {
  status: string
  category: string
  priority: string
  keyword: string
}

const ALL = '__all__'
const REPLY_MAX = 2000

/**
 * 工单详情。
 *
 * 三件事在这里做：看家长写了什么与历史来往、该状态 / 优先级、回家长。
 *
 * **内部备注**：后端工单只有 `replies` 一个字段（`{adminId,adminName,at,body}`），
 * 家长端会读到**每一条**管理员回复，`PATCH` 的 body 是 `.strict()` 且只有
 * `status/priority/assigneeId`。所以后台根本没有「家长看不到的内部备注」这个能力，
 * 界面上用一块显式提示把它和家长可见的回复框分开，而不是给一个存不进去的输入框。
 */
function TicketDetailDialog({
  ticketNo,
  onClose,
  onChanged,
}: {
  ticketNo: string
  onClose: () => void
  onChanged: () => void
}) {
  const { data, loading, error, reload } = useAsyncData(() => api.tickets.detail(ticketNo), {
    deps: [ticketNo],
  })
  const ticket: TicketRow | null = data?.ticket ?? null

  // 草稿为 null 时显示后端当前值：避免「拉回数据后 setState」变成 set-state-in-effect
  const [statusDraft, setStatusDraft] = useState<string | null>(null)
  const [priorityDraft, setPriorityDraft] = useState<string | null>(null)
  const [savingMeta, setSavingMeta] = useState(false)

  const [pendingClose, setPendingClose] = useState<TicketPatch | null>(null)
  const [closeReason, setCloseReason] = useState('')
  const [closing, setClosing] = useState(false)

  const [replyBody, setReplyBody] = useState('')
  const [replyError, setReplyError] = useState('')
  const [sending, setSending] = useState(false)

  const status = statusDraft ?? ticket?.status ?? 'open'
  const priority = priorityDraft ?? ticket?.priority ?? 'normal'

  const applyPatch = async (patch: TicketPatch, successText: string) => {
    setSavingMeta(true)
    try {
      await api.tickets.update(ticketNo, patch)
      toast.success(successText)
      setStatusDraft(null)
      setPriorityDraft(null)
      reload()
      onChanged()
    } catch (err: unknown) {
      toast.error(errorMessageOf(err, '保存失败，请稍后重试'))
      console.error('更新工单失败：', err)
    } finally {
      setSavingMeta(false)
    }
  }

  const saveMeta = async () => {
    if (!ticket) return
    const patch: TicketPatch = {}
    if (status !== ticket.status) patch.status = status as TicketStatus
    if (priority !== ticket.priority) patch.priority = priority as TicketPriority
    if (Object.keys(patch).length === 0) {
      toast.info('状态与优先级都没有改动')
      return
    }
    // 关闭工单单独走「写原因」的确认流程
    if (patch.status === 'closed') {
      setPendingClose(patch)
      return
    }
    await applyPatch(patch, '工单已更新')
  }

  const confirmClose = async () => {
    if (!pendingClose) return
    setClosing(true)
    try {
      const reason = closeReason.trim()
      // 后端没有「关闭原因」字段，也不允许对已关闭工单回复（409）。
      // 所以要留下原因，只能在关闭**之前**把它作为一条给家长的回复发出去 —— 家长可见。
      if (reason) await api.tickets.reply(ticketNo, { body: reason })
      await api.tickets.update(ticketNo, pendingClose)
      toast.success(reason ? '已回复原因并关闭工单' : '工单已关闭')
      setPendingClose(null)
      setCloseReason('')
      setStatusDraft(null)
      reload()
      onChanged()
    } catch (err: unknown) {
      toast.error(errorMessageOf(err, '关闭失败，请稍后重试'))
      console.error('关闭工单失败：', err)
    } finally {
      setClosing(false)
    }
  }

  const sendReply = async () => {
    const body = replyBody.trim()
    if (!body) {
      setReplyError('回复内容不能为空')
      return
    }
    if (body.length > REPLY_MAX) {
      setReplyError(`回复不能超过 ${REPLY_MAX} 个字`)
      return
    }
    setSending(true)
    setReplyError('')
    try {
      await api.tickets.reply(ticketNo, { body })
      toast.success('已回复家长')
      setReplyBody('')
      reload()
      onChanged()
    } catch (err: unknown) {
      setReplyError(errorMessageOf(err, '回复失败，请稍后重试'))
      console.error('回复工单失败：', err)
    } finally {
      setSending(false)
    }
  }

  const replies = [...(ticket?.replies ?? [])].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  )
  const closed = ticket?.status === 'closed'

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span>{ticket?.subject ?? '工单详情'}</span>
            {ticket ? <ToneBadge tone={statusToneOf(ticket.status)}>{statusLabelOf(ticket)}</ToneBadge> : null}
            {ticket ? (
              <ToneBadge tone={priorityToneOf(ticket.priority)}>{priorityLabelOf(ticket.priority)}优先级</ToneBadge>
            ) : null}
          </DialogTitle>
          <DialogDescription className="font-mono">{ticketNo}</DialogDescription>
        </DialogHeader>

        <DataState loading={loading && !data} error={error} empty={!ticket} emptyText="工单不存在" onRetry={reload}>
          {ticket ? (
            <div className="space-y-4">
              <div className="grid gap-2 rounded-lg bg-muted p-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <div className="text-muted-foreground">家长</div>
                  <div className="text-foreground">
                    {parentTextOf(ticket)}
                    {ticket.userPhone ? <span className="ml-1 text-muted-foreground">{ticket.userPhone}</span> : null}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">联系方式</div>
                  <div className="text-foreground">{ticket.contact || '未留'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">分类</div>
                  <div className="text-foreground">{categoryLabelOf(ticket.category)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">处理人</div>
                  <div className="text-foreground">{ticket.assigneeName || '未分派（首次回复自动认领）'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">提交时间</div>
                  <div className="text-foreground">{formatDateTime(ticket.createdAt)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">最近更新</div>
                  <div className="text-foreground">{formatDateTime(ticket.updatedAt)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">关联设备</div>
                  <div className="font-mono text-foreground">{ticket.deviceId || '未指定'}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">家长账号</div>
                  <div className="font-mono text-foreground">
                    {ticket.userId === null ? '已注销' : `#${ticket.userId}`}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">关闭时间</div>
                  <div className="text-foreground">{ticket.closedAt ? formatDateTime(ticket.closedAt) : '未关闭'}</div>
                </div>
              </div>

              <p className="text-[11px] text-muted-foreground">
                工单是家长给自己开的：这里只显示这条工单自带的设备，不提供「拿家长账号去查他名下设备」的入口。
              </p>

              {/* 家长与客服的来往：角色 + 时间都标出来，家长写的不冒充客服写的 */}
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">沟通记录（共 {replies.length + 1} 条）</div>

                <div className="rounded-lg border p-3">
                  <div className="mb-1 flex items-center gap-2 text-[11px]">
                    <ToneBadge tone="blue">家长</ToneBadge>
                    <span className="text-muted-foreground">{formatDateTime(ticket.createdAt)}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-foreground">{ticket.body}</p>
                </div>

                {replies.map((reply, index) => (
                  <div
                    key={`${reply.at}-${index}`}
                    className={`rounded-lg border p-3 ${reply.by === 'admin' ? 'bg-[#07c160]/5' : ''}`}
                  >
                    <div className="mb-1 flex items-center gap-2 text-[11px]">
                      <ToneBadge tone={reply.by === 'admin' ? 'green' : 'blue'}>
                        {reply.by === 'admin' ? `客服 ${reply.adminName || ''}`.trim() : '家长'}
                      </ToneBadge>
                      <span className="text-muted-foreground">{formatDateTime(reply.at)}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-foreground">{reply.body}</p>
                  </div>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">状态</span>
                  <Select value={status} onChange={(e) => setStatusDraft(e.target.value)}>
                    {TICKET_STATUS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">优先级</span>
                  <Select value={priority} onChange={(e) => setPriorityDraft(e.target.value)}>
                    {TICKET_PRIORITY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={saveMeta} disabled={savingMeta}>
                  {savingMeta ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  保存状态 / 优先级
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  选中「已关闭」并保存时会再确认一次，并且可以顺手写一句关闭原因。
                </span>
              </div>

              {/* 内部备注：后端没有这个能力，明确标出来而不是给一个存不进去的框 */}
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                <div className="flex items-center gap-2 text-xs font-medium text-amber-900">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  内部备注（家长看不到）—— 后台目前没有这个功能
                </div>
                <p className="mt-1 text-xs text-amber-800">
                  工单只有 `replies` 一个字段，家长端会读到**每一条**管理员回复；`PATCH` 也不接受备注字段
                  （`.strict()` 会 422）。所以这里不提供输入框：要留只有自己人看的记录，请写在别处，
                  千万不要写进下面的回复框。
                </p>
              </div>

              <div className="space-y-2 rounded-lg border p-3">
                <div className="text-xs font-medium text-foreground">
                  回复家长（<span className="text-amber-700">家长可见</span>）
                </div>
                {closed ? (
                  <p className="text-xs text-amber-700">
                    工单已关闭，不能回复（后端会 409）。要接着沟通，请先把状态改回「处理中」。
                  </p>
                ) : null}
                <Textarea
                  rows={3}
                  maxLength={REPLY_MAX}
                  disabled={closed || sending}
                  placeholder="写清结论和下一步，家长会在消息中心看到这条回复。"
                  value={replyBody}
                  onChange={(e) => {
                    setReplyBody(e.target.value)
                    setReplyError('')
                  }}
                />
                {replyError ? <p className="text-xs text-destructive">{replyError}</p> : null}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    {replyBody.trim().length} / {REPLY_MAX}
                  </span>
                  <Button size="sm" onClick={sendReply} disabled={closed || sending}>
                    {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    发送回复
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </DataState>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
            关闭窗口
          </Button>
        </DialogFooter>
      </DialogContent>

      <ConfirmDialog
        open={Boolean(pendingClose)}
        onOpenChange={(open) => (!open ? setPendingClose(null) : null)}
        title="关闭工单"
        description="关闭后家长不能再回复这条工单（除非后台把状态改回「处理中」）。"
        confirmText="确认关闭"
        loading={closing}
        onConfirm={confirmClose}
      >
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">
            关闭原因（可选）—— <span className="text-amber-700">填写后家长会看到</span>
          </span>
          <Textarea
            rows={2}
            maxLength={REPLY_MAX}
            placeholder="后端没有「关闭原因」字段：填了会先作为一条给家长的回复发出，再关闭工单。留空则直接关闭。"
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
          />
        </label>
      </ConfirmDialog>
    </Dialog>
  )
}

/**
 * 客服工单。
 *
 * 非目标（与 `support.constants.ts` 一致，界面如实写）：**没有附件**、**没有模板与自动回复机器人**。
 * 工单是家长给自己开的，后台只处理这一条单子上的信息。
 */
export default function TicketsPage() {
  const { filters, setFilter, reset, page, setPage, pageSize, changePageSize } = useFilters<TicketFilters>({
    status: ALL,
    category: ALL,
    priority: ALL,
    keyword: '',
  })

  const { data, loading, error, reload: load } = useAsyncData(
    () =>
      api.tickets.list({
        status: filters.status === ALL ? undefined : filters.status,
        category: filters.category === ALL ? undefined : filters.category,
        priority: filters.priority === ALL ? undefined : filters.priority,
        keyword: filters.keyword.trim() || undefined,
        page,
        pageSize,
      }),
    { deps: [filters.status, filters.category, filters.priority, filters.keyword, page, pageSize], debounceMs: 250 },
  )

  const [detailNo, setDetailNo] = useState<string | null>(null)
  const tickets = data?.items ?? []
  const hasFilter =
    filters.status !== ALL || filters.category !== ALL || filters.priority !== ALL || filters.keyword.trim() !== ''

  return (
    <div>
      <PageHeader
        title="客服工单"
        description="家长在 App 里给自己开的单子：看正文与来往、改状态与优先级、回复家长。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      <Card className="mb-3">
        <CardContent className="p-4 text-xs text-muted-foreground">
          工单**没有附件**、**没有模板与自动回复机器人** —— 这两件事现在就不假装有。家长开单上限：同时
          <span className="text-foreground"> 5 条</span> 未关闭工单；单条正文与回复上限 2000 字。
        </CardContent>
      </Card>

      <Card className="mb-3">
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">状态</span>
            <Select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
              <option value={ALL}>全部状态</option>
              {TICKET_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </label>

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">分类</span>
            <Select value={filters.category} onChange={(e) => setFilter('category', e.target.value)}>
              <option value={ALL}>全部分类</option>
              {TICKET_CATEGORY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </label>

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">优先级</span>
            <Select value={filters.priority} onChange={(e) => setFilter('priority', e.target.value)}>
              <option value={ALL}>全部优先级</option>
              {TICKET_PRIORITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </label>

          <label className="block space-y-1 lg:col-span-2">
            <span className="text-xs text-muted-foreground">关键词（单号 / 标题 / 正文）</span>
            <Input
              value={filters.keyword}
              placeholder="输入后自动筛选"
              onChange={(e) => setFilter('keyword', e.target.value)}
            />
          </label>

          <div className="flex items-end">
            <Button variant="outline" size="sm" onClick={reset} disabled={!hasFilter}>
              <X className="h-3.5 w-3.5" />
              重置筛选
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <DataState
          loading={loading && !data}
          error={error}
          empty={tickets.length === 0}
          emptyText={hasFilter ? '没有符合条件的工单' : '还没有家长提交工单'}
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">单号</TableHead>
                  <TableHead>标题</TableHead>
                  <TableHead className="w-40">家长</TableHead>
                  <TableHead className="w-40">分类</TableHead>
                  <TableHead className="w-28">状态</TableHead>
                  <TableHead className="w-20">优先级</TableHead>
                  <TableHead className="w-28">处理人</TableHead>
                  <TableHead className="w-40">最近更新</TableHead>
                  <TableHead className="w-24 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tickets.map((ticket) => (
                  <TableRow key={ticket.ticketNo}>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{ticket.ticketNo}</TableCell>
                    <TableCell>
                      <div className="text-sm text-foreground">{ticket.subject}</div>
                      <div className="line-clamp-1 text-[11px] text-muted-foreground">{ticket.body}</div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="text-foreground">{parentTextOf(ticket)}</div>
                      <div className="text-muted-foreground">{ticket.userPhone}</div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {categoryLabelOf(ticket.category)}
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={statusToneOf(ticket.status)}>{statusLabelOf(ticket)}</ToneBadge>
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={priorityToneOf(ticket.priority)}>{priorityLabelOf(ticket.priority)}</ToneBadge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {ticket.assigneeName || '未分派'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(ticket.updatedAt)}
                      <div className="text-[11px]">{ticket.replies.length} 条回复</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={() => setDetailNo(ticket.ticketNo)}>
                        查看 / 回复
                      </Button>
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

      {detailNo ? (
        <TicketDetailDialog ticketNo={detailNo} onClose={() => setDetailNo(null)} onChanged={load} />
      ) : null}
    </div>
  )
}
