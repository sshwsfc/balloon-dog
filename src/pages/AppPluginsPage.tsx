import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, ChevronRight, Info, Puzzle, RefreshCw, Shield } from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { AppPluginTarget } from '@/types'

export function AppPluginsPage() {
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [targets, setTargets] = useState<AppPluginTarget[]>([])

  const loadData = useCallback(async (options?: { silent?: boolean }) => {
    try {
      const data = await api.getAppPlugins()
      setTargets(data.targets ?? [])
      setError(null)
    } catch (err) {
      const message = toUserMessage(err, '加载插件目录失败')
      setError(message)
      if (!options?.silent) toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

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
          <h1 className="text-xl font-medium text-gray-900 flex-1">插件管理</h1>
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

  return (
    <div className="page-shell page-shell--wide">
      <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1">插件管理</h1>
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

      <div className="px-3 py-3">
        <div className="bg-[#07c160]/5 border border-[#07c160]/20 rounded-lg p-3">
          <div className="flex items-start space-x-2">
            <Shield className="w-4 h-4 text-[#07c160] mt-0.5 flex-shrink-0" />
            <p className="text-xs text-gray-600 leading-relaxed">
              点开应用卡片，可以逐项关闭支付、直播、小程序等具体功能。
              「已关闭」的数量就是当前被拦下的功能项。
            </p>
          </div>
        </div>
      </div>

      {targets.length === 0 ? (
        <div className="px-3">
          <Card className="overflow-hidden">
            <CardContent className="p-6 text-center">
              <Puzzle className="w-10 h-10 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">插件目录为空，请稍后重试或联系维护者。</p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 px-3 sm:grid-cols-3 lg:grid-cols-4">
          {targets.map((target) => {
            const blockedPercent = target.total > 0 ? Math.round((target.blocked / target.total) * 100) : 0
            return (
              <button
                key={target.packageName}
                type="button"
                onClick={() => navigate(`/app-plugins/${encodeURIComponent(target.packageName)}`)}
                className="text-left bg-white rounded-lg p-3 shadow-sm hover:bg-gray-50 active:bg-gray-100 transition-colors"
              >
                <div className="flex items-center space-x-2 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-green-50 text-[#07c160] flex items-center justify-center font-medium flex-shrink-0">
                    {target.badge}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{target.appName}</div>
                    <div className="text-[10px] text-gray-400 truncate">{target.packageName}</div>
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between">
                  <span className="text-xs text-gray-500">
                    已关闭 {target.blocked} / 共 {target.total}
                  </span>
                  <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0" />
                </div>

                <div className="h-1 bg-gray-100 rounded-full mt-2 overflow-hidden">
                  <div className="h-full bg-red-400" style={{ width: `${blockedPercent}%` }} />
                </div>
              </button>
            )
          })}
        </div>
      )}

      <div className="px-3 mt-3">
        <div className="bg-white rounded-lg p-3 border border-gray-100">
          <div className="flex items-start space-x-2">
            <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-gray-500 leading-relaxed space-y-1">
              <p className="font-medium text-gray-700">插件管控是怎么做到的</p>
              <p>
                · Android 没有「只允许应用里的某几个功能」的公开接口，这里靠孩子设备上的
                <b>无障碍服务</b>：识别当前界面文案，命中规则就退回并显示说明遮罩。
              </p>
              <p>· 应用改版改了文案可能漏拦；WebView / 游戏画布里的内容看不见；有几百毫秒延迟。</p>
              <p>· 「支付管理」「应用商店」「浏览器」是跨应用的伪目标，不对应某个具体应用。</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
