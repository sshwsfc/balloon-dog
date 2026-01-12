import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog, DialogHeader, DialogTitle, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { toast } from 'sonner'
import { ArrowLeft, Smartphone, Plus, Trash2, Wifi, Battery } from 'lucide-react'
import { api } from '@/services/api'

interface Device {
  id: string
  userId: string
  name: string
  model: string
  os: string
  battery: number
  status: 'online' | 'offline'
  lastActive: string
  network: string
  locked: boolean
  tempUnlock: string | null
  avatar?: string
}

export function DeviceManagePage() {
  const navigate = useNavigate()
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [newDeviceName, setNewDeviceName] = useState('')
  const [newDeviceModel, setNewDeviceModel] = useState('')
  const [newDeviceOs, setNewDeviceOs] = useState('')
  const [deviceCode, setDeviceCode] = useState('')

  useEffect(() => {
    loadDevices()
  }, [])

  const loadDevices = async () => {
    try {
      const response = await api.getDevices()
      setDevices(response.devices)
    } catch (error) {
      toast.error('加载设备列表失败')
      console.error('Failed to load devices:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleAddDevice = async () => {
    if (!newDeviceName.trim()) {
      toast.error('请输入设备名称')
      return
    }
    if (!newDeviceModel.trim()) {
      toast.error('请输入设备型号')
      return
    }
    if (!newDeviceOs.trim()) {
      toast.error('请输入操作系统')
      return
    }

    try {
      await api.addDevice({
        name: newDeviceName.trim(),
        model: newDeviceModel.trim(),
        os: newDeviceOs.trim(),
        deviceCode: deviceCode.trim()
      })
      await loadDevices()
      setAddDialogOpen(false)
      setNewDeviceName('')
      setNewDeviceModel('')
      setNewDeviceOs('')
      setDeviceCode('')
      toast.success('设备添加成功')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '添加设备失败'
      toast.error(message)
      console.error('Failed to add device:', error)
    }
  }

  const handleDeleteDevice = async (deviceId: string) => {
    try {
      await api.deleteDevice(deviceId)
      await loadDevices()
      toast.success('设备已删除')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '删除设备失败'
      toast.error(message)
      console.error('Failed to delete device:', error)
    }
  }

  const handleSelectDevice = async (deviceId: string) => {
    try {
      await api.selectDevice(deviceId)
      toast.success('设备已切换')
      navigate('/')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '切换设备失败'
      toast.error(message)
      console.error('Failed to select device:', error)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]"></div>
          <p className="mt-2 text-gray-500 text-sm">加载中...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen pb-20 bg-gray-100">
      <div className="bg-white px-4 py-4 border-b border-gray-200 flex items-center">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1">设备管理</h1>
      </div>

      <div className="px-4 py-4">
        <div className="mb-4">
          <Button
            className="w-full bg-[#07c160] hover:bg-[#06a050]"
            onClick={() => setAddDialogOpen(true)}
          >
            <Plus className="w-4 h-4 mr-2" />
            添加新设备
          </Button>
        </div>

        {devices.length === 0 ? (
          <div className="text-center py-12">
            <Smartphone className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500">暂无设备</p>
            <p className="text-gray-400 text-sm mt-2">点击上方按钮添加您的第一个设备</p>
          </div>
        ) : (
          <div className="space-y-3">
            {devices.map((device) => (
              <Card key={device.id} className="overflow-hidden">
                <CardContent className="p-4">
                  <div className="flex items-center space-x-3">
                    <div className="w-14 h-14 bg-gradient-to-br from-green-400 to-green-600 rounded-xl flex items-center justify-center flex-shrink-0">
                      <Smartphone className="w-7 h-7 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900 text-base truncate">{device.name}</div>
                      <div className="text-xs text-gray-400 mt-0.5">{device.model} · {device.os}</div>
                      <div className="flex items-center space-x-2 mt-2">
                        <div className={`flex items-center space-x-1 ${device.status === 'online' ? 'text-green-500' : 'text-gray-400'}`}>
                          <Wifi className="w-3 h-3" />
                          <span className="text-xs">{device.status === 'online' ? '在线' : '离线'}</span>
                        </div>
                        <div className="flex items-center space-x-1 text-gray-400">
                          <Battery className="w-3 h-3" />
                          <span className="text-xs">{device.battery}%</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-100">
                    <span className="text-xs text-gray-400">{device.lastActive}</span>
                    <div className="flex space-x-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleSelectDevice(device.id)}
                        className="text-green-600 border-green-200 hover:bg-green-50"
                      >
                        切换
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleDeleteDevice(device.id)}
                        className="text-red-600 border-red-200 hover:bg-red-50"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加新设备</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700 mb-2 block">设备名称</label>
              <input
                type="text"
                value={newDeviceName}
                onChange={(e) => setNewDeviceName(e.target.value)}
                placeholder="例如：小米手机 14 Pro"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-2 block">设备型号</label>
              <input
                type="text"
                value={newDeviceModel}
                onChange={(e) => setNewDeviceModel(e.target.value)}
                placeholder="例如：Xiaomi 14 Pro"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-2 block">操作系统</label>
              <input
                type="text"
                value={newDeviceOs}
                onChange={(e) => setNewDeviceOs(e.target.value)}
                placeholder="例如：Android 14"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-2 block">设备码（可选）</label>
              <input
                type="text"
                value={deviceCode}
                onChange={(e) => setDeviceCode(e.target.value)}
                placeholder="输入设备码以绑定设备"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>取消</Button>
            <Button className="bg-[#07c160] hover:bg-[#06a050]" onClick={handleAddDevice}>
              确认添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
