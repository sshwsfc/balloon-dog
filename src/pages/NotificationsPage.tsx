import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { HeaderRefreshButton } from '@/components/HeaderRefreshButton'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  BellOff,
  CheckCheck,
  ChevronRight,
  Hourglass,
  Loader2,
  MapPin,
  PackagePlus,
  ShieldAlert,
  Settings,
  Smartphone,
  Trash2,
  WifiOff,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { AppNotification } from '@/types'
import { useTranslation } from 'react-i18next'
import { tt } from '@/i18n'
import { formatRelative } from '@/lib/format'

/**
 * 渲染通知的标题/正文。
 *
 * 服务端存的是**模板**（`'{{v0}} 已失联'` 本身就是一条中文 key）+ 参数，
 * 因为「带变量的句子」整句没法当 key —— 从前服务端把变量拼进中文句子再落库，
 * 英文界面上就会原样露出中文（`npm run e2e:ux` 的英文扫描真的抓到过）。
 *
 * 模板和**字符串参数**都要过一遍 t()：参数里也常常是中文 key
 * （缺口名「无障碍看门狗」、申请种类「申请加时」）。用户内容（设备名、应用名、
 * 孩子自己写的理由）查不到词典，i18next 会原样回显，所以过一遍是零风险的。
 */
function renderNotificationText(text: string, params?: Record<string, string | number> | null): string {
  if (!params) return tt(text)
  const filled: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(params)) {
    filled[key] = typeof value === 'string' ? tt(value) : value
  }
  return tt(text, filled)
}

/**
 * 消息中心（规划 §2.1 第一档）。
 *
 * 这一页要解决的是「家长根本不知道」：设备失联、管控能力失效、孩子进了/出了安全区、
 * 孩子申请装应用 —— 这些以前只躺在「设备动态」那个要主动去翻的流里。
 *
 * 两条刻意的设计：
 *  1. **未读与已读分开计数**，且「全部已读」是显式动作。通知不是日志 ——
 *     如果一进来就自动全标已读，家长回头再看时已经分不清哪些是新的。
 *  2. **点进来源页之前先标已读，再跳转**（跳转失败也不回滚）：
 *     家长点它的意图就是「我去看看这件事」，回来时还亮着未读才是更糟的体验。
 */
const PAGE_SIZE = 20

/** 每种通知的图标与配色。级别只决定颜色，类型决定图标。 */
function iconOf(type: AppNotification['type']) {
  switch (type) {
    case 'agent_offline':
      return WifiOff
    case 'health_danger':
      return ShieldAlert
    case 'geofence_enter':
    case 'geofence_exit':
      return MapPin
    case 'app_audit':
      return PackagePlus
    case 'child_request':
      return Hourglass
    case 'child_sos':
      return AlertTriangle
    case 'membership_expiring':
      return Smartphone
    default:
      return Bell
  }
}

function dotClass(level: AppNotification['level']): string {
  if (level === 'danger') return 'bg-red-500'
  if (level === 'warn') return 'bg-amber-500'
  return 'bg-gray-300'
}

function iconBoxClass(level: AppNotification['level']): string {
  if (level === 'danger') return 'bg-red-50 text-red-600'
  if (level === 'warn') return 'bg-amber-50 text-amber-600'
  return 'bg-gray-50 text-gray-500'
}

