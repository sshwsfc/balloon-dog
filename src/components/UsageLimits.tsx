import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertTriangle,
  BellRing,
  Film,
  Gamepad2,
  Pencil,
  Plus,
  Timer,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ToggleSwitch } from '@/components/ToggleSwitch'
import { api, toUserMessage } from '@/services/api'
import type { Features, UsageBudget, UsageBudgetKind, UsageSummary } from '@/types'

/**
 * 「用量上限」的三条限制：每日使用时长 / 游戏局数 / 动画集数。
 *
 * 它们本来就是同一种东西 —— **达到条件就自动下发锁屏指令**，所以放在同一张卡里、
 * 用同一套交互（设置 / 改 / 删 / 达上限徽章）。
 *
 * 区别在数据来源，因此时长单独走一条路：
 * - 时长：`Features.timePlan`（单一全局值，`PUT /features/time-plan`）
 * - 局数 / 集数：`UsageBudget` 列表（可按应用细分，`PUT /usage-budgets`），
 *   计数由孩子端的截屏 + AI 分析产出，所以没开「屏幕洞察」时它们没有意义。
 *
 * 组件自己拉取局数 / 集数的数据（首页不关心），但弹窗的开合由首页持有 ——
 * 九宫格里的「屏幕时间」入口也要能直接把时长那条打开。
 */
export type UsageLimitKind = 'time' | UsageBudgetKind

export interface UsageLimitEdit {
  kind: UsageLimitKind
  /** 已存在的「局数 / 集数」上限；时长没有对应的单条记录 */
  budget?: UsageBudget
}

interface UsageLimitsProps {
  features: Features
  editing: UsageLimitEdit | null
  onEditingChange: (next: UsageLimitEdit | null) => void
  /** 上限变化后让首页重新拉 features（它自己也要更新「今日使用时长」那条） */
  onChanged: () => void | Promise<void>
  /** 就地开启「屏幕洞察」（局数 / 集数计数的前提） */
  onEnableInsights: () => void | Promise<void>
}

const COUNT_META: Record<
  UsageBudgetKind,
  { label: string; unit: string; desc: string; icon: typeof Gamepad2 }
> = {
  game_round: { label: '游戏局数', unit: '局', desc: '今天最多能打完几局游戏', icon: Gamepad2 },
  video_episode: { label: '动画集数', unit: '集', desc: '今天最多能看完几集动画', icon: Film },
}

const COUNT_KINDS = Object.keys(COUNT_META) as UsageBudgetKind[]

const TIME_LABEL = '每日使用时长'
const TIME_UNIT = '分钟'
const TIME_DESC = '到点自动锁屏，按孩子端上报的实际使用时长计算'

const TIME_PRESETS = [60, 120, 180, 240, 300, 360]
const COUNT_PRESETS = [1, 2, 3, 5, 10]
/** 首页的九宫格 / 概览卡里也用它，保持一致 */
export const USAGE_LIMIT_MAX = 200

function kindLabel(kind: UsageLimitKind, t: (key: string) => string): string {
  return kind === 'time' ? t(TIME_LABEL) : t(COUNT_META[kind].label)
}

