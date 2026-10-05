import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToggleSwitch } from '@/components/ToggleSwitch'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Ban,
  Battery,
  BookOpen,
  CalendarClock,
  Camera,
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Download,
  Eye,
  EyeOff,
  Globe,
  Headphones,
  Image as ImageIcon,
  Info,
  Loader2,
  Lock,
  MapPin,
  MessageCircle,
  MessageSquare,
  Mic,
  Monitor,
  Moon,
  Phone,
  Puzzle,
  RefreshCw,
  Repeat,
  ScreenShare,
  Settings,
  Shield,
  Smartphone,
  Trash2,
  Unlock,
  Users,
  Video,
  Wifi,
  X,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type {
  AppLimitEntry,
  CommandDispatchResult,
  Device,
  DeviceApp,
  DeviceCommand,
  DeviceEvent,
  Features,
  Insight,
  MediaAsset,
  ToggleState,
} from '@/types'

/**
 * 首页功能格。
 *
 * 这里刻意只放**有真实接口**的入口：没有后端能力的东西要么不放，
 * 要么在点击时如实说明「当前版本尚未实现」，不做假的成功反馈。
 */
interface GridTile {
  id: string
  icon: typeof Lock
  name: string
  color: string
  bg: string
  /** 当前版本没有对应接口，点击只给诚实提示 */
  unsupported?: boolean
}

const TILE_GROUPS: { title: string; tiles: GridTile[] }[] = [
  {
    title: '设备和应用限制',
    tiles: [
      { id: 'mode', icon: Repeat, name: '模式切换', color: 'text-[#07c160]', bg: 'bg-green-50' },
      { id: 'eyeCare', icon: Eye, name: '护眼设置', color: 'text-cyan-500', bg: 'bg-cyan-50' },
      { id: 'timePlan', icon: Clock, name: '屏幕时间', color: 'text-purple-500', bg: 'bg-purple-50' },
      { id: 'appLimit', icon: Smartphone, name: '应用限制', color: 'text-green-500', bg: 'bg-green-50' },
      { id: 'appAudit', icon: Shield, name: '应用审核', color: 'text-yellow-500', bg: 'bg-yellow-50' },
      { id: 'webBlock', icon: Globe, name: '网址拦截', color: 'text-red-500', bg: 'bg-red-50' },
      { id: 'schedule', icon: CalendarClock, name: '定时锁屏', color: 'text-teal-500', bg: 'bg-teal-50' },
      { id: 'lock', icon: Lock, name: '一键锁屏', color: 'text-orange-500', bg: 'bg-orange-50' },
      { id: 'tempUnlock', icon: Unlock, name: '临时可用', color: 'text-blue-500', bg: 'bg-blue-50' },
    ],
  },
  {
    title: '应用管控',
    tiles: [
      { id: 'wechat', icon: MessageCircle, name: '微信管控', color: 'text-green-600', bg: 'bg-green-50' },
      { id: 'qq', icon: MessageSquare, name: 'QQ 管控', color: 'text-blue-500', bg: 'bg-blue-50' },
      { id: 'plugins', icon: Puzzle, name: '功能管控', color: 'text-violet-500', bg: 'bg-violet-50' },
      { id: 'appApproval', icon: ClipboardCheck, name: '应用审批', color: 'text-amber-500', bg: 'bg-amber-50' },
    ],
  },
  {
    title: '远程监控',
    tiles: [
      // 项目没有实时同屏能力（只有周期截屏 + AI 分析），所以这个格子叫「屏幕洞察」，
      // 不再叫「同屏监控」—— 那个名字会让人以为能看到实时画面。
      { id: 'insights', icon: Monitor, name: '屏幕洞察', color: 'text-indigo-500', bg: 'bg-indigo-50' },
      { id: 'photo', icon: Camera, name: '远程拍照', color: 'text-cyan-500', bg: 'bg-cyan-50' },
      { id: 'videoRecord', icon: Video, name: '连续录像', color: 'text-fuchsia-500', bg: 'bg-fuchsia-50' },
      { id: 'audioRecord', icon: Mic, name: '远程录音', color: 'text-rose-500', bg: 'bg-rose-50' },
      { id: 'screenshot', icon: ImageIcon, name: '截图', color: 'text-sky-500', bg: 'bg-sky-50' },
      { id: 'location', icon: MapPin, name: '定位', color: 'text-emerald-500', bg: 'bg-emerald-50' },
      { id: 'remoteHelp', icon: ScreenShare, name: '远程协助', color: 'text-pink-500', bg: 'bg-pink-50' },
      { id: 'callSms', icon: Phone, name: '通话短信', color: 'text-teal-500', bg: 'bg-teal-50' },
    ],
  },
  {
    title: '孩子管理',
    tiles: [
      { id: 'devices', icon: Settings, name: '孩子设置', color: 'text-gray-600', bg: 'bg-gray-100' },
      { id: 'family', icon: Users, name: '家庭成员', color: 'text-gray-400', bg: 'bg-gray-100', unsupported: true },
      { id: 'hideIcon', icon: EyeOff, name: '隐藏图标', color: 'text-slate-500', bg: 'bg-slate-100' },
    ],
  },
]

