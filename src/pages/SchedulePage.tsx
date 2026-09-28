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
  CalendarClock,
  ChevronRight,
  Info,
  Lock,
  LockOpen,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Timer,
  Trash2,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type {
  LockPolicy,
  LockStrength,
  ScheduleAction,
  ScheduleListResponse,
  ScheduleRule,
  ScheduleRuleInput,
} from '@/types'

/** 0=周日 … 6=周六，与后端 `daysOfWeek` 和 JS `Date.getDay()` 一致；展示顺序按中文习惯从周一开始 */
const WEEKDAY_META = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 0, label: '日' },
] as const

/** 索引即星期几（0=周日），用于拼「周日、周三」 */
const DAY_LABEL = ['日', '一', '二', '三', '四', '五', '六']

const ACTION_META: Record<ScheduleAction, { label: string; desc: string; className: string; icon: typeof Lock }> = {
  lock: {
    label: '锁定',
    desc: '该时段不允许使用',
    className: 'bg-red-100 text-red-700',
    icon: Lock,
  },
  unlock: {
    label: '允许使用',
    desc: '该时段可以使用（优先于锁定）',
    className: 'bg-green-100 text-green-700',
    icon: LockOpen,
  },
}

const STRENGTH_META: Record<LockStrength, { title: string; desc: string }> = {
  kiosk: {
    title: '锁定页（kiosk）',
    desc: '锁定后停在锁定页，家长可以随时远程解锁，推荐日常使用。',
  },
  password: {
    title: '系统密码（password）',
    desc: '锁定瞬间把系统锁屏密码改成随机值，孩子无法绕过锁定页。',
  },
}

/** 倒计时预告的快捷取值（0 = 不预告） */
const COUNTDOWN_PRESETS = [0, 10, 30, 60, 300]

/** 常用时段预设：跨天的睡觉时段是最常见的用法 */
const TIME_PRESETS: { name: string; startMinute: number; endMinute: number; action: ScheduleAction }[] = [
  { name: '睡觉 22:00 → 次日 07:00', startMinute: 1320, endMinute: 420, action: 'lock' },
  { name: '上学 08:00 → 17:00', startMinute: 480, endMinute: 1020, action: 'lock' },
  { name: '午休放行 12:00 → 14:00', startMinute: 720, endMinute: 840, action: 'unlock' },
  { name: '全天 00:00 → 24:00', startMinute: 0, endMinute: 1440, action: 'lock' },
]

/**
 * 表单以「分钟数」为准而不是 HH:MM 字符串：
 * `<input type="time">` 表达不了 24:00，用字符串存会把「全天 00:00 → 24:00」
 * 悄悄降级成 23:59。分钟数只在渲染时转成控件的 HH:MM 值。
 */
interface RuleFormState {
  name: string
  action: ScheduleAction
  days: number[]
  startMinute: number
  endMinute: number
}

const emptyForm = (): RuleFormState => ({
  name: '',
  action: 'lock',
  days: WEEKDAY_META.map((day) => day.value),
  startMinute: 1320,
  endMinute: 420,
})

function padTwo(value: number): string {
  return String(value).padStart(2, '0')
}

/** 分钟数 → `<input type="time">` 的 HH:MM；1440 是控件表达不了的 24:00，按 23:59 显示并另行提示 */
function minuteToTime(minute: number): string {
  if (minute >= 1440) return '23:59'
  return `${padTwo(Math.floor(minute / 60))}:${padTwo(minute % 60)}`
}

/** HH:MM → 分钟数 */
function timeToMinute(value: string): number {
  const [hourText, minuteText] = value.split(':')
  const hour = Number.parseInt(hourText ?? '', 10)
  const minute = Number.parseInt(minuteText ?? '', 10)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0
  return Math.min(1439, Math.max(0, hour * 60 + minute))
}

/** 1320 → 「22:00」，1440 → 「24:00」 */
function formatMinute(minute: number): string {
  if (minute >= 1440) return '24:00'
  return `${padTwo(Math.floor(minute / 60))}:${padTwo(minute % 60)}`
}

/** 跨天判断：endMinute < startMinute（22:00 → 次日 07:00） */
function isOvernight(startMinute: number, endMinute: number): boolean {
  return endMinute < startMinute
}

