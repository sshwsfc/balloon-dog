import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HeaderRefreshButton } from '@/components/HeaderRefreshButton'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, BookOpen, CalendarClock, Check, Info, Loader2, Repeat, Smartphone } from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import { FeatureTip } from '@/components/FeatureTip'
import type { DeviceModeState, DeviceModeValue, ModeApp } from '@/types'
import { useTranslation } from 'react-i18next'

/** 手动模式的展示信息；`study` 是关键卖点，必须一眼能看懂 */
const MODE_META: Record<DeviceModeValue, { label: string; desc: string; className: string; icon: typeof Repeat }> = {
  study: {
    label: '学习模式',
    desc: '只能用白名单里的应用，其他应用会被拦下',
    className: 'bg-green-100 text-green-700',
    icon: BookOpen,
  },
  normal: {
    label: '普通模式',
    desc: '不按模式限制应用，由时间表和时长规则管',
    className: 'bg-blue-100 text-blue-700',
    icon: Smartphone,
  },
}

type ModeChoice = 'schedule' | 'study' | 'normal'

const CHOICE_META: { value: ModeChoice; title: string; desc: string; icon: typeof Repeat }[] = [
  {
    value: 'schedule',
    title: '按时间设置',
    desc: '选中的学习时段自动进入学习模式，其余时间普通模式。',
    icon: CalendarClock,
  },
  {
    value: 'study',
    title: '学习模式',
    desc: '一直保持学习模式，直到你手动切回；时段规划不生效。',
    icon: BookOpen,
  },
  {
    value: 'normal',
    title: '普通模式',
    desc: '一直保持普通模式，不拦截应用。',
    icon: Smartphone,
  },
]

/** 当前选中的是三态里的哪一个；null = 三态都没选中（manualMode 为 null 且时段规划关闭） */
function choiceOf(mode: DeviceModeState): ModeChoice | null {
  if (mode.manualMode === 'study') return 'study'
  if (mode.manualMode === 'normal') return 'normal'
  if (mode.scheduleEnabled) return 'schedule'
  return null
}

