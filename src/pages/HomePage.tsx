import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import {
  Battery,
  BookOpen,
  Camera,
  Check,
  ChevronRight,
  Clock,
  Eye,
  Image as ImageIcon,
  Loader2,
  Lock,
  MapPin,
  Mic,
  Phone,
  Play,
  RefreshCw,
  Shield,
  Smartphone,
  Video,
  Wifi,
  X,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type {
  CommandDispatchResult,
  Device,
  DeviceCommand,
  Features,
  MediaAsset,
  ToggleState,
} from '@/types'

interface FeatureMeta {
  id: keyof Features | string
  icon: typeof Lock
  name: string
  desc: string
  color: string
  bg: string
}

const basicFeatures: FeatureMeta[] = [
  { id: 'lockScreen', icon: Lock, name: '一键锁屏', desc: '立即锁定设备屏幕', color: 'text-orange-500', bg: 'bg-orange-50' },
  { id: 'tempUnlock', icon: Shield, name: '临时使用', desc: '授权临时使用权限', color: 'text-blue-500', bg: 'bg-blue-50' },
  { id: 'timePlan', icon: Clock, name: '时间规划', desc: '设置使用时间限制', color: 'text-purple-500', bg: 'bg-purple-50' },
  { id: 'appLimit', icon: Smartphone, name: '应用限制', desc: '限制应用使用时长', color: 'text-green-500', bg: 'bg-green-50' },
  { id: 'appAudit', icon: Shield, name: '应用审核', desc: '审核新安装应用', color: 'text-yellow-500', bg: 'bg-yellow-50' },
  { id: 'webBlock', icon: MapPin, name: '网址拦截', desc: '拦截不良网站', color: 'text-red-500', bg: 'bg-red-50' },
]

const advancedFeatures: FeatureMeta[] = [
  { id: 'quizUnlock', icon: BookOpen, name: '答题解锁', desc: '通过答题获得使用时长', color: 'text-amber-500', bg: 'bg-amber-50' },
  { id: 'screenMonitor', icon: Eye, name: '同屏监控', desc: '实时查看屏幕内容', color: 'text-indigo-500', bg: 'bg-indigo-50' },
  { id: 'remoteHelp', icon: Smartphone, name: '远程协助', desc: '远程操作帮助', color: 'text-pink-500', bg: 'bg-pink-50' },
  { id: 'callSms', icon: Phone, name: '电话短信', desc: '查看通话和短信', color: 'text-teal-500', bg: 'bg-teal-50' },
  { id: 'remotePhoto', icon: Camera, name: '远程拍照', desc: '远程拍摄照片', color: 'text-cyan-500', bg: 'bg-cyan-50' },
  { id: 'remoteRecord', icon: Mic, name: '远程录音', desc: '远程录制音频', color: 'text-rose-500', bg: 'bg-rose-50' },
  { id: 'videoRecord', icon: Video, name: '连续录像', desc: '持续视频录制', color: 'text-fuchsia-500', bg: 'bg-fuchsia-50' },
]

/** 指令状态 → 展示文案与配色 */
const COMMAND_STATUS_VIEW: Record<string, { label: string; className: string }> = {
  pending: { label: '等待设备响应', className: 'bg-amber-100 text-amber-700' },
  dispatched: { label: '设备执行中', className: 'bg-blue-100 text-blue-700' },
  succeeded: { label: '已完成', className: 'bg-green-100 text-green-700' },
  failed: { label: '执行失败', className: 'bg-red-100 text-red-700' },
  expired: { label: '已超时', className: 'bg-gray-100 text-gray-600' },
  cancelled: { label: '已撤销', className: 'bg-gray-100 text-gray-600' },
}

function formatCountdown(untilIso: string, now: number): string | null {
  const diff = new Date(untilIso).getTime() - now
  if (diff <= 0) return null
  const totalSeconds = Math.floor(diff / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}小时${minutes}分钟后自动锁定`
  if (minutes > 0) return `${minutes}分${String(seconds).padStart(2, '0')}秒后自动锁定`
  return `${seconds}秒后自动锁定`
}

export function HomePage() {
  const navigate = useNavigate()

  const [device, setDevice] = useState<Device | null>(null)
  const [features, setFeatures] = useState<Features | null>(null)
  const [commands, setCommands] = useState<DeviceCommand[]>([])
  const [media, setMedia] = useState<MediaAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [lockDialogOpen, setLockDialogOpen] = useState(false)
  const [tempUnlockDialogOpen, setTempUnlockDialogOpen] = useState(false)
  const [timePlanDialogOpen, setTimePlanDialogOpen] = useState(false)
  const [appLimitDialogOpen, setAppLimitDialogOpen] = useState(false)
  const [appAuditDialogOpen, setAppAuditDialogOpen] = useState(false)
  const [webBlockDialogOpen, setWebBlockDialogOpen] = useState(false)

  const [tempUnlockMinutes, setTempUnlockMinutes] = useState('')
  const [timePlanLimit, setTimePlanLimit] = useState('')
  const [selectedApp, setSelectedApp] = useState('')
  const [appLimit, setAppLimit] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [busyFeature, setBusyFeature] = useState<string | null>(null)

  /** 倒计时需要一个会走的时钟（原实现读一次就不动了，数字永远不变） */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const loadData = useCallback(async (options?: { silent?: boolean }) => {
      try {
        const [deviceData, featuresData, commandsData, mediaData] = await Promise.all([
          api.getDevice(),
          api.getFeatures(),
          api.getCommands({ limit: 5 }),
          api.getMedia({ limit: 6 }),
        ])
        setDevice(deviceData)
        setFeatures(featuresData)
        setCommands(commandsData.commands ?? [])
        setMedia(mediaData.media ?? [])
        setLoadError(null)
      } catch (error) {
        const message = toUserMessage(error, '加载数据失败，请刷新页面重试')
        setLoadError(message)
        // 首次加载失败才弹 toast；静默刷新失败不打扰用户
        if (!options?.silent) toast.error(message)
      } finally {
        setLoading(false)
      }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  /**
   * 下发类操作的统一包装。
   * 后端是「乐观更新 + 指令队列」：立即返回期望状态，真正的执行结果由设备回报。
   * 所以这里既要把指令状态讲清楚，也要在设备离线时如实提示。
   */
  const dispatch = useCallback(
    async (action: () => Promise<CommandDispatchResult>, successText: string) => {
      try {
        const result = await action()
        if (result.noop) {
          toast.info('设备已处于该状态，无需操作')
        } else if (result.warning) {
          toast.warning(result.warning)
        } else {
          toast.success(successText)
        }
        if (result.device) setDevice(result.device)
        await loadData({ silent: true })
        return true
      } catch (error) {
        toast.error(toUserMessage(error))
        return false
      }
    },
    [loadData],
  )

  const handleLockScreen = async () => {
    if (!device) return
    const target = !device.locked
    const ok = await dispatch(
      () => api.lockScreen(target),
      target ? '锁屏指令已下发' : '解锁指令已下发',
    )
    if (ok) setLockDialogOpen(false)
  }

  const handleTempUnlock = async () => {
    if (!device) return
    if (device.tempUnlock) {
      const ok = await dispatch(() => api.cancelTempUnlock(), '已取消临时解锁')
      if (ok) setTempUnlockDialogOpen(false)
      return
    }
    const minutes = Number.parseInt(tempUnlockMinutes, 10)
    if (!Number.isFinite(minutes) || minutes <= 0) {
      toast.error('请输入有效的时长')
      return
    }
    const ok = await dispatch(() => api.tempUnlock(minutes), `临时解锁指令已下发（${minutes} 分钟）`)
    if (ok) {
      setTempUnlockDialogOpen(false)
      setTempUnlockMinutes('')
    }
  }

  const handleSetTimePlan = async () => {
    const limit = Number.parseInt(timePlanLimit, 10)
    if (!Number.isFinite(limit) || limit <= 0) {
      toast.error('请输入有效的时长')
      return
    }
    try {
      await api.setTimePlan(limit)
      toast.success(`每日使用时长已设为 ${limit} 分钟`)
      setTimePlanDialogOpen(false)
      setTimePlanLimit('')
      await loadData({ silent: true })
    } catch (error) {
      toast.error(toUserMessage(error))
    }
  }

  const handleSetAppLimit = async () => {
    const limit = Number.parseInt(appLimit, 10)
    if (!selectedApp || !Number.isFinite(limit) || limit <= 0) {
      toast.error('请选择应用并输入有效时长')
      return
    }
    try {
      await api.setAppLimit(selectedApp, limit)
      toast.success(`${selectedApp} 的限制已设为 ${limit} 分钟`)
      setAppLimitDialogOpen(false)
      setSelectedApp('')
      setAppLimit('')
      await loadData({ silent: true })
    } catch (error) {
      toast.error(toUserMessage(error))
    }
  }

  const handleAuditApp = async (appName: string, approved: boolean) => {
    try {
      await api.auditApp(appName, approved)
      toast.success(approved ? `已批准 ${appName}` : `已拒绝 ${appName}`)
      await loadData({ silent: true })
    } catch (error) {
      toast.error(toUserMessage(error))
    }
  }

  const handleBlockUrl = async () => {
    if (!newUrl.trim()) {
      toast.error('请输入要拦截的网址')
      return
    }
    try {
      const res = await api.blockUrl(newUrl.trim())
      toast.success(`已拦截 ${res.url}`)
      setNewUrl('')
      await loadData({ silent: true })
    } catch (error) {
      toast.error(toUserMessage(error))
    }
  }

  const handleUnblockUrl = async (url: string) => {
    try {
      await api.unblockUrl(url)
      toast.success(`已取消拦截 ${url}`)
      await loadData({ silent: true })
    } catch (error) {
      toast.error(toUserMessage(error))
    }
  }

  /** 开关类功能的统一切换（关键：调用方必须阻止事件冒泡，否则会同时触发行点击动作） */
  const handleToggleFeature = async (featureId: string) => {
    if (!features) return
    const current = (features as unknown as Record<string, ToggleState | undefined>)[featureId]
    if (!current || typeof current.enabled !== 'boolean') {
      toast.error('该功能不支持开关')
      return
    }
    setBusyFeature(featureId)
    try {
      await api.enableFeature(featureId, !current.enabled)
      toast.success(!current.enabled ? '功能已开启' : '功能已关闭')
      await loadData({ silent: true })
    } catch (error) {
      toast.error(toUserMessage(error))
    } finally {
      setBusyFeature(null)
    }
  }

  const handleTakePhoto = async () => {
    await dispatch(() => api.takePhoto(), '拍照指令已下发，稍后可在「设备照片」中查看')
  }

  const handleRecording = async (kind: 'video' | 'audio') => {
    const isVideo = kind === 'video'
    // 找出该设备上最近一条成功的「开始录制」指令，用它的 recordingId 去停止
    const history = await api.getCommands({ limit: 20 }).catch(() => ({ commands: [] as DeviceCommand[] }))
    const active = history.commands.find(
      (c) =>
        c.type === (isVideo ? 'start_recording' : 'start_audio') && c.status === 'succeeded',
    )
    const stopId = (active?.result as { recordingId?: string } | null)?.recordingId

    if (stopId) {
      await dispatch(
        () => (isVideo ? api.stopRecording(stopId) : api.stopAudioRecording(stopId)),
        isVideo ? '已下发停止录像' : '已下发停止录音',
      )
    } else {
      await dispatch(
        () => (isVideo ? api.startRecording() : api.startAudioRecording()),
        isVideo ? '已下发开始录像' : '已下发开始录音',
      )
    }
  }

  const handleAdvancedAction = (featureId: string) => {
    switch (featureId) {
      case 'quizUnlock':
        navigate('/quiz-unlock')
        break
      case 'remotePhoto':
        void handleTakePhoto()
        break
      case 'screenMonitor':
        void dispatch(() => api.screenshot(), '截图指令已下发')
        break
      case 'videoRecord':
        void handleRecording('video')
        break
      case 'remoteRecord':
        void handleRecording('audio')
        break
      case 'remoteHelp':
      case 'callSms':
        toast.info('该能力需要孩子设备端 Agent 在线，已记录请求')
        break
      default:
        break
    }
  }

  const tempUnlockLabel = useMemo(() => {
    if (!device?.tempUnlock) return null
    return formatCountdown(device.tempUnlock, now)
  }, [device?.tempUnlock, now])

  if (loading) {
    return (
      <div className="min-h-screen pb-20 bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]" />
          <p className="mt-2 text-gray-500 text-sm">加载中...</p>
        </div>
      </div>
    )
  }

  // 加载失败时给出可操作的错误态，而不是继续渲染 null 导致白屏
  if (!device || !features) {
    return (
      <div className="min-h-screen pb-20 bg-gray-100 flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <Smartphone className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-700 font-medium">暂时拿不到设备信息</p>
          <p className="text-sm text-gray-500 mt-2">{loadError ?? '请稍后重试'}</p>
          <div className="flex gap-2 mt-4">
            <Button
              className="flex-1 bg-[#07c160] hover:bg-[#06a050]"
              onClick={() => {
                setLoading(true)
                void loadData()
              }}
            >
              <RefreshCw className="w-4 h-4 mr-1" />
              重新加载
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => navigate('/devices')}>
              去绑定设备
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen pb-20 bg-gray-100">
      <div className="bg-white px-4 py-4 border-b border-gray-200 flex items-center justify-between">
        <h1 className="text-xl font-medium text-gray-900">设备监控</h1>
        <button
          type="button"
          onClick={() => void loadData({ silent: true })}
          className="text-gray-400 p-1"
          aria-label="刷新"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      {/* 设备概览 */}
      <div className="px-3 py-3">
        <Card className="overflow-hidden">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="w-14 h-14 bg-gradient-to-br from-green-400 to-green-600 rounded-xl flex items-center justify-center">
                <Smartphone className="w-7 h-7 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900 text-base truncate">{device.name}</div>
                <div className="text-xs text-gray-400 mt-0.5 truncate">
                  {device.model} · {device.os}
                </div>
              </div>
              <Badge
                className={
                  device.status === 'offline'
                    ? 'bg-gray-400 text-white'
                    : device.locked
                      ? 'bg-red-500 text-white'
                      : 'bg-[#07c160] text-white'
                }
              >
                {device.status === 'offline' ? '离线' : device.locked ? '已锁定' : '在线'}
              </Badge>
            </div>

            <div className="flex items-center justify-around mt-4 pt-4 border-t border-gray-100">
              <div className="flex items-center space-x-1.5">
                <Battery className="w-4 h-4 text-gray-500" />
                <span className="text-xs text-gray-500">{device.battery}%</span>
              </div>
              <div className="flex items-center space-x-1.5">
                <Wifi className="w-4 h-4 text-gray-500" />
                <span className="text-xs text-gray-500">{device.network || '未知网络'}</span>
              </div>
              <div className="text-xs text-gray-400">{device.lastActive}</div>
            </div>

            {tempUnlockLabel && (
              <div className="mt-3 bg-green-50 text-green-700 text-xs rounded-lg px-3 py-2 text-center">
                临时解锁中 · {tempUnlockLabel}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 基础功能 */}
      <div className="px-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">基础功能</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {basicFeatures.map((feature, index) => {
              const Icon = feature.icon
              const status =
                feature.id === 'lockScreen'
                  ? device.locked
                    ? '设备已锁定'
                    : '设备正常使用'
                  : feature.id === 'tempUnlock'
                    ? (tempUnlockLabel ?? '设备正常锁定')
                    : feature.id === 'timePlan'
                      ? `今日已使用 ${features.timePlan.usedToday} 分钟${
                          features.timePlan.dailyLimit > 0 ? `，限制 ${features.timePlan.dailyLimit} 分钟` : '，未设置限制'
                        }`
                      : feature.desc

              const onClick = () => {
                if (feature.id === 'lockScreen') setLockDialogOpen(true)
                else if (feature.id === 'tempUnlock') setTempUnlockDialogOpen(true)
                else if (feature.id === 'timePlan') setTimePlanDialogOpen(true)
                else if (feature.id === 'appLimit') setAppLimitDialogOpen(true)
                else if (feature.id === 'appAudit') setAppAuditDialogOpen(true)
                else if (feature.id === 'webBlock') setWebBlockDialogOpen(true)
              }

              return (
                <div key={feature.id}>
                  <button
                    type="button"
                    onClick={onClick}
                    className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
                  >
                    <div className="flex items-center space-x-3 flex-1 min-w-0">
                      <div className={`w-10 h-10 rounded-lg ${feature.bg} flex items-center justify-center flex-shrink-0`}>
                        <Icon className={`w-5 h-5 ${feature.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-900">{feature.name}</div>
                        <div className="text-xs text-gray-400 mt-0.5 truncate">{status}</div>
                      </div>
                    </div>
                    <ChevronRight className="w-5 h-5 text-gray-300 flex-shrink-0 ml-2" />
                  </button>
                  {index < basicFeatures.length - 1 && <div className="mx-4 border-t border-gray-100" />}
                </div>
              )
            })}
          </CardContent>
        </Card>
      </div>

      {/* 高级功能 */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">高级功能</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {advancedFeatures.map((feature, index) => {
              const Icon = feature.icon
              const state = (features as unknown as Record<string, ToggleState | undefined>)[feature.id]
              const enabled = state?.enabled ?? false
              const busy = busyFeature === feature.id

              return (
                <div key={feature.id}>
                  <div className="flex items-center py-3 px-4 hover:bg-gray-50 transition-colors">
                    {/*
                      行主体负责「执行动作」，右侧开关负责「启用功能」。
                      两者是独立按钮，不再像原实现那样把 onClick 嵌套在可点击 div 里
                      （那会导致事件冒泡，一次点击发两次请求 / 同时触发两个完全不同的动作）。
                    */}
                    <button
                      type="button"
                      onClick={() => handleAdvancedAction(feature.id)}
                      className="flex items-center space-x-3 flex-1 min-w-0 text-left"
                    >
                      <div className={`w-10 h-10 rounded-lg ${feature.bg} flex items-center justify-center flex-shrink-0`}>
                        {feature.id === 'videoRecord' || feature.id === 'remoteRecord' ? (
                          <Play className={`w-5 h-5 ${feature.color}`} />
                        ) : (
                          <Icon className={`w-5 h-5 ${feature.color}`} />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-900">{feature.name}</div>
                        <div className="text-xs text-gray-400 mt-0.5 truncate">
                          {enabled ? feature.desc : '未开启'}
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={`${feature.name}开关`}
                      disabled={busy}
                      onClick={() => void handleToggleFeature(feature.id)}
                      className="w-11 h-6 rounded-full relative flex-shrink-0 ml-2 disabled:opacity-50"
                    >
                      <span
                        className={`absolute w-5 h-5 rounded-full top-0.5 bg-white shadow transition-all ${
                          enabled ? 'right-0.5' : 'left-0.5'
                        }`}
                      />
                      <span className={`block w-full h-full rounded-full ${enabled ? 'bg-[#07c160]' : 'bg-gray-300'}`} />
                      {busy && (
                        <Loader2 className="w-3 h-3 absolute inset-0 m-auto animate-spin text-white mix-blend-difference" />
                      )}
                    </button>
                  </div>
                  {index < advancedFeatures.length - 1 && <div className="mx-4 border-t border-gray-100" />}
                </div>
              )
            })}
          </CardContent>
        </Card>
      </div>

      {/* 最近指令：让家长看到「指令下发」之后的真实执行情况 */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">最近指令</span>
          <span className="text-xs text-gray-400">由孩子设备执行并回报</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {commands.length === 0 ? (
              <p className="text-center text-sm text-gray-400 py-6">还没有下发过指令</p>
            ) : (
              commands.map((command, index) => {
                const view = COMMAND_STATUS_VIEW[command.status] ?? {
                  label: command.status,
                  className: 'bg-gray-100 text-gray-600',
                }
                return (
                  <div key={command.id}>
                    <div className="flex items-center justify-between py-3 px-4">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-gray-900">{command.label}</div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {new Date(command.createdAt).toLocaleString('zh-CN')}
                          {command.error ? ` · ${command.error}` : ''}
                        </div>
                      </div>
                      <Badge className={view.className}>{view.label}</Badge>
                    </div>
                    {index < commands.length - 1 && <div className="mx-4 border-t border-gray-100" />}
                  </div>
                )
              })
            )}
          </CardContent>
        </Card>
      </div>

      {/* 最近媒体 */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">设备照片</span>
          <Link to="/media" className="text-xs text-[#07c160]">
            查看全部
          </Link>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-3">
            {media.length === 0 ? (
              <div className="text-center py-4">
                <ImageIcon className="w-8 h-8 text-gray-300 mx-auto mb-1" />
                <p className="text-xs text-gray-400">暂无照片，点击「远程拍照」试试</p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {media.map((item) => (
                  <Link key={item.id} to="/media" className="block">
                    <div className="aspect-square rounded-lg bg-gray-100 overflow-hidden">
                      {item.mimeType.startsWith('image/') ? (
                        <img src={item.url} alt={item.kind} className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          {item.kind === 'audio' ? (
                            <Mic className="w-5 h-5 text-gray-400" />
                          ) : (
                            <Video className="w-5 h-5 text-gray-400" />
                          )}
                        </div>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 锁屏 ---------------- */}
      <Dialog open={lockDialogOpen} onOpenChange={setLockDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{device.locked ? '解锁设备' : '锁定设备'}</DialogTitle>
          </DialogHeader>
          <p className="text-gray-600">
            {device.locked
              ? '确定要解锁设备吗？解锁后孩子可以正常使用手机。'
              : '确定要锁定设备吗？锁定后孩子将无法使用手机。'}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLockDialogOpen(false)}>
              取消
            </Button>
            <Button className="bg-[#07c160] hover:bg-[#06a050]" onClick={() => void handleLockScreen()}>
              {device.locked ? '解锁' : '锁定'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- 临时使用 ---------------- */}
      <Dialog open={tempUnlockDialogOpen} onOpenChange={setTempUnlockDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{device.tempUnlock ? '取消临时解锁' : '临时使用'}</DialogTitle>
          </DialogHeader>
          {device.tempUnlock ? (
            <div>
              <p className="text-gray-600 mb-4">设备当前处于临时解锁状态：</p>
              <div className="bg-green-50 text-green-700 p-3 rounded-lg">
                <p className="font-medium">{tempUnlockLabel ?? '即将到期'}</p>
              </div>
              <p className="text-gray-500 text-sm mt-4">取消后设备将立即恢复锁定</p>
            </div>
          ) : (
            <div>
              <p className="text-gray-600 mb-4">选择临时解锁时长：</p>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {[5, 15, 30, 60, 120, 180].map((min) => (
                  <Button
                    key={min}
                    variant="outline"
                    onClick={() => setTempUnlockMinutes(String(min))}
                    className={tempUnlockMinutes === String(min) ? 'border-[#07c160] text-[#07c160]' : ''}
                  >
                    {min}分钟
                  </Button>
                ))}
              </div>
              <div className="flex items-center space-x-2">
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={tempUnlockMinutes}
                  onChange={(e) => setTempUnlockMinutes(e.target.value)}
                  placeholder="输入分钟数"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
                />
                <span className="text-gray-500 text-sm">分钟</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTempUnlockDialogOpen(false)}>
              取消
            </Button>
            <Button className="bg-[#07c160] hover:bg-[#06a050]" onClick={() => void handleTempUnlock()}>
              {device.tempUnlock ? '取消解锁' : '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- 时间规划 ---------------- */}
      <Dialog open={timePlanDialogOpen} onOpenChange={setTimePlanDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>时间规划</DialogTitle>
          </DialogHeader>
          <p className="text-gray-600 mb-4">设置每日使用时长上限（分钟）：</p>
          <div className="grid grid-cols-3 gap-2 mb-4">
            {[60, 120, 180, 240, 300, 360].map((min) => (
              <Button
                key={min}
                variant="outline"
                onClick={() => setTimePlanLimit(String(min))}
                className={timePlanLimit === String(min) ? 'border-[#07c160] text-[#07c160]' : ''}
              >
                {min}分钟
              </Button>
            ))}
          </div>
          <div className="flex items-center space-x-2">
            <input
              type="number"
              min={1}
              value={timePlanLimit}
              onChange={(e) => setTimePlanLimit(e.target.value)}
              placeholder="输入分钟数"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
            />
            <span className="text-gray-500 text-sm">分钟</span>
          </div>
          <p className="text-xs text-gray-500 mt-4">
            当前设置：{features.timePlan.dailyLimit > 0 ? `${features.timePlan.dailyLimit} 分钟/天` : '未设置'}
            ，今日已用 {features.timePlan.usedToday} 分钟
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTimePlanDialogOpen(false)}>
              取消
            </Button>
            <Button className="bg-[#07c160] hover:bg-[#06a050]" onClick={() => void handleSetTimePlan()}>
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- 应用限制 ---------------- */}
      <Dialog open={appLimitDialogOpen} onOpenChange={setAppLimitDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>应用限制</DialogTitle>
          </DialogHeader>
          <p className="text-gray-600 mb-4">选择应用并设置每日时长限制：</p>
          {Object.keys(features.appLimit.apps).length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">
              还没有可限制的应用。孩子在设备上安装应用后会自动出现在这里。
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 mb-4">
              {Object.entries(features.appLimit.apps).map(([app, limit]) => (
                <Button
                  key={app}
                  variant="outline"
                  onClick={() => setSelectedApp(app)}
                  className={selectedApp === app ? 'border-[#07c160] text-[#07c160]' : ''}
                >
                  {app}
                  <span className="text-xs text-gray-400 ml-1">{limit}分</span>
                </Button>
              ))}
            </div>
          )}
          {selectedApp && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">为 {selectedApp} 设置时长限制（分钟）：</p>
              <div className="grid grid-cols-4 gap-2">
                {[15, 30, 60, 120].map((min) => (
                  <Button
                    key={min}
                    variant="outline"
                    onClick={() => setAppLimit(String(min))}
                    className={appLimit === String(min) ? 'border-[#07c160] text-[#07c160]' : ''}
                  >
                    {min}
                  </Button>
                ))}
              </div>
              <input
                type="number"
                min={1}
                value={appLimit}
                onChange={(e) => setAppLimit(e.target.value)}
                placeholder="输入分钟数"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAppLimitDialogOpen(false)}>
              取消
            </Button>
            <Button
              className="bg-[#07c160] hover:bg-[#06a050]"
              onClick={() => void handleSetAppLimit()}
              disabled={!selectedApp}
            >
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- 应用审核 ---------------- */}
      <Dialog open={appAuditDialogOpen} onOpenChange={setAppAuditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>应用审核</DialogTitle>
          </DialogHeader>
          {features.appAudit.pendingApps.length > 0 ? (
            <div className="space-y-3">
              <p className="text-gray-600">以下应用等待审核：</p>
              {features.appAudit.pendingApps.map((app) => (
                <div key={app} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <span className="font-medium text-sm">{app}</span>
                  <div className="flex space-x-2">
                    <Button size="sm" variant="outline" onClick={() => void handleAuditApp(app, false)}>
                      <X className="w-4 h-4" />
                    </Button>
                    <Button
                      size="sm"
                      className="bg-[#07c160] hover:bg-[#06a050]"
                      onClick={() => void handleAuditApp(app, true)}
                    >
                      <Check className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-600 text-center py-4">暂无待审核的应用</p>
          )}
          <DialogFooter>
            <Button onClick={() => setAppAuditDialogOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- 网址拦截 ---------------- */}
      <Dialog open={webBlockDialogOpen} onOpenChange={setWebBlockDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>网址拦截</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="text-gray-600 mb-2">添加要拦截的网址：</p>
              <input
                type="text"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="输入域名，例如 gambling.com"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
              />
              <Button className="w-full mt-2 bg-[#07c160] hover:bg-[#06a050]" onClick={() => void handleBlockUrl()}>
                添加
              </Button>
            </div>
            {features.webBlock.blockedUrls.length > 0 && (
              <div>
                <p className="text-gray-600 mb-2">已拦截的网址：</p>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {features.webBlock.blockedUrls.map((url) => (
                    <div key={url} className="flex items-center justify-between p-2 bg-gray-50 rounded text-sm">
                      <span className="text-gray-700 truncate">{url}</span>
                      {/* 原实现这里只是个装饰性图标，点不了；现在真的能取消拦截 */}
                      <button
                        type="button"
                        onClick={() => void handleUnblockUrl(url)}
                        className="text-gray-400 hover:text-red-500 p-1"
                        aria-label={`取消拦截 ${url}`}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setWebBlockDialogOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
