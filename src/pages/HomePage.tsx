import { useState, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogHeader, DialogTitle, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { toast } from 'sonner'
import { Shield, Clock, Lock, MapPin, Smartphone, Eye, Camera, Mic, Video, Phone, MessageSquare, ChevronRight, Battery, Wifi, Play, Pause, Check, X } from 'lucide-react'
import { api } from '@/services/api'

const basicFeatures = [
  { id: 'lockScreen', icon: Lock, name: '一键锁屏', desc: '立即锁定设备屏幕', color: 'text-orange-500', bg: 'bg-orange-50' },
  { id: 'tempUnlock', icon: Shield, name: '临时使用', desc: '授权临时使用权限', color: 'text-blue-500', bg: 'bg-blue-50' },
  { id: 'timePlan', icon: Clock, name: '时间规划', desc: '设置使用时间限制', color: 'text-purple-500', bg: 'bg-purple-50' },
  { id: 'appLimit', icon: Smartphone, name: '应用限制', desc: '限制应用使用时长', color: 'text-green-500', bg: 'bg-green-50' },
  { id: 'appAudit', icon: Shield, name: '应用审核', desc: '审核新安装应用', color: 'text-yellow-500', bg: 'bg-yellow-50' },
  { id: 'webBlock', icon: MapPin, name: '网址拦截', desc: '拦截不良网站', color: 'text-red-500', bg: 'bg-red-50' },
]

const advancedFeatures = [
  { id: 'screenMonitor', icon: Eye, name: '同屏监控', desc: '实时查看屏幕内容', color: 'text-indigo-500', bg: 'bg-indigo-50' },
  { id: 'remoteHelp', icon: Smartphone, name: '远程协助', desc: '远程操作帮助', color: 'text-pink-500', bg: 'bg-pink-50' },
  { id: 'callSms', icon: Phone, name: '电话短信', desc: '查看通话和短信', color: 'text-teal-500', bg: 'bg-teal-50' },
  { id: 'remotePhoto', icon: Camera, name: '远程拍照', desc: '远程拍摄照片', color: 'text-cyan-500', bg: 'bg-cyan-50' },
  { id: 'remoteRecord', icon: Mic, name: '远程录音', desc: '远程录制音频', color: 'text-rose-500', bg: 'bg-rose-50' },
  { id: 'videoRecord', icon: Video, name: '连续录像', desc: '持续视频录制', color: 'text-fuchsia-500', bg: 'bg-fuchsia-50' },
]

function FeatureItem({ feature, onClick, status }: { feature: typeof basicFeatures[0]; onClick: () => void; status?: string }) {
  const Icon = feature.icon
  return (
    <div className="flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors cursor-pointer" onClick={onClick}>
      <div className="flex items-center space-x-3 flex-1">
        <div className={`w-10 h-10 rounded-lg ${feature.bg} flex items-center justify-center flex-shrink-0`}>
          <Icon className={`w-5 h-5 ${feature.color}`} />
        </div>
        <div className="flex-1">
          <div className="font-medium text-gray-900">{feature.name}</div>
          <div className="text-xs text-gray-400 mt-0.5">{status || feature.desc}</div>
        </div>
      </div>
      <ChevronRight className="w-5 h-5 text-gray-300 flex-shrink-0 ml-2" />
    </div>
  )
}

export function HomePage() {
  const [device, setDevice] = useState<any>(null)
  const [features, setFeatures] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  
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

  const [recordingState, setRecordingState] = useState<{ [key: string]: 'idle' | 'recording' }>({})
  const [recordingId, setRecordingId] = useState<{ [key: string]: string }>({})

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      const [deviceData, featuresData] = await Promise.all([
        api.getDevice(),
        api.getFeatures()
      ])
      setDevice(deviceData)
      setFeatures(featuresData)
    } catch (error) {
      toast.error('加载数据失败，请刷新页面重试')
      console.error('Failed to load data:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleLockScreen = async () => {
    try {
      await api.lockScreen(!device.locked)
      await loadData()
      setLockDialogOpen(false)
      toast.success(device.locked ? '设备已解锁' : '设备已锁定')
    } catch (error: any) {
      toast.error(error.message || '操作失败，请稍后重试')
      console.error('Failed to lock screen:', error)
    }
  }

  const handleTempUnlock = async () => {
    try {
      if (device.tempUnlock) {
        await api.cancelTempUnlock()
        toast.success('临时解锁已取消')
      } else {
        const minutes = parseInt(tempUnlockMinutes)
        if (minutes && minutes > 0) {
          await api.tempUnlock(minutes)
          toast.success(`设备已解锁 ${minutes} 分钟`)
        } else {
          toast.error('请输入有效的时间')
          return
        }
      }
      await loadData()
      setTempUnlockDialogOpen(false)
      setTempUnlockMinutes('')
    } catch (error: any) {
      toast.error(error.message || '操作失败，请稍后重试')
      console.error('Failed to temp unlock:', error)
    }
  }

  const handleSetTimePlan = async () => {
    try {
      const limit = parseInt(timePlanLimit)
      if (limit && limit > 0) {
        await api.setTimePlan(limit)
        await loadData()
        setTimePlanDialogOpen(false)
        setTimePlanLimit('')
        toast.success(`每日使用时间已设置为 ${limit} 分钟`)
      } else {
        toast.error('请输入有效的时间')
      }
    } catch (error: any) {
      toast.error(error.message || '操作失败，请稍后重试')
      console.error('Failed to set time plan:', error)
    }
  }

  const handleSetAppLimit = async () => {
    try {
      const limit = parseInt(appLimit)
      if (limit && limit > 0 && selectedApp) {
        await api.setAppLimit(selectedApp, limit)
        await loadData()
        setAppLimitDialogOpen(false)
        setSelectedApp('')
        setAppLimit('')
        toast.success(`${selectedApp} 的时间限制已设置为 ${limit} 分钟`)
      } else {
        toast.error('请选择应用并输入有效的时间')
      }
    } catch (error: any) {
      toast.error(error.message || '操作失败，请稍后重试')
      console.error('Failed to set app limit:', error)
    }
  }

  const handleAuditApp = async (appName: string, approved: boolean) => {
    try {
      await api.auditApp(appName, approved)
      await loadData()
      toast.success(approved ? `已批准 ${appName} 的使用` : `已拒绝 ${appName} 的使用`)
    } catch (error: any) {
      toast.error(error.message || '操作失败，请稍后重试')
      console.error('Failed to audit app:', error)
    }
  }

  const handleBlockUrl = async () => {
    try {
      if (newUrl.trim()) {
        await api.blockUrl(newUrl.trim())
        await loadData()
        setNewUrl('')
        toast.success(`已添加 ${newUrl.trim()} 到拦截列表`)
      } else {
        toast.error('请输入有效的网址')
      }
    } catch (error: any) {
      toast.error(error.message || '操作失败，请稍后重试')
      console.error('Failed to block url:', error)
    }
  }

  const handleToggleFeature = async (feature: string) => {
    try {
      const enabled = features[feature].enabled
      await api.enableFeature(feature, !enabled)
      await loadData()
      toast.success(!enabled ? '功能已开启' : '功能已关闭')
    } catch (error: any) {
      toast.error(error.message || '操作失败，请稍后重试')
      console.error('Failed to toggle feature:', error)
    }
  }

  const handleTakePhoto = async () => {
    try {
      await api.takePhoto()
      toast.success('拍照成功')
    } catch (error: any) {
      toast.error(error.message || '拍照失败，请稍后重试')
      console.error('Failed to take photo:', error)
    }
  }

  const handleToggleRecording = async (type: 'video' | 'audio') => {
    try {
      const featureKey = type === 'video' ? 'videoRecord' : 'remoteRecord'
      const currentState = recordingState[featureKey] || 'idle'
      
      if (currentState === 'idle') {
        const response = type === 'video' 
          ? await api.startRecording()
          : await api.startAudioRecording()
        setRecordingState({ ...recordingState, [featureKey]: 'recording' })
        setRecordingId({ ...recordingId, [featureKey]: response.recordingId })
        toast.success('开始录制')
      } else {
        const id = recordingId[featureKey]
        if (type === 'video') {
          await api.stopRecording(id)
        } else {
          await api.stopAudioRecording(id)
        }
        setRecordingState({ ...recordingState, [featureKey]: 'idle' })
        toast.success('录制完成')
      }
    } catch (error: any) {
      toast.error(error.message || '录制失败，请稍后重试')
      console.error('Failed to toggle recording:', error)
    }
  }

  const getTempUnlockTime = () => {
    if (!device?.tempUnlock) return null
    const unlockTime = new Date(device.tempUnlock)
    const now = new Date()
    const diff = unlockTime.getTime() - now.getTime()
    if (diff <= 0) return null
    const minutes = Math.floor(diff / 60000)
    return `${minutes}分钟后锁定`
  }

  const tempUnlockTime = getTempUnlockTime()

  if (loading) {
    return (
      <div className="min-h-screen pb-20 bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]"></div>
          <p className="mt-2 text-gray-500 text-sm">加载中...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen pb-20 bg-gray-100">
      <div className="bg-white px-4 py-4 border-b border-gray-200">
        <h1 className="text-xl font-medium text-gray-900">设备监控</h1>
      </div>

      <div className="px-3 py-3">
        <Card className="overflow-hidden">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="w-14 h-14 bg-gradient-to-br from-green-400 to-green-600 rounded-xl flex items-center justify-center">
                <Smartphone className="w-7 h-7 text-white" />
              </div>
              <div className="flex-1">
                <div className="font-medium text-gray-900 text-base">{device.name}</div>
                <div className="text-xs text-gray-400 mt-0.5">{device.os}</div>
              </div>
              <div className="text-right">
                <Badge className={device.locked ? "bg-red-500 text-white" : "bg-[#07c160] text-white"}>
                  {device.locked ? '已锁定' : '在线'}
                </Badge>
              </div>
            </div>
            <div className="flex items-center justify-around mt-4 pt-4 border-t border-gray-100">
              <div className="flex items-center space-x-1.5">
                <Battery className="w-4 h-4 text-gray-500" />
                <span className="text-xs text-gray-500">{device.battery}%</span>
              </div>
              <div className="flex items-center space-x-1.5">
                <Wifi className="w-4 h-4 text-gray-500" />
                <span className="text-xs text-gray-500">Wi-Fi</span>
              </div>
              <div className="text-xs text-gray-400">
                {device.lastActive}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="px-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">基础功能</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {basicFeatures.map((feature) => (
              <div key={feature.id}>
                <FeatureItem 
                  feature={feature} 
                  onClick={() => {
                    if (feature.id === 'lockScreen') setLockDialogOpen(true)
                    else if (feature.id === 'tempUnlock') setTempUnlockDialogOpen(true)
                    else if (feature.id === 'timePlan') setTimePlanDialogOpen(true)
                    else if (feature.id === 'appLimit') setAppLimitDialogOpen(true)
                    else if (feature.id === 'appAudit') setAppAuditDialogOpen(true)
                    else if (feature.id === 'webBlock') setWebBlockDialogOpen(true)
                  }}
                  status={
                    feature.id === 'lockScreen' 
                      ? (device.locked ? '设备已锁定' : '设备正常使用')
                      : feature.id === 'tempUnlock'
                      ? (tempUnlockTime || '设备正常锁定')
                      : feature.id === 'timePlan'
                      ? `今日已使用 ${features.timePlan.usedToday} 分钟，限制 ${features.timePlan.dailyLimit} 分钟`
                      : undefined
                  }
                />
                {feature.id !== basicFeatures[basicFeatures.length - 1].id && (
                  <div className="mx-4 border-t border-gray-100" />
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="px-3 mt-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">高级功能</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {advancedFeatures.map((feature) => {
              const isRecording = recordingState[feature.id] === 'recording'
              return (
                <div key={feature.id}>
                  <div 
                    className="flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors cursor-pointer"
                    onClick={() => {
                      if (feature.id === 'screenMonitor' || feature.id === 'remoteHelp' || feature.id === 'callSms') {
                        handleToggleFeature(feature.id)
                      } else if (feature.id === 'remotePhoto') {
                        handleTakePhoto()
                      } else if (feature.id === 'videoRecord' || feature.id === 'remoteRecord') {
                        handleToggleRecording(feature.id === 'videoRecord' ? 'video' : 'audio')
                      }
                    }}
                  >
                    <div className="flex items-center space-x-3 flex-1">
                      <div className={`w-10 h-10 rounded-lg ${feature.bg} flex items-center justify-center flex-shrink-0 ${isRecording ? 'animate-pulse' : ''}`}>
                        {feature.id === 'videoRecord' || feature.id === 'remoteRecord' ? (
                          isRecording ? <Pause className={`w-5 h-5 ${feature.color}`} /> : <Play className={`w-5 h-5 ${feature.color}`} />
                        ) : (
                          <feature.icon className={`w-5 h-5 ${feature.color}`} />
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="font-medium text-gray-900">{feature.name}</div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {isRecording ? '录制中...' : features[feature.id].enabled ? '已开启' : '未开启'}
                        </div>
                      </div>
                    </div>
                    <div className="w-10 h-6 rounded-full relative cursor-pointer" onClick={() => handleToggleFeature(feature.id)}>
                      <div className={`absolute w-5 h-5 rounded-full top-0.5 transition-all ${features[feature.id].enabled ? 'right-0.5 bg-[#07c160]' : 'left-0.5 bg-gray-300'}`} />
                      <div className={`w-full h-full rounded-full ${features[feature.id].enabled ? 'bg-green-100' : 'bg-gray-200'}`} />
                    </div>
                  </div>
                  {feature.id !== advancedFeatures[advancedFeatures.length - 1].id && (
                    <div className="mx-4 border-t border-gray-100" />
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>
      </div>

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
            <Button variant="outline" onClick={() => setLockDialogOpen(false)}>取消</Button>
            <Button className="bg-[#07c160] hover:bg-[#06a050]" onClick={handleLockScreen}>
              {device.locked ? '解锁' : '锁定'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tempUnlockDialogOpen} onOpenChange={setTempUnlockDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{device.tempUnlock ? '取消临时解锁' : '临时使用'}</DialogTitle>
          </DialogHeader>
          {device.tempUnlock ? (
            <div>
              <p className="text-gray-600 mb-4">设备当前处于临时解锁状态：</p>
              <div className="bg-green-50 text-green-700 p-3 rounded-lg">
                <p className="font-medium">{tempUnlockTime}</p>
              </div>
              <p className="text-gray-500 text-sm mt-4">取消后设备将立即锁定</p>
            </div>
          ) : (
            <div>
              <p className="text-gray-600 mb-4">选择临时解锁时长：</p>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {[5, 15, 30, 60, 120, 180].map((min) => (
                  <Button
                    key={min}
                    variant="outline"
                    onClick={() => setTempUnlockMinutes(min.toString())}
                    className={tempUnlockMinutes === min.toString() ? 'border-[#07c160] text-[#07c160]' : ''}
                  >
                    {min}分钟
                  </Button>
                ))}
              </div>
              <div className="flex items-center space-x-2">
                <input
                  type="number"
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
            <Button variant="outline" onClick={() => setTempUnlockDialogOpen(false)}>取消</Button>
            <Button className="bg-[#07c160] hover:bg-[#06a050]" onClick={handleTempUnlock}>
              {device.tempUnlock ? '取消解锁' : '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={timePlanDialogOpen} onOpenChange={setTimePlanDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>时间规划</DialogTitle>
          </DialogHeader>
            <p className="text-gray-600 mb-4">设置每日使用时长限制（分钟）：</p>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {[60, 120, 180, 240, 300, 360].map((min) => (
                <Button
                  key={min}
                  variant="outline"
                  onClick={() => setTimePlanLimit(min.toString())}
                  className={timePlanLimit === min.toString() ? 'border-[#07c160] text-[#07c160]' : ''}
                >
                  {min}分钟
                </Button>
              ))}
            </div>
            <div className="flex items-center space-x-2">
              <input
                type="number"
                value={timePlanLimit}
                onChange={(e) => setTimePlanLimit(e.target.value)}
                placeholder="输入分钟数"
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
              />
              <span className="text-gray-500 text-sm">分钟</span>
            </div>
            <p className="text-xs text-gray-500 mt-4">当前设置：{features.timePlan.dailyLimit} 分钟/天</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTimePlanDialogOpen(false)}>取消</Button>
            <Button className="bg-[#07c160] hover:bg-[#06a050]" onClick={handleSetTimePlan}>确认</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={appLimitDialogOpen} onOpenChange={setAppLimitDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>应用限制</DialogTitle>
          </DialogHeader>
            <p className="text-gray-600 mb-4">选择应用并设置时长限制：</p>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {Object.keys(features.appLimit.apps).map((app) => (
                <Button
                  key={app}
                  variant="outline"
                  onClick={() => setSelectedApp(app)}
                  className={selectedApp === app ? 'border-[#07c160] text-[#07c160]' : ''}
                >
                  {app}
                </Button>
              ))}
            </div>
            {selectedApp && (
              <div className="space-y-3">
                <p className="text-sm text-gray-600">为 {selectedApp} 设置时长限制（分钟）：</p>
                <div className="grid grid-cols-3 gap-2 mb-4">
                  {[15, 30, 60, 120].map((min) => (
                    <Button
                      key={min}
                      variant="outline"
                      onClick={() => setAppLimit(min.toString())}
                      className={appLimit === min.toString() ? 'border-[#07c160] text-[#07c160]' : ''}
                    >
                      {min}分钟
                    </Button>
                  ))}
                </div>
                <div className="flex items-center space-x-2">
                  <input
                    type="number"
                    value={appLimit}
                    onChange={(e) => setAppLimit(e.target.value)}
                    placeholder="输入分钟数"
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
                  />
                  <span className="text-gray-500 text-sm">分钟</span>
                </div>
              </div>
            )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAppLimitDialogOpen(false)}>取消</Button>
            <Button className="bg-[#07c160] hover:bg-[#06a050]" onClick={handleSetAppLimit} disabled={!selectedApp}>确认</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={appAuditDialogOpen} onOpenChange={setAppAuditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>应用审核</DialogTitle>
          </DialogHeader>
            {features.appAudit.pendingApps.length > 0 ? (
              <div className="space-y-3">
                <p className="text-gray-600">以下应用等待审核：</p>
                {features.appAudit.pendingApps.map((app: string) => (
                  <div key={app} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <span className="font-medium">{app}</span>
                    <div className="flex space-x-2">
                      <Button size="sm" variant="outline" onClick={() => handleAuditApp(app, false)}>
                        <X className="w-4 h-4" />
                      </Button>
                      <Button size="sm" className="bg-[#07c160] hover:bg-[#06a050]" onClick={() => handleAuditApp(app, true)}>
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

      <Dialog open={webBlockDialogOpen} onOpenChange={setWebBlockDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>网址拦截</DialogTitle>
          </DialogHeader>
            <div className="space-y-4">
              <div>
                <p className="text-gray-600 mb-2">添加新的拦截网址：</p>
                <input
                  type="text"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="输入网址，例如：gambling.com"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
                />
                <Button className="w-full mt-2 bg-[#07c160] hover:bg-[#06a050]" onClick={handleBlockUrl}>添加</Button>
              </div>
              {features.webBlock.blockedUrls.length > 0 && (
                <div>
                  <p className="text-gray-600 mb-2">已拦截的网址：</p>
                  <div className="space-y-2">
                    {features.webBlock.blockedUrls.map((url: string) => (
                      <div key={url} className="flex items-center justify-between p-2 bg-gray-50 rounded text-sm">
                        <span className="text-gray-700">{url}</span>
                        <X className="w-4 h-4 text-gray-400" />
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