/** 「22:00 → 次日 07:00」这类时段文案 */
function formatRange(startMinute: number, endMinute: number): string {
  return isOvernight(startMinute, endMinute)
    ? `${formatMinute(startMinute)} → 次日 ${formatMinute(endMinute)}`
    : `${formatMinute(startMinute)} → ${formatMinute(endMinute)}`
}

/**
 * 星期文案。
 * 全选显示「每天」；「周一至周五」单独识别（最常见的作息）；
 * 其余按「周一、周三」列出，周日放在最后更符合中文习惯。
 */
function formatDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b)
  if (sorted.length === 0) return '未选择'
  if (sorted.length === 7) return '每天'
  if (sorted.length === 5 && [1, 2, 3, 4, 5].every((day) => sorted.includes(day))) return '周一至周五'
  return [1, 2, 3, 4, 5, 6, 0]
    .filter((day) => sorted.includes(day))
    .map((day) => `周${DAY_LABEL[day]}`)
    .join('、')
}

/** 把 ISO 时间转成「今天 22:00」「明天 07:00」这类中文短句（按本机时区） */
function formatDateTime(iso: string): string {
  const target = new Date(iso)
  if (Number.isNaN(target.getTime())) return '未知时间'
  const now = new Date()
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(target) - startOfDay(now)) / 86_400_000)
  const clock = `${padTwo(target.getHours())}:${padTwo(target.getMinutes())}`
  const prefix =
    dayDiff === 0
      ? '今天'
      : dayDiff === 1
        ? '明天'
        : dayDiff === 2
          ? '后天'
          : `${target.getMonth() + 1}月${target.getDate()}日`
  return `${prefix} ${clock}`
}

function validateForm(form: RuleFormState): string | null {
  if (!form.name.trim()) return '请填写规则名称'
  if (form.name.trim().length > 30) return '名称最多 30 个字'
  if (form.days.length === 0) return '请至少选择一天'
  if (form.startMinute === form.endMinute) {
    return '开始时间与结束时间不能相同；要表达「整天」请用「全天 00:00 → 24:00」预设'
  }
  return null
}

