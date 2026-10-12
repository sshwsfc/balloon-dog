import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Info,
  Loader2,
  Phone,
  PhoneCall,
  PhoneMissed,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import { FeatureEnableCard } from '@/components/FeatureGate'
import { useFeatureToggle } from '@/hooks/useFeatureToggle'
import { FeatureTip } from '@/components/FeatureTip'
import type { CallLogEntry, SmsMessage } from '@/types'
import { useTranslation } from 'react-i18next'
import { tt } from '@/i18n'

/** 每页条数；与后端默认值保持一致 */
const PAGE_SIZE = 20

type TabKey = 'calls' | 'sms'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'calls', label: '通话记录' },
  { key: 'sms', label: '短信' },
]

const CALL_TYPE_VIEW: Record<string, { label: string; className: string; iconClass: string }> = {
  incoming: { label: '呼入', className: 'bg-green-100 text-green-700', iconClass: 'text-green-600' },
  outgoing: { label: '呼出', className: 'bg-blue-100 text-blue-700', iconClass: 'text-blue-600' },
  missed: { label: '未接', className: 'bg-red-100 text-red-700', iconClass: 'text-red-500' },
}

const SMS_TYPE_VIEW: Record<string, { label: string; className: string }> = {
  inbox: { label: '收件', className: 'bg-green-100 text-green-700' },
  sent: { label: '发件', className: 'bg-blue-100 text-blue-700' },
}

interface ListState<T> {
  items: T[]
  total: number
  /** 当前已加载到第几页，用于「加载更多」 */
  page: number
  hasMore: boolean
  loading: boolean
  loadingMore: boolean
  error: string | null
}

function emptyList<T>(): ListState<T> {
  return { items: [], total: 0, page: 1, hasMore: false, loading: true, loadingMore: false, error: null }
}

type PageFetcher<T> = (page: number) => Promise<{ items: T[]; total: number; totalPages: number }>

/**
 * 拉一页数据并合并进列表状态。
 *
 * 抽成普通函数（而不是自定义 hook）是因为两套列表（通话 / 短信）只有取数接口不同，
 * 加载态、分页合并、错误提示完全一样。
 */
async function runPage<T>(
  fetcher: PageFetcher<T>,
  page: number,
  mode: 'replace' | 'append',
  setState: Dispatch<SetStateAction<ListState<T>>>,
  fallback: string,
): Promise<void> {
  setState((prev) =>
    mode === 'replace' ? { ...prev, loading: true, error: null } : { ...prev, loadingMore: true },
  )
  try {
    const res = await fetcher(page)
    const items = res.items ?? []
    setState((prev) => {
      const merged = mode === 'append' ? [...prev.items, ...items] : items
      return {
        items: merged,
        total: res.total ?? merged.length,
        page,
        hasMore: page < (res.totalPages ?? 1),
        loading: false,
        loadingMore: false,
        error: null,
      }
    })
  } catch (error: unknown) {
    const message = toUserMessage(error, fallback)
    setState((prev) => ({ ...prev, loading: false, loadingMore: false, error: message }))
    toast.error(message)
  }
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0')
}

/** 「今天 14:30」/「昨天 09:05」/「3月5日 14:30」；解析不了就写「时间未知」，不显示 Invalid Date */
function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return tt('时间未知')
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const clock = `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`
  if (sameDay(date, now)) return tt('今天 {{v0}}', { v0: clock })
  if (sameDay(date, yesterday)) return tt('昨天 {{v0}}', { v0: clock })
  return tt('{{v0}}月{{v1}}日 {{v2}}', { v0: date.getMonth() + 1, v1: date.getDate(), v2: clock })
}

/** 通话时长。未接或 0 秒一律写「未接通」，不写成「0 秒」——那看起来像一通打完了的电话。 */
function formatCallDuration(seconds: number, type: string): string {
  if (type === 'missed' || !Number.isFinite(seconds) || seconds <= 0) return tt('未接通')
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes > 0) return tt('{{v0}} 分 {{v1}} 秒', { v0: minutes, v1: rest })
  return tt('{{v0}} 秒', { v0: rest })
}

