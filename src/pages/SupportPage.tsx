import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { HeaderRefreshButton } from '@/components/HeaderRefreshButton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, ChevronRight, Loader2, MessageSquareText, Plus, Send } from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { SupportConfig, SupportTicketView } from '@/types'
import { formatDateTime } from '@/lib/format'
import { useAuth } from '@/contexts/AuthContext'
import { useDevices } from '@/contexts/DeviceContext'
import { useTranslation } from 'react-i18next'

/**
 * 帮助与反馈（规划 §5.5）：家长提交工单、看进度、补充信息。
 *
 * 这一页刻意做成「有边界的老实界面」，而不是一个看着很全的客服中心：
 *
 *  1. **分类、提示语、未关闭工单上限、正文长度上限、是否开放，全部来自服务端**
 *     （`GET /api/support/config`）。前端不自己抄一份枚举 —— 抄了以后后台加了分类，
 *     家长端就永远少一个选项，而且没人会注意到。
 *  2. **没有附件**。不做上传按钮再告诉用户「暂不支持」：那是在假装有。正文里可以让
 *     家长描述，或引用「媒体库」里已有的记录（那边本来就有）。
 *  3. **关闭的工单不能再回**。能回的话「关闭」就只是个颜色，客服的队列永远清不空。
 *  3.5. **状态文案用 `context: 'ticket'` 查词典**：服务端下发的「已关闭」在家长端
 *     别处（设备离线）已经表示 "off"，直接 `t('已关闭')` 会让英文界面把工单显示成
 *     "off"。中文界面没有任何变化（zh 没有词典，回落到 base key），英文界面查
 *     `已关闭_ticket`。同一个中文词在不同语境必须能用不同的英文。
 *  4. **详情里家长与客服分角色显示**，但**不显示值班客服的账号名**（服务端不下发）。
 *     内部备注也不在这一页里 —— 那是给我们自己看的，家长看到的必须是能对外的说法。
 */

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-amber-100 text-amber-700',
  processing: 'bg-blue-100 text-blue-700',
  waiting: 'bg-purple-100 text-purple-700',
  closed: 'bg-gray-100 text-gray-500',
}