export function UsageLimits({
  features,
  editing,
  onEditingChange,
  onChanged,
  onEnableInsights,
}: UsageLimitsProps) {
  const { t } = useTranslation()
  const [budgets, setBudgets] = useState<UsageBudget[]>([])
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<UsageBudget | null>(null)
  const [removing, setRemoving] = useState(false)

  /** 局数 / 集数的计数来自截屏 + AI 分析，没开「屏幕洞察」就没有可限的对象 */
  const insightsOn = features.screenMonitor.enabled

  const load = useCallback(async () => {
    try {
      const [summary, list] = await Promise.all([api.getUsageSummary(), api.getUsageBudgets()])
      setUsage(summary)
      setBudgets(list.items ?? [])
    } catch (error: unknown) {
      // 这张卡是首页的附加信息，读不到就少显示几行，不打断整页
      console.error('读取用量上限失败：', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const summaryOf = (budget: UsageBudget) =>
    usage?.budgets.find((entry) => entry.id === budget.id)

  const handleToggleBudget = async (budget: UsageBudget) => {
    setBusyKey(`budget-${budget.id}`)
    try {
      await api.upsertUsageBudget({
        kind: budget.kind,
        appName: budget.appName,
        dailyLimit: budget.dailyLimit,
        enabled: !budget.enabled,
      })
      toast.success(budget.enabled ? t('上限已停用') : t('上限已启用'))
      await load()
      await onChanged()
    } catch (error: unknown) {
      toast.error(toUserMessage(error))
    } finally {
      setBusyKey(null)
    }
  }

  const handleRemoveBudget = async () => {
    if (!removeTarget) return
    setRemoving(true)
    try {
      await api.deleteUsageBudget(removeTarget.id)
      toast.success(t('上限已删除'))
      setRemoveTarget(null)
      await load()
      await onChanged()
    } catch (error: unknown) {
      toast.error(toUserMessage(error))
    } finally {
      setRemoving(false)
    }
  }

  const timeLimit = features.timePlan.dailyLimit
  const timeUsed = features.timePlan.usedToday
  const timeExceeded = timeLimit > 0 && timeUsed >= timeLimit

  return (
    <>
      <Card className="overflow-hidden">
        {/* ---- 每日使用时长 ---- */}
        <div className="flex items-center px-4 py-3">
          <div className="w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center flex-shrink-0">
            <Timer className="w-5 h-5 text-gray-500" />
          </div>
          <div className="flex-1 min-w-0 ml-3">
            <div className="flex items-center flex-wrap gap-1.5">
              <span className="font-medium text-gray-900 text-sm">{t(TIME_LABEL)}</span>
              {timeExceeded && (
                <Badge className="bg-red-100 text-red-700 text-[10px]">{t('已达上限')}</Badge>
              )}
            </div>
            <div className="text-xs text-gray-400 mt-0.5">{t(TIME_DESC)}</div>
            <p className="text-[11px] text-gray-400 mt-0.5">
              {timeLimit > 0
                ? t('今日已用 {{v0}} 分钟 / 上限 {{v1}} 分钟', { v0: timeUsed, v1: timeLimit })
                : t('还没有设置上限，今天可无限使用')}
            </p>
            {timeExceeded && (
              <p className="text-[11px] text-red-600 mt-0.5">
                {t('已达上限，将自动下发锁屏指令')}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onEditingChange({ kind: 'time' })}
            className="text-gray-300 hover:text-[#07c160] p-1.5 ml-1"
            aria-label={t('编辑{{v0}}上限', { v0: t(TIME_LABEL) })}
          >
            <Pencil className="w-4 h-4" />
          </button>
        </div>

        <div className="mx-4 border-t border-gray-100" />

        {/* ---- 游戏局数 / 动画集数（前提：开了「屏幕洞察」） ---- */}
        {!insightsOn ? (
          <div className="px-4 py-3">
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-amber-800 leading-relaxed">
                  {t('开启「屏幕洞察」后，才能按局数 / 集数限制 —— 这两个数字要靠截屏分析才能数出来。')}
                </p>
                <Button
                  size="sm"
                  className="mt-2 h-7 gap-1 bg-[#07c160] px-3 text-xs hover:bg-[#06a050]"
                  onClick={() => void onEnableInsights()}
                >
                  <BellRing />
                  {t('开启屏幕洞察')}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          COUNT_KINDS.map((kind, kindIndex) => {
            const meta = COUNT_META[kind]
            const KindIcon = meta.icon
            const rows = budgets.filter((budget) => budget.kind === kind)
            const usedToday = usage?.used?.[kind] ?? 0
            return (
              <div key={kind}>
                <div className="flex items-center px-4 pt-3 pb-2">
                  <div className="w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center flex-shrink-0">
                    <KindIcon className="w-5 h-5 text-gray-500" />
                  </div>
                  <div className="flex-1 min-w-0 ml-3">
                    <div className="font-medium text-gray-900 text-sm">{t(meta.label)}</div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {t(meta.desc)}{t('（今日已数出 {{v0}} {{v1}}）', { v0: usedToday, v1: t(meta.unit) })}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onEditingChange({ kind })}
                    className="text-xs text-[#07c160] flex items-center flex-shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5 mr-0.5" />
                    {t('设置')}
                  </button>
                </div>

                {loading ? (
                  <p className="px-4 pb-3 text-xs text-gray-400">{t('加载中...')}</p>
                ) : rows.length === 0 ? (
                  <p className="px-4 pb-3 text-xs text-gray-400">
                    {t('还没有设置')}{t(meta.label)}{t('上限，今天可无限')}
                    {kind === 'game_round' ? t('玩') : t('看')}。
                  </p>
                ) : (
                  rows.map((budget) => {
                    const summary = summaryOf(budget)
                    const used = summary?.usedToday ?? budget.usedToday
                    const exceeded = summary?.exceeded ?? used >= budget.dailyLimit
                    // 同一类型可能同时存在「全部应用」和「指定应用」两条，无障碍标签要能区分
                    const scope = budget.appName || t('全部应用')
                    return (
                      <div key={budget.id} className="flex items-center px-4 py-2.5">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center flex-wrap gap-1.5">
                            <span className="text-sm text-gray-900">{scope}</span>
                            {!budget.enabled && (
                              <Badge className="bg-gray-100 text-gray-500 text-[10px]">{t('已停用')}</Badge>
                            )}
                            {budget.enabled && exceeded && (
                              <Badge className="bg-red-100 text-red-700 text-[10px]">{t('已达上限')}</Badge>
                            )}
                          </div>
                          <p className="text-[11px] text-gray-400 mt-0.5">
                            {t('今日已用')} {used} {t(meta.unit)}{t('/ 上限')}{budget.dailyLimit} {t(meta.unit)}
                            {budget.enabled && summary ? t('（剩余 {{v0}}）', { v0: summary.remaining }) : ''}
                          </p>
                          {budget.enabled && exceeded && (
                            <p className="text-[11px] text-red-600 mt-0.5">
                              {t('已达上限，将自动下发锁屏指令')}
                            </p>
                          )}
                        </div>

                        <ToggleSwitch
                          checked={budget.enabled}
                          busy={busyKey === `budget-${budget.id}`}
                          label={t('{{v0}}上限开关（{{v1}}）', { v0: t(meta.label), v1: scope })}
                          onChange={() => void handleToggleBudget(budget)}
                        />
                        <button
                          type="button"
                          onClick={() => onEditingChange({ kind, budget })}
                          className="text-gray-300 hover:text-[#07c160] p-1.5 ml-1"
                          aria-label={t('编辑{{v0}}上限（{{v1}}）', { v0: t(meta.label), v1: scope })}
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setRemoveTarget(budget)}
                          className="text-gray-300 hover:text-red-500 p-1.5"
                          aria-label={t('删除{{v0}}上限（{{v1}}）', { v0: t(meta.label), v1: scope })}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )
                  })
                )}

                {kindIndex < COUNT_KINDS.length - 1 && (
                  <div className="mx-4 border-t border-gray-100" />
                )}
              </div>
            )
          })
        )}
      </Card>

      <p className="mt-2 px-1 text-[11px] text-gray-400 leading-relaxed">
        {t('三条限制都是「达到上限就自动下发锁屏指令」；局数与集数由 AI 分析统计，可能有误差。')}
      </p>

      {/* ---- 编辑 ---- */}
      {editing && (
        <UsageLimitDialog
          // 换一条限制就换一份表单状态，省掉一堆「打开时同步草稿」的 effect
          key={`${editing.kind}:${editing.budget?.id ?? 'new'}`}
          editing={editing}
          timeLimit={timeLimit}
          onClose={() => onEditingChange(null)}
          onSaved={async () => {
            onEditingChange(null)
            await load()
            await onChanged()
          }}
        />
      )}

      {/* ---- 删除 ---- */}
      <Dialog open={Boolean(removeTarget)} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('删除用量上限')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            {t('删除后 {{v0}} 不再受「{{v1}}」限制，已用次数不会被清零。', {
              v0: removeTarget?.appName || t('全部应用'),
              v1: removeTarget ? t(COUNT_META[removeTarget.kind].label) : '',
            })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)} disabled={removing}>
              {t('取消')}
            </Button>
            <Button
              className="bg-red-500 hover:bg-red-600"
              onClick={() => void handleRemoveBudget()}
              disabled={removing}
            >
              {removing ? t('删除中…') : t('删除')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * 一条上限的编辑器。
 *
 * 时长与局数 / 集数共用同一个弹窗框架，但字段不同：时长只有分钟数（且没有「按应用」和
 * 「启用开关」的概念 —— 后端每次写入都会把 timePlan 开关打开），局数 / 集数还有作用范围。
 */
function UsageLimitDialog({
  editing,
  timeLimit,
  onClose,
  onSaved,
}: {
  editing: UsageLimitEdit
  timeLimit: number
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  // 先用一次判断把联合类型收窄，后面才敢拿它去索引 COUNT_META
  const countKind: UsageBudgetKind | null = editing.kind === 'time' ? null : editing.kind
  const isTime = countKind === null
  const meta = countKind ? COUNT_META[countKind] : null

  const [appName, setAppName] = useState(editing.budget?.appName ?? '')
  const [dailyLimit, setDailyLimit] = useState(
    editing.kind === 'time'
      ? timeLimit > 0
        ? String(timeLimit)
        : ''
      : String(editing.budget?.dailyLimit ?? (editing.kind === 'game_round' ? 3 : 2)),
  )
  const [enabled, setEnabled] = useState(editing.budget?.enabled ?? true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const label = kindLabel(editing.kind, t)

  const handleSubmit = async () => {
    const limit = Number.parseInt(dailyLimit, 10)
    if (isTime) {
      if (!Number.isFinite(limit) || limit < 0) {
        setError(t('输入有效的时长'))
        return
      }
    } else if (!Number.isFinite(limit) || limit < 1 || limit > USAGE_LIMIT_MAX) {
      setError(t('每日上限需在 1 ~ 200 之间'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      if (isTime) {
        await api.setTimePlan(limit)
        toast.success(
          limit > 0
            ? t('每日使用时长已设为 {{v0}} 分钟', { v0: limit })
            : t('已取消每日使用时长上限'),
        )
      } else if (countKind) {
        await api.upsertUsageBudget({
          kind: countKind,
          appName: appName.trim(),
          dailyLimit: limit,
          enabled,
        })
        toast.success(t('{{v0}}上限已保存', { v0: label }))
      }
      await onSaved()
    } catch (err: unknown) {
      const message = toUserMessage(err, t('保存失败，请稍后重试'))
      setError(message)
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('设置{{v0}}上限', { v0: label })}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {!isTime && (
            <div>
              <label className="text-sm text-gray-600 block mb-1.5" htmlFor="usage-limit-app">
                {t('应用（留空 = 全部应用）')}
              </label>
              <input
                id="usage-limit-app"
                type="text"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                placeholder={t('例如 王者荣耀，留空 = 不限应用')}
                maxLength={50}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
              />
            </div>
          )}

          <div>
            <label className="text-sm text-gray-600 block mb-1.5" htmlFor="usage-limit-value">
              {isTime ? t('每日上限（分钟）') : t('每日上限')}
            </label>
            <div className="flex items-center space-x-2">
              <input
                id="usage-limit-value"
                type="number"
                min={0}
                max={isTime ? undefined : USAGE_LIMIT_MAX}
                value={dailyLimit}
                onChange={(e) => setDailyLimit(e.target.value)}
                placeholder={isTime ? t('输入分钟数，留空 = 不限制') : undefined}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
              />
              <span className="text-sm text-gray-500">
                {isTime ? t(TIME_UNIT) : `${t(meta!.unit)}${t('/ 天')}`}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(isTime ? TIME_PRESETS : COUNT_PRESETS).map((preset) => (
                <Button
                  key={preset}
                  variant="outline"
                  size="sm"
                  onClick={() => setDailyLimit(String(preset))}
                  className={dailyLimit === String(preset) ? 'border-[#07c160] text-[#07c160]' : ''}
                >
                  {preset} {isTime ? t(TIME_UNIT) : t(meta!.unit)}
                </Button>
              ))}
              {isTime && (
                <Button variant="outline" size="sm" onClick={() => setDailyLimit('0')}>
                  {t('不限制')}
                </Button>
              )}
            </div>
          </div>

          {!isTime && (
            <div className="flex items-center py-1">
              <div className="flex-1 min-w-0">
                <span className="text-sm text-gray-800">{t('启用上限')}</span>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  {t('启用后达到上限将自动下发锁屏指令')}
                </p>
              </div>
              <ToggleSwitch
                checked={enabled}
                label={t('启用上限')}
                onChange={() => setEnabled((current) => !current)}
              />
            </div>
          )}

          <p className="text-xs text-gray-500">
            {t('当前设置：')}
            {isTime
              ? timeLimit > 0
                ? t('{{v0}} 分钟/天', { v0: timeLimit })
                : t('未设置')
              : editing.budget
                ? t('{{v0}} {{v1}}/天', { v0: editing.budget.dailyLimit, v1: t(meta!.unit) })
                : t('未设置')}
          </p>

          {error && (
            <div className="flex items-start space-x-2 bg-red-50 border border-red-200 rounded-lg p-2.5">
              <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-red-700">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t('取消')}
          </Button>
          <Button
            className="bg-[#07c160] hover:bg-[#06a050]"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? t('保存中…') : t('确认')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