interface ListFrameProps {
  loading: boolean
  loadingMore: boolean
  error: string | null
  total: number
  shown: number
  hasMore: boolean
  emptyTitle: string
  emptyHint: string
  onRetry: () => void
  onLoadMore: () => void
  children: ReactNode
}

/** 两套列表共用的外壳：加载中 / 加载失败 / 空列表 / 列表 + 加载更多 */
function ListFrame({
  loading,
  loadingMore,
  error,
  total,
  shown,
  hasMore,
  emptyTitle,
  emptyHint,
  onRetry,
  onLoadMore,
  children,
}: ListFrameProps) {
  const { t } = useTranslation()
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]" />
          <p className="mt-2 text-gray-500 text-sm">{t('加载中...')}</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="px-4 py-14 text-center">
        <p className="text-gray-700">{error}</p>
        <Button className="mt-4 bg-[#07c160] hover:bg-[#06a050]" onClick={onRetry}>
          {t('重试')}
        </Button>
      </div>
    )
  }

  if (shown === 0) {
    return (
      <Card className="mx-3">
        <CardContent className="p-6 text-center">
          <Info className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-700">{emptyTitle}</p>
          <p className="text-xs text-gray-500 mt-2 leading-relaxed text-left">{emptyHint}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card className="mx-3 overflow-hidden">
        <CardContent className="p-0">{children}</CardContent>
      </Card>
      <div className="px-3 mt-3">
        {hasMore ? (
          <Button variant="outline" className="w-full bg-white" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? (
              <>
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                {t('加载中…')}
              </>
            ) : (
              t('加载更多（还有 {{v0}} 条）', { v0: Math.max(total - shown, 0) })
            )}
          </Button>
        ) : (
          <p className="text-center text-xs text-gray-400">{t('已显示全部')} {total} {t('条')}</p>
        )}
      </div>
    </>
  )
}

