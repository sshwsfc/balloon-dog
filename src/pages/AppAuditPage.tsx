import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToggleSwitch } from '@/components/ToggleSwitch'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, Check, Info, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { Features } from '@/types'

export function AppAuditPage() {
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [features, setFeatures] = useState<Features | null>(null)
  const [toggling, setToggling] = useState(false)
  const [busyApp, setBusyApp] = useState<string | null>(null)

  const loadData = useCallback(async (options?: { silent?: boolean }) => {
    try {
      const data = await api.getFeatures()
      setFeatures(data)
      setError(null)
    } catch (err) {
      const message = toUserMessage(err, '加载应用审批设置失败')
      setError(message)
      if (!options?.silent) toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const handleToggle = async () => {
    if (!features) return
    const next = !features.appAudit.enabled
    setToggling(true)
    try {
      await api.enableFeature('appAudit', next)
      toast.success(next ? '应用审批已开启' : '应用审批已关闭')
      await loadData({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, '操作失败，请稍后重试'))
      console.error('切换应用审批失败：', err)
    } finally {
      setToggling(false)
    }
  }

  const handleAudit = async (appName: string, approved: boolean) => {
    setBusyApp(appName)
    try {
      await api.auditApp(appName, approved)
      toast.success(approved ? `已批准 ${appName}` : `已拒绝 ${appName}`)
      await loadData({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, '操作失败，请稍后重试'))
      console.error('审批应用失败：', err)
    } finally {
      setBusyApp(null)
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

  if (error && !features) {
    return (
      <div className="page-shell">
        <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-xl font-medium text-gray-900 flex-1">应用审批</h1>
        </div>
        <div className="px-6 py-20 text-center">
          <ShieldCheck className="w-12 h-12 text-gray-300 mx-auto mb-3" />
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

  if (!features) return null

  const pendingApps = features.appAudit.pendingApps ?? []

  return (
    <div className="page-shell">
      <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1">应用审批</h1>
        <button
          type="button"
          onClick={() => void loadData({ silent: true })}
          className="text-gray-400 p-1"
          aria-label="刷新"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      {/* ---------------- 头部 ---------------- */}
      <div className="px-3 py-4">
        <div className="bg-white rounded-lg p-5 text-center">
          <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center mx-auto">
            <ShieldCheck className="w-8 h-8 text-[#07c160]" />
          </div>
          <p className="font-medium text-gray-900 mt-3">安装前先问过家长</p>
          <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">
            孩子设备上的安装入口会被关上；有人想装应用时，请求会出现在下面等你决定，
            批准后设备端临时放开 <b>30 分钟</b>。
          </p>
        </div>
      </div>

      {/* ---------------- 开关 ---------------- */}
      <div className="px-3">
        <Card className="overflow-hidden">
          <CardContent className="p-4">
            <div className="flex items-center">
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2">
                  <span className="font-medium text-gray-900">启用应用审批</span>
                  <Badge
                    className={
                      features.appAudit.enabled ? 'bg-[#07c160] text-white' : 'bg-gray-300 text-white'
                    }
                  >
                    {features.appAudit.enabled ? '已开启' : '已关闭'}
                  </Badge>
                </div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {features.appAudit.enabled
                    ? '没有你的批准，设备上装不了应用'
                    : '关闭后孩子安装应用不再需要你批准'}
                </div>
              </div>
              <ToggleSwitch
                checked={features.appAudit.enabled}
                busy={toggling}
                disabled={toggling}
                label="应用审批总开关"
                onChange={() => void handleToggle()}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 待审批列表 ---------------- */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">待审批应用</span>
          <span className="text-xs text-gray-400">{pendingApps.length} 个</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {pendingApps.length === 0 ? (
              <div className="p-6 text-center">
                <ShieldCheck className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-500">
                  暂无待审批的应用。孩子设备发起安装请求后会出现在这里。
                </p>
              </div>
            ) : (
              pendingApps.map((app, index) => (
                <div key={app}>
                  <div className="flex items-center py-3 px-4">
                    <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center text-sm text-gray-600 font-medium flex-shrink-0">
                      {app.slice(0, 1)}
                    </div>
                    <div className="flex-1 min-w-0 ml-3">
                      <div className="text-sm text-gray-900 truncate">{app}</div>
                      <div className="text-[11px] text-gray-400 mt-0.5">等待家长决定是否允许安装</div>
                    </div>
                    <div className="flex space-x-2 flex-shrink-0 ml-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-red-500 border-red-200"
                        disabled={busyApp === app}
                        onClick={() => void handleAudit(app, false)}
                        aria-label={`拒绝 ${app}`}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        className="bg-[#07c160] hover:bg-[#06a050]"
                        disabled={busyApp === app}
                        onClick={() => void handleAudit(app, true)}
                        aria-label={`批准 ${app}`}
                      >
                        <Check className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                  {index < pendingApps.length - 1 && <div className="mx-4 border-t border-gray-100" />}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 诚实说明 ---------------- */}
      <div className="px-3 mt-3">
        <Card className="overflow-hidden">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-start space-x-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-amber-700 leading-relaxed">
                <p className="font-medium text-sm">这不是系统级的「安装前审批」</p>
                <p className="mt-0.5">
                  Android <b>没有</b>「安装前弹给家长审批」的公开 API，所以做不到应用商店那种
                  「点安装 → 家长手机弹出确认」的效果。
                </p>
              </div>
            </div>

            <div className="flex items-start space-x-2">
              <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-gray-500 leading-relaxed space-y-1">
                <p className="font-medium text-gray-700">这个开关实际做了什么</p>
                <p>
                  · 孩子设备被设为<b>设备所有者</b>时，用 <code>DISALLOW_INSTALL_APPS</code>
                  关上系统安装入口 —— 只有在你的批准窗口内、或这个开关关闭时，安装才被允许。
                </p>
                <p>
                  · 无障碍服务检测到安装界面时，把「谁想装什么」<b>上报</b>到这里
                  （同一个应用包 10 分钟内最多报一次，避免重复打扰）。
                </p>
                <p>
                  · 你批准后，设备端<b>临时放开安装 30 分钟</b>；超时自动收回，需要重新批准。
                  同时会给这个应用加上<b>每天 60 分钟</b>的默认时长限制，可在「应用限制」里调整。
                </p>
                <p>· 因此它依赖设备所有者权限与无障碍权限都在线；两者被关掉就失效。</p>
                <p>
                  · 通过 ADB、部分文件管理器或系统自带商店的旁路安装仍可能绕过 —— 这条限制是
                  「提高门槛」，不是不可突破的强制拦截。
                </p>
                <p>
                  · 设备端 Agent 尚未上报审批请求时，这里会一直是空的；空列表不代表审批在正常工作。
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