export function NotificationsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [items, setItems] = useState<AppNotification[]>([])
  const [total, setTotal] = useState(0)
  const [unreadCount, setUnreadCount] = useState(0)
  const [page, setPage] = useState(1)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  /**
   * 拉一页通知。
   *
   * 刻意不写成「effect 里 `void loadData()`」那种写法：React Compiler 会把 setState
   * 追进 effect 体内并判成同步 setState（既有的十几个页面都因此挂着这条 lint）。
   * 这里用 `.then()` 链，setState 明确发生在微任务里。
   */
  const loadData = useCallback(
    () =>
      api
        .getNotifications({ page, pageSize: PAGE_SIZE, unreadOnly })
        .then((res) => {
          setItems(res.items)
          setTotal(res.total)
          setUnreadCount(res.unreadCount)
        })
        .catch((error: unknown) => {
          toast.error(toUserMessage(error, t('加载通知失败，请稍后重试')))
        })
        .finally(() => setLoading(false)),
    [page, unreadOnly, t],
  )

  useEffect(() => {
    // `void` 是为了显式忽略「组件已卸载」时的 resolve —— 上面已 catch，不会变成未处理拒绝
    void loadData()
  }, [loadData])

  const handleOpen = async (item: AppNotification) => {
    if (!item.read) {
      try {
        const res = await api.readNotification(item.id)
        setUnreadCount(res.unreadCount)
        setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, read: true } : n)))
      } catch (error: unknown) {
        // 标已读失败不该拦住跳转 —— 家长是来看这件事的
        console.error('标记已读失败：', error)
      }
    }
    if (item.linkPath) navigate(item.linkPath)
  }

  const handleReadAll = async () => {
    setBusy(true)
    try {
      await api.readAllNotifications()
      setUnreadCount(0)
      await loadData()
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('操作失败，请稍后重试')))
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (item: AppNotification) => {
    try {
      const res = await api.deleteNotification(item.id)
      setUnreadCount(res.unreadCount)
      await loadData()
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('删除失败，请稍后重试')))
    }
  }

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
            <h1 className="text-base font-medium text-gray-900">{t('消息中心')}</h1>
            {unreadCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-red-500 text-white text-[10px] leading-none">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </div>
          <div className="flex items-center space-x-1">
            <button
              type="button"
              className="p-1.5 rounded-full hover:bg-gray-100 active:bg-gray-200"
              onClick={() => navigate('/notifications/settings')}
              aria-label={t('通知设置')}
            >
              <Settings className="w-4.5 h-4.5 text-gray-600" />
            </button>
            <HeaderRefreshButton onRefresh={loadData} />
          </div>
        </div>
      </div>

      <div className="px-3 py-3 space-y-3">
        {/* 筛选 / 批量操作 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <button
              type="button"
              className={`px-3 py-1.5 rounded-full text-xs border ${
                unreadOnly
                  ? 'bg-[#07c160] text-white border-[#07c160]'
                  : 'bg-white text-gray-600 border-gray-200'
              }`}
              onClick={() => {
                setPage(1)
                setUnreadOnly((v) => !v)
              }}
            >
              {t('只看未读')}
            </button>
            <span className="text-xs text-gray-400">
              {t('共 {{v0}} 条', { v0: total })}
            </span>
          </div>
          {unreadCount > 0 && (
            <button
              type="button"
              className="flex items-center space-x-1 text-xs text-[#07c160] disabled:opacity-50"
              disabled={busy}
              onClick={() => void handleReadAll()}
            >
              <CheckCheck className="w-3.5 h-3.5" />
              <span>{t('全部已读')}</span>
            </button>
          )}
        </div>

        {loading ? (
          <Card>
            <CardContent className="p-8 flex items-center justify-center space-x-2 text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">{t('加载中...')}</span>
            </CardContent>
          </Card>
        ) : items.length === 0 ? (
          <Card>
            <CardContent className="p-10 flex flex-col items-center text-center space-y-3">
              <div className="w-14 h-14 rounded-full bg-gray-50 flex items-center justify-center">
                {unreadOnly ? (
                  <BellOff className="w-7 h-7 text-gray-300" />
                ) : (
                  <Bell className="w-7 h-7 text-gray-300" />
                )}
              </div>
              <div>
                <p className="text-sm text-gray-700">
                  {unreadOnly ? t('没有未读消息') : t('还没有任何消息')}
                </p>
                <p className="mt-1 text-xs text-gray-400 leading-relaxed">
                  {t('设备失联、管控能力失效、孩子进出安全区、孩子申请装应用的时候，这里会有提醒。')}
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const Icon = iconOf(item.type)
              return (
                <Card key={item.id} className={item.read ? '' : 'border-l-4 border-l-[#07c160]'}>
                  <CardContent className="p-0">
                    <div className="flex items-start p-3.5 space-x-3">
                      <div
                        className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${iconBoxClass(item.level)}`}
                      >
                        <Icon className="w-4.5 h-4.5" />
                      </div>
                      <button
                        type="button"
                        className="flex-1 min-w-0 text-left"
                        onClick={() => void handleOpen(item)}
                      >
                        <div className="flex items-center space-x-2">
                          <span className="text-sm font-medium text-gray-900 truncate">
                            {renderNotificationText(item.title, item.titleParams)}
                          </span>
                          {!item.read && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass(item.level)}`} />}
                        </div>
                        {item.body && (
                          <p className="mt-1 text-xs text-gray-600 leading-relaxed line-clamp-3">
                            {renderNotificationText(item.body, item.bodyParams)}
                          </p>
                        )}
                        <div className="mt-1.5 flex items-center space-x-2">
                          {/* 类型名也是服务端给的（「管控能力失效」这类中文 key），同样要过 t() */}
                          <span className="text-[11px] text-gray-400">{t(item.typeLabel)}</span>
                          <span className="text-[11px] text-gray-300">·</span>
                          <span className="text-[11px] text-gray-400">{formatRelative(item.createdAt)}</span>
                          {item.linkPath && <ChevronRight className="w-3 h-3 text-gray-300" />}
                        </div>
                      </button>
                      <button
                        type="button"
                        className="p-1.5 rounded-full hover:bg-gray-100 active:bg-gray-200 shrink-0"
                        onClick={() => void handleRemove(item)}
                        aria-label={t('删除')}
                      >
                        <Trash2 className="w-4 h-4 text-gray-400" />
                      </button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}

            {total > items.length && (
              <div className="flex justify-center pt-1 pb-2">
                <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)}>
                  {t('加载更多')}
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="flex items-start space-x-2 px-1 pb-2">
          <AlertTriangle className="w-3.5 h-3.5 text-gray-300 mt-0.5 shrink-0" />
          <p className="text-[11px] text-gray-400 leading-relaxed">
            {t('消息在这里保留，不会因为读了就消失。想只留重要的，可以在右上角的通知设置里逐类关掉。')}
          </p>
        </div>
      </div>
    </div>
  )
}
