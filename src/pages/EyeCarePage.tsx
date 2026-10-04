import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToggleSwitch } from '@/components/ToggleSwitch'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  Clock,
  Eye,
  Info,
  Loader2,
  Moon,
  RefreshCw,
  Save,
  Sun,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { EyeCareConfig, EyeCareConfigPatch } from '@/types'

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => hour)

/** 数值项的统一校验区间，与后端 zod 保持一致；写在一起避免两处漂移 */
const NUMBER_RULES = {
  continuousMinutes: { min: 5, max: 240, label: '连续用眼提醒', unit: '分钟' },
  restMinutes: { min: 1, max: 60, label: '强制休息时长', unit: '分钟' },
} as const

type NumberFieldKey = keyof typeof NUMBER_RULES

const BRIGHTNESS_PRESETS = [0, 50, 80, 100]

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

export function EyeCarePage() {
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [config, setConfig] = useState<EyeCareConfig | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [continuousDraft, setContinuousDraft] = useState('40')
  const [restDraft, setRestDraft] = useState('10')
  const [brightnessDraft, setBrightnessDraft] = useState('0')

  const syncDrafts = (next: EyeCareConfig) => {
    setContinuousDraft(String(next.continuousMinutes))
    setRestDraft(String(next.restMinutes))
    setBrightnessDraft(String(next.maxBrightnessPercent))
  }

  const loadData = useCallback(async (options?: { silent?: boolean }) => {
    try {
      const data = await api.getEyeCare()
      setConfig(data.config)
      setContinuousDraft(String(data.config.continuousMinutes))
      setRestDraft(String(data.config.restMinutes))
      setBrightnessDraft(String(data.config.maxBrightnessPercent))
      setError(null)
    } catch (err) {
      const message = toUserMessage(err, '加载护眼设置失败')
      setError(message)
      if (!options?.silent) toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  /**
   * 保存的统一包装。
   *
   * 失败时回读一次服务端配置：护眼设置里「夜间锁屏」这类组合校验是在写入**之后**
   * 才判定的，不回读的话界面上会留下一个服务端并没有接受的草稿值。
   */
  const save = async (patch: EyeCareConfigPatch, successText: string, key: string) => {
    setBusy(key)
    try {
      const result = await api.updateEyeCare(patch)
      setConfig(result.config)
      syncDrafts(result.config)
      toast.success(successText)
    } catch (err) {
      toast.error(toUserMessage(err, '保存失败，请稍后重试'))
      console.error('保存护眼设置失败：', err)
      await loadData({ silent: true })
    } finally {
      setBusy(null)
    }
  }

  const handleToggleEnabled = async () => {
    if (!config) return
    await save(
      { enabled: !config.enabled },
      config.enabled ? '护眼设置已关闭' : '护眼设置已开启',
      'enabled',
    )
  }

  const commitNumber = async (field: NumberFieldKey, draft: string) => {
    if (!config) return
    const rule = NUMBER_RULES[field]
    const value = Number.parseInt(draft, 10)
    if (!Number.isFinite(value) || value < rule.min || value > rule.max) {
      toast.error(`${rule.label}需在 ${rule.min} ~ ${rule.max} ${rule.unit}之间`)
      syncDrafts(config)
      return
    }
    if (value === config[field]) return
    const patch: EyeCareConfigPatch =
      field === 'continuousMinutes' ? { continuousMinutes: value } : { restMinutes: value }
    await save(patch, `${rule.label}已设为 ${value} ${rule.unit}`, field)
  }

  /**
   * 夜间时段改起止小时。
   *
   * 起止相同表示「不启用夜间时段」；此时如果夜间锁屏还开着就是自相矛盾的配置，
   * 后端也会拒绝。这里先在前端拦下，避免发出一次注定失败的请求。
   */
  const handleHourChange = async (which: 'start' | 'end', value: number) => {
    if (!config) return
    const nextStart = which === 'start' ? value : config.nightStartHour
    const nextEnd = which === 'end' ? value : config.nightEndHour
    if (nextStart === nextEnd && config.nightLockEnabled) {
      toast.error('起止小时相同表示不启用夜间时段，请先关闭「夜间锁屏」')
      return
    }
    if (nextStart === config.nightStartHour && nextEnd === config.nightEndHour) return

    setConfig({
      ...config,
      nightStartHour: nextStart,
      nightEndHour: nextEnd,
      nightEnabled: nextStart !== nextEnd,
    })
    await save(
      {
        nightStartHour: nextStart,
        nightEndHour: nextEnd,
        // 一起带上，让后端的「夜间锁定 + 空时段」组合校验真正生效
        nightLockEnabled: config.nightLockEnabled,
      },
      nextStart === nextEnd
        ? '夜间时段已清空（起止小时相同表示不启用）'
        : `夜间护眼时段已设为 ${formatHour(nextStart)} → ${formatHour(nextEnd)}`,
      which === 'start' ? 'nightStart' : 'nightEnd',
    )
  }

  const handleToggleNightLock = async () => {
    if (!config) return
    if (!config.nightLockEnabled && !config.nightEnabled) {
      toast.error('夜间时段未启用（起止小时相同），请先设置夜间护眼时段')
      return
    }
    await save(
      { nightLockEnabled: !config.nightLockEnabled },
      config.nightLockEnabled ? '已关闭夜间锁屏' : '已开启夜间锁屏：夜间时段将直接锁屏',
      'nightLock',
    )
  }

  const commitBrightness = async (value: number) => {
    if (!config) return
    if (value !== 0 && (value < 10 || value > 100)) {
      toast.error('亮度上限需为 0（不限制）或 10 ~ 100')
      syncDrafts(config)
      return
    }
    if (value === config.maxBrightnessPercent) return
    await save(
      { maxBrightnessPercent: value },
      value === 0 ? '已取消亮度上限' : `屏幕亮度上限已设为 ${value}%`,
      'brightness',
    )
  }

  const handleBrightnessCommitFromDraft = async () => {
    if (!config) return
    const value = Number.parseInt(brightnessDraft, 10)
    if (!Number.isFinite(value)) {
      syncDrafts(config)
      return
    }
    await commitBrightness(value)
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

  if (error && !config) {
    return (
      <div className="page-shell">
        <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-xl font-medium text-gray-900 flex-1">护眼设置</h1>
        </div>
        <div className="px-6 py-20 text-center">
          <Eye className="w-12 h-12 text-gray-300 mx-auto mb-3" />
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

  if (!config) return null

  return (
    <div className="page-shell">
      <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1">护眼设置</h1>
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

      {/* ---------------- 总开关 ---------------- */}
      <div className="px-3 py-3">
        <Card className="overflow-hidden">
          <CardContent className="p-4">
            <div className="flex items-center">
              <div
                className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${
                  config.enabled ? 'bg-green-50' : 'bg-gray-100'
                }`}
              >
                <Eye className={`w-6 h-6 ${config.enabled ? 'text-[#07c160]' : 'text-gray-400'}`} />
              </div>
              <div className="flex-1 min-w-0 ml-3">
                <div className="flex items-center space-x-2">
                  <span className="font-medium text-gray-900">护眼设置</span>
                  <Badge className={config.enabled ? 'bg-[#07c160] text-white' : 'bg-gray-300 text-white'}>
                    {config.enabled ? '已开启' : '已关闭'}
                  </Badge>
                </div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {config.enabled ? '按下面的规则在孩子设备上生效' : '关闭后所有护眼规则都不生效'}
                </div>
              </div>
              <ToggleSwitch
                checked={config.enabled}
                busy={busy === 'enabled'}
                disabled={busy === 'enabled'}
                label="护眼设置总开关"
                onChange={() => void handleToggleEnabled()}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 连续用眼与强制休息 ---------------- */}
      <div className="px-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">连续用眼提醒</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-4 space-y-4">
            <div className="flex items-center space-x-2">
              <Clock className="w-4 h-4 text-gray-500 flex-shrink-0" />
              <span className="text-sm text-gray-700 flex-1">连续用眼提醒</span>
              <input
                type="number"
                min={NUMBER_RULES.continuousMinutes.min}
                max={NUMBER_RULES.continuousMinutes.max}
                value={continuousDraft}
                onChange={(e) => setContinuousDraft(e.target.value)}
                onBlur={() => void commitNumber('continuousMinutes', continuousDraft)}
                disabled={busy === 'continuousMinutes'}
                className="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:border-[#07c160] disabled:bg-gray-50"
              />
              <span className="text-sm text-gray-500">分钟</span>
            </div>

            <div className="flex items-center space-x-2">
              <Moon className="w-4 h-4 text-gray-500 flex-shrink-0" />
              <span className="text-sm text-gray-700 flex-1">强制休息时长</span>
              <input
                type="number"
                min={NUMBER_RULES.restMinutes.min}
                max={NUMBER_RULES.restMinutes.max}
                value={restDraft}
                onChange={(e) => setRestDraft(e.target.value)}
                onBlur={() => void commitNumber('restMinutes', restDraft)}
                disabled={busy === 'restMinutes'}
                className="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:border-[#07c160] disabled:bg-gray-50"
              />
              <span className="text-sm text-gray-500">分钟</span>
            </div>

            <p className="text-xs text-gray-400 leading-relaxed">
              连续用眼达到 {config.continuousMinutes} 分钟后，设备会强制休息 {config.restMinutes} 分钟。
              <b className="text-gray-600">休息期间是真的锁屏</b>，休息结束自动解锁 ——
              这是设备端无障碍服务执行的，不是弹一个提醒而已。
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 夜间护眼 ---------------- */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">夜间护眼时段</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-4 space-y-4">
            <div className="flex items-center space-x-2">
              <span className="text-sm text-gray-700 w-16 flex-shrink-0">开始</span>
              <select
                value={config.nightStartHour}
                onChange={(e) => void handleHourChange('start', Number(e.target.value))}
                disabled={busy === 'nightStart' || busy === 'nightEnd'}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160] disabled:bg-gray-50"
              >
                {HOUR_OPTIONS.map((hour) => (
                  <option key={hour} value={hour}>
                    {formatHour(hour)}
                  </option>
                ))}
              </select>
              <span className="text-sm text-gray-400">→</span>
              <span className="text-sm text-gray-700 w-16 flex-shrink-0 text-right">结束</span>
              <select
                value={config.nightEndHour}
                onChange={(e) => void handleHourChange('end', Number(e.target.value))}
                disabled={busy === 'nightStart' || busy === 'nightEnd'}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160] disabled:bg-gray-50"
              >
                {HOUR_OPTIONS.map((hour) => (
                  <option key={hour} value={hour}>
                    {formatHour(hour)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-900">夜间锁屏</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {config.nightEnabled
                    ? '开启后，夜间时段内设备会直接锁屏'
                    : '夜间时段未启用（起止小时相同），无法开启'}
                </div>
              </div>
              <ToggleSwitch
                checked={config.nightLockEnabled}
                busy={busy === 'nightLock'}
                disabled={busy === 'nightLock'}
                label="夜间锁屏开关"
                onChange={() => void handleToggleNightLock()}
              />
            </div>

            <div className="flex items-center flex-wrap gap-2">
              <Badge className={config.nightEnabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}>
                {config.nightEnabled
                  ? `夜间时段 ${formatHour(config.nightStartHour)} → ${formatHour(config.nightEndHour)}`
                  : '夜间时段未启用'}
              </Badge>
              {config.nightLockEnabled && (
                <Badge className="bg-red-100 text-red-700">夜间将锁屏</Badge>
              )}
            </div>

            <p className="text-xs text-gray-400 leading-relaxed">
              起止小时相同（例如都设为 00）表示不启用夜间时段；此时无法开启夜间锁屏 ——
              否则家长会以为孩子夜里被锁住了，其实没有。
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 屏幕亮度上限 ---------------- */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">屏幕亮度上限</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-4 space-y-4">
            <div className="flex items-center space-x-2">
              <Sun className="w-4 h-4 text-gray-500 flex-shrink-0" />
              <span className="text-sm text-gray-700 flex-1">
                {config.maxBrightnessPercent === 0
                  ? '不限制亮度'
                  : `上限 ${config.maxBrightnessPercent}%`}
              </span>
              {busy === 'brightness' && <Loader2 className="w-4 h-4 animate-spin text-[#07c160]" />}
            </div>

            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={config.maxBrightnessPercent === 0 ? 100 : Number(brightnessDraft) || 100}
              disabled={config.maxBrightnessPercent === 0 || busy === 'brightness'}
              onChange={(e) => setBrightnessDraft(e.target.value)}
              className="w-full accent-[#07c160] disabled:opacity-40"
            />

            <div className="flex flex-wrap gap-2">
              {BRIGHTNESS_PRESETS.map((value) => (
                <Button
                  key={value}
                  variant="outline"
                  size="sm"
                  disabled={busy === 'brightness'}
                  onClick={() => void commitBrightness(value)}
                  className={
                    config.maxBrightnessPercent === value ? 'border-[#07c160] text-[#07c160]' : ''
                  }
                >
                  {value === 0 ? '不限制' : `${value}%`}
                </Button>
              ))}
              <Button
                variant="outline"
                size="sm"
                disabled={config.maxBrightnessPercent === 0 || busy === 'brightness'}
                onClick={() => void handleBrightnessCommitFromDraft()}
              >
                <Save className="w-3.5 h-3.5 mr-1" />
                保存亮度
              </Button>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="flex items-start space-x-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-amber-700 leading-relaxed">
                  亮度上限需要孩子设备端的<b>「修改系统设置」或设备所有者权限</b>才能真正生效。
                  没有授权时这条设置只是记录下来，不会改变屏幕亮度。可选 10 ~ 100，0 表示不限制。
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 说明 ---------------- */}
      <div className="px-3 mt-3">
        <div className="bg-white rounded-lg p-3 border border-gray-100">
          <div className="flex items-start space-x-2">
            <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-gray-500 leading-relaxed space-y-1">
              <p className="font-medium text-gray-700">护眼设置的边界</p>
              <p>· 强制休息是<b>真的锁屏</b>，休息结束后自动解锁；由设备端无障碍服务执行。</p>
              <p>· 亮度上限依赖设备端权限，未授权时不会生效。</p>
              <p>
                · 暂不支持「距离 / 姿势提醒」：那需要前置摄像头持续取帧做人脸与距离推断，
                隐私代价与误报率都很高，所以不放一个假的开关。
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