export function SupportPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { devices } = useDevices()

  const [config, setConfig] = useState<SupportConfig | null>(null)
  const [tickets, setTickets] = useState<SupportTicketView[]>([])
  const [loading, setLoading] = useState(true)

  const [createOpen, setCreateOpen] = useState(false)
  const [category, setCategory] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [contact, setContact] = useState('')
  const [attachDevice, setAttachDevice] = useState(false)

  const [detail, setDetail] = useState<SupportTicketView | null>(null)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [replyBusy, setReplyBusy] = useState(false)

  const load = useCallback(
    () =>
      Promise.all([api.getSupportConfig(), api.getSupportTickets()])
        .then(([cfg, mine]) => {
          setConfig(cfg)
          setTickets(mine.tickets)
        })
        .catch((error: unknown) => {
          toast.error(toUserMessage(error, t('加载帮助与反馈失败')))
        })
        .finally(() => setLoading(false)),
    [t],
  )

  useEffect(() => {
    void load()
  }, [load])

  const openCount = tickets.filter((ticket) => ticket.status !== 'closed').length
  const atLimit = config ? openCount >= config.openLimit : false

  const categoryLabel = (key: string) =>
    config?.categories.find((item) => item.key === key)?.label ?? key
  const selectedCategory = config?.categories.find((item) => item.key === category)

  const openCreate = () => {
    setCategory(config?.categories[0]?.key ?? '')
    setSubject('')
    setBody('')
    // 联系方式默认填账号手机号：客服能打通的那个号通常就是它，填错了家长可以改。
    setContact(user?.phone ?? '')
    setAttachDevice(devices.length > 0)
    setCreateOpen(true)
  }

  const handleCreate = async () => {
    if (!selectedCategory) {
      toast.error(t('先选一个问题分类'))
      return
    }
    if (subject.trim().length < 2) {
      toast.error(t('标题至少写 2 个字，方便客服一眼看懂'))
      return
    }
    if (body.trim().length < 5) {
      toast.error(t('把遇到的问题写清楚一点（至少 5 个字）'))
      return
    }
    setBusy(true)
    try {
      await api.createSupportTicket({
        category: selectedCategory.key,
        subject: subject.trim(),
        body: body.trim(),
        contact: contact.trim() || undefined,
        deviceId: attachDevice ? devices[0]?.id : undefined,
      })
      toast.success(t('工单已提交，客服会在这里回复你'))
      setCreateOpen(false)
      await load()
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('提交工单失败，请稍后重试')))
    } finally {
      setBusy(false)
    }
  }

  const openDetail = async (ticketNo: string) => {
    try {
      const fresh = await api.getSupportTicket(ticketNo)
      setDetail(fresh.ticket)
      setReply('')
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('加载工单详情失败')))
    }
  }

  const handleReply = async () => {
    if (!detail) return
    if (reply.trim().length === 0) {
      toast.error(t('写点内容再回复'))
      return
    }
    setReplyBusy(true)
    try {
      const updated = await api.replySupportTicket(detail.ticketNo, reply.trim())
      setDetail(updated.ticket)
      setTickets((prev) => prev.map((ticket) => (ticket.ticketNo === updated.ticket.ticketNo ? updated.ticket : ticket)))
      setReply('')
      toast.success(t('已回复，客服会看到'))
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('回复失败，请稍后重试')))
    } finally {
      setReplyBusy(false)
    }
  }

  const lastReplyOf = (ticket: SupportTicketView) => ticket.replies[ticket.replies.length - 1]

  return (
    <div className="page-shell">
      <div className="page-header">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={t('返回')}
            className="p-2 -ml-2 rounded-full active:bg-gray-100"
            onClick={() => navigate(-1)}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-lg font-medium flex-1">{t('帮助与反馈')}</h1>
          <HeaderRefreshButton onRefresh={() => void load()} />
        </div>
      </div>

      <div className="p-4 space-y-4 pb-24">
        {config && !config.enabled && (
          <Card>
            <CardContent className="p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium">{t('客服工单暂时关闭')}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {t('历史工单还能在这里查看；等它恢复后再提交新的问题。')}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {config?.enabled && (
          <Button
            className="w-full bg-[#07c160] hover:bg-[#06ad56]"
            disabled={atLimit}
            onClick={openCreate}
          >
            <Plus className="w-4 h-4 mr-1" />
            {t('新建工单')}
          </Button>
        )}

        {config && atLimit && (
          <p className="text-xs text-gray-500 text-center">
            {t('同时最多 {{v0}} 条未关闭的工单，先等正在处理的那些有结果。', { v0: config.openLimit })}
          </p>
        )}

        {config && <p className="text-xs text-gray-400 leading-relaxed">{t(config.notice)}</p>}

        {config && (
          <p className="text-xs text-gray-400 leading-relaxed">
            {config.contact
              ? t('客服联系方式：{{v0}}', { v0: config.contact })
              : t('当前没有配置对外联系方式，客服会在工单里回复你。')}
          </p>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin mb-2" />
            <p className="text-sm">{t('加载中...')}</p>
          </div>
        ) : tickets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <MessageSquareText className="w-10 h-10 mb-3" />
            <p className="text-sm">{t('还没有提交过工单')}</p>
            <p className="text-xs mt-1">{t('遇到用不明白的地方，就描述一下发生了什么。')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {tickets.map((ticket) => {
              const lastReply = lastReplyOf(ticket)
              return (
                <Card
                  key={ticket.ticketNo}
                  className="cursor-pointer active:bg-gray-50"
                  onClick={() => void openDetail(ticket.ticketNo)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-gray-900 flex-1 break-words">{ticket.subject}</p>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                          STATUS_STYLES[ticket.status] ?? 'bg-gray-100 text-gray-500'
                        }`}
                      >
                        {t(ticket.statusLabel, { context: 'ticket' })}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mt-2">
                      {categoryLabel(ticket.category)} · {ticket.ticketNo} · {formatDateTime(ticket.updatedAt)}
                    </p>
                    {lastReply && (
                      <p className="text-xs text-gray-500 mt-2 line-clamp-1">
                        {lastReply.by === 'admin' ? t('客服：') : t('我：')}
                        {lastReply.body}
                      </p>
                    )}
                    <div className="flex items-center justify-end text-xs text-gray-400 mt-1">
                      {t('查看详情')}
                      <ChevronRight className="w-3.5 h-3.5" />
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* 新建工单 */}
      <Dialog open={createOpen} onOpenChange={(open) => !busy && setCreateOpen(open)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('新建工单')}</DialogTitle>
            <DialogDescription>{t('写清楚发生了什么，客服就不用再问一轮。')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 max-h-[60vh] overflow-y-auto">
            <div>
              <label className="text-sm text-gray-700 block mb-2">{t('问题分类')}</label>
              <div className="grid grid-cols-2 gap-2">
                {config?.categories.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={`text-left text-sm px-3 py-2 rounded-lg border ${
                      category === item.key
                        ? 'border-[#07c160] bg-green-50 text-[#07c160]'
                        : 'border-gray-200 text-gray-700 active:bg-gray-50'
                    }`}
                    onClick={() => setCategory(item.key)}
                  >
                    {t(item.label)}
                  </button>
                ))}
              </div>
              {selectedCategory?.hint && (
                <p className="text-xs text-gray-400 mt-2">{t(selectedCategory.hint)}</p>
              )}
            </div>

            <div>
              <label className="text-sm text-gray-700 block mb-2">{t('标题')}</label>
              <input
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#07c160]"
                value={subject}
                maxLength={80}
                placeholder={t('一句话说明问题')}
                onChange={(event) => setSubject(event.target.value)}
              />
            </div>

            <div>
              <label className="text-sm text-gray-700 block mb-2">{t('详细描述')}</label>
              <textarea
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#07c160]"
                rows={5}
                maxLength={config?.bodyMax ?? 2000}
                value={body}
                placeholder={t('设备名称、什么操作、看到了什么提示 —— 这些最有帮助')}
                onChange={(event) => setBody(event.target.value)}
              />
              <p className="text-xs text-gray-400 mt-1 text-right">
                {body.length}/{config?.bodyMax ?? 2000}
              </p>
            </div>

            <div>
              <label className="text-sm text-gray-700 block mb-2">{t('联系方式（可选）')}</label>
              <input
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#07c160]"
                value={contact}
                maxLength={64}
                placeholder={t('手机号或邮箱')}
                onChange={(event) => setContact(event.target.value)}
              />
            </div>

            {devices.length > 0 && (
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-[#07c160]"
                  checked={attachDevice}
                  onChange={(event) => setAttachDevice(event.target.checked)}
                />
                {t('附上设备「{{v0}}」', { v0: devices[0]?.name ?? '' })}
              </label>
            )}

            <p className="text-xs text-gray-400">{t('工单只支持文字描述，暂不支持上传附件。')}</p>
          </div>

          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setCreateOpen(false)}>
              {t('取消')}
            </Button>
            <Button className="bg-[#07c160] hover:bg-[#06ad56]" disabled={busy} onClick={() => void handleCreate()}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('提交')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 工单详情 */}
      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="break-words">{detail?.subject}</DialogTitle>
            <DialogDescription>
              {detail ? `${categoryLabel(detail.category)} · ${detail.ticketNo}` : ''}
            </DialogDescription>
          </DialogHeader>

          {detail && (
            <div className="space-y-4 max-h-[60vh] overflow-y-auto">
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    STATUS_STYLES[detail.status] ?? 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {t(detail.statusLabel, { context: 'ticket' })}
                </span>
                <span className="text-xs text-gray-400">{formatDateTime(detail.createdAt)}</span>
              </div>

              <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-700 whitespace-pre-wrap break-words">
                {detail.body}
              </div>

              {detail.replies.length > 0 && (
                <div className="space-y-3">
                  {detail.replies.map((item, index) => (
                    <div
                      key={`${item.at}-${index}`}
                      className={item.by === 'admin' ? 'flex flex-col items-start' : 'flex flex-col items-end'}
                    >
                      <p className="text-xs text-gray-400 mb-1">
                        {item.by === 'admin' ? t('客服') : t('我')} · {formatDateTime(item.at)}
                      </p>
                      <div
                        className={`rounded-lg px-3 py-2 text-sm max-w-[85%] whitespace-pre-wrap break-words ${
                          item.by === 'admin' ? 'bg-white border border-gray-200 text-gray-700' : 'bg-[#07c160] text-white'
                        }`}
                      >
                        {item.body}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {detail.status === 'closed' ? (
                <p className="text-xs text-gray-400">
                  {t('工单已关闭。如果问题又出现了，请新建一条工单 —— 这样客服不会漏掉。')}
                </p>
              ) : (
                <div>
                  <label className="text-sm text-gray-700 block mb-2">{t('补充说明')}</label>
                  <textarea
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#07c160]"
                    rows={3}
                    maxLength={config?.bodyMax ?? 2000}
                    value={reply}
                    placeholder={t('补充最新的情况，或回答客服的问题')}
                    onChange={(event) => setReply(event.target.value)}
                  />
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            {detail && detail.status !== 'closed' && (
              <Button
                className="bg-[#07c160] hover:bg-[#06ad56]"
                disabled={replyBusy}
                onClick={() => void handleReply()}
              >
                {replyBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
                {t('发送')}
              </Button>
            )}
            <Button variant="outline" onClick={() => setDetail(null)}>
              {t('关闭')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