/** 设备事件类型 → 图标与配色。未知类型按灰色圆点兜底展示，不假装认识它。 */
const EVENT_META: Record<string, { icon: typeof Lock; className: string }> = {
  unlock: { icon: Unlock, className: 'text-green-500' },
  lock: { icon: Lock, className: 'text-red-500' },
  screen_on: { icon: Eye, className: 'text-blue-500' },
  screen_off: { icon: Moon, className: 'text-gray-400' },
  app_installed: { icon: Download, className: 'text-cyan-500' },
  app_removed: { icon: Trash2, className: 'text-orange-500' },
  mode_enter: { icon: Repeat, className: 'text-[#07c160]' },
  eye_rest: { icon: Eye, className: 'text-cyan-600' },
  plugin_blocked: { icon: Shield, className: 'text-violet-500' },
  app_blocked: { icon: Ban, className: 'text-red-500' },
}

interface FeatureMeta {
  id: string
  icon: typeof Lock
  name: string
  desc: string
  color: string
  bg: string
}

/**
 * 纯开关类功能。
 *
 * 九宫格负责「执行动作」，这里负责「启用/停用能力」，两者是同一功能的不同维度，
 * 不能合并成一个按钮（原实现把开关和动作套在同一个可点击区域里，一次点击发两次请求）。
 */
const toggleFeatures: FeatureMeta[] = [
  { id: 'quizUnlock', icon: BookOpen, name: '答题解锁', desc: '通过答题获得使用时长', color: 'text-amber-500', bg: 'bg-amber-50' },
  { id: 'screenMonitor', icon: Eye, name: '屏幕洞察', desc: '周期截屏并交给 AI 分析', color: 'text-indigo-500', bg: 'bg-indigo-50' },
  { id: 'modeSwitch', icon: Repeat, name: '模式切换', desc: '学习模式 / 普通模式', color: 'text-[#07c160]', bg: 'bg-green-50' },
  { id: 'eyeCare', icon: Eye, name: '护眼设置', desc: '连续用眼提醒与强制休息', color: 'text-cyan-500', bg: 'bg-cyan-50' },
  { id: 'appPlugin', icon: Puzzle, name: '功能管控', desc: '按应用关闭具体功能', color: 'text-violet-500', bg: 'bg-violet-50' },
  { id: 'remotePhoto', icon: Camera, name: '远程拍照', desc: '远程拍摄照片', color: 'text-cyan-500', bg: 'bg-cyan-50' },
  { id: 'remoteRecord', icon: Mic, name: '远程录音', desc: '远程录制音频', color: 'text-rose-500', bg: 'bg-rose-50' },
  { id: 'videoRecord', icon: Video, name: '连续录像', desc: '持续视频录制', color: 'text-fuchsia-500', bg: 'bg-fuchsia-50' },
  { id: 'remoteHelp', icon: Smartphone, name: '远程协助', desc: '远程操作帮助', color: 'text-pink-500', bg: 'bg-pink-50' },
  { id: 'callSms', icon: MessageCircle, name: '电话短信', desc: '查看通话和短信', color: 'text-teal-500', bg: 'bg-teal-50' },
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

function padTwo(value: number): string {
  return String(value).padStart(2, '0')
}

/** 「1 小时 35 分」这类中文时长；不再显示成裸分钟数 */
function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 分钟'
  const hours = Math.floor(minutes / 60)
  const rest = Math.round(minutes % 60)
  if (hours > 0 && rest > 0) return `${hours} 小时 ${rest} 分`
  if (hours > 0) return `${hours} 小时`
  return `${rest} 分钟`
}

