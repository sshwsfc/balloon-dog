import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { HeaderRefreshButton } from '@/components/HeaderRefreshButton'
import { MembershipGate } from '@/components/MembershipGate'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, Eye, EyeOff, Info, Sparkles } from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import { useMembership } from '@/hooks/useMembership'
import type { ScreenMonitorConfig, ScreenMonitorConfigPatch } from '@/types'
import { useTranslation } from 'react-i18next'

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

function defaultsFrom(config: ScreenMonitorConfig): Record<NumberFieldKey, string> {
  return {
    captureIntervalSeconds: String(config.captureIntervalSeconds),
    framesPerBatch: String(config.framesPerBatch),
    analyzeSampleCount: String(config.analyzeSampleCount),
    retentionDays: String(config.retentionDays),
  }
}

/**
 * AI 洞察配置页（`/insights/config`）。
 *
 * 从洞察页拆出来：洞察页只负责「看」（概览 / 提醒 / 时间线 / 用量上限的只读展示），
 * 所有会改动孩子端行为的开关集中在这里，避免家长在一条长页面里滚来滚去。
 */
export function InsightsConfigPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { isSuper } = useMembership()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [config, setConfig] = useState<ScreenMonitorConfig | null>(null)
  const [numberDrafts, setNumberDrafts] = useState<Record<NumberFieldKey, string>>({
    captureIntervalSeconds: '30',
    framesPerBatch: '10',
    analyzeSampleCount: '6',
    retentionDays: '7',
  })
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      // 非超级会员不发请求：这页一个接口，服务端会 403，拉一次只是白刷一屏红
      if (!isSuper) {
        setLoading(false)
        return
      }
      try {
        const data = await api.getScreenMonitorConfig()
        setConfig(data)
        setNumberDrafts(defaultsFrom(data))
        setError(null)
      } catch (err) {
        const message = toUserMessage(err, t('加载 AI 洞察配置失败'))
        setError(message)
        if (!options?.silent) toast.error(message)
      } finally {
        setLoading(false)
      }
    },
    [t, isSuper],
  )

  useEffect(() => {
    void load()
  }, [load])

  const reload = (options?: { silent?: boolean }) => load(options)

  const analysisMode = config?.analysisMode ?? 'disabled'
  const isAi = analysisMode === 'ai'

  const saveConfig = async (patch: ScreenMonitorConfigPatch, successText: string, key: string) => {
    setBusyKey(key)
    try {
      await api.updateScreenMonitorConfig(patch)
      toast.success(successText)
      await reload({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, t('保存失败，请稍后重试')))
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
      toast.error(
        t('{{v0}}需在 {{v1}} ~ {{v2}} {{v3}}之间', {
          v0: t(rule.label),
          v1: rule.min,
          v2: rule.max,
          v3: t(rule.unit),
        }),
      )
      setNumberDrafts((current) => ({ ...current, [field]: String(config?.[field] ?? rule.min) }))
      return
    }
    if (value === config?.[field]) return
    await saveConfig(
      { [field]: value },
      t('{{v0}}已设为 {{v1}} {{v2}}', { v0: t(rule.label), v1: value, v2: t(rule.unit) }),
      field,
    )
  }

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

  if (error && !config) {
    return (
      <div className="page-shell">
        <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-xl font-medium text-gray-900 flex-1">{t('AI 洞察配置')}</h1>
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
            {t('重新加载')}
          </Button>
        </div>
      </div>
    )
  }

  if (!isSuper) {
    return (
      <div className="page-shell">
        <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-xl font-medium text-gray-900 flex-1">{t('AI 洞察配置')}</h1>
        </div>
        <div className="px-3 py-4 sm:px-4">
          <MembershipGate
            entitlementKey="aiInsight"
            title={t('AI 洞察配置是超级会员功能')}
            description={t('截屏采集与 AI 画面分析属于超级会员，开通后即可在这里调整采集频率与异常提醒。')}
          />
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
        <h1 className="text-xl font-medium text-gray-900 flex-1">{t('AI 洞察配置')}</h1>
        <HeaderRefreshButton onRefresh={() => reload({ silent: true })} />
      </div>

      {error && (
        <div className="px-3 pt-3">
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-start space-x-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-700 flex-1">
              {t('最新数据读取失败：')}
              {error}
              {t('（下方是上次加载的数据）')}
            </p>
          </div>
        </div>
      )}

    <div className="px-3 mt-3">
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
            <div className="font-medium text-gray-900 text-sm">{t('开启截屏采集')}</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {config?.captureEnabled ? t('已开启，设备会周期性上传屏幕画面') : t('默认关闭，开启前请阅读下方隐私说明')}
            </div>
          </div>
          <Toggle
            checked={config?.captureEnabled ?? false}
            disabled={busyKey === 'captureEnabled' || !config}
            label={t('截屏采集开关')}
            onChange={() => {
              if (!config) return
              void saveConfig(
                { captureEnabled: !config.captureEnabled },
                !config.captureEnabled ? t('截屏采集已开启') : t('截屏采集已关闭'),
                'captureEnabled',
              )
            }}
          />
        </div>

        {config && (
          /* 手动截图**不**要求「屏幕洞察」开关，所以这里刻意只判 config 是否加载完，
             不判 captureEnabled：截图是「按一次看一次」，和这一页的周期采集 + AI 分析不是
             同一件事，后端也已撤掉门禁。能不能截到由孩子端的无障碍服务决定，截不到时
             下发结果里会带设备回报的真实原因。 */
          
          <div className="mx-4 mb-3 flex items-center justify-between gap-3 border-t border-gray-50 pt-3">
              <div className="text-xs text-gray-400 leading-relaxed">
                {t('想立刻看当前画面？点右侧下发一次截图，结果在「媒体」页。')}
              </div>
              <button
                type="button"
                disabled={busyKey === 'manualShot'}
                onClick={() => {
                  void (async () => {
                    setBusyKey('manualShot')
                    try {
                      await api.screenshot()
                      toast.success(t('截图指令已下发，稍后到「媒体」页查看'))
                    } catch (err: unknown) {
                      toast.error(toUserMessage(err, t('截图指令下发失败')))
                    } finally {
                      setBusyKey(null)
                    }
                  })()
                }}
                className="flex-shrink-0 text-sm text-[#07c160] font-medium px-3 py-1.5 rounded-lg bg-green-50 active:bg-green-100 disabled:opacity-50"
              >
                {t('立即截图')}
              </button>
            </div>
        )}

        {config?.captureEnabled && (
          <div className="mx-4 mb-3 bg-red-50 border border-red-200 rounded-lg p-3">
            <div className="flex items-start space-x-2">
              <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-red-700 leading-relaxed space-y-1">
                <p className="font-medium text-sm">{t('开启后请注意：')}</p>
                <p>{t('· 孩子设备的屏幕画面会被')}<b>{t('周期性采集')}</b>{t('（当前每')} {config.captureIntervalSeconds}{t('秒一张， 每')}{config.framesPerBatch} {t('张打成一个包）。')}
                </p>
                <p>{t('· 截图会')}<b>{t('发送至 AI 服务进行分析')}</b>{t('，用于识别内容、统计局数与集数并生成提醒。')}
                </p>
                <p>{t('· 截图按')}<b>{t('留档')} {config.retentionDays} {t('天')}</b>{t('后自动删除，家长端')}<b>{t('不展示截图原图')}</b>{t('（儿童隐私约定），只能看到帧时间线（时间 + 应用名）。')}</p>
                <p>{t('· 确有需要时再开启，并事先告知孩子。')}</p>
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
                  <span className="text-sm text-gray-700">{t(rule.label)}</span>
                  <span className="text-[11px] text-gray-400 ml-1.5">
                    {rule.min} ~ {rule.max} {t(rule.unit)}
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
                  aria-label={t(rule.label)}
                  className="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:border-[#07c160] disabled:bg-gray-50"
                />
                <span className="text-sm text-gray-500 w-6">{t(rule.unit)}</span>
              </div>
            )
          })}
        </div>

        <div className="mx-4 border-t border-gray-100" />

        {/* AI 分析开关与采样数 */}
        <div className="flex items-center py-3 px-4">
          <div className="flex-1 min-w-0">
            <div className="font-medium text-gray-900 text-sm">{t('开启 AI 分析')}</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {isAi ? t('已配置视觉模型，会对截图做真实分析') : t('模型未就绪，开启后仍只会做启发式推断')}
            </div>
          </div>
          <Toggle
            checked={config?.analyzeEnabled ?? false}
            disabled={busyKey === 'analyzeEnabled' || !config}
            label={t('AI 分析开关')}
            onChange={() => {
              if (!config) return
              void saveConfig(
                { analyzeEnabled: !config.analyzeEnabled },
                !config.analyzeEnabled ? t('AI 分析已开启') : t('AI 分析已关闭'),
                'analyzeEnabled',
              )
            }}
          />
        </div>

        <div className="mx-4 border-t border-gray-100" />

        {/* 用屏幕内容出题 */}
        <div className="flex items-center py-3 px-4">
          <div className="flex-1 min-w-0">
            <div className="font-medium text-gray-900 text-sm">{t('用屏幕内容出题')}</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {config?.quizFromScreen
                ? t('答题解锁会用屏幕内容出题')
                : t('答题解锁只从题库取题')}
            </div>
          </div>
          <Toggle
            checked={config?.quizFromScreen ?? false}
            disabled={busyKey === 'quizFromScreen' || !config}
            label={t('用屏幕内容出题开关')}
            onChange={() => {
              if (!config) return
              void saveConfig(
                { quizFromScreen: !config.quizFromScreen },
                !config.quizFromScreen ? t('已开启屏幕出题') : t('已关闭屏幕出题'),
                'quizFromScreen',
              )
            }}
          />
        </div>

        <div className="mx-4 border-t border-gray-100" />

        {/* 5 类提醒开关 */}
        <div className="px-4 py-3">
          <p className="text-xs text-gray-400 mb-1">{t('异常提醒类型')}</p>
          {ALERT_SWITCHES.map((item, index) => (
            <div key={String(item.key)}>
              <div className="flex items-center py-2.5">
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-gray-800">{t(item.label)}</span>
                  <p className="text-[11px] text-gray-400 mt-0.5">{t(item.desc)}</p>
                </div>
                <Toggle
                  checked={Boolean(config?.[item.key])}
                  disabled={busyKey === String(item.key) || !config}
                  label={t('{{v0}}提醒开关', { v0: t(item.label) })}
                  onChange={() => {
                    if (!config) return
                    const current = Boolean(config[item.key])
                    void saveConfig(
                      { [item.key]: !current },
                      t('{{v0}}提醒{{v1}}', { v0: t(item.label), v1: current ? t('已关闭') : t('已开启') }),
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
            <p className="text-xs text-gray-500 leading-relaxed">{t('这些开关都作用在孩子端，改动立即保存；设备下次上报时生效。关闭截屏后不再产生新的洞察批次。')}</p>
          </div>
        </div>
      </div>
    </div>

    </div>
  )
}
