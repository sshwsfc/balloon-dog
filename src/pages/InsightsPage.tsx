import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Eye,
  EyeOff,
  Film,
  Gamepad2,
  ImageOff,
  Info,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type {
  Insight,
  InsightDetail,
  InsightFrame,
  InsightListResponse,
  InsightRiskLevel,
  ScreenMonitorConfig,
  ScreenMonitorConfigPatch,
  UsageAlert,
  UsageAlertSeverity,
  UsageAlertType,
  UsageBudget,
  UsageBudgetKind,
  UsageEpisode,
  UsageSummary,
  UsageSummaryBudget,
} from '@/types'

/** 时间线左侧色条 / 风险徽章 */
const RISK_META: Record<InsightRiskLevel, { label: string; stripe: string; badge: string }> = {
  none: { label: '无明显风险', stripe: 'border-l-gray-300', badge: 'bg-gray-100 text-gray-600' },
  low: { label: '低风险', stripe: 'border-l-blue-300', badge: 'bg-blue-100 text-blue-700' },
  medium: { label: '中风险', stripe: 'border-l-orange-400', badge: 'bg-orange-100 text-orange-700' },
  high: { label: '高风险', stripe: 'border-l-red-500', badge: 'bg-red-100 text-red-700' },
}

/** 提醒紧急度：high 红、medium 橙、low 灰 */
const SEVERITY_META: Record<UsageAlertSeverity, { label: string; className: string; stripe: string }> = {
  high: { label: '高危', className: 'bg-red-100 text-red-700', stripe: 'border-l-red-500' },
  medium: { label: '中等', className: 'bg-orange-100 text-orange-700', stripe: 'border-l-orange-400' },
  low: { label: '提示', className: 'bg-gray-100 text-gray-600', stripe: 'border-l-gray-300' },
}

/** 排序权重：high 在前 */
const SEVERITY_ORDER: Record<UsageAlertSeverity, number> = { high: 0, medium: 1, low: 2 }

const ALERT_TYPE_OPTIONS: { value: UsageAlertType; label: string }[] = [
  { value: 'minor_content', label: '不适龄内容' },
  { value: 'scam_suspect', label: '疑似诈骗' },
  { value: 'emotional_issue', label: '情绪问题' },
  { value: 'game_addiction', label: '游戏沉迷' },
  { value: 'high_spending', label: '高额消费' },
]

const ANALYSIS_MODE_LABEL: Record<ScreenMonitorConfig['analysisMode'], string> = {
  ai: 'AI 分析',
  heuristic: '启发式推断',
  disabled: '未分析',
}

const BUDGET_KIND_META: Record<UsageBudgetKind, { label: string; unit: string; desc: string; icon: typeof Gamepad2 }> = {
  game_round: { label: '游戏局数', unit: '局', desc: '今天最多能打完几局游戏', icon: Gamepad2 },
  video_episode: { label: '动画集数', unit: '集', desc: '今天最多能看完几集动画', icon: Film },
}

/** 数值型设置项的合法区间，与后端 zod 校验保持一致 */
const NUMBER_RULES = {
  captureIntervalSeconds: { min: 10, max: 600, label: '截屏间隔', unit: '秒' },
  framesPerBatch: { min: 2, max: 30, label: '每包张数', unit: '张' },
  analyzeSampleCount: { min: 1, max: 20, label: '采样张数', unit: '张' },
  retentionDays: { min: 1, max: 90, label: '留档天数', unit: '天' },
} as const

type NumberFieldKey = keyof typeof NUMBER_RULES

const ALERT_SWITCHES: { key: keyof ScreenMonitorConfig; label: string; desc: string }[] = [
  { key: 'alertMinorContent', label: '不适龄内容', desc: '出现暴力、成人等内容时提醒' },
  { key: 'alertScam', label: '疑似诈骗', desc: '出现刷单、返利、转账等话术时提醒' },
  { key: 'alertEmotional', label: '情绪问题', desc: '出现自伤、霸凌、极端情绪内容时提醒' },
  { key: 'alertGameAddiction', label: '游戏沉迷', desc: '连续多局游戏或长时间在线时提醒' },
  { key: 'alertHighSpending', label: '高额消费', desc: '出现充值、打赏、付款界面时提醒' },
]

interface FilterState {
  onlyRisky: boolean
  alertType: UsageAlertType | ''
  unreadOnly: boolean
}

interface BudgetFormState {
  kind: UsageBudgetKind
  appName: string
  dailyLimit: string
  enabled: boolean
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0')
}

/** 「10月01日 14:30」；null 显示占位符而不是 Invalid Date */
function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.getMonth() + 1}月${date.getDate()}日 ${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`
}

/** 帧时间线只需要「时分秒」 */
function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}:${padTwo(date.getSeconds())}`
}

function formatPeriod(item: Insight): string {
  if (!item.periodFrom && !item.periodTo) return '时间段未知'
  return `${formatDateTime(item.periodFrom)} → ${formatDateTime(item.periodTo)}`
}

/** 一天内的时间范围压缩成「14:30 ~ 15:02」，跨天则退回完整日期 */
function formatFrameRange(frames: InsightFrame[]): string {
  if (frames.length === 0) return '本包没有帧记录'
  const first = frames[0]
  const last = frames[frames.length - 1]
  const firstAt = new Date(first.capturedAt)
  const lastAt = new Date(last.capturedAt)
  if (Number.isNaN(firstAt.getTime()) || Number.isNaN(lastAt.getTime())) return '时间未知'
  const sameDay =
    firstAt.getFullYear() === lastAt.getFullYear() &&
    firstAt.getMonth() === lastAt.getMonth() &&
    firstAt.getDate() === lastAt.getDate()
  return sameDay
    ? `${formatClock(first.capturedAt)} ~ ${formatClock(last.capturedAt)}`
    : `${formatDateTime(first.capturedAt)} → ${formatDateTime(last.capturedAt)}`
}

function kindLabel(kind: UsageBudgetKind): string {
  return BUDGET_KIND_META[kind]?.label ?? kind
}

function uniqueApps(item: Insight): string[] {
  const names = item.activities
    .map((activity) => activity.app || activity.packageName)
    .filter((name): name is string => Boolean(name))
  return [...new Set(names)]
}

function sortAlerts(items: UsageAlert[]): UsageAlert[] {
  return [...items].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (bySeverity !== 0) return bySeverity
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })
}

/** 开关：与 HomePage / SchedulePage 保持同一套样式与无障碍语义 */
function Toggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className="w-11 h-6 rounded-full relative flex-shrink-0 ml-2 disabled:opacity-50"
    >
      <span
        className={`absolute w-5 h-5 rounded-full top-0.5 bg-white shadow transition-all ${
          checked ? 'right-0.5' : 'left-0.5'
        }`}
      />
      <span className={`block w-full h-full rounded-full ${checked ? 'bg-[#07c160]' : 'bg-gray-300'}`} />
    </button>
  )
}