export function CallSmsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [tab, setTab] = useState<TabKey>('calls')
  const [calls, setCalls] = useState<ListState<CallLogEntry>>(emptyList)
  const [sms, setSms] = useState<ListState<SmsMessage>>(emptyList)
  const [syncing, setSyncing] = useState(false)
  /** 「刷新」= 下发 `sync_calls_sms` 指令，服务端要求「电话短信」开关已开 */
  const callSms = useFeatureToggle('callSms')

  /** 两个取数函数身份必须稳定，否则下面的 useEffect 会反复触发 */
  const fetchCalls = useCallback(async (page: number) => {
    const res = await api.getCallLogs({ page, pageSize: PAGE_SIZE })
    return { items: res.items ?? [], total: res.total ?? 0, totalPages: res.totalPages ?? 1 }
  }, [])

  const fetchSms = useCallback(async (page: number) => {
    const res = await api.getSmsMessages({ page, pageSize: PAGE_SIZE })
    return { items: res.items ?? [], total: res.total ?? 0, totalPages: res.totalPages ?? 1 }
  }, [])

  const loadCalls = useCallback(
    (page: number, mode: 'replace' | 'append') =>
      runPage(fetchCalls, page, mode, setCalls, t('加载通话记录失败')),
    [fetchCalls, t],
  )

  const loadSms = useCallback(
    (page: number, mode: 'replace' | 'append') =>
      runPage(fetchSms, page, mode, setSms, t('加载短信失败')),
    [fetchSms, t],
  )

  // 切到哪个标签就拉哪个标签的数据：两个接口都要受限权限，没必要一次性都拉。
  useEffect(() => {
    if (tab === 'calls') void loadCalls(1, 'replace')
    else void loadSms(1, 'replace')
  }, [tab, loadCalls, loadSms])

  /**
   * 「刷新」= 下发设备指令 `sync_calls_sms`，让设备重新读一次通话记录/短信并上报。
   * 不能只是重新请求后端列表：没上报过的数据在后端根本不存在。
   */
  const handleSync = async () => {
    setSyncing(true)
    try {
      const result = await api.syncCallsSms()
      if (result.noop) {
        toast.info(t('设备已处于该状态，无需操作'))
      } else if (result.warning) {
        toast.warning(result.warning)
      } else {
        toast.success(t('已让设备重新读取，完成后刷新即可看到'))
      }
      // 指令要先排队、等设备执行完；这里顺手再拉一次当前已有数据，不让界面显得没反应
      if (tab === 'calls') await loadCalls(1, 'replace')
      else await loadSms(1, 'replace')
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('下发刷新指令失败')))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="page-shell">
      <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1">{t('通话与短信')}</h1>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void handleSync()}
          disabled={syncing || callSms.state === 'off'}
          aria-label={t('刷新')}
        >
          <RefreshCw className={`w-5 h-5 text-gray-400 ${syncing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* 开关没开就地开启：不用跳回首页找那个开关 */}
      {callSms.state === 'off' && (
        <div className="px-3 pt-3">
          <FeatureEnableCard
            title={t('电话短信还没开启')}
            hint={t('开启后才能让设备重新读取。')}
            enabling={callSms.enabling}
            onEnable={() => void callSms.enable()}
          />
        </div>
      )}

      {/* ---------------- 受限权限说明：这是整页最重要的前提 ---------------- */}
      <div className="px-3 pt-3">
        <div className="flex items-start space-x-2 bg-amber-50 border border-amber-200 rounded-lg p-3">
          <ShieldAlert className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-amber-800 leading-relaxed space-y-1">
            <p className="font-medium text-sm">{t('这两项依赖「受限权限」，不是装上就能看')}</p>
            <p>
              {t('通话记录需要孩子设备授予')} <code>READ_CALL_LOG</code>{t('，短信需要')} <code>READ_SMS</code>{t('。它们属于 Google Play 的')}<b>{t('受限权限')}</b>{t('，只能在孩子设备上手动授予（设备所有者模式也可用 ADB 授权），没有「远程点一下就授权」的办法。')}</p>
            <p>
              {t('没有授权时，设备不会读取也不会上报，')}<b>{t('下面的列表就会一直是空的')}</b>{t('—— 空列表不等于孩子没有通话或短信。')}</p>
          </div>
        </div>
      </div>

      {/* ---------------- 标签 ---------------- */}
      <div className="px-3 pt-3">
        <div className="flex rounded-lg bg-gray-200 p-0.5">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                tab === item.key ? 'bg-white text-gray-900 font-medium shadow-sm' : 'text-gray-500'
              }`}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
      </div>

      {/* ---------------- 数据来源与刷新 ---------------- */}
      <div className="px-3 pt-3 flex items-center justify-between">
        <span className="text-xs text-gray-400">{t('数据由设备上报，正常情况下每 6 小时一次')}</span>
        <button
          type="button"
          onClick={() => void handleSync()}
          disabled={syncing}
          className="text-xs text-[#07c160] disabled:text-gray-400"
        >
          {syncing ? t('正在通知设备…') : t('立即让设备重新读取')}
        </button>
      </div>

      {/* ---------------- 通话记录 ---------------- */}
      {tab === 'calls' && (
        <div className="pt-3">
          <ListFrame
            loading={calls.loading}
            loadingMore={calls.loadingMore}
            error={calls.error}
            total={calls.total}
            shown={calls.items.length}
            hasMore={calls.hasMore}
            emptyTitle={t('这里还没有通话记录')}
            emptyHint={t('常见原因：① 孩子设备没授予「通话记录」权限（READ_CALL_LOG 属受限权限，必须在设备上手动授予）；② 设备端 Agent 版本过旧，不支持读取通话记录；③ 这台设备确实没有通话记录。前两种可以点右上角「刷新」让设备重新读取。')}
            onRetry={() => void loadCalls(1, 'replace')}
            onLoadMore={() => void loadCalls(calls.page + 1, 'append')}
          >
            {calls.items.map((call, index) => {
              const view = CALL_TYPE_VIEW[call.type] ?? {
                label: call.type,
                className: 'bg-gray-100 text-gray-600',
                iconClass: 'text-gray-500',
              }
              const CallIcon = call.type === 'missed' ? PhoneMissed : call.type === 'outgoing' ? PhoneCall : Phone
              const matchedName = call.name?.trim() ? call.name : null
              return (
                <div key={call.id}>
                  <div className="flex items-start space-x-3 py-3 px-4">
                    <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                      <CallIcon className={`w-4 h-4 ${view.iconClass}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center space-x-2">
                        <span className="text-sm font-medium text-gray-900 truncate">
                          {matchedName ?? call.phoneNumber}
                        </span>
                        <Badge className={`${view.className} flex-shrink-0`}>{t(view.label)}</Badge>
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5 truncate">
                        {matchedName ? call.phoneNumber : t('未匹配到联系人')}
                      </div>
                      <div className="text-xs text-gray-500 mt-1 flex items-center space-x-2">
                        <span>{formatDateTime(call.occurredAt)}</span>
                        <span className="text-gray-300">·</span>
                        <span>{formatCallDuration(call.durationSeconds, call.type)}</span>
                      </div>
                    </div>
                  </div>
                  {index < calls.items.length - 1 && <div className="mx-4 border-t border-gray-100" />}
                </div>
              )
            })}
          </ListFrame>
        </div>
      )}

      {/* ---------------- 短信 ---------------- */}
      {tab === 'sms' && (
        <div className="pt-3">
          <ListFrame
            loading={sms.loading}
            loadingMore={sms.loadingMore}
            error={sms.error}
            total={sms.total}
            shown={sms.items.length}
            hasMore={sms.hasMore}
            emptyTitle={t('这里还没有短信')}
            emptyHint={t('常见原因：① 孩子设备没授予「短信」权限（READ_SMS 属受限权限，必须在设备上手动授予）；② 设备端 Agent 版本过旧，不支持读取短信；③ 这台设备确实没有短信。前两种可以点右上角「刷新」让设备重新读取。')}
            onRetry={() => void loadSms(1, 'replace')}
            onLoadMore={() => void loadSms(sms.page + 1, 'append')}
          >
            {sms.items.map((message, index) => {
              const view = SMS_TYPE_VIEW[message.type] ?? {
                label: message.type,
                className: 'bg-gray-100 text-gray-600',
              }
              return (
                <div key={message.id}>
                  <div className="py-3 px-4">
                    <div className="flex items-center space-x-2">
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {message.address}
                      </span>
                      <Badge className={`${view.className} flex-shrink-0`}>{t(view.label)}</Badge>
                      <span className="text-xs text-gray-400 ml-auto flex-shrink-0 pl-2">
                        {formatDateTime(message.occurredAt)}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600 mt-1.5 whitespace-pre-wrap break-words leading-relaxed">
                      {message.body || t('（空短信）')}
                    </p>
                  </div>
                  {index < sms.items.length - 1 && <div className="mx-4 border-t border-gray-100" />}
                </div>
              )
            })}
          </ListFrame>
        </div>
      )}

      <div className="px-3 mt-4">
        <p className="text-[10px] text-gray-400 leading-relaxed px-1">{t('读取通话记录与短信需要孩子端 Agent 在线并有对应权限。设备离线时，「刷新」会排队，上线后执行。')}</p>
      </div>
      <FeatureTip id="callSms" text={t('通话与短信依赖孩子端的受限权限；如果一直是空的，先去孩子端确认权限没被系统回收。')} />

    </div>
  )
}
