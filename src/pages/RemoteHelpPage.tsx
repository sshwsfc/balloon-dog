import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import {
  AppWindow,
  ArrowLeft,
  Bell,
  Camera,
  CornerUpLeft,
  Home,
  Info,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  Search,
  SquareStack,
  type LucideIcon,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { CommandDispatchResult, DeviceApp, RemoteAction } from '@/types'

interface RemoteActionMeta {
  action: RemoteAction
  label: string
  desc: string
  icon: LucideIcon
}

/** 四个系统级动作，「打开应用」单独放在下面（它要选包名） */
const GLOBAL_ACTIONS: RemoteActionMeta[] = [
  { action: 'back', label: '返回', desc: '触发一次系统返回', icon: CornerUpLeft },
  { action: 'home', label: '回桌面', desc: '回到系统桌面', icon: Home },
  { action: 'recents', label: '最近任务', desc: '打开最近任务列表', icon: SquareStack },
  { action: 'notifications', label: '通知栏', desc: '拉下系统通知栏', icon: Bell },
]

export function RemoteHelpPage() {
  const navigate = useNavigate()
  const [busy, setBusy] = useState<string | null>(null)
  const [appsOpen, setAppsOpen] = useState(false)
  const [apps, setApps] = useState<DeviceApp[]>([])
  const [appsLoading, setAppsLoading] = useState(false)
  const [appsError, setAppsError] = useState<string | null>(null)
  const [appQuery, setAppQuery] = useState('')
  const [refreshingApps, setRefreshingApps] = useState(false)

  /** 指令结果一律照实说：noop / warning 都由后端给出，不能一律报成功 */
  const reportResult = useCallback((result: CommandDispatchResult, successText: string) => {
    if (result.noop) {
      toast.info('设备已处于该状态，无需操作')
    } else if (result.warning) {
      toast.warning(result.warning)
    } else {
      toast.success(successText)
    }
  }, [])

  const handleAction = async (action: RemoteAction, label: string) => {
    setBusy(action)
    try {
      const result = await api.remoteAction(action)
      reportResult(result, `已下发「${label}」指令`)
    } catch (error: unknown) {
      toast.error(toUserMessage(error, `下发「${label}」失败`))
    } finally {
      setBusy(null)
    }
  }

  const handleScreenshot = async () => {
    setBusy('screenshot')
    try {
      const result = await api.screenshot()
      reportResult(result, '已下发截图指令，稍后可到「媒体」里查看')
    } catch (error: unknown) {
      toast.error(toUserMessage(error, '下发截图指令失败'))
    } finally {
      setBusy(null)
    }
  }

  const loadApps = useCallback(async () => {
    setAppsLoading(true)
    setAppsError(null)
    try {
      const res = await api.getDeviceApps()
      setApps(res.apps ?? [])
    } catch (error: unknown) {
      const message = toUserMessage(error, '加载设备应用列表失败')
      setAppsError(message)
      toast.error(message)
    } finally {
      setAppsLoading(false)
    }
  }, [])

  // 每次打开弹窗都重新拉一次：应用清单是设备上报的，可能已经变了
  useEffect(() => {
    if (appsOpen) void loadApps()
  }, [appsOpen, loadApps])

  const filteredApps = useMemo(() => {
    const keyword = appQuery.trim().toLowerCase()
    return apps
      // 没有启动入口的应用（系统组件等）无法被 open_app 打开，直接不列出来
      .filter((app) => app.isLaunchable !== false)
      .filter((app) => {
        if (!keyword) return true
        return (
          app.appName.toLowerCase().includes(keyword) || app.packageName.toLowerCase().includes(keyword)
        )
      })
      .sort((a, b) => a.appName.localeCompare(b.appName, 'zh-CN'))
  }, [apps, appQuery])

  const handleOpenApp = async (app: DeviceApp) => {
    setBusy(`open_app:${app.packageName}`)
    try {
      const result = await api.remoteAction('open_app', app.packageName)
      reportResult(result, `已下发「打开 ${app.appName}」指令`)
      setAppsOpen(false)
    } catch (error: unknown) {
      toast.error(toUserMessage(error, `下发「打开 ${app.appName}」失败`))
    } finally {
      setBusy(null)
    }
  }

  const handleRefreshApps = async () => {
    setRefreshingApps(true)
    try {
      const result = await api.refreshDeviceApps()
      reportResult(result, '已通知设备重新上报应用列表，稍后刷新即可看到')
      await loadApps()
    } catch (error: unknown) {
      toast.error(toUserMessage(error, '通知设备刷新应用列表失败'))
    } finally {
      setRefreshingApps(false)
    }
  }

  return (
    <div className="page-shell">
      <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1">远程协助</h1>
      </div>

      {/* ---------------- 先把「这是什么」讲清楚 ---------------- */}
      <div className="px-3 pt-3">
        <div className="flex items-start space-x-2 bg-sky-50 border border-sky-200 rounded-lg p-3">
          <Info className="w-4 h-4 text-sky-600 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-sky-900 leading-relaxed space-y-1">
            <p className="font-medium text-sm">这是「远程操作 + 取屏」，不是实时投屏</p>
            <p>
              <b>不是实时投屏：</b>你看到的是「截取当前画面」按需抓的一张图，不是连续的视频流，
              也没有声音，画面不会自动更新。
            </p>
            <p>
              <b>不是远程控制：</b>你只能让孩子设备执行返回、回桌面、最近任务、拉通知栏和打开指定应用
              这几个系统动作，<b>不能点击屏幕上的任意位置</b>，也不能输入文字。
            </p>
            <p>
              这些动作依赖孩子设备上的无障碍服务，并且需要设备在线。无障碍服务被关掉时设备会直接失败并回报，
              不会假装执行成功。
            </p>
          </div>
        </div>
      </div>

      {/* ---------------- 远程操作 ---------------- */}
      <div className="px-3 pt-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center space-x-2 mb-1">
              <MonitorSmartphone className="w-5 h-5 text-[#07c160]" />
              <h2 className="font-medium text-gray-900">远程操作</h2>
            </div>
            <p className="text-xs text-gray-500 mb-3 leading-relaxed">
              点一下就把指令发给孩子的设备，设备执行后立即生效。
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {GLOBAL_ACTIONS.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void handleAction(item.action, item.label)}
                  className="flex flex-col items-center justify-center py-3 rounded-lg border border-gray-200 bg-white active:bg-gray-50 disabled:opacity-50"
                >
                  {busy === item.action ? (
                    <Loader2 className="w-5 h-5 text-[#07c160] animate-spin" />
                  ) : (
                    <item.icon className="w-5 h-5 text-gray-600" />
                  )}
                  <span className="text-xs text-gray-800 mt-1.5">{item.label}</span>
                  <span className="text-[10px] text-gray-400 mt-0.5 px-1 text-center leading-tight">
                    {item.desc}
                  </span>
                </button>
              ))}
            </div>

            {/* 打开应用：不能猜包名，必须让家长从设备上报的清单里选 */}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => setAppsOpen(true)}
              className="mt-2 w-full flex items-center space-x-3 p-3 rounded-lg border border-gray-200 bg-white active:bg-gray-50 disabled:opacity-50"
            >
              <AppWindow className="w-5 h-5 text-gray-600 flex-shrink-0" />
              <span className="flex-1 text-left">
                <span className="block text-sm text-gray-800">打开应用</span>
                <span className="block text-[10px] text-gray-400 mt-0.5">
                  从孩子设备已安装的应用里选一个，在它上面打开
                </span>
              </span>
              <span className="text-xs text-[#07c160]">选择</span>
            </button>
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 取屏 ---------------- */}
      <div className="px-3 pt-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center space-x-2 mb-1">
              <Camera className="w-5 h-5 text-[#07c160]" />
              <h2 className="font-medium text-gray-900">看看现在是什么画面</h2>
            </div>
            <p className="text-xs text-gray-500 mb-3 leading-relaxed">
              抓取一张孩子设备当前的屏幕截图。这是一张静止的图，不是持续的画面，
              避免频繁点击 —— 每次都会占用设备一次截屏动作。
            </p>
            <Button
              variant="outline"
              className="w-full bg-white"
              disabled={busy !== null}
              onClick={() => void handleScreenshot()}
            >
              {busy === 'screenshot' ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  正在下发…
                </>
              ) : (
                '截取当前画面'
              )}
            </Button>
            <p className="text-[10px] text-gray-400 mt-2 leading-relaxed">
              截图会保存到「媒体」里，和定时截屏、远程拍照放在一起。
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="px-3 mt-4">
        <p className="text-[10px] text-gray-400 leading-relaxed px-1">
          提示：远程操作需要孩子设备端 Agent 在线、且无障碍服务处于开启状态。
          设备离线时指令会排队，设备上线后执行。
        </p>
      </div>

      {/* ---------------- 选择应用 ---------------- */}
      <Dialog open={appsOpen} onOpenChange={setAppsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>打开应用</DialogTitle>
            <DialogDescription>
              下面是孩子设备上报的、可以打开的应用。找不到想要的应用时，可以让设备重新上报。
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center space-x-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={appQuery}
                onChange={(e) => setAppQuery(e.target.value)}
                placeholder="搜索应用名或包名"
                className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
              />
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() => void handleRefreshApps()}
              disabled={refreshingApps}
              aria-label="让设备重新上报应用列表"
            >
              <RefreshCw className={`w-4 h-4 text-gray-400 ${refreshingApps ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          {appsLoading ? (
            <div className="py-10 text-center">
              <Loader2 className="w-6 h-6 text-[#07c160] animate-spin mx-auto" />
              <p className="text-xs text-gray-500 mt-2">正在读取设备应用列表...</p>
            </div>
          ) : appsError ? (
            <div className="py-10 text-center">
              <p className="text-sm text-gray-600">{appsError}</p>
              <Button variant="outline" className="mt-3 bg-white" onClick={() => void loadApps()}>
                重新加载
              </Button>
            </div>
          ) : filteredApps.length === 0 ? (
            <div className="py-8 text-center">
              <AppWindow className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-600">
                {apps.length === 0 ? '设备还没有上报应用列表' : '没有匹配的应用'}
              </p>
              <p className="text-xs text-gray-400 mt-1 leading-relaxed px-2">
                {apps.length === 0
                  ? '设备端 Agent 需要在线并上报过应用清单。点右上角刷新可以通知设备重新上报。'
                  : '换个关键词试试。'}
              </p>
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto -mx-1 px-1 space-y-1">
              {filteredApps.map((app) => (
                <button
                  key={app.packageName}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void handleOpenApp(app)}
                  className="w-full flex items-center space-x-3 p-2.5 rounded-lg border border-gray-100 bg-gray-50 active:bg-gray-100 disabled:opacity-50"
                >
                  <AppWindow className="w-4 h-4 text-gray-500 flex-shrink-0" />
                  <span className="flex-1 min-w-0 text-left">
                    <span className="block text-sm text-gray-800 truncate">{app.appName}</span>
                    <span className="block text-[10px] text-gray-400 truncate">{app.packageName}</span>
                  </span>
                  {app.isSystem && (
                    <Badge className="bg-gray-200 text-gray-600 flex-shrink-0">系统</Badge>
                  )}
                  {busy === `open_app:${app.packageName}` && (
                    <Loader2 className="w-4 h-4 text-[#07c160] animate-spin flex-shrink-0" />
                  )}
                </button>
              ))}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setAppsOpen(false)}>
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