/** 一条异常提醒。evidence 一定要露出来，家长据此判断是不是误报。 */
function AlertCard({
  alert,
  busy,
  onMarkRead,
  onOpenInsight,
}: {
  alert: UsageAlert
  busy: boolean
  onMarkRead: (alert: UsageAlert) => void
  onOpenInsight: (insightId: string) => void
}) {
  const severity = SEVERITY_META[alert.severity] ?? SEVERITY_META.low
  return (
    <div
      className={`border-l-4 ${severity.stripe} ${alert.read ? 'bg-white' : 'bg-red-50/40'} px-4 py-3`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center flex-wrap gap-1.5 min-w-0">
          <Badge className={`${severity.className} text-[10px]`}>{severity.label}</Badge>
          <Badge className="bg-gray-100 text-gray-600 text-[10px]">{alert.typeLabel}</Badge>
          {!alert.read && <Badge className="bg-[#07c160] text-white text-[10px]">未读</Badge>}
        </div>
        <span className="text-[11px] text-gray-400 flex-shrink-0">{formatDateTime(alert.createdAt)}</span>
      </div>

      <p className="mt-1.5 text-sm font-medium text-gray-900">{alert.title}</p>
      {alert.detail && <p className="mt-1 text-xs text-gray-600 leading-relaxed">{alert.detail}</p>}

      {alert.evidence && (
        <div className="mt-2 bg-white border border-gray-200 rounded-lg px-3 py-2">
          <p className="text-[11px] text-gray-400 mb-0.5">AI 判定依据（原文）</p>
          <p className="text-xs text-gray-700 leading-relaxed break-words">{alert.evidence}</p>
        </div>
      )}

      <div className="mt-2 flex items-center gap-3">
        {!alert.read && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onMarkRead(alert)}
            className="text-xs text-[#07c160] flex items-center disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5 mr-0.5" />
            标记已读
          </button>
        )}
        {alert.insightId && (
          <button
            type="button"
            onClick={() => onOpenInsight(alert.insightId as string)}
            className="text-xs text-gray-500 flex items-center"
          >
            查看对应洞察
          </button>
        )}
      </div>

      <p className="mt-1.5 text-[11px] text-gray-400 leading-relaxed">
        AI 判断可能有误，请结合孩子的实际情况确认，不要仅凭此提醒下结论。
      </p>
    </div>
  )
}

