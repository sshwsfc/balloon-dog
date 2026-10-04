import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, CalendarClock, Eraser, Info, Loader2, RefreshCw, Save } from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { ModeSlot } from '@/types'

/**
 * 列的展示顺序：周一 → 周日。
 * 后端与 JS `Date.getDay()` 都用 0=周日，切换顺序只发生在这里，
 * 提交前一定转回后端的 0..6，不能把「第一列」当成 0。
 */
const DAY_COLUMNS = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
] as const

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

const TOTAL_CELLS = 168

function cellKey(dayOfWeek: number, hour: number): string {
  return `${dayOfWeek}-${hour}`
}

export function ModeSchedulePage() {
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** 选中格子集合；key 为 `${dayOfWeek}-${hour}`，只在前端存在，提交时展开成数组 */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [savedKeys, setSavedKeys] = useState<Set<string>>(() => new Set())
  const [saving, setSaving] = useState(false)

  const loadData = useCallback(async (options?: { silent?: boolean }) => {
    try {
      const data = await api.getStudySlots()
      const keys = new Set((data.slots ?? []).map((slot) => cellKey(slot.dayOfWeek, slot.hour)))
      setSelected(new Set(keys))
      setSavedKeys(keys)
      setError(null)
    } catch (err) {
      const message = toUserMessage(err, '加载模式时段失败')
      setError(message)
      if (!options?.silent) toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const dirty = useMemo(() => {
    if (selected.size !== savedKeys.size) return true
    for (const key of selected) {
      if (!savedKeys.has(key)) return true
    }
    return false
  }, [selected, savedKeys])

  /** 某一列（某天）是否已全选，用来决定日切换按钮是「全选这一天」还是「清空这一天」 */
  const dayFullySelected = useCallback(
    (dayOfWeek: number) => HOURS.every((hour) => selected.has(cellKey(dayOfWeek, hour))),
    [selected],
  )

  const toggleCell = (dayOfWeek: number, hour: number) => {
    setSelected((current) => {
      const next = new Set(current)
      const key = cellKey(dayOfWeek, hour)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleDay = (dayOfWeek: number) => {
    setSelected((current) => {
      const next = new Set(current)
      const allSelected = HOURS.every((hour) => next.has(cellKey(dayOfWeek, hour)))
      for (const hour of HOURS) {
        const key = cellKey(dayOfWeek, hour)
        if (allSelected) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }

  const handleSelectAll = () => {
    setSelected(new Set(DAY_COLUMNS.flatMap((day) => HOURS.map((hour) => cellKey(day.value, hour)))))
  }

  const handleClear = () => {
    setSelected(new Set())
  }

  const handleSave = async () => {
    // 整表替换：一次提交要么全成要么全不成，不会留下半套规则
    const slots: ModeSlot[] = [...selected].map((key) => {
      const [dayText, hourText] = key.split('-')
      return { dayOfWeek: Number(dayText), hour: Number(hourText) }
    })
    setSaving(true)
    try {
      const result = await api.replaceStudySlots(slots)
      const keys = new Set((result.slots ?? []).map((slot) => cellKey(slot.dayOfWeek, slot.hour)))
      setSelected(new Set(keys))
      setSavedKeys(keys)
      toast.success(
        keys.size === 0
          ? '已清空时段规划：按约定此时全天都是学习模式'
          : `已保存 ${keys.size} 个学习时段`,
      )
    } catch (err) {
      toast.error(toUserMessage(err, '保存失败，请稍后重试'))
      console.error('保存模式时段失败：', err)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="page-shell page-shell--center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]" />
          <p className="mt-2 text-gray-500 text-sm">加载中...</p>
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
        <h1 className="text-xl font-medium text-gray-900 flex-1">设置模式时段</h1>
        <button
          type="button"
          onClick={() => void loadData({ silent: true })}
          className="text-gray-400 p-1"
          aria-label="刷新"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      {error && (
        <div className="px-3 pt-3">
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-start space-x-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-700 flex-1">{error}</p>
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

      {/* ---------------- 说明与统计 ---------------- */}
      <div className="px-3 py-3">
        <Card className="overflow-hidden">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-gray-400">已选学习时段</div>
                <div className="text-2xl font-semibold text-gray-900 mt-0.5">
                  {selected.size}
                  <span className="text-sm font-normal text-gray-400"> / {TOTAL_CELLS} 格</span>
                </div>
              </div>
              <div className="text-right space-y-1">
                <div className="flex items-center space-x-1.5 justify-end">
                  <span className="w-3 h-3 rounded bg-[#07c160]" />
                  <span className="text-xs text-gray-500">学习模式</span>
                </div>
                <div className="flex items-center space-x-1.5 justify-end">
                  <span className="w-3 h-3 rounded bg-gray-200" />
                  <span className="text-xs text-gray-500">普通模式</span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={handleClear} disabled={selected.size === 0}>
                <Eraser className="w-3.5 h-3.5 mr-1" />
                清空
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSelectAll}
                disabled={selected.size === TOTAL_CELLS}
              >
                全选
              </Button>
              <Button
                size="sm"
                className="bg-[#07c160] hover:bg-[#06a050]"
                onClick={() => void handleSave()}
                disabled={saving || !dirty}
              >
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5 mr-1" />
                )}
                保存当前规划
              </Button>
            </div>

            {dirty ? (
              <p className="text-xs text-amber-600">有未保存的修改，点「保存当前规划」生效。</p>
            ) : (
              <p className="text-xs text-gray-400">当前改动已保存。</p>
            )}

            {selected.size === 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start space-x-2">
                <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                <div className="text-xs text-red-700 leading-relaxed">
                  <p className="font-medium text-sm">不设置则全天为学习模式</p>
                  <p className="mt-0.5">
                    一格都不选时，除白名单应用外孩子一整天都用不了任何应用。
                    如果本意是「不限制」，请改回普通模式，而不是保存空规划。
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 7 × 24 格子 ---------------- */}
      <div className="px-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">星期 × 小时</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-3">
            {/*
              宽屏下把 24 小时拆成「00–11 / 12–23」两栏并排。
              一栏 24 行在桌面上要滚很久，而横向明明有大片空地 ——
              响应式不只是「别溢出」，也包括「有空间就用起来」。
              窄屏仍然是一栏到底，手机上的操作方式和以前完全一致。
            */}
            <div className="grid gap-x-5 gap-y-0 lg:grid-cols-2">
              {[HOURS.slice(0, 12), HOURS.slice(12)].map((half, index) => (
                <div key={index} className={index === 1 ? 'mt-3 lg:mt-0' : ''}>
                  {/* 表头：点一下可以整天全选 / 整天清空 */}
                  <div className="flex items-center gap-1 mb-1">
                    <div className="w-8 flex-shrink-0" />
                    {DAY_COLUMNS.map((day) => {
                      const full = dayFullySelected(day.value)
                      return (
                        <button
                          key={day.value}
                          type="button"
                          aria-pressed={full}
                          onClick={() => toggleDay(day.value)}
                          title={`${day.label}：点一下整天全选 / 清空`}
                          className={`flex-1 min-w-0 py-1.5 rounded text-[11px] font-medium transition-colors ${
                            full
                              ? 'bg-green-50 text-[#07c160]'
                              : 'bg-gray-50 text-gray-500 hover:bg-gray-100'
                          }`}
                        >
                          {day.label.slice(1)}
                        </button>
                      )
                    })}
                  </div>

                  {half.map((hour) => (
                    <div key={hour} className="flex items-center gap-1 mb-1">
                      <div className="w-8 flex-shrink-0 text-[10px] text-gray-400 text-right pr-1">
                        {String(hour).padStart(2, '0')}
                      </div>
                      {DAY_COLUMNS.map((day) => {
                        const key = cellKey(day.value, hour)
                        const active = selected.has(key)
                        return (
                          <button
                            key={key}
                            type="button"
                            aria-pressed={active}
                            aria-label={`${day.label} ${hour} 点，${active ? '学习模式' : '普通模式'}`}
                            onClick={() => toggleCell(day.value, hour)}
                            className={`h-6 min-w-0 flex-1 rounded transition-colors ${
                              active
                                ? 'bg-[#07c160] hover:bg-[#06a050]'
                                : 'bg-gray-200 hover:bg-gray-300'
                            }`}
                          />
                        )
                      })}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 语义说明 ---------------- */}
      <div className="px-3 mt-3">
        <div className="bg-white rounded-lg p-3 border border-gray-100">
          <div className="flex items-start space-x-2">
            <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-gray-500 leading-relaxed space-y-1">
              <p className="font-medium text-gray-700">这些格子怎么生效</p>
              <p>· 绿色格 = 该时段为学习模式，只允许白名单应用；灰色格 = 普通模式。</p>
              <p>· 一次保存就是整份规划：不设置则全天为学习模式（不是「不限制」）。</p>
              <p>
                · 星期沿用「周日 = 0」的约定（与定时锁屏时间表一致），表格按中文习惯从周一排到周日。
              </p>
              <p>· 求值由孩子设备按本地时钟完成，断网也照样生效。</p>
            </div>
          </div>
        </div>
      </div>

      <div className="px-3 mt-3">
        <Card className="overflow-hidden">
          <CardContent className="p-4 flex items-center justify-between">
            <div className="flex items-center space-x-2 min-w-0">
              <CalendarClock className="w-5 h-5 text-gray-400 flex-shrink-0" />
              <span className="text-xs text-gray-500">选好之后别忘了点保存</span>
            </div>
            <Button
              size="sm"
              className="bg-[#07c160] hover:bg-[#06a050]"
              onClick={() => void handleSave()}
              disabled={saving || !dirty}
            >
              {saving ? '保存中…' : '保存当前规划'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
