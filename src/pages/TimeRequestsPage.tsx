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
import { ArrowLeft, Check, Clock, Hourglass, Inbox, Loader2, X } from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { TimeRequest } from '@/types'
import { useTranslation } from 'react-i18next'
import { formatRelative } from '@/lib/format'

/**
 * 孩子的申请（规划 §3.1）。
 *
 * 在此之前孩子端只有「被锁」和「设置页」，除了等家长什么也做不了 —— 这是亲子冲突
 * 的主要来源。这一页是那个出口的另一半：孩子点「申请加时」，家长在这里回应。
 *
 * 三条刻意的设计：
 *  1. **默认只看待审批**。家长打开这一页就是来处理它们的，历史和待办混在一起
 *     会让人先花时间分辨哪个要动手。
 *  2. **批准时可以改小，不能改大**。孩子申请 120 分钟、家长给 30 分钟是常态；
 *     强迫家长「要么原样批准、要么拒绝后自己去点临时解锁」会把高频动作拆成两步。
 *     改大只可能是误触，服务端也会兜底取 min(给的值, 申请值)。
 *  3. **批完明确告诉家长设备会怎样**（下发一段放行时间、离线时排队），
 *     而不是只说一句「操作成功」—— 家长真正想知道的是「孩子现在能用了吗」。
 */
const MINUTE_CHOICES = [15, 30, 60]