function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--'
  return `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`
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
  /** null = 读取失败（与「确实没有动态」区分开，避免把加载失败说成没有动静） */
  const [events, setEvents] = useState<DeviceEvent[] | null>([])
  const [insights, setInsights] = useState<Insight[] | null>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [lockDialogOpen, setLockDialogOpen] = useState(false)
  const [tempUnlockDialogOpen, setTempUnlockDialogOpen] = useState(false)
  const [timePlanDialogOpen, setTimePlanDialogOpen] = useState(false)
  const [appLimitDialogOpen, setAppLimitDialogOpen] = useState(false)
  const [appAuditDialogOpen, setAppAuditDialogOpen] = useState(false)
  const [webBlockDialogOpen, setWebBlockDialogOpen] = useState(false)
  const [hideIconDialogOpen, setHideIconDialogOpen] = useState(false)

  const [tempUnlockMinutes, setTempUnlockMinutes] = useState('')
  const [timePlanLimit, setTimePlanLimit] = useState('')
  /** 选中的应用**包名**：设备端按包名匹配前台窗口，展示名只是给人看的 */
  const [selectedPackage, setSelectedPackage] = useState('')
  const [selectedApp, setSelectedApp] = useState('')
  const [appLimit, setAppLimit] = useState('')
  /** 孩子设备上报的应用清单（家长从这里选应用才能拿到真实包名） */
  const [deviceApps, setDeviceApps] = useState<DeviceApp[]>([])
  const [deviceAppsLoading, setDeviceAppsLoading] = useState(false)
  const [deviceAppsError, setDeviceAppsError] = useState<string | null>(null)
  const [newUrl, setNewUrl] = useState('')
  const [busyFeature, setBusyFeature] = useState<string | null>(null)
  /** 通栏锁屏按钮自己的忙碌态：它是最重要的按钮，不能和别处共用 busyFeature */
  const [lockingBusy, setLockingBusy] = useState(false)
  /** 九宫格里正在执行的动作（拍照 / 录像 / 截图…），用于逐格转圈 */
  const [busyTile, setBusyTile] = useState<string | null>(null)
  /** 环境监听指令（开始 / 停止）的忙碌态 */
  const [ambientBusy, setAmbientBusy] = useState<'start' | 'stop' | null>(null)
  /** 隐藏图标写的是设备字段而不是功能开关，所以单独一个忙碌态 */
  const [hideIconBusy, setHideIconBusy] = useState(false)

  /** 倒计时需要一个会走的时钟（原实现读一次就不动了，数字永远不变） */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const loadData = useCallback(async (options?: { silent?: boolean }) => {
    try {
      const [deviceData, featuresData, commandsData, mediaData, eventsData, insightsData] = await Promise.all([
        api.getDevice(),
        api.getFeatures(),
        api.getCommands({ limit: 5 }),
        api.getMedia({ limit: 6 }),
        // 动态与洞察是「附加信息」，它们失败不该把整页变成错误页
        api.getDeviceEvents({ pageSize: 20 }).catch(() => null),
        api.getInsights({ limit: 10 }).catch(() => null),
      ])
      setDevice(deviceData)
      setFeatures(featuresData)
      setCommands(commandsData.commands ?? [])
      setMedia(mediaData.media ?? [])
      setEvents(eventsData ? eventsData.items ?? [] : null)
      setInsights(insightsData ? insightsData.items ?? [] : null)
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
   * 拉孩子设备上报的应用清单。
   *
   * 逐应用限时必须带真实包名 —— 这是唯一能保证「设了就会生效」的来源。
   * 必须传 `includeSystem: true`：孩子真正会沉迷的应用（时钟、YouTube、浏览器…）
   * 基本都是系统应用，默认（不传）清单里只剩气球狗自己。
   */
  const loadDeviceApps = useCallback(async () => {
    setDeviceAppsLoading(true)
    try {
      const data = await api.getDeviceApps({ includeSystem: true })
      setDeviceApps(data.apps ?? [])
      setDeviceAppsError(null)
    } catch (error) {
      setDeviceAppsError(toUserMessage(error, '读取设备应用清单失败'))
    } finally {
      setDeviceAppsLoading(false)
    }
  }, [])

  const handleOpenAppLimitDialog = () => {
    setAppLimitDialogOpen(true)
    setDeviceAppsError(null)
    void loadDeviceApps()
  }

  /** 让设备重新上报清单（走指令队列）。设备离线时不会有即时结果，别承诺「马上出现」。 */
  const handleRefreshDeviceApps = async () => {
    try {
      await api.refreshDeviceApps()
      toast.success('已请求设备同步应用清单，设备在线时几秒后刷新')
    } catch (error) {
      toast.error(toUserMessage(error))
    }
    await loadDeviceApps()
  }

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
    setLockingBusy(true)
    const ok = await dispatch(
      () => api.lockScreen(target),
      target ? '锁屏指令已下发' : '解锁指令已下发',
    )
    setLockingBusy(false)
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
    if (!selectedPackage || !Number.isFinite(limit) || limit <= 0) {
      toast.error('请选择应用并输入有效时长')
      return
    }
    try {
      await api.setAppLimit(selectedApp || selectedPackage, selectedPackage, limit)
      toast.success(`${selectedApp || selectedPackage} 的限制已设为 ${limit} 分钟`)
      setAppLimitDialogOpen(false)
      setSelectedPackage('')
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

  /**
   * 环境监听（contract §6）。
   *
   * 和「远程录音」不是同一件事：`start_ambient` 是让设备**持续分段**录（每段 5 分钟），
   * 归在功能开关 `audioRecord` 下。设备端录音期间会挂常驻通知，不做隐蔽录音 ——
   * 这一点必须在界面上说出来，不能只放在文档里。
   */
  const handleAmbient = async (mode: 'start' | 'stop') => {
    setAmbientBusy(mode)
    try {
      await dispatch(
        () => (mode === 'start' ? api.startAmbient() : api.stopAmbient()),
        mode === 'start' ? '已下发开始环境监听' : '已下发停止环境监听',
      )
    } finally {
      setAmbientBusy(null)
    }
  }

  /**
   * 隐藏 / 恢复孩子设备上的客户端图标（contract §9）。
   *
   * 注意它写的是设备字段（`ChildDevice.hideIcon`），不是功能开关：
   * `/api/features` 只认白名单里的功能标识，`hideIcon` 会被判为未知标识拒绝。
   */
  const handleToggleHideIcon = async () => {
    if (!device) return
    const next = !device.hideIcon
    setHideIconBusy(true)
    try {
      const res = await api.updateDevice(device.id, { hideIcon: next })
      toast.success(next ? '已下发隐藏图标' : '已下发恢复图标')
      if (res.device) setDevice(res.device)
      await loadData({ silent: true })
    } catch (error: unknown) {
      toast.error(toUserMessage(error, next ? '隐藏图标失败' : '恢复图标失败'))
    } finally {
      setHideIconBusy(false)
    }
  }

  /**
   * 九宫格动作分发。
   *
   * 没有对应接口的能力（家庭成员 / 隐藏图标）在这里如实说明「尚未实现」，
   * 而不是弹一个假的成功提示 —— 家长会按提示去做别的操作，错误反馈代价更高。
   */
  const handleTileAction = async (tile: GridTile) => {
    switch (tile.id) {
      case 'mode':
        navigate('/mode')
        return
      case 'eyeCare':
        navigate('/eye-care')
        return
      case 'timePlan':
        setTimePlanDialogOpen(true)
        return
      case 'appLimit':
        handleOpenAppLimitDialog()
        return
      case 'appAudit':
        setAppAuditDialogOpen(true)
        return
      case 'webBlock':
        setWebBlockDialogOpen(true)
        return
      case 'schedule':
        navigate('/schedule')
        return
      case 'lock':
        setLockDialogOpen(true)
        return
      case 'tempUnlock':
        setTempUnlockDialogOpen(true)
        return
      case 'wechat':
        navigate('/app-plugins/com.tencent.mm')
        return
      case 'qq':
        navigate('/app-plugins/com.tencent.mobileqq')
        return
      case 'plugins':
        navigate('/app-plugins')
        return
      case 'appApproval':
        navigate('/app-audit')
        return
      case 'insights':
        // 项目没有实时同屏能力，只有周期截屏 + AI 分析，所以进洞察页而不是假装「同屏」
        navigate('/insights')
        return
      case 'remoteHelp':
        navigate('/remote-help')
        return
      case 'callSms':
        navigate('/call-sms')
        return
      case 'location':
        navigate('/location')
        return
      case 'devices':
        navigate('/devices')
        return
      case 'hideIcon':
        setHideIconDialogOpen(true)
        return
      case 'family':
        // 家庭成员是「多个家长互相可见」的产品概念，后端没有这套模型
        toast.info('该能力需要孩子设备端 Agent 支持，当前版本尚未实现')
        return
      case 'photo':
      case 'videoRecord':
      case 'audioRecord':
      case 'screenshot': {
        setBusyTile(tile.id)
        try {
          if (tile.id === 'photo') await handleTakePhoto()
          else if (tile.id === 'videoRecord') await handleRecording('video')
          else if (tile.id === 'audioRecord') await handleRecording('audio')
          else await dispatch(() => api.screenshot(), '截图指令已下发，稍后可在「设备照片」中查看')
        } finally {
          setBusyTile(null)
        }
        return
      }
      default:
        return
    }
  }

  const tempUnlockLabel = useMemo(() => {
    if (!device?.tempUnlock) return null
    return formatCountdown(device.tempUnlock, now)
  }, [device?.tempUnlock, now])

  /**
   * 屏幕亮灭。
   *
   * `Device` 接口没有亮屏字段，只能从设备事件流里取最近一条 screen_on / screen_off；
   * 取不到就显示「未知」，不去猜一个看起来合理但可能是错的结论。
   */
  const screenOn = useMemo(() => {
    if (!events) return null
    const latest = events.find((event) => event.type === 'screen_on' || event.type === 'screen_off')
    if (!latest) return null
    return latest.type === 'screen_on'
  }, [events])

  /**
   * 「最近活跃应用」。
   *
   * 后端没有「按使用时长排行」的接口，这里用的是**屏幕洞察记录**里出现的应用次数，
   * 只是一个近似信号，所以界面上的文案必须写成「最近活跃」而不是「使用最多」，
   * 并明确标注数据来源，避免家长把它当成精确的使用时长统计。
   */
  const activeApps = useMemo(() => {
    if (!insights) return []
    const counts = new Map<string, number>()
    for (const insight of insights) {
      for (const activity of insight.activities) {
        const name = activity.app || activity.packageName
        if (!name) continue
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count]) => ({ name, count }))
  }, [insights])

  const usagePercent = useMemo(() => {
    if (!features || features.timePlan.dailyLimit <= 0) return 0
    return Math.min(100, Math.round((features.timePlan.usedToday / features.timePlan.dailyLimit) * 100))
  }, [features])

  /**
   * 弹窗里可选的「应用」= 设备上报的**可启动**应用 ∪ 已有额度。
   *
   * - 只用可启动的应用：没有桌面入口的包（如安装器）设备端拦不到，
   *   给它设限就是留一条永不触发的假规则。
   * - 带上已有额度：清单还没同步时，家长仍能看到/调整已经设过的限制。
   * - 按包名去重：同一个包在清单和历史记录里可能挂着不同展示名（「时钟」/「Clock」）。
   */
  const appLimitCandidates = useMemo(() => {
    type Candidate = { packageName: string; appName: string; entry?: AppLimitEntry }
    const map = new Map<string, Candidate>()
    for (const app of deviceApps) {
      if (!app.isLaunchable) continue
      const pkg = app.packageName.trim()
      if (!pkg) continue
      map.set(pkg, { packageName: pkg, appName: app.appName || pkg })
    }
    for (const [name, entry] of Object.entries(features?.appLimit.apps ?? {})) {
      const pkg = entry.packageName?.trim()
      if (!pkg) continue
      const prev = map.get(pkg)
      map.set(pkg, { packageName: pkg, appName: prev?.appName || name, entry })
    }
    return [...map.values()].sort((a, b) => a.appName.localeCompare(b.appName, 'zh-Hans-CN'))
  }, [deviceApps, features])

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

  // 加载失败时给出可操作的错误态，而不是继续渲染 null 导致白屏
  if (!device || !features) {
    return (
      <div className="page-shell page-shell--wide page-shell--center">
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
    <div className="page-shell page-shell--wide">
      <div className="page-header flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
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

      {/* ---------------- 设备概览 ---------------- */}
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
              <div className="flex items-center gap-1 flex-shrink-0">
                {device.locked && <Badge className="bg-red-500 text-white">已锁定</Badge>}
                <Badge className={device.status === 'offline' ? 'bg-gray-400 text-white' : 'bg-[#07c160] text-white'}>
                  {device.status === 'offline' ? '离线' : '在线'}
                </Badge>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 mt-4 pt-4 border-t border-gray-100">
              <div className="flex flex-col items-center">
                <Battery className="w-4 h-4 text-gray-500" />
                <span className="text-xs text-gray-500 mt-1">{device.battery}%</span>
              </div>
              <div className="flex flex-col items-center">
                <Wifi className="w-4 h-4 text-gray-500" />
                <span className="text-xs text-gray-500 mt-1 truncate max-w-full">
                  {device.network || '未知网络'}
                </span>
              </div>
              <div className="flex flex-col items-center">
                {screenOn === null ? (
                  <EyeOff className="w-4 h-4 text-gray-300" />
                ) : (
                  <Eye className={`w-4 h-4 ${screenOn ? 'text-blue-500' : 'text-gray-400'}`} />
                )}
                <span className="text-xs text-gray-500 mt-1">
                  {screenOn === null ? '屏幕未知' : screenOn ? '屏幕已亮' : '屏幕已灭'}
                </span>
              </div>
              <div className="flex flex-col items-center">
                <Clock className="w-4 h-4 text-gray-500" />
                <span className="text-xs text-gray-500 mt-1">{device.lastActive || '未知'}</span>
              </div>
            </div>

            {tempUnlockLabel && (
              <div className="mt-3 bg-green-50 text-green-700 text-xs rounded-lg px-3 py-2 text-center">
                临时解锁中 · {tempUnlockLabel}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 一键锁屏（通栏，最重要） ---------------- */}
      <div className="px-3">
        <button
          type="button"
          disabled={lockingBusy}
          onClick={() => void handleLockScreen()}
          className={`w-full rounded-xl px-4 py-5 flex items-center text-left shadow-lg transition-transform active:scale-[0.99] disabled:opacity-80 ${
            device.locked
              ? 'bg-gradient-to-r from-green-500 to-green-600'
              : 'bg-gradient-to-r from-red-500 to-orange-500'
          }`}
        >
          <div className="w-14 h-14 rounded-full bg-white/25 flex items-center justify-center flex-shrink-0">
            {lockingBusy ? (
              <Loader2 className="w-7 h-7 text-white animate-spin" />
            ) : device.locked ? (
              <Unlock className="w-7 h-7 text-white" />
            ) : (
              <Lock className="w-7 h-7 text-white" />
            )}
          </div>
          <div className="flex-1 min-w-0 ml-4">
            <div className="text-white text-2xl font-semibold leading-tight">
              {device.locked ? '已锁定' : '立即锁定'}
            </div>
            <div className="text-white/85 text-xs mt-1">
              {device.locked
                ? '点击可远程解锁；孩子设备将在下次心跳时执行'
                : '点击后立即下发锁屏指令，让孩子放下手机'}
            </div>
          </div>
          <ChevronRight className="w-6 h-6 text-white/80 flex-shrink-0" />
        </button>

        <div className="grid grid-cols-2 gap-2 mt-2">
          <Button
            variant="outline"
            className="bg-white border-gray-200"
            onClick={() => setTempUnlockDialogOpen(true)}
          >
            <Unlock className="w-4 h-4 mr-1 text-blue-500" />
            {device.tempUnlock ? '取消临时可用' : '临时可用'}
          </Button>
          <Button
            variant="outline"
            className="bg-white border-gray-200"
            onClick={() => navigate('/quiz-unlock')}
          >
            <BookOpen className="w-4 h-4 mr-1 text-amber-500" />
            答题解锁
          </Button>
        </div>
      </div>

      {/* ---------------- 今日概览：使用时长 / 活跃应用 / 最新动态 ---------------- */}
      <div className="px-3 mt-3">
        <Card className="overflow-hidden">
          <CardContent className="p-4 space-y-4">
            <div>
              <div className="flex items-end justify-between">
                <div>
                  <div className="text-xs text-gray-400">今日使用时长</div>
                  <div className="text-2xl font-semibold text-gray-900 mt-0.5">
                    {formatMinutes(features.timePlan.usedToday)}
                  </div>
                </div>
                <div className="text-xs text-gray-400 text-right">
                  {features.timePlan.dailyLimit > 0
                    ? `上限 ${formatMinutes(features.timePlan.dailyLimit)}`
                    : '未设置上限'}
                </div>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full mt-2 overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    usagePercent >= 100 ? 'bg-red-500' : usagePercent >= 80 ? 'bg-orange-500' : 'bg-[#07c160]'
                  }`}
                  style={{ width: `${usagePercent}%` }}
                />
              </div>
            </div>

            <div className="border-t border-gray-100 pt-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">最近活跃应用</span>
                <button
                  type="button"
                  className="text-[11px] text-[#07c160]"
                  onClick={() => navigate('/insights')}
                >
                  查看洞察
                </button>
              </div>
              {insights === null ? (
                <p className="text-xs text-gray-400 mt-2">屏幕洞察记录读取失败</p>
              ) : activeApps.length === 0 ? (
                <p className="text-xs text-gray-400 mt-2">最近没有屏幕洞察记录</p>
              ) : (
                <div className="flex items-start gap-3 mt-2 flex-wrap">
                  {activeApps.map(({ name, count }) => (
                    <div key={name} className="flex items-center space-x-1.5">
                      <div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center text-xs text-gray-600 font-medium">
                        {name.slice(0, 1)}
                      </div>
                      <div className="leading-tight">
                        <div className="text-xs text-gray-700 max-w-[72px] truncate">{name}</div>
                        <div className="text-[10px] text-gray-400">{count} 次记录</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[10px] text-gray-400 mt-2 leading-relaxed">
                按最近的屏幕洞察记录统计出现次数，不是精确的使用时长排行。
              </p>
            </div>

            <div className="border-t border-gray-100 pt-3">
              <span className="text-xs text-gray-400">最新动态</span>
              {events === null ? (
                <p className="text-xs text-gray-400 mt-2">动态加载失败，稍后可下拉刷新重试</p>
              ) : events.length === 0 ? (
                <p className="text-xs text-gray-400 mt-2">设备还没有上报任何动态</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {events.slice(0, 3).map((event) => {
                    const meta = EVENT_META[event.type] ?? { icon: Info, className: 'text-gray-400' }
                    const Icon = meta.icon
                    return (
                      <div key={event.id} className="flex items-start space-x-2">
                        <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${meta.className}`} />
                        <span className="text-xs text-gray-500 flex-shrink-0">
                          {formatClock(event.createdAt)}
                        </span>
                        <span className="text-xs text-gray-700 flex-1 min-w-0">{event.detail}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 九宫格功能分组 ---------------- */}
      {TILE_GROUPS.map((group) => (
        <div key={group.title} className="px-3 mt-4">
          <div className="mb-2 px-1 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-500">{group.title}</span>
          </div>
          <Card className="overflow-hidden">
            <CardContent className="p-3">
              <div className="grid grid-cols-3 gap-y-4 gap-x-2 sm:grid-cols-4 lg:grid-cols-6">
                {group.tiles.map((tile) => {
                  const Icon = tile.icon
                  const busy = busyTile === tile.id
                  return (
                    <button
                      key={tile.id}
                      type="button"
                      disabled={busy}
                      onClick={() => void handleTileAction(tile)}
                      className="flex flex-col items-center py-1 rounded-lg hover:bg-gray-50 active:bg-gray-100 transition-colors disabled:opacity-60"
                    >
                      <div
                        className={`w-11 h-11 rounded-xl ${tile.bg} flex items-center justify-center relative`}
                      >
                        {busy ? (
                          <Loader2 className={`w-5 h-5 animate-spin ${tile.color}`} />
                        ) : (
                          <Icon className={`w-5 h-5 ${tile.color}`} />
                        )}
                        {tile.unsupported && (
                          <span className="absolute -top-1 -right-1 text-[9px] bg-gray-300 text-white rounded px-1 leading-4">
                            未开放
                          </span>
                        )}
                      </div>
                      <span
                        className={`text-[11px] mt-1.5 ${tile.unsupported ? 'text-gray-400' : 'text-gray-700'}`}
                      >
                        {tile.name}
                      </span>
                    </button>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      ))}

      {/* ---------------- 功能开关 ---------------- */}
      <div className="px-3 mt-4">
        <div className="mb-2 px-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">功能开关</span>
          <span className="text-xs text-gray-400">启用 / 停用设备能力</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {toggleFeatures.map((feature, index) => {
              const Icon = feature.icon
              const state = (features as unknown as Record<string, ToggleState | undefined>)[feature.id]
              const enabled = state?.enabled ?? false
              const busy = busyFeature === feature.id

              return (
                <div key={feature.id}>
                  <div className="flex items-center py-3 px-4 hover:bg-gray-50 transition-colors">
                    <div className={`w-10 h-10 rounded-lg ${feature.bg} flex items-center justify-center flex-shrink-0`}>
                      <Icon className={`w-5 h-5 ${feature.color}`} />
                    </div>
                    <div className="flex-1 min-w-0 ml-3">
                      <div className="font-medium text-gray-900 text-sm">{feature.name}</div>
                      <div className="text-xs text-gray-400 mt-0.5 truncate">
                        {enabled ? feature.desc : '未开启'}
                      </div>
                    </div>
                    <ToggleSwitch
                      checked={enabled}
                      busy={busy}
                      disabled={busy}
                      label={`${feature.name}开关`}
                      onChange={() => void handleToggleFeature(feature.id)}
                    />
                  </div>
                  {index < toggleFeatures.length - 1 && <div className="mx-4 border-t border-gray-100" />}
                </div>
              )
            })}
          </CardContent>
        </Card>
        <p className="text-[10px] text-gray-400 mt-2 px-1 leading-relaxed">
          这些开关是功能总闸：关掉某一项后，即使下发对应指令，孩子设备端也会拒绝执行。
        </p>
      </div>

      {/* ---------------- 环境监听 ---------------- */}
      <div className="px-3 mt-4">
        <div className="mb-2 px-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">环境监听</span>
          <Link to="/media" className="text-xs text-[#07c160]">
            去「媒体」听录音
          </Link>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-4">
            <div className="flex items-start space-x-3">
              <div className="w-10 h-10 rounded-lg bg-rose-50 flex items-center justify-center flex-shrink-0">
                <Headphones className="w-5 h-5 text-rose-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2">
                  <span className="text-sm font-medium text-gray-900">环境监听</span>
                  <Badge
                    className={
                      features.audioRecord?.enabled
                        ? 'bg-green-100 text-green-700'
                        : 'bg-gray-100 text-gray-600'
                    }
                  >
                    {features.audioRecord?.enabled ? '已开启' : '未开启'}
                  </Badge>
                </div>
                <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                  让孩子的设备持续分段录音（每段约 5 分钟），录音会像远程录音一样出现在「媒体」里。
                  这是「持续录」，和上面九宫格里的「远程录音」（录一次）不是同一件事。
                </p>
              </div>
              <ToggleSwitch
                checked={features.audioRecord?.enabled ?? false}
                busy={busyFeature === 'audioRecord'}
                disabled={busyFeature === 'audioRecord'}
                label="环境监听开关"
                onChange={() => void handleToggleFeature('audioRecord')}
              />
            </div>

            <div className="flex items-start space-x-2 bg-amber-50 border border-amber-200 rounded-lg p-2.5 mt-3">
              <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-amber-800 leading-relaxed">
                录音期间，孩子设备上会一直显示一条常驻通知「家长开启了环境监听」——
                <b>不做隐蔽录音</b>，孩子看得到。设备重启或进程被杀后不会自动恢复，需要你重新开启。
              </p>
            </div>

            <div className="flex space-x-2 mt-3">
              <Button
                className="flex-1 bg-[#07c160] hover:bg-[#06a050]"
                disabled={ambientBusy !== null || features.audioRecord?.enabled === false}
                onClick={() => void handleAmbient('start')}
              >
                {ambientBusy === 'start' ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    正在下发…
                  </>
                ) : (
                  '开始环境监听'
                )}
              </Button>
              <Button
                variant="outline"
                className="flex-1 bg-white"
                disabled={ambientBusy !== null}
                onClick={() => void handleAmbient('stop')}
              >
                {ambientBusy === 'stop' ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    正在下发…
                  </>
                ) : (
                  '停止'
                )}
              </Button>
            </div>
            <p className="text-[10px] text-gray-400 mt-2 leading-relaxed">
              开关（audioRecord）是总闸：关闭状态下设备会拒绝执行环境监听指令。
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 最近指令 ---------------- */}
      <div className="px-3 mt-4">
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

      {/* ---------------- 最近媒体 ---------------- */}
      <div className="px-3 mt-4">
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
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
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
            <Button
              className="bg-[#07c160] hover:bg-[#06a050]"
              disabled={lockingBusy}
              onClick={() => void handleLockScreen()}
            >
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

      {/* ---------------- 屏幕时间 ---------------- */}
      <Dialog open={timePlanDialogOpen} onOpenChange={setTimePlanDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>屏幕时间限制</DialogTitle>
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
          <p className="text-gray-600 mb-2">从孩子设备上的应用里选择，并设置每日时长限制：</p>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-gray-400">
              {deviceAppsLoading
                ? '正在读取设备应用清单…'
                : `设备已上报 ${appLimitCandidates.length} 个可限制的应用`}
            </span>
            <Button
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => void handleRefreshDeviceApps()}
              disabled={deviceAppsLoading}
            >
              <RefreshCw className={`w-3 h-3 mr-1 ${deviceAppsLoading ? 'animate-spin' : ''}`} />
              刷新清单
            </Button>
          </div>
          {deviceAppsError && <p className="text-sm text-red-500 mb-3">{deviceAppsError}</p>}
          {appLimitCandidates.length === 0 ? (
            <div className="py-4 text-center">
              <p className="text-sm text-gray-500">
                {deviceAppsLoading ? '正在读取…' : '还没拿到孩子设备上的应用清单。'}
              </p>
              {!deviceAppsLoading && (
                <p className="text-xs text-gray-400 mt-1">
                  设备在线时点上方「刷新清单」，几秒后会出现在这里。
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2 mb-4 max-h-64 overflow-y-auto">
              {appLimitCandidates.map(({ packageName, appName, entry }) => {
                const usedMinutes = Math.floor((entry?.usedTodaySeconds ?? 0) / 60)
                const percent =
                  entry && entry.dailyLimit > 0
                    ? Math.min(100, (entry.usedTodaySeconds / (entry.dailyLimit * 60)) * 100)
                    : 0
                const over = !!entry && entry.dailyLimit > 0 && usedMinutes >= entry.dailyLimit
                const active = selectedPackage === packageName
                return (
                  <button
                    key={packageName}
                    type="button"
                    onClick={() => {
                      setSelectedPackage(packageName)
                      setSelectedApp(appName)
                    }}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      active ? 'border-[#07c160] bg-green-50' : 'border-gray-200 bg-white'
                    }`}
                  >
                    <div className="flex items-center justify-between space-x-2">
                      <span className="text-sm font-medium text-gray-900 truncate">{appName}</span>
                      <span className={`text-xs flex-shrink-0 ${over ? 'text-red-500' : 'text-gray-500'}`}>
                        {entry
                          ? `今日已用 ${usedMinutes} 分钟 / 上限 ${entry.dailyLimit} 分钟`
                          : '未设限制'}
                      </span>
                    </div>
                    <p className="text-[10px] text-gray-400 mt-0.5 truncate">{packageName}</p>
                    {entry && (
                      <div className="mt-2 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${over ? 'bg-red-400' : 'bg-[#07c160]'}`}
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}
          <p className="text-[10px] text-gray-400 mb-3 leading-relaxed">
            用量由孩子设备上报（依赖 PACKAGE_USAGE_STATS 权限），约每 30 分钟一次。
            「今日已用 0 分钟」也可能是设备还没上报或权限没授予，不代表孩子没使用。
          </p>
          {selectedPackage && (
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
              disabled={!selectedPackage}
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
          <div className="flex items-start space-x-2 bg-amber-50 border border-amber-200 rounded-lg p-2.5 mb-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-700 leading-relaxed">
              Android 没有「安装前弹给家长审批」的系统接口。这里只处理孩子设备上报的安装请求，
              批准后设备端会临时放开安装 <b>30 分钟</b>；完整的说明与开关在「应用审批」页面。
            </p>
          </div>
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
            <Button variant="outline" onClick={() => navigate('/app-audit')}>
              去应用审批设置
            </Button>
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
          <div className="flex items-start space-x-2 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-amber-800 leading-relaxed space-y-1.5">
              <p className="font-medium text-sm">拦截只在「域名解析」这一层生效</p>
              <p>
                设备开启本地 VPN，把上网时的域名解析接管过来：命中名单的域名直接返回「域名不存在」。
                它<b>只认域名</b>，所以下面这些情况拦不到：
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>直接用 IP 地址访问 —— 根本没走域名解析</li>
                <li>浏览器开了 DoH / DoT 加密解析 —— 解析请求不经过设备</li>
                <li>域名已被缓存 —— 缓存过期前仍可能打开</li>
                <li>已经打开的页面、应用自己的直连通道 —— 不受影响</li>
              </ul>
              <p>
                它是<b>提高门槛</b>，不是网络防火墙，也不能拦下所有访问。
                拦截是否真的生效，还取决于设备端的 VPN 服务在正常运行 —— 请在孩子设备上实际确认。
              </p>
            </div>
          </div>
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

      {/* ---------------- 隐藏图标 ---------------- */}
      <Dialog open={hideIconDialogOpen} onOpenChange={setHideIconDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>隐藏图标</DialogTitle>
          </DialogHeader>
          <div className="flex items-start space-x-2 bg-red-50 border border-red-200 rounded-lg p-3">
            <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-red-800 leading-relaxed space-y-1.5">
              <p className="font-medium text-sm">隐藏后，孩子设备上也会找不到这个应用</p>
              <p>
                图标、桌面入口、应用列表里的条目都会消失。<b>孩子自己打不开，你也只能靠这个页面远程恢复</b>；
                如果设备离线或 Agent 出问题，就只剩下用 ADB（或设备所有者指令）把组件重新启用的办法。
              </p>
              <p>
                它只藏入口，不妨碍孩子通过系统设置停用或卸载 —— 那部分由设备所有者权限下的防卸载限制负责。
                隐藏或恢复都需要孩子设备在线，离线时指令会排队。
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900">隐藏客户端图标</div>
              <div className="text-xs text-gray-500 mt-0.5">
                {device.hideIcon ? '当前已隐藏（孩子设备上没有入口）' : '当前显示在桌面上'}
              </div>
            </div>
            <ToggleSwitch
              checked={device.hideIcon}
              busy={hideIconBusy}
              disabled={hideIconBusy}
              label="隐藏图标开关"
              onChange={() => void handleToggleHideIcon()}
            />
          </div>
          <DialogFooter>
            <Button onClick={() => setHideIconDialogOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="px-3 mt-4">
        <p className="text-[10px] text-gray-400 leading-relaxed px-1">
          提示：所有远程操作（锁屏、拍照、录像、截图）都需要孩子设备端 Agent 在线。
          离线时指令会排队，设备上线后执行。
        </p>
      </div>
    </div>
  )
}
