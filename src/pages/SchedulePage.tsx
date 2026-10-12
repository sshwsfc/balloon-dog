import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HeaderRefreshButton } from '@/components/HeaderRefreshButton'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, CalendarClock, ChevronRight, Info, Lock, LockOpen, Moon, Pencil, Plus, ShieldCheck, Timer, Trash2 } from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import { FeatureTip } from '@/components/FeatureTip'
import type {
  LockPolicy,
  LockStrength,
  ScheduleAction,
  ScheduleListResponse,
  ScheduleRule,
  ScheduleRuleInput,
} from '@/types'
import { useTranslation } from 'react-i18next'
import { tt } from '@/i18n'

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

/** 索引即星期几（0=周日），用于拼「周日、周三」。这里存**完整**词条而不是单个
 *  字再在前面拼「周」——英文里星期的名字是独立单词，拼不出「周」前缀。 */
const DAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const ACTION_META: Record<ScheduleAction, { label: string; desc: string; className: string; icon: typeof Lock }> = {
  lock: {
    label: '锁定',
    desc: '该时段不能用',
    className: 'bg-red-100 text-red-700',
    icon: Lock,
  },
  unlock: {
    label: '允许使用',
    desc: '该时段可以用，优先于锁定',
    className: 'bg-green-100 text-green-700',
    icon: LockOpen,
  },
}

const STRENGTH_META: Record<LockStrength, { title: string; desc: string }> = {
  kiosk: {
    title: '锁定页（kiosk）',
    desc: '锁定后停在锁定页，可随时远程解锁，推荐日常使用。',
  },
  password: {
    title: '系统密码（password）',
    desc: '锁定时把系统锁屏密码改成随机值，孩子无法绕过。',
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
    ? tt('{{v0}} → 次日 {{v1}}', { v0: formatMinute(startMinute), v1: formatMinute(endMinute) })
    : `${formatMinute(startMinute)} → ${formatMinute(endMinute)}`
}

/**
 * 星期文案。
 * 全选显示「每天」；「周一至周五」单独识别（最常见的作息）；
 * 其余按「周一、周三」列出，周日放在最后更符合中文习惯。
 */
function formatDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b)
  if (sorted.length === 0) return tt('未选择')
  if (sorted.length === 7) return tt('每天')
  if (sorted.length === 5 && [1, 2, 3, 4, 5].every((day) => sorted.includes(day))) return tt('周一至周五')
  return [1, 2, 3, 4, 5, 6, 0]
    .filter((day) => sorted.includes(day))
    .map((day) => tt(DAY_LABEL[day]))
    .join(tt('、'))
}

/** 把 ISO 时间转成「今天 22:00」「明天 07:00」这类中文短句（按本机时区） */
function formatDateTime(iso: string): string {
  const target = new Date(iso)
  if (Number.isNaN(target.getTime())) return tt('未知时间')
  const now = new Date()
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(target) - startOfDay(now)) / 86_400_000)
  const clock = `${padTwo(target.getHours())}:${padTwo(target.getMinutes())}`
  const prefix =
    dayDiff === 0
      ? tt('今天')
      : dayDiff === 1
        ? tt('明天')
        : dayDiff === 2
          ? tt('后天')
          : tt('{{v0}}月{{v1}}日', { v0: target.getMonth() + 1, v1: target.getDate() })
  return `${prefix} ${clock}`
}

function validateForm(form: RuleFormState): string | null {
  if (!form.name.trim()) return tt('请填写规则名称')
  if (form.name.trim().length > 30) return tt('名称最多 30 个字')
  if (form.days.length === 0) return tt('请至少选择一天')
  if (form.startMinute === form.endMinute) {
    return tt('开始和结束时间不能相同；整天请用「全天 00:00 → 24:00」预设')
  }
  return null
}