export function SchedulePage() {
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [policy, setPolicy] = useState<LockPolicy | null>(null)
  const [rules, setRules] = useState<ScheduleRule[]>([])
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [preview, setPreview] = useState<ScheduleListResponse['preview'] | null>(null)

  /** 倒计时秒数需要本地草稿，避免边输边发请求 / 每敲一位弹一次 toast */
  const [countdownDraft, setCountdownDraft] = useState('30')
  const [busy, setBusy] = useState<string | null>(null)

  const [ruleDialogOpen, setRuleDialogOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<ScheduleRule | null>(null)
  const [form, setForm] = useState<RuleFormState>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<ScheduleRule | null>(null)

  const loadData = useCallback(async (options?: { silent?: boolean }) => {
    try {
      const [policyData, scheduleData] = await Promise.all([api.getLockPolicy(), api.getSchedules()])
      setPolicy(policyData)
      setCountdownDraft(String(policyData.countdownSeconds))
      setRules(scheduleData.schedules ?? [])
      setScheduleEnabled(scheduleData.scheduleEnabled)
      setPreview(scheduleData.preview ?? null)
      setError(null)
    } catch (err) {
      const message = toUserMessage(err, '加载锁屏设置失败')
      setError(message)
      // 首次加载失败才弹 toast；mutation 之后的静默刷新失败不打扰用户
      if (!options?.silent) toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  /** 策略类修改的统一包装：成功后重新拉取数据，失败统一走 toUserMessage */
  const savePolicy = async (
    patch: { strength?: LockStrength; countdownSeconds?: number; scheduleEnabled?: boolean },
    successText: string,
    key: string,
  ) => {
    setBusy(key)
    try {
      await api.updateLockPolicy(patch)
      toast.success(successText)
      await loadData({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, '保存失败，请稍后重试'))
      console.error('保存锁屏策略失败：', err)
    } finally {
      setBusy(null)
    }
  }

  const handleSaveCountdown = async () => {
    const seconds = Number.parseInt(countdownDraft, 10)
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) {
      toast.error('倒计时需在 0 ~ 600 秒之间')
      setCountdownDraft(String(policy?.countdownSeconds ?? 30))
      return
    }
    if (seconds === policy?.countdownSeconds) return
    await savePolicy(
      { countdownSeconds: seconds },
      seconds === 0 ? '已关闭锁屏预告' : `锁屏预告已设为 ${seconds} 秒`,
      'countdown',
    )
  }

  const handleSaveStrength = async (strength: LockStrength) => {
    if (strength === policy?.strength) return
    await savePolicy({ strength }, `锁屏强度已切换为「${STRENGTH_META[strength].title}」`, 'strength')
  }

  const handleToggleSchedule = async () => {
    await savePolicy(
      { scheduleEnabled: !scheduleEnabled },
      scheduleEnabled ? '定时时间表已暂停' : '定时时间表已启用',
      'scheduleEnabled',
    )
  }

  const handleToggleRule = async (rule: ScheduleRule) => {
    const label = rule.name || '未命名规则'
    setBusy(rule.id)
    try {
      await api.updateSchedule(rule.id, { enabled: !rule.enabled })
      toast.success(rule.enabled ? `已暂停「${label}」` : `已启用「${label}」`)
      await loadData({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, '操作失败，请稍后重试'))
      console.error('切换规则状态失败：', err)
    } finally {
      setBusy(null)
    }
  }

  const openCreateDialog = () => {
    setEditingRule(null)
    setForm(emptyForm())
    setFormError(null)
    setRuleDialogOpen(true)
  }

  const openEditDialog = (rule: ScheduleRule) => {
    setEditingRule(rule)
    setForm({
      name: rule.name,
      action: rule.action,
      days: [...rule.daysOfWeek],
      startMinute: rule.startMinute,
      endMinute: rule.endMinute,
    })
    setFormError(null)
    setRuleDialogOpen(true)
  }

  const applyPreset = (preset: (typeof TIME_PRESETS)[number]) => {
    setForm((current) => ({
      ...current,
      startMinute: preset.startMinute,
      endMinute: preset.endMinute,
      action: preset.action,
    }))
  }

  const toggleDay = (day: number) => {
    setForm((current) => ({
      ...current,
      days: current.days.includes(day) ? current.days.filter((value) => value !== day) : [...current.days, day],
    }))
  }

  const handleSubmitRule = async () => {
    const invalid = validateForm(form)
    if (invalid) {
      setFormError(invalid)
      return
    }
    const payload: ScheduleRuleInput = {
      name: form.name.trim(),
      action: form.action,
      daysOfWeek: [...form.days].sort((a, b) => a - b),
      startMinute: form.startMinute,
      endMinute: form.endMinute,
      // 新增时默认启用；编辑时保持原有开关状态，避免保存动作顺手把暂停的规则打开
      enabled: editingRule ? editingRule.enabled : true,
    }

    setSubmitting(true)
    setFormError(null)
    try {
      if (editingRule) {
        await api.updateSchedule(editingRule.id, payload)
        toast.success('规则已更新')
      } else {
        await api.createSchedule(payload)
        toast.success('规则已添加')
      }
      setRuleDialogOpen(false)
      setEditingRule(null)
      setForm(emptyForm())
      await loadData({ silent: true })
    } catch (err) {
      const message = toUserMessage(err, '保存规则失败，请稍后重试')
      setFormError(message)
      toast.error(message)
      console.error('保存时间表规则失败：', err)
    } finally {
      setSubmitting(false)
    }
  }

  const handleRemoveRule = async () => {
    if (!removeTarget) return
    try {
      await api.deleteSchedule(removeTarget.id)
      toast.success('规则已删除')
      setRemoveTarget(null)
      await loadData({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, '删除失败，请稍后重试'))
      console.error('删除时间表规则失败：', err)
    }
  }

  const formOvernight = isOvernight(form.startMinute, form.endMinute)

  if (loading) {
    return (
      <div className="min-h-screen pb-20 bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]" />
          <p className="mt-2 text-gray-500 text-sm">加载中...</p>
        </div>
      </div>
    )
  }

  if (error && !policy) {
    return (
      <div className="min-h-screen pb-20 bg-gray-100">
        <div className="bg-white px-4 py-4 border-b border-gray-200 flex items-center">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-xl font-medium text-gray-900 flex-1">锁屏设置</h1>
        </div>
        <div className="px-6 py-20 text-center">
          <CalendarClock className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-700">{error}</p>
          <Button
            className="mt-4 bg-[#07c160] hover:bg-[#06a050]"
            onClick={() => {
              setLoading(true)
              void loadData()
            }}
          >
            重新加载
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen pb-20 bg-gray-100">
      <div className="bg-white px-4 py-4 border-b border-gray-200 flex items-center">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1">锁屏设置</h1>
        <button
          type="button"
          onClick={() => void loadData({ silent: true })}
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
              最新配置读取失败：{error}（下方仍是上一次成功加载的内容）
            </p>
            <button
              type="button"
              className="text-xs text-[#07c160] flex-shrink-0"
              onClick={() => void loadData({ silent: true })}
            >
              重试
            </button>
          </div>
        </div>
      )}

      {/* ---------------- 实时预览 ---------------- */}
      <div className="px-3 py-3">
        <Card className="overflow-hidden">
          <div
            className={`px-4 py-4 ${
              preview?.lockedNow
                ? 'bg-gradient-to-br from-red-500 to-red-600'
                : 'bg-gradient-to-br from-green-400 to-green-600'
            }`}
          >
            <div className="flex items-center space-x-3 text-white">
              <div className="w-11 h-11 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                {preview?.lockedNow ? <Lock className="w-6 h-6" /> : <LockOpen className="w-6 h-6" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-base font-medium">
                  {!scheduleEnabled ? '定时时间表已暂停' : preview?.lockedNow ? '现在处于锁定时段' : '现在允许使用'}
                </p>
                <p className="text-xs opacity-90 mt-0.5">
                  {!scheduleEnabled
                    ? '规则都已保存，但总开关关闭时不生效'
                    : preview?.matchedRuleName
                      ? `命中规则「${preview.matchedRuleName}」`
                      : '当前没有命中任何规则的时段'}
                </p>
              </div>
            </div>
          </div>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-start space-x-2">
              <CalendarClock className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-gray-700">
                {!scheduleEnabled ? (
                  <span className="text-gray-500">总开关关闭，打开后才会按规则自动锁定 / 放行</span>
                ) : !preview?.nextChangeAt || preview.nextChangeLocked === null ? (
                  <span className="text-gray-500">接下来 7 天内没有状态变化</span>
                ) : (
                  <>
                    下次状态变更：
                    <span className={`font-medium ${preview.nextChangeLocked ? 'text-red-600' : 'text-green-600'}`}>
                      {formatDateTime(preview.nextChangeAt)}
                      {preview.nextChangeLocked ? ' 锁定' : ' 解除锁定'}
                    </span>
                  </>
                )}
              </div>
            </div>

            {preview?.evaluatedAt && (
              <p className="text-[11px] text-gray-400 leading-relaxed border-t border-gray-100 pt-2">
                以上是<b>服务器时间</b>（{formatDateTime(preview.evaluatedAt)}）的推算结果，仅供参照；
                真正执行的是孩子设备，以设备本地时钟为准。
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 锁屏强度 ---------------- */}
      <div className="px-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">锁屏强度</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-4 space-y-3">
            {(['kiosk', 'password'] as LockStrength[]).map((strength) => {
              const selected = (policy?.strength ?? 'kiosk') === strength
              return (
                <button
                  key={strength}
                  type="button"
                  disabled={busy === 'strength'}
                  onClick={() => void handleSaveStrength(strength)}
                  className={`w-full text-left p-3 rounded-lg border transition-colors disabled:opacity-60 ${
                    selected ? 'border-[#07c160] bg-green-50' : 'border-gray-200 bg-white hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      {strength === 'kiosk' ? (
                        <ShieldCheck className="w-4 h-4 text-green-600" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-red-500" />
                      )}
                      <span className="font-medium text-gray-900 text-sm">{STRENGTH_META[strength].title}</span>
                    </div>
                    {selected && <Badge className="bg-[#07c160] text-white text-[10px]">当前</Badge>}
                  </div>
                  <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">{STRENGTH_META[strength].desc}</p>
                </button>
              )
            })}

            {policy?.strength === 'password' && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <div className="flex items-start space-x-2">
                  <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                  <div className="text-xs text-red-700 leading-relaxed space-y-1">
                    <p className="font-medium text-sm">高风险：请先设置好应急密码</p>
                    <p>
                      · 触发锁定时，设备会立刻把<b>系统锁屏密码改成随机值</b>
                      ，孩子（以及任何不知道随机值的人）都无法进入系统。
                    </p>
                    <p>
                      · 解锁只能靠家长端远程下发解锁指令；<b>网络不可用时，只能使用设备上事先设置的应急密码</b>。
                    </p>
                    <p>
                      · 请务必先在孩子设备上进入「锁屏设置 → 应急密码」完成设置并牢记该密码，
                      否则设备可能被彻底锁死，只能恢复出厂设置。
                    </p>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 锁屏倒计时预告 ---------------- */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">锁屏倒计时预告</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center space-x-2">
              <Timer className="w-4 h-4 text-gray-500 flex-shrink-0" />
              <span className="text-sm text-gray-700 flex-1">锁屏前预告秒数</span>
              <input
                type="number"
                min={0}
                max={600}
                value={countdownDraft}
                onChange={(e) => setCountdownDraft(e.target.value)}
                onBlur={() => void handleSaveCountdown()}
                disabled={busy === 'countdown'}
                className="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:border-[#07c160] disabled:bg-gray-50"
              />
              <span className="text-sm text-gray-500">秒</span>
            </div>

            <div className="flex flex-wrap gap-2">
              {COUNTDOWN_PRESETS.map((seconds) => (
                <Button
                  key={seconds}
                  variant="outline"
                  size="sm"
                  disabled={busy === 'countdown'}
                  onClick={() => {
                    setCountdownDraft(String(seconds))
                    if (seconds === policy?.countdownSeconds) return
                    void savePolicy(
                      { countdownSeconds: seconds },
                      seconds === 0 ? '已关闭锁屏预告' : `锁屏预告已设为 ${seconds} 秒`,
                      'countdown',
                    )
                  }}
                  className={policy?.countdownSeconds === seconds ? 'border-[#07c160] text-[#07c160]' : ''}
                >
                  {seconds === 0 ? '不预告' : `${seconds} 秒`}
                </Button>
              ))}
              <Button variant="outline" size="sm" disabled={busy === 'countdown'} onClick={() => void handleSaveCountdown()}>
                保存
              </Button>
            </div>

            <p className="text-xs text-gray-400 leading-relaxed">
              触发锁屏前，孩子设备会弹出一个透明悬浮窗做倒计时提醒，让孩子有时间收尾；
              0 表示不预告、直接锁屏。可填 0 ~ 600 秒，当前为 {policy?.countdownSeconds ?? 0} 秒。
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 定时时间表 ---------------- */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">定时时间表</span>
          <button type="button" className="text-xs text-[#07c160] flex items-center" onClick={openCreateDialog}>
            <Plus className="w-3.5 h-3.5 mr-0.5" />
            添加规则
          </button>
        </div>

        <Card className="overflow-hidden">
          {/* 总开关 */}
          <div className="flex items-center py-3 px-4">
            <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0">
              <CalendarClock className="w-5 h-5 text-purple-500" />
            </div>
            <div className="flex-1 min-w-0 ml-3">
              <div className="font-medium text-gray-900 text-sm">启用定时时间表</div>
              <div className="text-xs text-gray-400 mt-0.5">
                {scheduleEnabled ? '按下面的规则自动锁定 / 放行' : '关闭后所有规则都不生效'}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={scheduleEnabled}
              aria-label="定时时间表总开关"
              disabled={busy === 'scheduleEnabled'}
              onClick={() => void handleToggleSchedule()}
              className="w-11 h-6 rounded-full relative flex-shrink-0 ml-2 disabled:opacity-50"
            >
              <span
                className={`absolute w-5 h-5 rounded-full top-0.5 bg-white shadow transition-all ${
                  scheduleEnabled ? 'right-0.5' : 'left-0.5'
                }`}
              />
              <span className={`block w-full h-full rounded-full ${scheduleEnabled ? 'bg-[#07c160]' : 'bg-gray-300'}`} />
            </button>
          </div>

          <div className="mx-4 border-t border-gray-100" />

          {/* 规则列表 */}
          {rules.length === 0 ? (
            <div className="p-6 text-center">
              <Moon className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">
                还没有规则。最常见的用法是加一条「睡觉 22:00 → 次日 07:00 锁定」，
                再叠加一条「午休 12:00 → 14:00 允许使用」。
              </p>
              <Button variant="outline" size="sm" className="mt-3" onClick={openCreateDialog}>
                <Plus className="w-4 h-4 mr-1" />
                添加第一条规则
              </Button>
            </div>
          ) : (
            rules.map((rule, index) => {
              const actionMeta = ACTION_META[rule.action] ?? ACTION_META.lock
              const ActionIcon = actionMeta.icon
              const label = rule.name || '未命名规则'
              return (
                <div key={rule.id}>
                  <div className="flex items-center py-3 px-4">
                    <div className="w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center flex-shrink-0">
                      <ActionIcon className={`w-5 h-5 ${rule.action === 'lock' ? 'text-red-500' : 'text-green-600'}`} />
                    </div>
                    <div className="flex-1 min-w-0 ml-3">
                      <div className="flex items-center space-x-2 flex-wrap">
                        <span className="font-medium text-gray-900 text-sm truncate">{label}</span>
                        <Badge className={`${actionMeta.className} text-[10px]`}>{actionMeta.label}</Badge>
                        {!rule.enabled && <Badge className="bg-gray-100 text-gray-500 text-[10px]">已暂停</Badge>}
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {formatDays(rule.daysOfWeek)} · {formatRange(rule.startMinute, rule.endMinute)}
                        {isOvernight(rule.startMinute, rule.endMinute) ? '（跨天）' : ''}
                      </p>
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={rule.enabled}
                      aria-label={`${label}开关`}
                      disabled={busy === rule.id}
                      onClick={() => void handleToggleRule(rule)}
                      className="w-11 h-6 rounded-full relative flex-shrink-0 ml-1 disabled:opacity-50"
                    >
                      <span
                        className={`absolute w-5 h-5 rounded-full top-0.5 bg-white shadow transition-all ${
                          rule.enabled ? 'right-0.5' : 'left-0.5'
                        }`}
                      />
                      <span className={`block w-full h-full rounded-full ${rule.enabled ? 'bg-[#07c160]' : 'bg-gray-300'}`} />
                    </button>

                    <button
                      type="button"
                      onClick={() => openEditDialog(rule)}
                      className="text-gray-300 hover:text-[#07c160] p-1.5 ml-1"
                      aria-label={`编辑 ${label}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemoveTarget(rule)}
                      className="text-gray-300 hover:text-red-500 p-1.5"
                      aria-label={`删除 ${label}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  {index < rules.length - 1 && <div className="mx-4 border-t border-gray-100" />}
                </div>
              )
            })
          )}
        </Card>

        {/* 语义说明：求值优先级最容易被误解，必须用人话讲清楚 */}
        <div className="mt-2">
          <div className="bg-white rounded-lg p-3 border border-gray-100">
            <div className="flex items-start space-x-2">
              <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-gray-500 leading-relaxed space-y-1">
                <p className="font-medium text-gray-700">规则怎么生效</p>
                <p>
                  · <b>允许使用</b>优先于<b>锁定</b>：先看有没有命中放行规则，命中就允许使用；否则命中锁定规则才锁定；
                  都没命中，就不会因为时间表而锁定。
                </p>
                <p>· 因此「整晚锁定 + 中午放行」可以直接叠加，不需要为放行时段额外挖洞。</p>
                <p>
                  · 开始时间晚于结束时间表示<b>跨天</b>，例如 22:00 → 07:00 就是当天 22:00 到次日 07:00；
                  开始与结束时间不能相同，要表达整天请填 00:00 → 24:00。
                </p>
                <p>· 星期和时段都按设备本地时间判断，周日对应 0，周一对应 1。</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ---------------- 新增 / 编辑规则 ---------------- */}
      <Dialog open={ruleDialogOpen} onOpenChange={setRuleDialogOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingRule ? '编辑规则' : '添加规则'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="text-sm text-gray-600 block mb-1.5">名称</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))}
                placeholder="例如 晚上睡觉"
                maxLength={30}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
              />
            </div>

            <div>
              <label className="text-sm text-gray-600 block mb-1.5">动作</label>
              <div className="grid grid-cols-2 gap-2">
                {(['lock', 'unlock'] as ScheduleAction[]).map((action) => (
                  <button
                    key={action}
                    type="button"
                    onClick={() => setForm((current) => ({ ...current, action }))}
                    className={`p-2.5 rounded-lg border text-left transition-colors ${
                      form.action === action ? 'border-[#07c160] bg-green-50' : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <span className="text-sm font-medium text-gray-900">{ACTION_META[action].label}</span>
                    <span className="block text-[11px] text-gray-500 mt-0.5">{ACTION_META[action].desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm text-gray-600 block mb-1.5">星期（至少一天）</label>
              <div className="grid grid-cols-7 gap-1.5">
                {WEEKDAY_META.map((day) => {
                  const selected = form.days.includes(day.value)
                  return (
                    <button
                      key={day.value}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleDay(day.value)}
                      className={`py-2 rounded-lg border text-sm transition-colors ${
                        selected
                          ? 'border-[#07c160] bg-green-50 text-[#07c160] font-medium'
                          : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                      }`}
                    >
                      {day.label}
                    </button>
                  )
                })}
              </div>
              <p className="text-[11px] text-gray-400 mt-1">已选：{formatDays(form.days)}</p>
            </div>

            <div>
              <label className="text-sm text-gray-600 block mb-1.5">时段</label>
              <div className="flex items-center space-x-2">
                <input
                  type="time"
                  value={minuteToTime(form.startMinute)}
                  onChange={(e) => setForm((current) => ({ ...current, startMinute: timeToMinute(e.target.value) }))}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
                />
                <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <input
                  type="time"
                  value={minuteToTime(form.endMinute)}
                  onChange={(e) => setForm((current) => ({ ...current, endMinute: timeToMinute(e.target.value) }))}
                  className={`flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160] ${
                    form.endMinute >= 1440 ? 'bg-gray-50 text-gray-500' : ''
                  }`}
                />
              </div>

              {form.startMinute === form.endMinute ? (
                <p className="mt-1.5 text-xs text-red-600">
                  开始时间与结束时间不能相同；要表达「整天」请点下面的「全天 00:00 → 24:00」预设。
                </p>
              ) : form.endMinute >= 1440 ? (
                <p className="mt-1.5 text-xs text-gray-500">
                  结束时间为 24:00（当天午夜）：{formatMinute(form.startMinute)} → 24:00，覆盖到当天 24 点。
                </p>
              ) : formOvernight ? (
                <p className="mt-1.5 text-xs text-amber-600">
                  跨天：从 {formatMinute(form.startMinute)} 到次日 {formatMinute(form.endMinute)}
                  （结束时间早于开始时间即表示跨天）
                </p>
              ) : (
                <p className="mt-1.5 text-xs text-gray-500">
                  同一天内：{formatMinute(form.startMinute)} → {formatMinute(form.endMinute)}
                </p>
              )}

              <div className="mt-2">
                <p className="text-[11px] text-gray-400 mb-1.5">常用时段</p>
                <div className="flex flex-wrap gap-1.5">
                  {TIME_PRESETS.map((preset) => {
                    const active =
                      form.startMinute === preset.startMinute && form.endMinute === preset.endMinute
                    return (
                      <Button
                        key={preset.name}
                        variant="outline"
                        size="sm"
                        onClick={() => applyPreset(preset)}
                        className={active ? 'border-[#07c160] text-[#07c160]' : ''}
                      >
                        {preset.name}
                      </Button>
                    )
                  })}
                </div>
              </div>
            </div>

            {formError && (
              <div className="flex items-start space-x-2 bg-red-50 border border-red-200 rounded-lg p-2.5">
                <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-red-700">{formError}</p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRuleDialogOpen(false)} disabled={submitting}>
              取消
            </Button>
            <Button
              className="bg-[#07c160] hover:bg-[#06a050]"
              onClick={() => void handleSubmitRule()}
              disabled={submitting}
            >
              {submitting ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- 删除规则 ---------------- */}
      <Dialog open={Boolean(removeTarget)} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除规则</DialogTitle>
          </DialogHeader>
          <p className="text-gray-600">
            确定要删除「{removeTarget?.name || '未命名规则'}」吗？
            {removeTarget
              ? `（${formatDays(removeTarget.daysOfWeek)} ${formatRange(removeTarget.startMinute, removeTarget.endMinute)}）删除后无法恢复。`
              : ''}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              取消
            </Button>
            <Button className="bg-red-500 hover:bg-red-600 text-white" onClick={() => void handleRemoveRule()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