export function ModePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<DeviceModeState | null>(null)
  const [studyApps, setStudyApps] = useState<ModeApp[]>([])
  const [busy, setBusy] = useState<ModeChoice | null>(null)

  const loadData = useCallback(async (options?: { silent?: boolean }) => {
    try {
      const [modeData, appsData] = await Promise.all([api.getDeviceMode(), api.getModeApps()])
      setMode(modeData)
      setStudyApps(appsData.study ?? [])
      setError(null)
    } catch (err) {
      const message = toUserMessage(err, t('加载模式设置失败'))
      setError(message)
      if (!options?.silent) toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadData()
  }, [loadData])

  /**
   * 三态切换。
   *
   * 「按时间设置」必须**同时**把 manualMode 清成 null 并打开 scheduleEnabled：
   * 只清 manualMode 而不开时段规划，结果会是「普通模式」，与按钮文案不符。
   */
  const handleSelect = async (choice: ModeChoice) => {
    if (!mode || choice === choiceOf(mode)) return
    const patch =
      choice === 'schedule'
        ? { manualMode: null, scheduleEnabled: true }
        : choice === 'study'
          ? { manualMode: 'study' as const }
          : { manualMode: 'normal' as const }

    setBusy(choice)
    try {
      const result = await api.updateDeviceMode(patch)
      setMode(result.mode)
      toast.success(t('已切换为「{{v0}}」', { v0: CHOICE_META.find((item) => item.value === choice)?.title ?? choice }))
    } catch (err) {
      toast.error(toUserMessage(err, t('切换模式失败，请稍后重试')))
      console.error('切换模式失败：', err)
    } finally {
      setBusy(null)
    }
  }

  const currentChoice = mode ? choiceOf(mode) : null
  const effective = mode ? MODE_META[mode.effectiveMode] : null
  const EffectiveIcon = effective?.icon ?? Repeat

  const currentSlotText = useMemo(() => {
    if (!mode?.currentSlot) return null
    const day = [t('周日'), t('周一'), t('周二'), t('周三'), t('周四'), t('周五'), t('周六')][mode.currentSlot.dayOfWeek] ?? ''
    return `${day} ${String(mode.currentSlot.hour).padStart(2, '0')}:00 - ${String(
      (mode.currentSlot.hour + 1) % 24,
    ).padStart(2, '0')}:00`
  }, [mode?.currentSlot, t])

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

  if (error && !mode) {
    return (
      <div className="page-shell">
        <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-xl font-medium text-gray-900 flex-1">{t('切换模式')}</h1>
        </div>
        <div className="px-6 py-20 text-center">
          <Repeat className="w-12 h-12 text-gray-300 mx-auto mb-3" />
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

  if (!mode || !effective) return null

  return (
    <div className="page-shell">
      <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1">{t('切换模式')}</h1>
        <HeaderRefreshButton onRefresh={() => loadData({ silent: true })} />
      </div>

      {/* ---------------- 当前模式 ---------------- */}
      <div className="px-3 py-3">
        <Card className="overflow-hidden">
          <div
            className={`px-4 py-5 ${
              mode.effectiveMode === 'study'
                ? 'bg-gradient-to-br from-green-500 to-green-600'
                : 'bg-gradient-to-br from-blue-500 to-blue-600'
            }`}
          >
            <div className="flex items-center space-x-3 text-white">
              <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                <EffectiveIcon className="w-6 h-6" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-white/80">{t('设备当前模式')}</p>
                <p className="text-2xl font-semibold leading-tight">{t(effective.label)}</p>
              </div>
            </div>
          </div>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center flex-wrap gap-2">
              <Badge className={effective.className}>{t(effective.label)}</Badge>
              {currentChoice === 'schedule' ? (
                <Badge className="bg-gray-100 text-gray-600">{t('按时间设置')}</Badge>
              ) : currentChoice === null ? (
                <Badge className="bg-amber-100 text-amber-700">{t('未选择模式')}</Badge>
              ) : (
                <Badge className="bg-amber-100 text-amber-700">{t('手动指定')}</Badge>
              )}
              {mode.scheduleEnabled && <Badge className="bg-gray-100 text-gray-600">{t('时段规划已启用')}</Badge>}
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">{t(effective.desc)}</p>
            {currentChoice === null && (
              <p className="text-xs text-amber-600 leading-relaxed">{t('还没选模式：时段规划未启用、也没手动指定，设备现在按普通模式运行。选「按时间设置」才会按格子拦截。')}</p>
            )}
            {currentChoice === 'schedule' && currentSlotText && (
              <p className="text-xs text-gray-400">
                {t('当前时段：')}{currentSlotText}
                {mode.slotCount > 0 ? t('（选中即学习模式）') : ''}
              </p>
            )}
            <p className="text-[11px] text-gray-400 leading-relaxed border-t border-gray-100 pt-2">
              {t('模式由')}<b>{t('孩子设备本地时钟')}</b>{t('求值，这里只是服务器推算，仅供参考。手动模式优先于时段规划。')}</p>
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 全天学习模式警告 ---------------- */}
      {mode.allDayStudyWarning && (
        <div className="px-3">
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start space-x-2">
            <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-red-700 leading-relaxed">
              <p className="font-medium text-sm">{t('未设置任何时段，全天都是学习模式')}</p>
              <p className="mt-0.5">{t('除白名单应用外，孩子一整天都用不了应用。点「制定规划」选学习时段，或改回普通模式。')}</p>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- 三态选择 ---------------- */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">{t('模式选择')}</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-3 space-y-2">
            {CHOICE_META.map((choice) => {
              const Icon = choice.icon
              const selected = currentChoice === choice.value
              const isBusy = busy === choice.value
              return (
                <button
                  key={choice.value}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void handleSelect(choice.value)}
                  className={`w-full text-left p-3 rounded-lg border transition-colors disabled:opacity-60 ${
                    selected ? 'border-[#07c160] bg-green-50' : 'border-gray-200 bg-white hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <Icon className={`w-4 h-4 ${selected ? 'text-[#07c160]' : 'text-gray-500'}`} />
                      <span className="font-medium text-gray-900 text-sm">{t(choice.title)}</span>
                    </div>
                    {isBusy ? (
                      <Loader2 className="w-4 h-4 animate-spin text-[#07c160]" />
                    ) : (
                      selected && <Check className="w-4 h-4 text-[#07c160]" />
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">{t(choice.desc)}</p>
                </button>
              )
            })}
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 学习模式白名单 ---------------- */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">{t('学习模式可用应用')}</span>
          <button type="button" className="text-xs text-[#07c160]" onClick={() => navigate('/mode/apps')}>
            {t('选择应用')}
          </button>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-4">
            {studyApps.length === 0 ? (
              <div className="text-center py-2">
                <BookOpen className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-500">
                  {t('白名单为空。学习模式下，没加入白名单的应用都会被拦下。')}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => navigate('/mode/apps')}
                >
                  {t('去选择应用')}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-x-3 gap-y-2">
                {studyApps.map((app) => (
                  <div key={app.id} className="flex items-center space-x-1.5">
                    <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center text-xs text-[#07c160] font-medium">
                      {(app.appName || app.packageName).slice(0, 1)}
                    </div>
                    <span className="text-xs text-gray-700 max-w-[80px] truncate">
                      {app.appName || app.packageName}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 时段规划 ---------------- */}
      <div className="px-3 mt-3">
        <Card className="overflow-hidden">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900">{t('模式时段规划')}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {mode.scheduleEnabled
                    ? mode.slotCount > 0
                      ? t('已选 {{v0}} / 168 格', { v0: mode.slotCount })
                      : t('已启用，但一格都没选（全天学习模式）')
                    : t('未启用')}
                </div>
              </div>
              <Button
                size="sm"
                className="bg-[#07c160] hover:bg-[#06a050]"
                onClick={() => navigate('/mode/schedule')}
              >
                {t('制定规划')}
              </Button>
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
              <p className="font-medium text-gray-700">{t('为什么留空会变成全天学习模式')}</p>
              <p>{t('· 「按时间设置」只把选中的格子当学习模式，一格都没选则')}<b>{t('全天学习模式')}</b>{t('，不是「不限制」。')}
              </p>
              <p>{t('· 该状态下孩子的手机整天用不了应用，所以会一直显示红色警告。')}</p>
              <p>{t('· 拦截靠孩子设备上的')}<b>{t('无障碍服务')}</b>{t('：按界面文案匹配、有几百毫秒延迟，关掉权限即失效，不是系统级白名单。')}</p>
            </div>
          </div>
        </div>
      </div>
      <FeatureTip id="mode" text={t('学习模式只放行白名单应用，其它一律拦下；普通模式不拦截，但仍受时间表和时长规则约束。')} />

    </div>
  )
}