export function SchedulePage() {
  const { t } = useTranslation()
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
      const message = toUserMessage(err, t('加载锁屏设置失败'))
      setError(message)
      // 首次加载失败才弹 toast；mutation 之后的静默刷新失败不打扰用户
      if (!options?.silent) toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [t])

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
      toast.error(toUserMessage(err, t('保存失败，请稍后重试')))
      console.error('保存锁屏策略失败：', err)
    } finally {
      setBusy(null)
    }
  }

  const handleSaveCountdown = async () => {
    const seconds = Number.parseInt(countdownDraft, 10)
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) {
      toast.error(t('倒计时需在 0 ~ 600 秒之间'))
      setCountdownDraft(String(policy?.countdownSeconds ?? 30))
      return
    }
    if (seconds === policy?.countdownSeconds) return
    await savePolicy(
      { countdownSeconds: seconds },
      seconds === 0 ? t('已关闭锁屏预告') : t('锁屏预告已设为 {{v0}} 秒', { v0: seconds }),
      'countdown',
    )
  }

  const handleSaveStrength = async (strength: LockStrength) => {
    if (strength === policy?.strength) return
    await savePolicy({ strength }, t('锁屏强度已切换为「{{v0}}」', { v0: t(STRENGTH_META[strength].title) }), 'strength')
  }

  const handleToggleSchedule = async () => {
    await savePolicy(
      { scheduleEnabled: !scheduleEnabled },
      scheduleEnabled ? t('定时时间表已暂停') : t('定时时间表已启用'),
      'scheduleEnabled',
    )
  }

  const handleToggleRule = async (rule: ScheduleRule) => {
    const label = rule.name || t('未命名规则')
    setBusy(rule.id)
    try {
      await api.updateSchedule(rule.id, { enabled: !rule.enabled })
      toast.success(rule.enabled ? t('已暂停「{{v0}}」', { v0: label }) : t('已启用「{{v0}}」', { v0: label }))
      await loadData({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, t('操作失败，请稍后重试')))
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
        toast.success(t('规则已更新'))
      } else {
        await api.createSchedule(payload)
        toast.success(t('规则已添加'))
      }
      setRuleDialogOpen(false)
      setEditingRule(null)
      setForm(emptyForm())
      await loadData({ silent: true })
    } catch (err) {
      const message = toUserMessage(err, t('保存规则失败，请稍后重试'))
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
      toast.success(t('规则已删除'))
      setRemoveTarget(null)
      await loadData({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, t('删除失败，请稍后重试')))
      console.error('删除时间表规则失败：', err)
    }
  }

  const formOvernight = isOvernight(form.startMinute, form.endMinute)

  if (loading) {
    return (
      <div className="page-shell page-shell--center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]" />
          <p className="mt-2 text-gray-500 text-sm">{t('加载中...')}</p>
        </div>
      </div>
    )
  }

  if (error && !policy) {
    return (
      <div className="page-shell">
        <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-xl font-medium text-gray-900 flex-1">{t('锁屏设置')}</h1>
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
            {t('重新加载')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="page-shell">
      <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1">{t('锁屏设置')}</h1>
        <HeaderRefreshButton onRefresh={() => loadData({ silent: true })} />
      </div>

      {/* 刷新失败但还留着上一次成功的数据：给条提示，不把整页换成错误页 */}
      {error && (
        <div className="px-3 pt-3">
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-start space-x-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-700 flex-1">
              {t('最新配置读取失败：')}{error}{t('（下面是上次加载的内容）')}
            </p>
            <button
              type="button"
              className="text-xs text-[#07c160] flex-shrink-0"
              onClick={() => void loadData({ silent: true })}
            >
              {t('重试')}
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
                  {!scheduleEnabled ? t('定时时间表已暂停') : preview?.lockedNow ? t('现在处于锁定时段') : t('现在允许使用')}
                </p>
                <p className="text-xs opacity-90 mt-0.5">
                  {!scheduleEnabled
                    ? t('总开关已关闭，规则不生效')
                    : preview?.matchedRuleName
                      ? t('命中规则「{{v0}}」', { v0: preview.matchedRuleName })
                      : t('当前没有命中任何规则')}
                </p>
              </div>
            </div>
          </div>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-start space-x-2">
              <CalendarClock className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-gray-700">
                {!scheduleEnabled ? (
                  <span className="text-gray-500">{t('总开关关闭，打开后按规则自动锁定 / 放行')}</span>
                ) : !preview?.nextChangeAt || preview.nextChangeLocked === null ? (
                  <span className="text-gray-500">{t('接下来 7 天内没有状态变化')}</span>
                ) : (
                  <>
                    {t('下次状态变更：')}
                    <span className={`font-medium ${preview.nextChangeLocked ? 'text-red-600' : 'text-green-600'}`}>
                      {formatDateTime(preview.nextChangeAt)}
                      {preview.nextChangeLocked ? t(' 锁定') : t(' 解除锁定')}
                    </span>
                  </>
                )}
              </div>
            </div>

            {preview?.evaluatedAt && (
              <p className="text-[11px] text-gray-400 leading-relaxed border-t border-gray-100 pt-2">
                {t('以上是')}<b>{t('服务器时间')}</b>（{formatDateTime(preview.evaluatedAt)}{t('）的推算结果，仅供参考；实际以孩子设备本地时钟为准。')}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 锁屏强度 ---------------- */}
      <div className="px-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">{t('锁屏强度')}</span>
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
                      <span className="font-medium text-gray-900 text-sm">{t(STRENGTH_META[strength].title)}</span>
                    </div>
                    {selected && <Badge className="bg-[#07c160] text-white text-[10px]">{t('当前')}</Badge>}
                  </div>
                  <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">{t(STRENGTH_META[strength].desc)}</p>
                </button>
              )
            })}

            {policy?.strength === 'password' && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <div className="flex items-start space-x-2">
                  <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                  <div className="text-xs text-red-700 leading-relaxed space-y-1">
                    <p className="font-medium text-sm">{t('高风险：先设置应急密码')}</p>
                    <p>{t('· 触发锁定时设备会立刻把')}<b>{t('系统锁屏密码改成随机值')}</b>
                      {t('，谁也进不了系统。')}
                    </p>
                    <p>{t('· 只能靠家长端远程解锁；')}<b>{t('网络不可用时只能用事先设置的应急密码')}</b>。
                    </p>
                    <p>{t('· 先到孩子设备「锁屏设置 → 应急密码」设好并牢记，否则设备可能彻底锁死，只能恢复出厂设置。')}</p>
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
          <span className="text-sm font-medium text-gray-500">{t('锁屏倒计时预告')}</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center space-x-2">
              <Timer className="w-4 h-4 text-gray-500 flex-shrink-0" />
              <span className="text-sm text-gray-700 flex-1">{t('锁屏前预告秒数')}</span>
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
              <span className="text-sm text-gray-500">{t('秒')}</span>
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
                      seconds === 0 ? t('已关闭锁屏预告') : t('锁屏预告已设为 {{v0}} 秒', { v0: seconds }),
                      'countdown',
                    )
                  }}
                  className={policy?.countdownSeconds === seconds ? 'border-[#07c160] text-[#07c160]' : ''}
                >
                  {seconds === 0 ? t('不预告') : t('{{v0}} 秒', { v0: seconds })}
                </Button>
              ))}
              <Button variant="outline" size="sm" disabled={busy === 'countdown'} onClick={() => void handleSaveCountdown()}>
                {t('保存')}
              </Button>
            </div>

            <p className="text-xs text-gray-400 leading-relaxed">{t('锁屏前孩子设备会弹倒计时悬浮窗，让孩子有时间收尾；0 表示不预告直接锁屏。可填 0 ~ 600 秒，当前为')}{policy?.countdownSeconds ?? 0} {t('秒。')}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 定时时间表 ---------------- */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">{t('定时时间表')}</span>
          <button type="button" className="text-xs text-[#07c160] flex items-center" onClick={openCreateDialog}>
            <Plus className="w-3.5 h-3.5 mr-0.5" />
            {t('添加规则')}
          </button>
        </div>

        <Card className="overflow-hidden">
          {/* 总开关 */}
          <div className="flex items-center py-3 px-4">
            <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0">
              <CalendarClock className="w-5 h-5 text-purple-500" />
            </div>
            <div className="flex-1 min-w-0 ml-3">
              <div className="font-medium text-gray-900 text-sm">{t('启用定时时间表')}</div>
              <div className="text-xs text-gray-400 mt-0.5">
                {scheduleEnabled ? t('按下面的规则自动锁定 / 放行') : t('关闭后所有规则都不生效')}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={scheduleEnabled}
              aria-label={t('定时时间表总开关')}
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
              <p className="text-sm text-gray-500">{t('还没有规则。点「添加第一条规则」，常用的是「睡觉 22:00 → 次日 07:00 锁定」。')}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={openCreateDialog}>
                <Plus className="w-4 h-4 mr-1" />
                {t('添加第一条规则')}
              </Button>
            </div>
          ) : (
            rules.map((rule, index) => {
              const actionMeta = ACTION_META[rule.action] ?? ACTION_META.lock
              const ActionIcon = actionMeta.icon
              const label = rule.name || t('未命名规则')
              return (
                <div key={rule.id}>
                  <div className="flex items-center py-3 px-4">
                    <div className="w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center flex-shrink-0">
                      <ActionIcon className={`w-5 h-5 ${rule.action === 'lock' ? 'text-red-500' : 'text-green-600'}`} />
                    </div>
                    <div className="flex-1 min-w-0 ml-3">
                      <div className="flex items-center space-x-2 flex-wrap">
                        <span className="font-medium text-gray-900 text-sm truncate">{label}</span>
                        <Badge className={`${actionMeta.className} text-[10px]`}>{t(actionMeta.label)}</Badge>
                        {!rule.enabled && <Badge className="bg-gray-100 text-gray-500 text-[10px]">{t('已暂停')}</Badge>}
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {formatDays(rule.daysOfWeek)} · {formatRange(rule.startMinute, rule.endMinute)}
                        {isOvernight(rule.startMinute, rule.endMinute) ? t('（跨天）') : ''}
                      </p>
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={rule.enabled}
                      aria-label={t('{{v0}}开关', { v0: label })}
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
                      aria-label={t('编辑 {{v0}}', { v0: label })}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemoveTarget(rule)}
                      className="text-gray-300 hover:text-red-500 p-1.5"
                      aria-label={t('删除 {{v0}}', { v0: label })}
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
                <p className="font-medium text-gray-700">{t('规则怎么生效')}</p>
                <p>
                  · <b>{t('允许使用')}</b>{t('优先于')}<b>{t('锁定')}</b>{t('：命中放行规则就允许使用；否则命中锁定规则才锁定；都没命中就不锁。')}</p>
                <p>{t('· 「整晚锁定 + 中午放行」可以直接叠加，放行规则自动优先。')}</p>
                <p>{t('· 开始时间晚于结束时间表示')}<b>{t('跨天')}</b>{t('，例如 22:00 → 07:00 即当天 22:00 到次日 07:00。整天请填 00:00 → 24:00。')}</p>
                <p>{t('· 星期和时段按设备本地时间判断，周日对应 0，周一对应 1。')}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ---------------- 新增 / 编辑规则 ---------------- */}
      <Dialog open={ruleDialogOpen} onOpenChange={setRuleDialogOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingRule ? t('编辑规则') : t('添加规则')}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="text-sm text-gray-600 block mb-1.5">{t('名称')}</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))}
                placeholder={t('例如 晚上睡觉')}
                maxLength={30}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
              />
            </div>

            <div>
              <label className="text-sm text-gray-600 block mb-1.5">{t('动作')}</label>
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
                    <span className="text-sm font-medium text-gray-900">{t(ACTION_META[action].label)}</span>
                    <span className="block text-[11px] text-gray-500 mt-0.5">{t(ACTION_META[action].desc)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm text-gray-600 block mb-1.5">{t('星期（至少选一天）')}</label>
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
                      {t(day.label)}
                    </button>
                  )
                })}
              </div>
              <p className="text-[11px] text-gray-400 mt-1">{t('已选：')}{formatDays(form.days)}</p>
            </div>

            <div>
              <label className="text-sm text-gray-600 block mb-1.5">{t('时段')}</label>
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
                <p className="mt-1.5 text-xs text-red-600">{t('开始和结束时间不能相同；整天请点下面「全天 00:00 → 24:00」预设。')}</p>
              ) : form.endMinute >= 1440 ? (
                <p className="mt-1.5 text-xs text-gray-500">{t('结束时间为 24:00：')}{formatMinute(form.startMinute)}{t('→ 24:00，覆盖到当天 24 点。')}</p>
              ) : formOvernight ? (
                <p className="mt-1.5 text-xs text-amber-600">
                  {t('跨天：从')} {formatMinute(form.startMinute)} {t('到次日')} {formatMinute(form.endMinute)}
                  {t('（结束早于开始即为跨天）')}
                </p>
              ) : (
                <p className="mt-1.5 text-xs text-gray-500">
                  {t('同一天内：')}{formatMinute(form.startMinute)} → {formatMinute(form.endMinute)}
                </p>
              )}

              <div className="mt-2">
                <p className="text-[11px] text-gray-400 mb-1.5">{t('常用时段')}</p>
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
                        {t(preset.name)}
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
              {t('取消')}
            </Button>
            <Button
              className="bg-[#07c160] hover:bg-[#06a050]"
              onClick={() => void handleSubmitRule()}
              disabled={submitting}
            >
              {submitting ? t('保存中…') : t('保存')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- 删除规则 ---------------- */}
      <Dialog open={Boolean(removeTarget)} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('删除规则')}</DialogTitle>
          </DialogHeader>
          <p className="text-gray-600">
            {t('确定要删除「')}{removeTarget?.name || t('未命名规则')}{t('」吗？')}
            {removeTarget
              ? t('（{{v0}} {{v1}}）删除后无法恢复。', { v0: formatDays(removeTarget.daysOfWeek), v1: formatRange(removeTarget.startMinute, removeTarget.endMinute) })
              : ''}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              {t('取消')}
            </Button>
            <Button className="bg-red-500 hover:bg-red-600 text-white" onClick={() => void handleRemoveRule()}>
              {t('删除')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <FeatureTip id="schedule" text={t('星期和时段按孩子设备本地时间判断；开始晚于结束即为跨天，如 22:00 → 07:00。')} />

    </div>
  )
}