export function InsightsPage() {
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [config, setConfig] = useState<ScreenMonitorConfig | null>(null)
  const [budgets, setBudgets] = useState<UsageBudget[]>([])
  const [insightData, setInsightData] = useState<InsightListResponse | null>(null)
  const [alerts, setAlerts] = useState<UsageAlert[]>([])
  const [alertUnread, setAlertUnread] = useState(0)

  const [onlyRisky, setOnlyRisky] = useState(false)
  const [alertType, setAlertType] = useState<UsageAlertType | ''>('')
  const [unreadOnly, setUnreadOnly] = useState(false)

  /** 数值型设置项需要本地草稿，避免每敲一位就发一次请求 */
  const [numberDrafts, setNumberDrafts] = useState<Record<NumberFieldKey, string>>({
    captureIntervalSeconds: '30',
    framesPerBatch: '10',
    analyzeSampleCount: '6',
    retentionDays: '7',
  })
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<InsightDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)

  const [budgetDialogOpen, setBudgetDialogOpen] = useState(false)
  const [editingBudget, setEditingBudget] = useState<UsageBudget | null>(null)
  const [budgetForm, setBudgetForm] = useState<BudgetFormState>({
    kind: 'game_round',
    appName: '',
    dailyLimit: '3',
    enabled: true,
  })
  const [budgetFormError, setBudgetFormError] = useState<string | null>(null)
  const [submittingBudget, setSubmittingBudget] = useState(false)
  const [removeBudgetTarget, setRemoveBudgetTarget] = useState<UsageBudget | null>(null)

  const loadAll = useCallback(async (filters: FilterState, options?: { silent?: boolean }) => {
    try {
      const [summaryData, configData, budgetData, insightRes, alertRes] = await Promise.all([
        api.getUsageSummary(),
        api.getScreenMonitorConfig(),
        api.getUsageBudgets(),
        api.getInsights({ limit: 30, onlyRisky: filters.onlyRisky }),
        api.getAlerts({
          limit: 50,
          type: filters.alertType || undefined,
          unreadOnly: filters.unreadOnly,
        }),
      ])
      setUsage(summaryData)
      setConfig(configData)
      setNumberDrafts({
        captureIntervalSeconds: String(configData.captureIntervalSeconds),
        framesPerBatch: String(configData.framesPerBatch),
        analyzeSampleCount: String(configData.analyzeSampleCount),
        retentionDays: String(configData.retentionDays),
      })
      setBudgets(budgetData.items ?? [])
      setInsightData(insightRes)
      setAlerts(alertRes.items ?? [])
      setAlertUnread(alertRes.unread ?? 0)
      setError(null)
    } catch (err) {
      const message = toUserMessage(err, '加载 AI 洞察失败')
      setError(message)
      // 首次加载失败才弹 toast；mutation 之后的静默刷新失败不打扰用户
      if (!options?.silent) toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAll({ onlyRisky: false, alertType: '', unreadOnly: false })
  }, [loadAll])

  const reload = (options?: { silent?: boolean }) =>
    loadAll({ onlyRisky, alertType, unreadOnly }, options)

  // ---------------- 截屏与 AI 设置 ----------------

  const saveConfig = async (patch: ScreenMonitorConfigPatch, successText: string, key: string) => {
    setBusyKey(key)
    try {
      await api.updateScreenMonitorConfig(patch)
      toast.success(successText)
      await reload({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, '保存失败，请稍后重试'))
      console.error('保存截屏与 AI 设置失败：', err)
    } finally {
      setBusyKey(null)
    }
  }

  const handleNumberBlur = async (field: NumberFieldKey) => {
    const rule = NUMBER_RULES[field]
    const raw = numberDrafts[field]
    const value = Number.parseInt(raw, 10)
    if (!Number.isFinite(value) || value < rule.min || value > rule.max) {
      toast.error(`${rule.label}需在 ${rule.min} ~ ${rule.max} ${rule.unit}之间`)
      setNumberDrafts((current) => ({ ...current, [field]: String(config?.[field] ?? rule.min) }))
      return
    }
    if (value === config?.[field]) return
    await saveConfig({ [field]: value }, `${rule.label}已设为 ${value} ${rule.unit}`, field)
  }

  // ---------------- 异常提醒 ----------------

  const handleMarkRead = async (alert: UsageAlert) => {
    setBusyKey(`alert-${alert.id}`)
    try {
      await api.markAlertRead(alert.id)
      toast.success('已标记为已读')
      await reload({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, '操作失败，请稍后重试'))
      console.error('标记提醒已读失败：', err)
    } finally {
      setBusyKey(null)
    }
  }

  const handleMarkAllRead = async () => {
    setBusyKey('alert-all')
    try {
      const result = await api.markAllAlertsRead()
      toast.success(result.updated > 0 ? `已将 ${result.updated} 条提醒标记为已读` : '没有未读提醒')
      await reload({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, '操作失败，请稍后重试'))
      console.error('全部标记已读失败：', err)
    } finally {
      setBusyKey(null)
    }
  }

  // ---------------- 洞察时间线 ----------------

  const handleToggleDetail = async (insightId: string) => {
    if (expandedId === insightId) {
      setExpandedId(null)
      setDetail(null)
      return
    }
    setExpandedId(insightId)
    setDetail(null)
    setRawOpen(false)
    setDetailLoading(true)
    try {
      setDetail(await api.getInsight(insightId))
    } catch (err) {
      toast.error(toUserMessage(err, '加载洞察详情失败'))
      console.error('加载洞察详情失败：', err)
      setExpandedId(null)
    } finally {
      setDetailLoading(false)
    }
  }

  const handleOpenInsightFromAlert = (insightId: string) => {
    setExpandedId(insightId)
    setDetail(null)
    setRawOpen(false)
    setDetailLoading(true)
    void api
      .getInsight(insightId)
      .then((data) => setDetail(data))
      .catch((err: unknown) => {
        toast.error(toUserMessage(err, '加载洞察详情失败'))
        setExpandedId(null)
      })
      .finally(() => setDetailLoading(false))
    window.setTimeout(() => {
      document.getElementById(`insight-${insightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 60)
  }

  const handleReanalyze = async (insightId: string) => {
    setBusyKey(`reanalyze-${insightId}`)
    try {
      await api.reanalyzeInsight(insightId)
      toast.success('已重新提交分析，稍后刷新即可看到新结论')
      setExpandedId(null)
      setDetail(null)
      await reload({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, '重新分析失败，请稍后重试'))
      console.error('重新分析失败：', err)
    } finally {
      setBusyKey(null)
    }
  }

  // ---------------- 用量上限 ----------------

  const openBudgetDialog = (kind: UsageBudgetKind, budget?: UsageBudget) => {
    setEditingBudget(budget ?? null)
    setBudgetForm({
      kind,
      appName: budget?.appName ?? '',
      dailyLimit: String(budget?.dailyLimit ?? (kind === 'game_round' ? 3 : 2)),
      enabled: budget?.enabled ?? true,
    })
    setBudgetFormError(null)
    setBudgetDialogOpen(true)
  }

  const handleSubmitBudget = async () => {
    const limit = Number.parseInt(budgetForm.dailyLimit, 10)
    if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
      setBudgetFormError('每日上限需在 1 ~ 200 之间')
      return
    }
    setSubmittingBudget(true)
    setBudgetFormError(null)
    try {
      await api.upsertUsageBudget({
        kind: budgetForm.kind,
        appName: budgetForm.appName.trim(),
        dailyLimit: limit,
        enabled: budgetForm.enabled,
      })
      toast.success(`${kindLabel(budgetForm.kind)}上限已保存`)
      setBudgetDialogOpen(false)
      setEditingBudget(null)
      await reload({ silent: true })
    } catch (err) {
      const message = toUserMessage(err, '保存用量上限失败')
      setBudgetFormError(message)
      toast.error(message)
      console.error('保存用量上限失败：', err)
    } finally {
      setSubmittingBudget(false)
    }
  }

  const handleToggleBudget = async (budget: UsageBudget) => {
    setBusyKey(`budget-${budget.id}`)
    try {
      await api.upsertUsageBudget({
        kind: budget.kind,
        appName: budget.appName,
        dailyLimit: budget.dailyLimit,
        enabled: !budget.enabled,
      })
      toast.success(budget.enabled ? '已停用该上限' : '已启用该上限')
      await reload({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, '操作失败，请稍后重试'))
      console.error('切换用量上限失败：', err)
    } finally {
      setBusyKey(null)
    }
  }

  const handleRemoveBudget = async () => {
    if (!removeBudgetTarget) return
    try {
      await api.deleteUsageBudget(removeBudgetTarget.id)
      toast.success('用量上限已删除')
      setRemoveBudgetTarget(null)
      await reload({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, '删除失败，请稍后重试'))
      console.error('删除用量上限失败：', err)
    }
  }

  // ---------------- 渲染 ----------------

  if (loading) {
    return (
      <div className="page-shell page-shell--wide page-shell--center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]" />
          <p className="mt-2 text-gray-500 text-sm">加载中...</p>
        </div>
      </div>
    )
  }

  if (error && !config && !usage) {
    return (
      <div className="page-shell page-shell--wide">
        <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-xl font-medium text-gray-900 flex-1">AI 洞察</h1>
        </div>
        <div className="px-6 py-20 text-center">
          <Sparkles className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-700">{error}</p>
          <Button
            className="mt-4 bg-[#07c160] hover:bg-[#06a050]"
            onClick={() => {
              setLoading(true)
              void reload()
            }}
          >
            重新加载
          </Button>
        </div>
      </div>
    )
  }

  const gameUsed = usage?.used?.game_round ?? 0
  const videoUsed = usage?.used?.video_episode ?? 0
  const enabledBudgets: UsageSummaryBudget[] = usage?.budgets ?? []
  const tightest = enabledBudgets.reduce<UsageSummaryBudget | null>(
    (acc, budget) => (acc === null || budget.remaining < acc.remaining ? budget : acc),
    null,
  )
  const items = insightData?.items ?? []
  const unread = insightData?.unreadAlerts ?? alertUnread
  const analysisMode = config?.analysisMode ?? 'disabled'
  const isAi = analysisMode === 'ai'
  const sortedAlerts = sortAlerts(alerts)

  return (
    <div className="page-shell page-shell--wide">
      <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1">AI 洞察</h1>
        <button
          type="button"
          onClick={() => void reload({ silent: true })}
          className="text-gray-400 p-1"
          aria-label="刷新"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      {/* 刷新失败但还留着上一次成功的数据：给条提示，不把整页换成错误页 */}
      {error && (
        <div className="px-3 pt-3">
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-start space-x-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-700 flex-1">
              最新数据读取失败：{error}（下方仍是上一次成功加载的内容）
            </p>
            <button
              type="button"
              className="text-xs text-[#07c160] flex-shrink-0"
              onClick={() => void reload({ silent: true })}
            >
              重试
            </button>
          </div>
        </div>
      )}

      {/* ---------------- 顶部概览 ---------------- */}
      <div className="px-3 py-3 space-y-3">
        {/*
          最重要的一条：没配 AI 时后端只是「启发式推断」。
          这句话必须比任何数字都显眼，否则家长会把推断当成 AI 结论。
        */}
        <div
          className={`rounded-xl px-4 py-3 ${
            isAi
              ? 'bg-gradient-to-br from-green-400 to-green-600 text-white'
              : 'bg-gradient-to-br from-amber-400 to-orange-500 text-white'
          }`}
        >
          <div className="flex items-start space-x-3">
            <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
              {isAi ? <BrainCircuit className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium">
                {isAi ? 'AI 分析已启用' : '当前不是 AI 分析'}
              </p>
              <p className="text-xs opacity-95 mt-1 leading-relaxed">
                {config?.analysisNote || '后端未返回分析说明'}
              </p>
              {!isAi && (
                <p className="text-xs opacity-95 mt-1 leading-relaxed">
                  下面的结论来自启发式推断，不是 AI 看图得出的，请谨慎参考。
                </p>
              )}
            </div>
          </div>
        </div>

        <Card className="overflow-hidden">
          <CardContent className="p-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="flex items-center justify-center space-x-1 text-gray-400">
                  <Gamepad2 className="w-3.5 h-3.5" />
                  <span className="text-[11px]">今日游戏</span>
                </div>
                <p className="mt-1 text-xl font-medium text-gray-900">{gameUsed}</p>
                <p className="text-[11px] text-gray-400">局</p>
              </div>
              <div className="border-x border-gray-100">
                <div className="flex items-center justify-center space-x-1 text-gray-400">
                  <Film className="w-3.5 h-3.5" />
                  <span className="text-[11px]">今日动画</span>
                </div>
                <p className="mt-1 text-xl font-medium text-gray-900">{videoUsed}</p>
                <p className="text-[11px] text-gray-400">集</p>
              </div>
              <div>
                <div className="flex items-center justify-center space-x-1 text-gray-400">
                  <Shield className="w-3.5 h-3.5" />
                  <span className="text-[11px]">剩余额度</span>
                </div>
                {tightest ? (
                  <>
                    <p
                      className={`mt-1 text-xl font-medium ${
                        tightest.exceeded ? 'text-red-600' : 'text-gray-900'
                      }`}
                    >
                      {tightest.remaining}
                    </p>
                    <p className="text-[11px] text-gray-400 truncate px-1">
                      最少的一项（{kindLabel(tightest.kind)}）
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mt-1 text-xl font-medium text-gray-300">—</p>
                    <p className="text-[11px] text-gray-400">未启用上限</p>
                  </>
                )}
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-gray-100 flex items-center justify-between">
              <div className="flex items-center space-x-1.5">
                <Bell className={`w-4 h-4 ${unread > 0 ? 'text-red-500' : 'text-gray-400'}`} />
                <span className="text-xs text-gray-600">
                  {unread > 0 ? `${unread} 条未读提醒` : '没有未读提醒'}
                </span>
              </div>
              <div className="flex items-center space-x-1.5">
                <Sparkles className="w-4 h-4 text-gray-400" />
                <span className="text-xs text-gray-600">
                  {isAi ? `AI 可用${config?.aiAvailable ? '' : '（未配置）'}` : ANALYSIS_MODE_LABEL[analysisMode]}
                </span>
              </div>
            </div>

            {usage?.dayKey && (
              <p className="mt-2 text-[11px] text-gray-400">
                用量统计日期：{usage.dayKey}（按服务器日期计算）
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 异常提醒 ---------------- */}
      <div className="px-3">
        <div className="mb-2 px-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">异常提醒</span>
          {unread > 0 && (
            <button
              type="button"
              disabled={busyKey === 'alert-all'}
              onClick={() => void handleMarkAllRead()}
              className="text-xs text-[#07c160] disabled:opacity-50"
            >
              全部标记已读
            </button>
          )}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-2 lg:flex-wrap lg:overflow-x-visible">
          <button
            type="button"
            onClick={() => {
              setAlertType('')
              void loadAll({ onlyRisky, alertType: '', unreadOnly }, { silent: true })
            }}
            className={`px-3 py-1.5 rounded-full text-xs whitespace-nowrap transition-colors ${
              alertType === '' ? 'bg-[#07c160] text-white' : 'bg-white text-gray-600'
            }`}
          >
            全部类型
          </button>
          {ALERT_TYPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                setAlertType(option.value)
                void loadAll({ onlyRisky, alertType: option.value, unreadOnly }, { silent: true })
              }}
              className={`px-3 py-1.5 rounded-full text-xs whitespace-nowrap transition-colors ${
                alertType === option.value ? 'bg-[#07c160] text-white' : 'bg-white text-gray-600'
              }`}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              const next = !unreadOnly
              setUnreadOnly(next)
              void loadAll({ onlyRisky, alertType, unreadOnly: next }, { silent: true })
            }}
            className={`px-3 py-1.5 rounded-full text-xs whitespace-nowrap transition-colors ${
              unreadOnly ? 'bg-[#07c160] text-white' : 'bg-white text-gray-600'
            }`}
          >
            只看未读
          </button>
        </div>

        <Card className="overflow-hidden">
          {sortedAlerts.length === 0 ? (
            <CardContent className="p-8 text-center">
              <Bell className="w-10 h-10 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-700 font-medium">
                {alertType || unreadOnly ? '当前筛选下没有提醒' : '还没有异常提醒'}
              </p>
              <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">
                开启截屏与 AI 分析后，识别到的不适龄内容、疑似诈骗、游戏沉迷等情况会在这里提醒；
                每条都会附上 AI 的判定依据，你可以据此判断是否误报。
              </p>
            </CardContent>
          ) : (
            sortedAlerts.map((alert, index) => (
              <div key={alert.id}>
                <AlertCard
                  alert={alert}
                  busy={busyKey === `alert-${alert.id}`}
                  onMarkRead={(target) => void handleMarkRead(target)}
                  onOpenInsight={handleOpenInsightFromAlert}
                />
                {index < sortedAlerts.length - 1 && <div className="mx-4 border-t border-gray-100" />}
              </div>
            ))
          )}
        </Card>

        {sortedAlerts.length > 0 && (
          <p className="mt-2 px-1 text-[11px] text-gray-400 leading-relaxed">
            提醒按紧急程度排序（高危在前）。所有结论都是模型推断，遇到疑问请先和孩子沟通确认。
          </p>
        )}
      </div>

      {/* ---------------- 截屏与 AI 设置 ---------------- */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">截屏与 AI 设置</span>
        </div>

        <Card className="overflow-hidden">
          {/* 截屏总开关：最高敏感度权限，默认关闭 */}
          <div className="flex items-center py-3 px-4">
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                config?.captureEnabled ? 'bg-indigo-50' : 'bg-gray-50'
              }`}
            >
              {config?.captureEnabled ? (
                <Eye className="w-5 h-5 text-indigo-500" />
              ) : (
                <EyeOff className="w-5 h-5 text-gray-400" />
              )}
            </div>
            <div className="flex-1 min-w-0 ml-3">
              <div className="font-medium text-gray-900 text-sm">开启截屏采集</div>
              <div className="text-xs text-gray-400 mt-0.5">
                {config?.captureEnabled ? '已开启，设备会周期性上传屏幕画面' : '默认关闭，开启前请阅读下方隐私说明'}
              </div>
            </div>
            <Toggle
              checked={config?.captureEnabled ?? false}
              disabled={busyKey === 'captureEnabled' || !config}
              label="截屏采集开关"
              onChange={() => {
                if (!config) return
                void saveConfig(
                  { captureEnabled: !config.captureEnabled },
                  !config.captureEnabled ? '截屏采集已开启' : '截屏采集已关闭',
                  'captureEnabled',
                )
              }}
            />
          </div>

          {config?.captureEnabled && (
            <div className="mx-4 mb-3 flex items-center justify-between gap-3 border-t border-gray-50 pt-3">
              <div className="text-xs text-gray-400 leading-relaxed">
                想立刻看一眼当前画面？可以单独下发一次手动截图，结果在「媒体」页可查看。
              </div>
              <button
                type="button"
                disabled={busyKey === 'manualShot'}
                onClick={() => {
                  void (async () => {
                    setBusyKey('manualShot')
                    try {
                      await api.screenshot()
                      toast.success('截图指令已下发，稍等片刻到「媒体」页查看')
                    } catch (err: unknown) {
                      toast.error(toUserMessage(err, '截图指令下发失败'))
                    } finally {
                      setBusyKey(null)
                    }
                  })()
                }}
                className="flex-shrink-0 text-sm text-[#07c160] font-medium px-3 py-1.5 rounded-lg bg-green-50 active:bg-green-100 disabled:opacity-50"
              >
                立即截图
              </button>
            </div>
          )}

          {config?.captureEnabled && (
            <div className="mx-4 mb-3 bg-red-50 border border-red-200 rounded-lg p-3">
              <div className="flex items-start space-x-2">
                <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                <div className="text-xs text-red-700 leading-relaxed space-y-1">
                  <p className="font-medium text-sm">开启后请知悉以下事实</p>
                  <p>
                    · 孩子设备的屏幕画面会被<b>周期性采集</b>（当前每 {config.captureIntervalSeconds} 秒一张，
                    每 {config.framesPerBatch} 张打成一个包）。
                  </p>
                  <p>
                    · 截图会<b>发送至 AI 服务进行分析</b>，用于识别内容、统计游戏局数与动画集数，并据此生成异常提醒。
                  </p>
                  <p>
                    · 截图按<b>留档 {config.retentionDays} 天</b>自动删除；家长端本页<b>不展示截图原图</b>
                    （儿童隐私约定），只能看到帧时间线（时间 + 应用名）。
                  </p>
                  <p>· 请仅在确有必要时开启，并事先告知孩子。</p>
                </div>
              </div>
            </div>
          )}

          <div className="mx-4 border-t border-gray-100" />

          {/* 数值参数 */}
          <div className="px-4 py-3 space-y-3">
            {(Object.keys(NUMBER_RULES) as NumberFieldKey[]).map((field) => {
              const rule = NUMBER_RULES[field]
              return (
                <div key={field} className="flex items-center space-x-2">
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-gray-700">{rule.label}</span>
                    <span className="text-[11px] text-gray-400 ml-1.5">
                      {rule.min} ~ {rule.max} {rule.unit}
                    </span>
                  </div>
                  <input
                    type="number"
                    min={rule.min}
                    max={rule.max}
                    value={numberDrafts[field]}
                    onChange={(e) =>
                      setNumberDrafts((current) => ({ ...current, [field]: e.target.value }))
                    }
                    onBlur={() => void handleNumberBlur(field)}
                    disabled={busyKey === field}
                    aria-label={rule.label}
                    className="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:border-[#07c160] disabled:bg-gray-50"
                  />
                  <span className="text-sm text-gray-500 w-6">{rule.unit}</span>
                </div>
              )
            })}
          </div>

          <div className="mx-4 border-t border-gray-100" />

          {/* AI 分析开关与采样数 */}
          <div className="flex items-center py-3 px-4">
            <div className="flex-1 min-w-0">
              <div className="font-medium text-gray-900 text-sm">开启 AI 分析</div>
              <div className="text-xs text-gray-400 mt-0.5">
                {isAi ? '已配置视觉模型，会对截图做真实分析' : '模型未就绪，开启后仍只会做启发式推断'}
              </div>
            </div>
            <Toggle
              checked={config?.analyzeEnabled ?? false}
              disabled={busyKey === 'analyzeEnabled' || !config}
              label="AI 分析开关"
              onChange={() => {
                if (!config) return
                void saveConfig(
                  { analyzeEnabled: !config.analyzeEnabled },
                  !config.analyzeEnabled ? 'AI 分析已开启' : 'AI 分析已关闭',
                  'analyzeEnabled',
                )
              }}
            />
          </div>

          <div className="mx-4 border-t border-gray-100" />

          {/* 用屏幕内容出题 */}
          <div className="flex items-center py-3 px-4">
            <div className="flex-1 min-w-0">
              <div className="font-medium text-gray-900 text-sm">用屏幕内容出题</div>
              <div className="text-xs text-gray-400 mt-0.5">
                {config?.quizFromScreen
                  ? '答题解锁会使用屏幕里出现的内容出题'
                  : '答题解锁只从题库取题'}
              </div>
            </div>
            <Toggle
              checked={config?.quizFromScreen ?? false}
              disabled={busyKey === 'quizFromScreen' || !config}
              label="用屏幕内容出题开关"
              onChange={() => {
                if (!config) return
                void saveConfig(
                  { quizFromScreen: !config.quizFromScreen },
                  !config.quizFromScreen ? '已开启屏幕出题' : '已关闭屏幕出题',
                  'quizFromScreen',
                )
              }}
            />
          </div>

          <div className="mx-4 border-t border-gray-100" />

          {/* 5 类提醒开关 */}
          <div className="px-4 py-3">
            <p className="text-xs text-gray-400 mb-1">异常提醒类型</p>
            {ALERT_SWITCHES.map((item, index) => (
              <div key={String(item.key)}>
                <div className="flex items-center py-2.5">
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-gray-800">{item.label}</span>
                    <p className="text-[11px] text-gray-400 mt-0.5">{item.desc}</p>
                  </div>
                  <Toggle
                    checked={Boolean(config?.[item.key])}
                    disabled={busyKey === String(item.key) || !config}
                    label={`${item.label}提醒开关`}
                    onChange={() => {
                      if (!config) return
                      const current = Boolean(config[item.key])
                      void saveConfig(
                        { [item.key]: !current },
                        `${item.label}提醒${current ? '已关闭' : '已开启'}`,
                        String(item.key),
                      )
                    }}
                  />
                </div>
                {index < ALERT_SWITCHES.length - 1 && <div className="border-t border-gray-100" />}
              </div>
            ))}
          </div>
        </Card>

        <div className="mt-2">
          <div className="bg-white rounded-lg p-3 border border-gray-100">
            <div className="flex items-start space-x-2">
              <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-gray-500 leading-relaxed">
                这些开关都作用在孩子设备上，改动会立即保存并重新读取；设备下次上报时生效。
                截屏与 AI 分析都是敏感能力，关闭截屏后不会再产生新的洞察批次。
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ---------------- 用量上限 ---------------- */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">用量上限</span>
        </div>

        <Card className="overflow-hidden">
          {(Object.keys(BUDGET_KIND_META) as UsageBudgetKind[]).map((kind, kindIndex) => {
            const meta = BUDGET_KIND_META[kind]
            const KindIcon = meta.icon
            const rows = budgets.filter((budget) => budget.kind === kind)
            return (
              <div key={kind}>
                <div className="flex items-center px-4 pt-3 pb-2">
                  <div className="w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center flex-shrink-0">
                    <KindIcon className="w-5 h-5 text-gray-500" />
                  </div>
                  <div className="flex-1 min-w-0 ml-3">
                    <div className="font-medium text-gray-900 text-sm">{meta.label}</div>
                    <div className="text-xs text-gray-400 mt-0.5">{meta.desc}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => openBudgetDialog(kind)}
                    className="text-xs text-[#07c160] flex items-center flex-shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5 mr-0.5" />
                    设置
                  </button>
                </div>

                {rows.length === 0 ? (
                  <p className="px-4 pb-3 text-xs text-gray-400">
                    还没有设置{meta.label}上限，孩子今天可以无限{kind === 'game_round' ? '玩' : '看'}。
                  </p>
                ) : (
                  rows.map((budget) => {
                    const summary = enabledBudgets.find((entry) => entry.id === budget.id)
                    const usedToday = summary?.usedToday ?? budget.usedToday
                    const exceeded = summary?.exceeded ?? usedToday >= budget.dailyLimit
                    // 同一类型可能同时存在「全部应用」和「指定应用」两条，无障碍标签要能区分
                    const scope = budget.appName || '全部应用'
                    return (
                      <div key={budget.id} className="flex items-center px-4 py-2.5">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center flex-wrap gap-1.5">
                            <span className="text-sm text-gray-900">{scope}</span>
                            {!budget.enabled && (
                              <Badge className="bg-gray-100 text-gray-500 text-[10px]">已停用</Badge>
                            )}
                            {budget.enabled && exceeded && (
                              <Badge className="bg-red-100 text-red-700 text-[10px]">已达上限</Badge>
                            )}
                          </div>
                          <p className="text-[11px] text-gray-400 mt-0.5">
                            今日已用 {usedToday} {meta.unit} / 上限 {budget.dailyLimit} {meta.unit}
                            {budget.enabled && summary ? `（剩余 ${summary.remaining}）` : ''}
                          </p>
                          {budget.enabled && exceeded && (
                            <p className="text-[11px] text-red-600 mt-0.5">
                              已达上限，后端会自动下发锁屏指令
                            </p>
                          )}
                        </div>

                        <Toggle
                          checked={budget.enabled}
                          disabled={busyKey === `budget-${budget.id}`}
                          label={`${meta.label}上限开关（${scope}）`}
                          onChange={() => void handleToggleBudget(budget)}
                        />
                        <button
                          type="button"
                          onClick={() => openBudgetDialog(kind, budget)}
                          className="text-gray-300 hover:text-[#07c160] p-1.5 ml-1"
                          aria-label={`编辑${meta.label}上限（${scope}）`}
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setRemoveBudgetTarget(budget)}
                          className="text-gray-300 hover:text-red-500 p-1.5"
                          aria-label={`删除${meta.label}上限（${scope}）`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )
                  })
                )}

                {kindIndex < Object.keys(BUDGET_KIND_META).length - 1 && (
                  <div className="mx-4 border-t border-gray-100" />
                )}
              </div>
            )
          })}
        </Card>

        <p className="mt-2 px-1 text-[11px] text-gray-400 leading-relaxed">
          局数与集数由 AI / 启发式分析从屏幕内容里统计，可能有误差；达到上限后后端会自动下发锁屏指令。
        </p>
      </div>

      {/* ---------------- 洞察时间线 ---------------- */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">洞察时间线</span>
          <button
            type="button"
            onClick={() => {
              const next = !onlyRisky
              setOnlyRisky(next)
              void loadAll({ onlyRisky: next, alertType, unreadOnly }, { silent: true })
            }}
            className={`text-xs px-2 py-1 rounded-full transition-colors ${
              onlyRisky ? 'bg-[#07c160] text-white' : 'text-[#07c160]'
            }`}
          >
            只看中高风险
          </button>
        </div>

        {items.length === 0 ? (
          <Card className="overflow-hidden">
            <CardContent className="p-8 text-center">
              <ImageOff className="w-10 h-10 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-700 font-medium">
                {onlyRisky ? '没有中高风险的洞察记录' : '还没有洞察记录'}
              </p>
              <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">
                {config?.captureEnabled
                  ? '截屏采集已开启。孩子在设备上使用一段时间、设备上传截屏包并完成分析后，这里会出现一条条按批次记录的洞察结论。'
                  : '截屏采集当前是关闭的。开启后，设备会周期性上传屏幕画面用于分析，结论会按批次出现在这里。'}
              </p>
              <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                本页只展示分析结论与帧时间线（时间 + 应用名），不提供截图原图查看。
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {items.map((item) => {
              const risk = RISK_META[item.riskLevel] ?? RISK_META.none
              const apps = uniqueApps(item)
              const expanded = expandedId === item.id
              return (
                <Card
                  key={item.id}
                  id={`insight-${item.id}`}
                  className={`overflow-hidden border-l-4 ${risk.stripe}`}
                >
                  <button
                    type="button"
                    onClick={() => void handleToggleDetail(item.id)}
                    className="w-full text-left p-4 hover:bg-gray-50 active:bg-gray-100 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center flex-wrap gap-1.5 min-w-0">
                        <Badge className={`${risk.badge} text-[10px]`}>{risk.label}</Badge>
                        {item.isAi ? (
                          <Badge className="bg-green-100 text-green-700 text-[10px]">AI 分析</Badge>
                        ) : (
                          <Badge className="bg-gray-100 text-gray-500 text-[10px]">启发式推断</Badge>
                        )}
                        {item.completedRounds > 0 && (
                          <Badge className="bg-indigo-100 text-indigo-700 text-[10px]">
                            完成 {item.completedRounds} 局
                          </Badge>
                        )}
                        {item.completedEpisodes > 0 && (
                          <Badge className="bg-cyan-100 text-cyan-700 text-[10px]">
                            看完 {item.completedEpisodes} 集
                          </Badge>
                        )}
                      </div>
                      {expanded ? (
                        <ChevronUp className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      )}
                    </div>

                    <p className="mt-1.5 text-[11px] text-gray-400 flex items-center">
                      <Clock className="w-3 h-3 mr-1 flex-shrink-0" />
                      {formatPeriod(item)}
                      <span className="mx-1">·</span>
                      {item.frameCount} 帧
                    </p>

                    <p className="mt-2 text-sm text-gray-800 leading-relaxed">{item.summary}</p>

                    {apps.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {apps.map((app) => (
                          <Badge key={app} className="bg-gray-100 text-gray-600 text-[10px]">
                            {app}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </button>

                  {expanded && (
                    <div className="border-t border-gray-100 bg-gray-50 p-4">
                      {detailLoading && (
                        <div className="py-6 text-center">
                          <Loader2 className="w-5 h-5 text-[#07c160] animate-spin mx-auto" />
                          <p className="mt-1.5 text-xs text-gray-500">加载详情中...</p>
                        </div>
                      )}

                      {!detailLoading && !detail && (
                        <p className="text-xs text-gray-500 text-center py-4">详情加载失败，请收起后重试</p>
                      )}

                      {!detailLoading && detail && (
                        <div className="space-y-3">
                          {/* 帧时间线 */}
                          <div className="bg-white rounded-lg border border-gray-100 p-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium text-gray-700">帧时间线</span>
                              <span className="text-[11px] text-gray-400">
                                {formatFrameRange(detail.frames)}
                              </span>
                            </div>
                            {detail.frames.length === 0 ? (
                              <p className="mt-2 text-[11px] text-gray-400">本包没有帧记录</p>
                            ) : (
                              <div className="mt-2 max-h-64 overflow-y-auto space-y-1.5">
                                {detail.frames.map((frame) => (
                                  <div key={frame.seq} className="flex items-center text-xs">
                                    <span className="w-2 h-2 rounded-full bg-[#07c160] flex-shrink-0 mr-2" />
                                    <span className="text-gray-500 w-20 flex-shrink-0 tabular-nums">
                                      {formatClock(frame.capturedAt)}
                                    </span>
                                    <span className="text-gray-800 truncate">
                                      {frame.appLabel || frame.packageName || '未知应用'}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                            <p className="mt-2 text-[11px] text-gray-400 leading-relaxed">
                              出于儿童隐私约定，后端不返回截图原图地址，这里只有「时间 + 应用名」。
                            </p>
                          </div>

                          {/* 游戏明细 */}
                          {detail.games.length > 0 && (
                            <div className="bg-white rounded-lg border border-gray-100 p-3">
                              <span className="text-xs font-medium text-gray-700">游戏识别</span>
                              <div className="mt-2 space-y-2">
                                {detail.games.map((game, index) => (
                                  <div key={`${game.name}-${index}`} className="text-xs">
                                    <div className="flex items-center flex-wrap gap-1.5">
                                      <span className="text-gray-900 font-medium">
                                        {game.name || '未知游戏'}
                                      </span>
                                      <Badge className="bg-gray-100 text-gray-600 text-[10px]">
                                        {game.scene}
                                      </Badge>
                                      {game.roundCompleted && (
                                        <Badge className="bg-indigo-100 text-indigo-700 text-[10px]">
                                          已完成一局
                                        </Badge>
                                      )}
                                      <span className="text-gray-400">
                                        置信度 {(game.confidence * 100).toFixed(0)}%
                                      </span>
                                    </div>
                                    {game.evidence && (
                                      <p className="mt-1 text-gray-600 leading-relaxed break-words">
                                        依据：{game.evidence}
                                      </p>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* 视频明细 */}
                          {detail.videos.length > 0 && (
                            <div className="bg-white rounded-lg border border-gray-100 p-3">
                              <span className="text-xs font-medium text-gray-700">动画 / 视频识别</span>
                              <div className="mt-2 space-y-2">
                                {detail.videos.map((video, index) => (
                                  <div key={`${video.name}-${index}`} className="text-xs">
                                    <div className="flex items-center flex-wrap gap-1.5">
                                      <span className="text-gray-900 font-medium">
                                        {video.name || '未知视频'}
                                      </span>
                                      {video.episodeCompleted && (
                                        <Badge className="bg-cyan-100 text-cyan-700 text-[10px]">
                                          已看完一集
                                        </Badge>
                                      )}
                                      <span className="text-gray-400">
                                        置信度 {(video.confidence * 100).toFixed(0)}%
                                      </span>
                                    </div>
                                    {video.evidence && (
                                      <p className="mt-1 text-gray-600 leading-relaxed break-words">
                                        依据：{video.evidence}
                                      </p>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* 用量片段 */}
                          {detail.episodes.length > 0 && (
                            <div className="bg-white rounded-lg border border-gray-100 p-3">
                              <span className="text-xs font-medium text-gray-700">用量统计依据</span>
                              <div className="mt-2 space-y-2">
                                {detail.episodes.map((episode: UsageEpisode) => (
                                  <div key={episode.id} className="text-xs">
                                    <div className="flex items-center flex-wrap gap-1.5">
                                      <span className="text-gray-900 font-medium">
                                        {episode.kindLabel}
                                      </span>
                                      <Badge className="bg-gray-100 text-gray-600 text-[10px]">
                                        {episode.appName || '全部应用'}
                                      </Badge>
                                      <span className="text-gray-500">+{episode.count}</span>
                                      <span className="text-gray-400">
                                        置信度 {(episode.confidence * 100).toFixed(0)}%
                                      </span>
                                    </div>
                                    {episode.evidence && (
                                      <p className="mt-1 text-gray-600 leading-relaxed break-words">
                                        依据：{episode.evidence}
                                      </p>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* 关键词与知识点 */}
                          {(detail.keywords.length > 0 || detail.topics.length > 0) && (
                            <div className="bg-white rounded-lg border border-gray-100 p-3 space-y-2">
                              {detail.keywords.length > 0 && (
                                <div>
                                  <span className="text-xs font-medium text-gray-700">关键词</span>
                                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                                    {detail.keywords.map((keyword) => (
                                      <Badge key={keyword} className="bg-gray-100 text-gray-600 text-[10px]">
                                        {keyword}
                                      </Badge>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {detail.topics.length > 0 && (
                                <div>
                                  <span className="text-xs font-medium text-gray-700">相关知识点</span>
                                  <div className="mt-1.5 space-y-1">
                                    {detail.topics.map((topic) => (
                                      <p key={`${topic.subject}-${topic.term}`} className="text-xs text-gray-600">
                                        {topic.term}
                                        {topic.meaning ? ` — ${topic.meaning}` : ''}
                                      </p>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}

                          {/* 本批次关联的提醒 */}
                          {detail.alerts.length > 0 && (
                            <div className="bg-white rounded-lg border border-gray-100 overflow-hidden">
                              <p className="text-xs font-medium text-gray-700 px-3 pt-3">本批次触发的提醒</p>
                              {sortAlerts(detail.alerts).map((alert, index) => (
                                <div key={alert.id}>
                                  <AlertCard
                                    alert={alert}
                                    busy={busyKey === `alert-${alert.id}`}
                                    onMarkRead={(target) => void handleMarkRead(target)}
                                    onOpenInsight={handleOpenInsightFromAlert}
                                  />
                                  {index < detail.alerts.length - 1 && (
                                    <div className="mx-4 border-t border-gray-100" />
                                  )}
                                </div>
                              ))}
                            </div>
                          )}

                          {/* 模型信息 + 原始输出 */}
                          <div className="bg-white rounded-lg border border-gray-100 p-3">
                            <p className="text-[11px] text-gray-400 leading-relaxed">
                              分析来源：{detail.provider || '未知'}
                              {detail.model ? ` / ${detail.model}` : ''}
                              {' · '}
                              批次 {detail.batchId}
                            </p>
                            <button
                              type="button"
                              onClick={() => setRawOpen((current) => !current)}
                              className="mt-2 text-xs text-[#07c160] flex items-center"
                            >
                              {rawOpen ? (
                                <ChevronUp className="w-3.5 h-3.5 mr-0.5" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5 mr-0.5" />
                              )}
                              {rawOpen ? '收起原始输出' : '查看原始 AI 输出（排查用）'}
                            </button>
                            {rawOpen && (
                              <pre className="mt-2 max-h-64 overflow-auto bg-gray-900 text-gray-100 text-[11px] rounded-lg p-3 whitespace-pre-wrap break-words">
                                {detail.rawJson || '（后端没有保存原始输出）'}
                              </pre>
                            )}
                          </div>

                          {/* 重新分析 */}
                          <div className="flex items-center justify-between bg-white rounded-lg border border-gray-100 p-3">
                            <p className="text-[11px] text-gray-500 leading-relaxed flex-1 mr-2">
                              换了模型或觉得结论不准，可以重新分析这一批截屏；旧结论会被清除后重跑。
                            </p>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busyKey === `reanalyze-${detail.id}`}
                              onClick={() => void handleReanalyze(detail.id)}
                              className="flex-shrink-0"
                            >
                              {busyKey === `reanalyze-${detail.id}` ? (
                                <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                              ) : (
                                <RefreshCw className="w-3.5 h-3.5 mr-1" />
                              )}
                              重新分析
                            </Button>
                          </div>

                          <p className="text-[11px] text-gray-400 leading-relaxed">
                            AI 判断可能有误，请结合实际：以上结论由模型从屏幕画面推断，
                            可能把正常的浏览、学习误判为风险行为。
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              )
            })}
          </div>
        )}

        {items.length > 0 && (
          <p className="mt-2 px-1 text-[11px] text-gray-400 leading-relaxed">
            每条 = 一个截屏批次（{config?.framesPerBatch ?? 10} 张一包，约每 {config?.captureIntervalSeconds ?? 30} 秒一张）。
            点开可看帧时间线、识别明细与原始输出。
          </p>
        )}
      </div>

      {/* ---------------- 编辑用量上限 ---------------- */}
      <Dialog open={budgetDialogOpen} onOpenChange={setBudgetDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingBudget ? `编辑${kindLabel(budgetForm.kind)}上限` : `设置${kindLabel(budgetForm.kind)}上限`}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="text-sm text-gray-600 block mb-1.5">限制类型</label>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(BUDGET_KIND_META) as UsageBudgetKind[]).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    disabled={Boolean(editingBudget)}
                    onClick={() => setBudgetForm((current) => ({ ...current, kind }))}
                    className={`p-2.5 rounded-lg border text-left transition-colors disabled:opacity-60 ${
                      budgetForm.kind === kind ? 'border-[#07c160] bg-green-50' : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <span className="text-sm font-medium text-gray-900">{BUDGET_KIND_META[kind].label}</span>
                    <span className="block text-[11px] text-gray-500 mt-0.5">
                      {BUDGET_KIND_META[kind].desc}
                    </span>
                  </button>
                ))}
              </div>
              {editingBudget && (
                <p className="mt-1 text-[11px] text-gray-400">
                  编辑已有上限时不能改类型与应用，避免在同一天重复计数。
                </p>
              )}
            </div>

            <div>
              <label className="text-sm text-gray-600 block mb-1.5" htmlFor="budget-app-name">
                应用（留空 = 全部应用）
              </label>
              <input
                id="budget-app-name"
                type="text"
                value={budgetForm.appName}
                disabled={Boolean(editingBudget)}
                onChange={(e) => setBudgetForm((current) => ({ ...current, appName: e.target.value }))}
                placeholder="例如 王者荣耀，留空表示不限应用"
                maxLength={50}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160] disabled:bg-gray-50 disabled:text-gray-500"
              />
            </div>

            <div>
              <label className="text-sm text-gray-600 block mb-1.5" htmlFor="budget-daily-limit">
                每日上限
              </label>
              <div className="flex items-center space-x-2">
                <input
                  id="budget-daily-limit"
                  type="number"
                  min={1}
                  max={200}
                  value={budgetForm.dailyLimit}
                  onChange={(e) => setBudgetForm((current) => ({ ...current, dailyLimit: e.target.value }))}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
                />
                <span className="text-sm text-gray-500">
                  {BUDGET_KIND_META[budgetForm.kind].unit} / 天
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[1, 2, 3, 5, 10].map((preset) => (
                  <Button
                    key={preset}
                    variant="outline"
                    size="sm"
                    onClick={() => setBudgetForm((current) => ({ ...current, dailyLimit: String(preset) }))}
                    className={budgetForm.dailyLimit === String(preset) ? 'border-[#07c160] text-[#07c160]' : ''}
                  >
                    {preset} {BUDGET_KIND_META[budgetForm.kind].unit}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex items-center py-1">
              <div className="flex-1 min-w-0">
                <span className="text-sm text-gray-800">启用该上限</span>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  启用后达到上限会自动下发锁屏指令
                </p>
              </div>
              <Toggle
                checked={budgetForm.enabled}
                label="启用该上限"
                onChange={() => setBudgetForm((current) => ({ ...current, enabled: !current.enabled }))}
              />
            </div>

            {budgetFormError && (
              <div className="flex items-start space-x-2 bg-red-50 border border-red-200 rounded-lg p-2.5">
                <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-red-700">{budgetFormError}</p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setBudgetDialogOpen(false)} disabled={submittingBudget}>
              取消
            </Button>
            <Button
              className="bg-[#07c160] hover:bg-[#06a050]"
              onClick={() => void handleSubmitBudget()}
              disabled={submittingBudget}
            >
              {submittingBudget ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- 删除用量上限 ---------------- */}
      <Dialog
        open={Boolean(removeBudgetTarget)}
        onOpenChange={(open) => !open && setRemoveBudgetTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除用量上限</DialogTitle>
          </DialogHeader>
          <p className="text-gray-600">
            确定要删除「{removeBudgetTarget ? kindLabel(removeBudgetTarget.kind) : ''}
            {removeBudgetTarget?.appName ? ` · ${removeBudgetTarget.appName}` : ' · 全部应用'}」这条上限吗？
            删除后不再限制，也不再自动锁屏。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveBudgetTarget(null)}>
              取消
            </Button>
            <Button className="bg-red-500 hover:bg-red-600 text-white" onClick={() => void handleRemoveBudget()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
