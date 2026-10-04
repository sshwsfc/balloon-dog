import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToggleSwitch } from '@/components/ToggleSwitch'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, Info, Loader2, Puzzle, RefreshCw, XCircle, CheckCircle2 } from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { AppPluginCategory, AppPluginTarget, AppPluginUpdateItem } from '@/types'

/** 分类展示顺序与中文名；与后端目录里的 category 取值一一对应 */
const CATEGORY_ORDER: AppPluginCategory[] = [
  'payment',
  'social',
  'entertainment',
  'game',
  'install',
  'browsing',
  'privacy',
]

const CATEGORY_LABEL: Record<AppPluginCategory, string> = {
  payment: '支付与消费',
  social: '社交',
  entertainment: '娱乐',
  game: '游戏',
  install: '安装与分发',
  browsing: '浏览',
  privacy: '隐私相关',
}

export function AppPluginDetailPage() {
  const navigate = useNavigate()
  const params = useParams<{ packageName: string }>()

  /** React Router 会先解一次码；这里再兜一次，避免包名里的 `%` 让 decode 抛异常 */
  const packageName = useMemo(() => {
    const raw = params.packageName ?? ''
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }, [params.packageName])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [targets, setTargets] = useState<AppPluginTarget[]>([])
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const loadData = useCallback(
    async (options?: { silent?: boolean }) => {
      try {
        const data = await api.getAppPlugins()
        setTargets(data.targets ?? [])
        setError(null)
      } catch (err) {
        const message = toUserMessage(err, '加载插件清单失败')
        setError(message)
        if (!options?.silent) toast.error(message)
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void loadData()
  }, [loadData])

  const target = useMemo(
    () => targets.find((item) => item.packageName === packageName) ?? null,
    [targets, packageName],
  )

  /** 提交插件开关。后端整批校验，未知键会整批报错，所以成功即代表全部写入。 */
  const applyItems = async (items: AppPluginUpdateItem[], successText: string, key: string) => {
    if (items.length === 0) return
    setBusyKey(key)
    try {
      const result = await api.updateAppPlugins(items)
      setTargets(result.targets ?? [])
      toast.success(successText)
    } catch (err) {
      toast.error(toUserMessage(err, '保存失败，请稍后重试'))
      console.error('保存插件开关失败：', err)
    } finally {
      setBusyKey(null)
    }
  }

  const handleTogglePlugin = async (pluginKey: string, enabled: boolean) => {
    if (!target) return
    await applyItems(
      [{ packageName: target.packageName, pluginKey, enabled }],
      enabled ? '已允许该功能' : '已关闭该功能',
      pluginKey,
    )
  }

  const handleBulk = async (enabled: boolean) => {
    if (!target) return
    const items = target.plugins.map((plugin) => ({
      packageName: target.packageName,
      pluginKey: plugin.key,
      enabled,
    }))
    await applyItems(
      items,
      enabled ? `已全部允许（${items.length} 项）` : `已全部关闭（${items.length} 项）`,
      enabled ? 'bulk-on' : 'bulk-off',
    )
  }

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

  if (error && targets.length === 0) {
    return (
      <div className="page-shell page-shell--wide">
        <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-xl font-medium text-gray-900 flex-1">插件清单</h1>
        </div>
        <div className="px-6 py-20 text-center">
          <Puzzle className="w-12 h-12 text-gray-300 mx-auto mb-3" />
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

  // 目录由服务端维护，请求一个目录里没有的包名时如实说明，不显示空白页
  if (!target) {
    return (
      <div className="page-shell page-shell--wide">
        <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-xl font-medium text-gray-900 flex-1">插件清单</h1>
        </div>
        <div className="px-6 py-20 text-center">
          <Puzzle className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-700 font-medium">插件目录里没有这个应用</p>
          <p className="text-sm text-gray-500 mt-2 break-all">{packageName || '（缺少包名）'}</p>
          <p className="text-xs text-gray-400 mt-2 leading-relaxed">
            可管控的应用目录由服务端维护（微信、QQ、抖音、应用商店、浏览器与跨应用支付）。
          </p>
          <Button className="mt-4 bg-[#07c160] hover:bg-[#06a050]" onClick={() => navigate('/app-plugins')}>
            返回插件管理
          </Button>
        </div>
      </div>
    )
  }

  const allBlocked = target.total > 0 && target.blocked === target.total
  const noneBlocked = target.blocked === 0
  const bulkBusy = busyKey === 'bulk-off' || busyKey === 'bulk-on'

  return (
    <div className="page-shell page-shell--wide">
      <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1 truncate">{target.appName}</h1>
        <button
          type="button"
          onClick={() => void loadData({ silent: true })}
          className="text-gray-400 p-1"
          aria-label="刷新"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      {/* ---------------- 概览 ---------------- */}
      <div className="px-3 py-3">
        <Card className="overflow-hidden">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="w-12 h-12 rounded-xl bg-green-50 text-[#07c160] flex items-center justify-center font-medium text-lg flex-shrink-0">
                {target.badge}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-gray-900 truncate">{target.appName}</div>
                <div className="text-[11px] text-gray-400 truncate mt-0.5">{target.packageName}</div>
              </div>
              <Badge className="bg-red-50 text-red-600 flex-shrink-0">
                已关闭 {target.blocked} / 共 {target.total}
              </Badge>
            </div>

            <div className="flex flex-wrap gap-2 mt-4">
              <Button
                size="sm"
                variant="outline"
                disabled={bulkBusy || noneBlocked}
                onClick={() => void handleBulk(false)}
                className="text-red-500 border-red-200"
              >
                {busyKey === 'bulk-off' ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 mr-1" />
                )}
                全部关闭
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={bulkBusy || allBlocked}
                onClick={() => void handleBulk(true)}
                className="text-[#07c160] border-green-200"
              >
                {busyKey === 'bulk-on' ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                )}
                全部允许
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {error && (
        <div className="px-3">
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

      {/* ---------------- 按分类的插件清单 ---------------- */}
      {CATEGORY_ORDER.map((category) => {
        const plugins = target.plugins.filter((plugin) => plugin.category === category)
        if (plugins.length === 0) return null
        return (
          <div key={category} className="px-3 mt-3">
            <div className="mb-2 px-1 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-500">{CATEGORY_LABEL[category]}</span>
              <span className="text-xs text-gray-400">
                {plugins.filter((plugin) => !plugin.enabled).length} / {plugins.length} 已关闭
              </span>
            </div>
            <Card className="overflow-hidden">
              <CardContent className="p-0">
                {plugins.map((plugin, index) => (
                  <div key={plugin.key}>
                    <div className="flex items-center py-3 px-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center space-x-1.5 min-w-0">
                          <span className="text-sm text-gray-900 truncate">{plugin.label}</span>
                          {plugin.customized && (
                            <Badge className="bg-blue-50 text-blue-600 text-[10px] flex-shrink-0">
                              已自定义
                            </Badge>
                          )}
                          {!plugin.enabled && (
                            <Badge className="bg-red-50 text-red-600 text-[10px] flex-shrink-0">已关闭</Badge>
                          )}
                        </div>
                        <div className="text-[11px] text-gray-400 mt-0.5">
                          {plugin.enabled ? '允许使用' : '命中即拦截'}
                        </div>
                      </div>
                      <ToggleSwitch
                        checked={plugin.enabled}
                        busy={busyKey === plugin.key}
                        disabled={busyKey !== null}
                        label={`${plugin.label}开关`}
                        onChange={() => void handleTogglePlugin(plugin.key, !plugin.enabled)}
                      />
                    </div>
                    {index < plugins.length - 1 && <div className="mx-4 border-t border-gray-100" />}
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )
      })}

      <div className="px-3 mt-3">
        <div className="bg-white rounded-lg p-3 border border-gray-100">
          <div className="flex items-start space-x-2">
            <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-gray-500 leading-relaxed space-y-1">
              <p className="font-medium text-gray-700">这些开关的边界</p>
              <p>· 默认全部放行：产品升级新增插件时不会突然拦住孩子正常在用的功能。</p>
              <p>
                · 拦截靠孩子设备上的无障碍服务按界面文案匹配，应用改版可能漏拦；
                WebView 与游戏画布里的内容看不见。
              </p>
              <p>· 改动会随设备端配置刷新（≤15 秒）生效，设备离线时等它上线后生效。</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
