import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Bell,
  ChevronRight,
  Image as ImageIcon,
  LogOut,
  Mail,
  Plus,
  Settings,
  Shield,
  Smartphone,
  User,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { api, toUserMessage } from '@/services/api'
import { toast } from 'sonner'
import type { Device } from '@/types'

export function ProfilePage() {
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const [devices, setDevices] = useState<Device[]>([])
  const [deviceError, setDeviceError] = useState<string | null>(null)

  const fetchDevices = useCallback(() => api.getDevices(), [])

  useEffect(() => {
    let cancelled = false
    fetchDevices()
      .then((res) => {
        if (cancelled) return
        setDevices(res.devices ?? [])
        setDeviceError(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setDeviceError(toUserMessage(error, '加载设备失败'))
      })
    return () => {
      cancelled = true
    }
  }, [fetchDevices])

  const reloadDevices = useCallback(async () => {
    try {
      const res = await fetchDevices()
      setDevices(res.devices ?? [])
      setDeviceError(null)
    } catch (error) {
      setDeviceError(toUserMessage(error, '加载设备失败'))
    }
  }, [fetchDevices])

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  const menuItems = [
    { icon: User, title: '个人信息', desc: '修改昵称、邮箱', onClick: () => toast.info('个人信息编辑即将上线') },
    { icon: Bell, title: '通知设置', desc: '消息提醒、推送通知', onClick: () => toast.info('通知设置即将上线') },
    { icon: Shield, title: '隐私安全', desc: '密码、指纹、面部识别', onClick: () => toast.info('隐私安全设置即将上线') },
    { icon: Settings, title: '通用设置', desc: '语言、主题、版本', onClick: () => toast.info('通用设置即将上线') },
  ]

  return (
    <div className="page-shell">
      <div className="bg-gradient-to-br from-green-400 to-green-600 text-white px-4 py-6">
        <div className="flex items-center space-x-3">
          {user?.avatar ? (
            <img src={user.avatar} alt="头像" className="w-16 h-16 rounded-full bg-white/20" />
          ) : (
            <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center">
              <User className="w-8 h-8" />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-xl font-medium truncate">{user?.name || '家长用户'}</h1>
            <p className="text-xs opacity-80 mt-0.5">家长账户</p>
            <p className="text-xs opacity-60 mt-1 truncate">
              {user?.phone || user?.email || '未绑定手机号'}
              {user?.wechatBound ? ' · 已绑定微信' : ''}
            </p>
          </div>
        </div>
      </div>

      {/* 设备列表 */}
      <div className="px-3 -mt-4">
        <Card>
          <CardContent className="p-0">
            {deviceError ? (
              <div className="px-4 py-4 text-center">
                <p className="text-sm text-gray-500">{deviceError}</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => void reloadDevices()}>
                  重试
                </Button>
              </div>
            ) : devices.length === 0 ? (
              // 原实现这里没有 onClick，点了没反应
              <button
                type="button"
                className="w-full flex items-center justify-center py-4 hover:bg-gray-50 active:bg-gray-100 transition-colors"
                onClick={() => navigate('/devices')}
              >
                <Plus className="w-4 h-4 text-gray-400 mr-1.5" />
                <span className="text-sm text-gray-500">绑定孩子设备</span>
              </button>
            ) : (
              <>
                {devices.map((device, index) => (
                  <div key={device.id}>
                    <button
                      type="button"
                      className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
                      onClick={() => navigate('/devices')}
                    >
                      <div className="flex items-center space-x-3 min-w-0">
                        <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                          <Smartphone className="w-5 h-5 text-blue-500" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center space-x-2">
                            <h4 className="font-medium text-gray-900 text-sm truncate">{device.name}</h4>
                            <Badge
                              className={
                                device.status === 'online'
                                  ? 'bg-[#07c160] text-white text-[10px]'
                                  : 'bg-gray-400 text-white text-[10px]'
                              }
                            >
                              {device.status === 'online' ? '在线' : '离线'}
                            </Badge>
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5 truncate">{device.model}</p>
                        </div>
                      </div>
                      <ChevronRight className="w-5 h-5 text-gray-300 flex-shrink-0" />
                    </button>
                    {index < devices.length - 1 && <div className="mx-4 border-t border-gray-100" />}
                  </div>
                ))}
                <div className="mx-4 border-t border-gray-100" />
                <button
                  type="button"
                  className="w-full flex items-center justify-center py-3 hover:bg-gray-50 active:bg-gray-100 transition-colors"
                  onClick={() => navigate('/devices')}
                >
                  <Plus className="w-4 h-4 text-gray-400 mr-1.5" />
                  <span className="text-sm text-gray-500">管理设备</span>
                </button>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 媒体入口 */}
      <div className="px-3 mt-3">
        <Card>
          <CardContent className="p-0">
            <button
              type="button"
              className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
              onClick={() => navigate('/media')}
            >
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-cyan-50 rounded-lg flex items-center justify-center">
                  <ImageIcon className="w-5 h-5 text-cyan-500" />
                </div>
                <div>
                  <h4 className="font-medium text-gray-900 text-sm">设备照片</h4>
                  <p className="text-xs text-gray-400 mt-0.5">查看孩子设备回传的照片与截图</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300" />
            </button>
          </CardContent>
        </Card>
      </div>

      {/* 设置项 */}
      <div className="px-3 mt-3">
        <Card>
          <CardContent className="p-0">
            {menuItems.map((item, index) => (
              <div key={item.title}>
                <button
                  type="button"
                  className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
                  onClick={item.onClick}
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center">
                      <item.icon className="w-5 h-5 text-gray-500" />
                    </div>
                    <div>
                      <h4 className="font-medium text-gray-900 text-sm">{item.title}</h4>
                      <p className="text-xs text-gray-400 mt-0.5">{item.desc}</p>
                    </div>
                  </div>
                  <ChevronRight className="w-5 h-5 text-gray-300" />
                </button>
                {index < menuItems.length - 1 && <div className="mx-4 border-t border-gray-100" />}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* 客服 + 退出 */}
      <div className="px-3 mt-3">
        <Card>
          <CardContent className="p-0">
            <button
              type="button"
              className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
              onClick={() => toast.info('客服联系方式即将上线')}
            >
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center">
                  <Mail className="w-5 h-5 text-gray-500" />
                </div>
                <div>
                  <h4 className="font-medium text-gray-900 text-sm">联系客服</h4>
                  <p className="text-xs text-gray-400 mt-0.5">获取帮助和支持</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300" />
            </button>
            <div className="mx-4 border-t border-gray-100" />
            <button
              type="button"
              className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
              onClick={handleLogout}
            >
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center">
                  <LogOut className="w-5 h-5 text-red-500" />
                </div>
                <div>
                  <h4 className="font-medium text-red-500 text-sm">退出登录</h4>
                  <p className="text-xs text-gray-400 mt-0.5">退出当前账户</p>
                </div>
              </div>
            </button>
          </CardContent>
        </Card>
      </div>

      <div className="px-3 mt-6 mb-4 text-center text-xs text-gray-400">
        <p>版本 1.0.0</p>
        <p className="mt-1">© 2026 气球狗 - 孩子的守护者</p>
      </div>
    </div>
  )
}