export function TimeRequestsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [items, setItems] = useState<TimeRequest[]>([])
  const [tab, setTab] = useState<'pending' | 'history'>('pending')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [approving, setApproving] = useState<TimeRequest | null>(null)
  const [rejecting, setRejecting] = useState<TimeRequest | null>(null)
  const [minutes, setMinutes] = useState(30)
  const [note, setNote] = useState('')

  /**
   * 拉列表。
   *
   * 与其它页面一样用 `.then()` 链而不是「effect 里 void loadData()」：
   * React Compiler 会把 async 函数里的 setState 追进 effect 体内并判成
   * 同步 setState（既有的十几个页面都因此挂着那条 lint）。
   */
  const loadData = useCallback(
    (status: 'pending' | 'all') =>
      api
        .listTimeRequests(status)
        .then((res) => {
          setItems(res.items)
          return res
        })
        .catch((error: unknown) => {
          toast.error(toUserMessage(error, t('加载申请失败，请稍后重试')))
        })
        .finally(() => setLoading(false)),
    [t],
  )

  useEffect(() => {
    // 切页签要重新拉：待审批与历史是两个查询（服务端排序方向都不同）
    void loadData(tab === 'pending' ? 'pending' : 'all')
  }, [loadData, tab])

  const openApprove = (item: TimeRequest) => {
    // 默认就用孩子申请的分钟数：家长最常见的动作是「同意他说的」，
    // 想给少一点再点下面那三个更小的档位。
    setMinutes(item.minutes)
    setApproving(item)
  }

  const handleApprove = async () => {
    if (!approving) return
    const item = approving
    setBusyId(item.id)
    try {
      const res = await api.reviewTimeRequest(item.id, { status: 'approved', minutes })
      toast.success(
        t('已批准 {{v0}} 分钟，设备会自动解锁', { v0: res.grantedMinutes ?? minutes }),
      )
      setApproving(null)
      await loadData(tab === 'pending' ? 'pending' : 'all')
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('操作失败，请稍后重试')))
      console.error('批准申请失败：', error)
    } finally {
      setBusyId(null)
    }
  }

  const handleReject = async () => {
    if (!rejecting) return
    const item = rejecting
    setBusyId(item.id)
    try {
      await api.reviewTimeRequest(item.id, { status: 'rejected', note: note.trim() })
      toast.success(t('已拒绝这条申请'))
      setRejecting(null)
      setNote('')
      await loadData(tab === 'pending' ? 'pending' : 'all')
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('操作失败，请稍后重试')))
      console.error('拒绝申请失败：', error)
    } finally {
      setBusyId(null)
    }
  }

  const pendingItems = items.filter((i) => i.status === 'pending')
  const historyItems = items.filter((i) => i.status !== 'pending')
  const shown = tab === 'pending' ? pendingItems : historyItems

  return (
    <div className="page-shell">
      <div className="page-header">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center space-x-2">
            <button
              type="button"
              className="p-1 -ml-1 rounded-full hover:bg-gray-100 active:bg-gray-200"
              onClick={() => navigate(-1)}
              aria-label={t('返回')}
            >
              <ArrowLeft className="w-5 h-5 text-gray-700" />
            </button>
            <h1 className="text-base font-medium text-gray-900">{t('孩子的申请')}</h1>
          </div>
          <HeaderRefreshButton onRefresh={() => void loadData(tab === 'pending' ? 'pending' : 'all')} />
        </div>

        {/* 待审批 / 已处理：两个查询、两个排序方向，所以在页签切换时重新拉 */}
        <div className="flex px-4 pb-2 space-x-2">
          {(
            [
              { key: 'pending' as const, label: t('待审批'), count: pendingItems.length },
              { key: 'history' as const, label: t('已处理'), count: historyItems.length },
            ]
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setLoading(true)
                setTab(item.key)
              }}
              className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                tab === item.key
                  ? 'bg-[#07c160] text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {item.label}
              {item.key === 'pending' && item.count > 0 && ` (${item.count})`}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 py-3 space-y-3">
        {loading && (
          <div className="flex items-center justify-center py-10 text-gray-400">
            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
            {t('加载中...')}
          </div>
        )}

        {!loading && shown.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Inbox className="w-10 h-10 text-gray-300 mb-3" />
              <p className="text-sm text-gray-500">
                {tab === 'pending' ? t('孩子现在没有待审批的申请') : t('还没有处理过的申请')}
              </p>
              <p className="mt-1 text-xs text-gray-400">
                {t('孩子可以在锁屏页申请加时，申请会出现在这里')}
              </p>
            </CardContent>
          </Card>
        )}

        {!loading &&
          shown.map((item) => (
            <Card key={item.id}>
              <CardContent className="pt-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center space-x-2">
                    {item.status === 'pending' ? (
                      <Hourglass className="w-5 h-5 text-amber-500" />
                    ) : (
                      <Clock className="w-5 h-5 text-gray-400" />
                    )}
                    <span className="font-medium text-gray-900">{t(item.kindLabel)}</span>
                    <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">
                      {t('{{v0}} 分钟', { v0: item.minutes })}
                    </span>
                  </div>
                  {item.status !== 'pending' && (
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        item.status === 'approved'
                          ? 'bg-green-50 text-[#07c160]'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {item.status === 'approved'
                        ? t('已批准 {{v0}} 分钟', { v0: item.grantedMinutes ?? item.minutes })
                        : t('已拒绝')}
                    </span>
                  )}
                </div>

                {item.reason && (
                  <p className="mt-2 text-sm text-gray-600 whitespace-pre-wrap">{item.reason}</p>
                )}
                <p className="mt-2 text-xs text-gray-400">
                  {formatRelative(item.createdAt)}
                  {item.reviewedAt ? ` · ${t('处理于')} ${formatRelative(item.reviewedAt)}` : ''}
                </p>
                {item.reviewNote && (
                  <p className="mt-1 text-xs text-gray-500">
                    {t('你的批注')}：{item.reviewNote}
                  </p>
                )}

                {item.status === 'pending' && (
                  <div className="mt-3 flex space-x-2">
                    <Button
                      className="flex-1 bg-[#07c160] hover:bg-[#06ad56]"
                      onClick={() => openApprove(item)}
                      disabled={busyId === item.id}
                    >
                      {busyId === item.id ? (
                        <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                      ) : (
                        <Check className="w-4 h-4 mr-1" />
                      )}
                      {t('批准')}
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => {
                        setNote('')
                        setRejecting(item)
                      }}
                      disabled={busyId === item.id}
                    >
                      <X className="w-4 h-4 mr-1" />
                      {t('拒绝')}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
      </div>

      {/* 批准：分钟数可以改小 —— 孩子申请 60 分钟，家长给 30 分钟是常态 */}
      <Dialog open={Boolean(approving)} onOpenChange={(open) => !open && setApproving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('批准这条申请')}</DialogTitle>
            <DialogDescription>
              {approving ? t('孩子申请了 {{v0}} 分钟', { v0: approving.minutes }) : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-gray-600">{t('实际给多长时间')}</p>
            <div className="flex space-x-2">
              {MINUTE_CHOICES.filter((m) => m <= (approving?.minutes ?? 0)).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMinutes(m)}
                  className={`px-4 py-2 rounded-lg text-sm border transition-colors ${
                    minutes === m
                      ? 'border-[#07c160] bg-green-50 text-[#07c160]'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {t('{{v0}} 分钟', { v0: m })}
                </button>
              ))}
              {/* 孩子申请的分钟数本身也是一个选项，放在最后（默认选中） */}
              <button
                type="button"
                onClick={() => setMinutes(approving?.minutes ?? 30)}
                className={`px-4 py-2 rounded-lg text-sm border transition-colors ${
                  minutes === approving?.minutes
                    ? 'border-[#07c160] bg-green-50 text-[#07c160]'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {t('全额 {{v0}} 分钟', { v0: approving?.minutes ?? 0 })}
              </button>
            </div>
            <p className="text-xs text-gray-400">
              {t('批准后会立即给设备下发 {{v0}} 分钟的使用时间；设备离线时会等它上线后执行。', {
                v0: minutes,
              })}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproving(null)} disabled={Boolean(busyId)}>
              {t('取消')}
            </Button>
            <Button
              className="bg-[#07c160] hover:bg-[#06ad56]"
              onClick={handleApprove}
              disabled={Boolean(busyId)}
            >
              {busyId ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              {t('确认批准')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 拒绝：允许留一句批注，孩子端锁屏页会把这句话显示出来 */}
      <Dialog open={Boolean(rejecting)} onOpenChange={(open) => !open && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('拒绝这条申请')}</DialogTitle>
            <DialogDescription>{t('可以给孩子留一句话，他会看到')}</DialogDescription>
          </DialogHeader>
          <textarea
            className="w-full h-20 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#07c160] resize-none"
            placeholder={t('例如：先把作业做完')}
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)} disabled={Boolean(busyId)}>
              {t('取消')}
            </Button>
            <Button variant="destructive" onClick={handleReject} disabled={Boolean(busyId)}>
              {busyId ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              {t('确认拒绝')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
