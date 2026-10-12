import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Loader2, Plus, SlidersHorizontal, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { MAX_QUICK_ACTIONS, useQuickActions } from '@/hooks/useQuickActions'

/** 一个可以放进快捷操作栏的动作。字段与首页九宫格的 `GridTile` 一致，可以直接互传。 */
export interface QuickAction {
  id: string
  /** 中文原文，渲染时过 `t()` */
  name: string
  icon: typeof Check
  color: string
  bg: string
}

export interface QuickActionGroup {
  title: string
  actions: QuickAction[]
}

interface QuickActionBarProps {
  /**
   * 可选项全集，按九宫格的分组排列。
   * **必须是模块级常量**（引用稳定）：里面的分组标题会被 `t()` 当词条查，
   * 而且下面的 `knownIds` 靠它做 memo。
   */
  groups: QuickActionGroup[]
  /** 第一次打开时放哪几个 */
  defaultIds: string[]
  /**
   * 少数动作的文案要看设备状态变。比如「临时可用」在临时解锁生效期间
   * 应显示「取消临时可用」—— 目录是模块级常量，写不了这种动态值，所以从外面传进来。
   */
  labelOverrides?: Record<string, string>
  /** 正在执行的那个动作（点了会转圈） */
  busyId?: string | null
  onRun: (action: QuickAction) => void
}

/**
 * 首页「立即锁定」下方的快捷操作栏。
 *
 * 为什么做成可编辑：家长每天真正反复点的就那么两三个（锁屏、临时可用、
 * 答题解锁……），但「哪两三个」因人而异 —— 与其把它写死成固定两个按钮，
 * 不如让家长自己排。内容与顺序只存本机 localStorage，不上传服务端：
 * 这是「我这个家长的操作习惯」，不是孩子账号的配置。
 */
export function QuickActionBar({
  groups,
  defaultIds,
  labelOverrides,
  busyId,
  onRun,
}: QuickActionBarProps) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const labelOf = (action: QuickAction) => t(labelOverrides?.[action.id] ?? action.name)

  const catalog = useMemo(() => groups.flatMap((group) => group.actions), [groups])
  const knownIds = useMemo(() => catalog.map((action) => action.id), [catalog])
  const byId = useMemo(
    () => new Map(catalog.map((action) => [action.id, action])),
    [catalog],
  )

  const { ids, isDefault, isFull, add, remove, move, reset } = useQuickActions(
    knownIds,
    defaultIds,
  )
  // 目录里没有的 id 已经在 hook 里被滤掉了，这里再兜一层，避免渲染出空白按钮
  const chosen = ids.map((id) => byId.get(id)).filter((action): action is QuickAction => Boolean(action))

  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-sm font-medium text-gray-500">{t('快捷操作')}</span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex items-center gap-0.5 text-xs text-[#07c160]"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t('编辑')}
        </button>
      </div>

      {chosen.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 py-4 text-center">
          <p className="text-xs text-gray-400">{t('还没有快捷操作')}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 h-7 gap-1 text-xs"
            onClick={() => setEditing(true)}
          >
            <Plus />
            {t('添加')}
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {chosen.map((action) => {
            const Icon = action.icon
            const busy = busyId === action.id
            return (
              <button
                key={action.id}
                type="button"
                disabled={busy}
                onClick={() => onRun(action)}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-gray-100 bg-white py-2.5 shadow-sm transition-transform active:scale-[0.97] disabled:opacity-70"
              >
                <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${action.bg}`}>
                  {busy ? (
                    <Loader2 className={`h-5 w-5 animate-spin ${action.color}`} />
                  ) : (
                    <Icon className={`h-5 w-5 ${action.color}`} />
                  )}
                </div>
                <span className="text-[11px] leading-none text-gray-700">{labelOf(action)}</span>
              </button>
            )
          })}
        </div>
      )}

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('编辑快捷操作')}</DialogTitle>
          </DialogHeader>

          <p className="text-xs text-gray-400">{t('快捷操作只保存在这台设备上')}</p>

          <div className="space-y-1">
            <p className="text-xs font-medium text-gray-500">
              {t('已添加')}（{chosen.length}/{MAX_QUICK_ACTIONS}）
            </p>
            {chosen.length === 0 ? (
              <p className="py-2 text-xs text-gray-400">{t('还没有快捷操作，从下面挑几个')}</p>
            ) : (
              chosen.map((action, index) => {
                const Icon = action.icon
                return (
                  <div
                    key={action.id}
                    className="flex items-center gap-2 rounded-lg border border-gray-100 px-2 py-1.5"
                  >
                    <div className={`flex h-7 w-7 items-center justify-center rounded-md ${action.bg}`}>
                      <Icon className={`h-4 w-4 ${action.color}`} />
                    </div>
                    <span className="flex-1 truncate text-sm text-gray-800">{labelOf(action)}</span>
                    <button
                      type="button"
                      aria-label={t('上移')}
                      disabled={index === 0}
                      onClick={() => move(action.id, -1)}
                      className="p-1 text-gray-400 disabled:opacity-30"
                    >
                      <ChevronUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('下移')}
                      disabled={index === chosen.length - 1}
                      onClick={() => move(action.id, 1)}
                      className="p-1 text-gray-400 disabled:opacity-30"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('移除')}
                      onClick={() => remove(action.id)}
                      className="p-1 text-gray-400"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )
              })
            )}
          </div>

          <div className="space-y-2 border-t border-gray-100 pt-3">
            <p className="text-xs font-medium text-gray-500">
              {t('可添加')}
              {isFull ? ` · ${t('最多放 {{v0}} 个', { v0: MAX_QUICK_ACTIONS })}` : ''}
            </p>
            {groups.map((group) => (
              <div key={group.title}>
                <p className="mb-1 text-[11px] text-gray-400">{t(group.title)}</p>
                <div className="flex flex-wrap gap-1.5">
                  {group.actions.map((action) => {
                    const already = ids.includes(action.id)
                    return (
                      <button
                        key={action.id}
                        type="button"
                        disabled={already || isFull}
                        onClick={() => add(action.id)}
                        className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs ${
                          already
                            ? 'border-[#07c160] bg-green-50 text-[#07c160]'
                            : 'border-gray-200 text-gray-600 disabled:opacity-40'
                        }`}
                      >
                        {already ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                        {t(action.name)}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          <DialogFooter>
            {!isDefault && (
              <Button variant="outline" onClick={reset}>
                {t('恢复默认')}
              </Button>
            )}
            <Button className="bg-[#07c160] hover:bg-[#06a050]" onClick={() => setEditing(false)}>
              {t('完成')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
