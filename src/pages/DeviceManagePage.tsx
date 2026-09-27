import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { ArrowLeft, Battery, Check, HelpCircle, Plus, Smartphone, Trash2, Wifi } from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { Device } from '@/types'

type DevicesResponse = { devices: Device[] }

export function DeviceManagePage() {
  const navigate = useNavigate()
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [helpDialogOpen, setHelpDialogOpen] = useState(false)
  const [deviceCode, setDeviceCode] = useState('')
  const [newDeviceName, setNewDeviceName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [removeTarget, setRemoveTarget] = useState<Device | null>(null)
  const [removing, setRemoving] = useState(false)

  const loadDevices = useCallback(async () => {
    try {
      const res: DevicesResponse = await api.getDevices()
      setDevices(res.devices ?? [])
      setError(null)
    } catch (err) {
      setError(toUserMessage(err, '加载设备列表失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDevices()
  }, [loadDevices])

  /**
   * 绑定设备。
   * 与 mock 版的根本差别：设备必须已经在孩子手机上装好 Agent 并完成注册
   * （屏幕上会显示 8 位设备码），家长输入的是**真实存在的**设备码。
   * 因此这里不再让家长手填型号/系统 —— 那些信息由设备自己上报。
   */
  const handleBindDevice = async () => {
    const code = deviceCode.trim().toUpperCase()
    if (!/^[A-Z0-9]{6,12}$/.test(code)) {
      toast.error('请输入孩子设备上显示的 6-12 位绑定码')
      return
    }
    setSubmitting(true)
    try {
      const res = await api.bindDevice({
        deviceCode: code,
        name: newDeviceName.trim() || undefined,
      })
      toast.success(res.alreadyBound ? '该设备已在你账号下' : '设备绑定成功')
      setAddDialogOpen(false)
      setDeviceCode('')
      setNewDeviceName('')
      await loadDevices()
    } catch (err) {
      toast.error(toUserMessage(err, '绑定设备失败'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleSelect = async (device: Device) => {
    try {
      await api.selectDevice(device.id)
      toast.success(`已切换到「${device.name}」`)
      navigate('/')
    } catch (err) {
      toast.error(toUserMessage(err, '切换设备失败'))
    }
  }

  const handleRemove = async () => {
    if (!removeTarget) return
    setRemoving(true)
    try {
      await api.deleteDevice(removeTarget.id)
      toast.success(`已解绑「${removeTarget.name}」`)
      setRemoveTarget(null)
      await loadDevices()
    } catch (err) {
      toast.error(toUserMessage(err, '解绑失败'))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="min-h-screen pb-20 bg-gray-100">
      <div className="bg-white px-4 py-4 border-b border-gray-200 flex items-center">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1">设备管理</h1>
        <Button variant="ghost" size="icon" onClick={() => setHelpDialogOpen(true)} aria-label="如何获取绑定码">
          <HelpCircle className="w-5 h-5 text-gray-400" />
        </Button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]" />
            <p className="mt-2 text-gray-500 text-sm">加载中...</p>
          </div>
        </div>
      )}

      {!loading && error && (
        <div className="px-4 py-16 text-center">
          <p className="text-gray-700">{error}</p>
          <Button
            className="mt-4 bg-[#07c160] hover:bg-[#06a050]"
            onClick={() => {
              setLoading(true)
              void loadDevices()
            }}
          >
            重新加载
          </Button>
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="px-3 py-3 space-y-3">
            {devices.length === 0 ? (
              <Card>
                <CardContent className="p-8 text-center">
                  <Smartphone className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-700 font-medium">还没有绑定任何设备</p>
                  <p className="text-sm text-gray-500 mt-2">
                    请先在孩子的手机上安装气球狗客户端，然后在下方输入它显示的绑定码。
                  </p>
                  <Button
                    className="mt-4 bg-[#07c160] hover:bg-[#06a050]"
                    onClick={() => setAddDialogOpen(true)}
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    绑定设备
                  </Button>
                </CardContent>
              </Card>
            ) : (
              devices.map((device) => (
                <Card key={device.id} className="overflow-hidden">
                  <CardContent className="p-4">
                    <div className="flex items-start space-x-3">
                      <div className="w-12 h-12 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                        <Smartphone className="w-6 h-6 text-blue-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center space-x-2">
                          <h3 className="font-medium text-gray-900 truncate">{device.name}</h3>
                          <Badge
                            className={
                              device.status === 'online'
                                ? 'bg-[#07c160] text-white'
                                : 'bg-gray-400 text-white'
                            }
                          >
                            {device.status === 'online' ? '在线' : '离线'}
                          </Badge>
                          {device.locked && <Badge className="bg-red-500 text-white">已锁定</Badge>}
                        </div>
                        <p className="text-xs text-gray-400 mt-1 truncate">
                          {device.model} · {device.os}
                        </p>
                        <div className="flex items-center space-x-4 mt-2 text-xs text-gray-500">
                          <span className="flex items-center">
                            <Battery className="w-3.5 h-3.5 mr-1" />
                            {device.battery}%
                          </span>
                          <span className="flex items-center">
                            <Wifi className="w-3.5 h-3.5 mr-1" />
                            {device.network || '未知'}
                          </span>
                          <span>{device.lastActive}</span>
                        </div>
                        <p className="text-[11px] text-gray-300 mt-2 font-mono">
                          绑定码 {device.deviceCode}
                          {device.agentVersion ? ` · 客户端 v${device.agentVersion}` : ''}
                        </p>
                      </div>
                    </div>

                    <div className="flex gap-2 mt-3">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        onClick={() => void handleSelect(device)}
                      >
                        <Check className="w-4 h-4 mr-1" />
                        设为当前设备
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-red-500 border-red-200 hover:bg-red-50"
                        onClick={() => setRemoveTarget(device)}
                      >
                        <Trash2 className="w-4 h-4 mr-1" />
                        解绑
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}

            {devices.length > 0 && (
              <Button
                variant="outline"
                className="w-full bg-white"
                onClick={() => setAddDialogOpen(true)}
              >
                <Plus className="w-4 h-4 mr-1" />
                绑定新设备
              </Button>
            )}
          </div>

          <div className="px-4 mt-4 text-xs text-gray-400 leading-relaxed">
            <p className="font-medium text-gray-500 mb-1">关于设备绑定</p>
            <p>
              每台设备在首次启动客户端时会在本地生成唯一的设备码与密钥。家长输入设备码完成认领后，
              即可对这台设备下发锁屏、拍照等指令；解绑不会影响孩子手机上客户端的数据，
              但会立即停止一切远程控制能力。
            </p>
          </div>
        </>
      )}

      {/* 绑定设备 */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>绑定孩子设备</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm text-gray-600 block mb-2">
                设备绑定码 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={deviceCode}
                onChange={(e) => setDeviceCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                placeholder="例如 A3F9K2M7"
                maxLength={12}
                autoCapitalize="characters"
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-center text-lg tracking-[0.3em] font-mono focus:outline-none focus:border-[#07c160]"
              />
              <p className="text-xs text-gray-400 mt-2">
                在孩子手机上打开气球狗客户端，首页会显示这串绑定码。
              </p>
            </div>
            <div>
              <label className="text-sm text-gray-600 block mb-2">设备备注名（可选）</label>
              <input
                type="text"
                value={newDeviceName}
                onChange={(e) => setNewDeviceName(e.target.value)}
                placeholder="例如 小明的手机"
                maxLength={30}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-[#07c160]"
              />
              <p className="text-xs text-gray-400 mt-2">
                不填则使用设备上报的名称。型号与系统信息由设备自动上报，无需手填。
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)} disabled={submitting}>
              取消
            </Button>
            <Button
              className="bg-[#07c160] hover:bg-[#06a050]"
              onClick={() => void handleBindDevice()}
              disabled={submitting}
            >
              {submitting ? '绑定中…' : '确认绑定'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 解绑确认 */}
      <Dialog open={Boolean(removeTarget)} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>解绑设备</DialogTitle>
          </DialogHeader>
          <p className="text-gray-600">
            确定要解绑「{removeTarget?.name}」吗？
          </p>
          <div className="bg-red-50 text-red-600 text-sm rounded-lg p-3 mt-3">
            解绑后该设备的历史位置、照片、答题记录都会被一并删除，且无法恢复。
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)} disabled={removing}>
              取消
            </Button>
            <Button
              className="bg-red-500 hover:bg-red-600 text-white"
              onClick={() => void handleRemove()}
              disabled={removing}
            >
              {removing ? '解绑中…' : '确认解绑'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 帮助 */}
      <Dialog open={helpDialogOpen} onOpenChange={setHelpDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>如何获取绑定码</DialogTitle>
          </DialogHeader>
          <ol className="text-sm text-gray-600 space-y-3 list-decimal list-inside">
            <li>在孩子手机上安装并打开气球狗客户端。</li>
            <li>客户端首次启动会自动向服务器注册，并在首页显示一个 8 位绑定码。</li>
            <li>在这里输入该绑定码，即可把这台设备加入你的账号。</li>
            <li>
              绑定成功后，客户端会立即拉取你设置的管控策略（锁屏、时长、应用限制、网址黑名单）并在本地生效。
            </li>
          </ol>
          <div className="bg-gray-50 rounded-lg p-3 mt-2">
            <p className="text-xs text-gray-500">
              提示：绑定码是设备身份的一部分，请勿分享给他人 —— 任何人拿到它都能申请绑定这台设备。
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setHelpDialogOpen(false)}>知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
