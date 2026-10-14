import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToggleSwitch } from '@/components/ToggleSwitch'
import { HeaderRefreshButton } from '@/components/HeaderRefreshButton'
import { AppIcon } from '@/components/AppIcon'
import { invalidateAppIcons } from '@/hooks/useAppIcons'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, Check, Info, ShieldCheck, X } from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import { FeatureTip } from '@/components/FeatureTip'
import type { Features } from '@/types'
import { useTranslation } from 'react-i18next'

export function AppAuditPage() {
  const { t } = useTranslation()
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
      const message = toUserMessage(err, t('加载应用审批设置失败'))
      setError(message)
      if (!options?.silent) toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const handleToggle = async () => {
    if (!features) return
    const next = !features.appAudit.enabled
    setToggling(true)
    try {
      await api.enableFeature('appAudit', next)
      toast.success(next ? t('应用审批已开启') : t('应用审批已关闭'))
      await loadData({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, t('操作失败，请稍后重试')))
      console.error('切换应用审批失败：', err)
    } finally {
      setToggling(false)
    }
  }

  const handleAudit = async (appName: string, approved: boolean) => {
    setBusyApp(appName)
    try {
      await api.auditApp(appName, approved)
      toast.success(approved ? t('已批准 {{v0}}', { v0: appName }) : t('已拒绝 {{v0}}', { v0: appName }))
      await loadData({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, t('操作失败，请稍后重试')))
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
          <p className="mt-2 text-gray-500 text-sm">{t('加载中...')}</p>
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
          <h1 className="text-xl font-medium text-gray-900 flex-1">{t('应用审批')}</h1>
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
            {t('重新加载')}
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
        <h1 className="text-xl font-medium text-gray-900 flex-1">{t('应用审批')}</h1>
        <HeaderRefreshButton
          onRefresh={() => {
            // 图标缓存跟着应用清单一起来：设备刚重新上报过图标时要立刻换新
            invalidateAppIcons()
            return loadData({ silent: true })
          }}
        />
      </div>

      {/* ---------------- 头部 ---------------- */}
      <div className="px-3 py-4">
        <div className="bg-white rounded-lg p-5 text-center">
          <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center mx-auto">
            <ShieldCheck className="w-8 h-8 text-[#07c160]" />
          </div>
          <p className="font-medium text-gray-900 mt-3">{t('安装前先问过家长')}</p>
          <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">{t('孩子端安装入口会被关上；有人想装应用时，请求会出现在下面等你决定，批准后设备端临时放开')}<b>{t('30 分钟')}</b>。
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
                  <span className="font-medium text-gray-900">{t('启用应用审批')}</span>
                  <Badge
                    className={
                      features.appAudit.enabled ? 'bg-[#07c160] text-white' : 'bg-gray-300 text-white'
                    }
                  >
                    {features.appAudit.enabled ? t('已开启') : t('已关闭')}
                  </Badge>
                </div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {features.appAudit.enabled
                    ? t('没有你的批准，设备上装不了应用')
                    : t('关闭后孩子装应用不再需要批准')}
                </div>
              </div>
              <ToggleSwitch
                checked={features.appAudit.enabled}
                busy={toggling}
                disabled={toggling}
                label={t('应用审批总开关')}
                onChange={() => void handleToggle()}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 待审批列表 ---------------- */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">{t('待审批应用')}</span>
          <span className="text-xs text-gray-400">{pendingApps.length} {t('个')}</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {pendingApps.length === 0 ? (
              <div className="p-6 text-center">
                <ShieldCheck className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-500">
                  {t('暂无待审批应用。孩子端发起安装请求后会出现在这里。')}
                </p>
              </div>
            ) : (
              pendingApps.map((app, index) => (
                <div key={app}>
                  <div className="flex items-center py-3 px-4">
                    <AppIcon
                      appName={app}
                      className="w-9 h-9 flex-shrink-0"
                      letterClassName="text-sm"
                    />
                    <div className="flex-1 min-w-0 ml-3">
                      <div className="text-sm text-gray-900 truncate">{app}</div>
                      <div className="text-[11px] text-gray-400 mt-0.5">{t('等待家长决定是否允许安装')}</div>
                    </div>
                    <div className="flex space-x-2 flex-shrink-0 ml-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-red-500 border-red-200"
                        disabled={busyApp === app}
                        onClick={() => void handleAudit(app, false)}
                        aria-label={t('拒绝 {{v0}}', { v0: app })}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        className="bg-[#07c160] hover:bg-[#06a050]"
                        disabled={busyApp === app}
                        onClick={() => void handleAudit(app, true)}
                        aria-label={t('批准 {{v0}}', { v0: app })}
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
                <p className="font-medium text-sm">{t('这不是系统级的「安装前审批」')}</p>
                <p className="mt-0.5">
                  Android <b>{t('没有')}</b>{t('「安装前弹给家长审批」的公开 API，做不到应用商店那种「点安装 → 家长手机确认」的效果。')}</p>
              </div>
            </div>

            <div className="flex items-start space-x-2">
              <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-gray-500 leading-relaxed space-y-1">
                <p className="font-medium text-gray-700">{t('这个开关实际做了什么')}</p>
                <p>{t('· 孩子设备被设为')}<b>{t('设备所有者')}</b>{t('时，用')} <code>DISALLOW_INSTALL_APPS</code>{t('关上系统安装入口：只有批准窗口内或开关关闭时才允许安装。')}</p>
                <p>{t('· 无障碍服务检测到安装界面时，把「谁想装什么」')}<b>{t('上报')}</b>{t('到这里（同一应用包 10 分钟内最多报一次，避免重复打扰）。')}</p>
                <p>{t('· 你批准后，设备端')}<b>{t('临时放开安装 30 分钟')}</b>{t('；超时自动收回，需重新批准。同时给这个应用加上')}<b>{t('每天 60 分钟')}</b>{t('的默认时长限制，可在「应用限制」里调整。')}
                </p>
                <p>{t('· 依赖设备所有者与无障碍权限；两者被关掉就失效。')}</p>
                <p>{t('· 通过 ADB、部分文件管理器或系统商店的旁路安装仍可绕过：这条限制只是提高门槛，不是强制拦截。')}</p>
                <p>{t('· 设备端 Agent 未上报审批请求时，这里一直是空的；空列表不代表审批正常。')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      <FeatureTip id="appAudit" text={t('安卓没有「安装前弹给家长审批」的系统接口，这里处理的是孩子端主动上报的安装请求。')} />

    </div>
  )
}
