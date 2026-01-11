import { Card, CardContent } from '@/components/ui/card'
import { User, Mail, Phone, Settings, Bell, Shield, LogOut, ChevronRight, Plus, Smartphone } from 'lucide-react'

export function ProfilePage() {
  return (
    <div className="min-h-screen pb-20 bg-gray-100">
      <div className="bg-gradient-to-br from-green-400 to-green-600 text-white px-4 py-6">
        <div className="flex items-center space-x-3">
          <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center">
            <User className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-xl font-medium">张小明</h1>
            <p className="text-xs opacity-80 mt-0.5">家长账户</p>
            <p className="text-xs opacity-60 mt-1">xiaoming@email.com</p>
          </div>
        </div>
      </div>

      <div className="px-3 -mt-4">
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center">
                  <Smartphone className="w-5 h-5 text-blue-500" />
                </div>
                <div>
                  <h4 className="font-medium text-gray-900 text-sm">小米手机 14 Pro</h4>
                  <p className="text-xs text-gray-400 mt-0.5">张小明的设备</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300" />
            </div>
            <div className="mx-4 border-t border-gray-100" />
            <div className="flex items-center justify-center py-3 hover:bg-gray-50 active:bg-gray-100 transition-colors cursor-pointer">
              <Plus className="w-4 h-4 text-gray-400 mr-1.5" />
              <span className="text-sm text-gray-500">添加新设备</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="px-3 mt-3">
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center">
                  <User className="w-5 h-5 text-gray-500" />
                </div>
                <div>
                  <h4 className="font-medium text-gray-900 text-sm">个人信息</h4>
                  <p className="text-xs text-gray-400 mt-0.5">修改姓名、手机号</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300" />
            </div>
            <div className="mx-4 border-t border-gray-100" />
            <div className="flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center">
                  <Bell className="w-5 h-5 text-gray-500" />
                </div>
                <div>
                  <h4 className="font-medium text-gray-900 text-sm">通知设置</h4>
                  <p className="text-xs text-gray-400 mt-0.5">消息提醒、推送通知</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300" />
            </div>
            <div className="mx-4 border-t border-gray-100" />
            <div className="flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center">
                  <Shield className="w-5 h-5 text-gray-500" />
                </div>
                <div>
                  <h4 className="font-medium text-gray-900 text-sm">隐私安全</h4>
                  <p className="text-xs text-gray-400 mt-0.5">密码、指纹、面部识别</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300" />
            </div>
            <div className="mx-4 border-t border-gray-100" />
            <div className="flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center">
                  <Settings className="w-5 h-5 text-gray-500" />
                </div>
                <div>
                  <h4 className="font-medium text-gray-900 text-sm">通用设置</h4>
                  <p className="text-xs text-gray-400 mt-0.5">语言、主题、版本</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300" />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="px-3 mt-3">
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors">
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
            </div>
            <div className="mx-4 border-t border-gray-100" />
            <div className="flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors cursor-pointer">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center">
                  <LogOut className="w-5 h-5 text-red-500" />
                </div>
                <div>
                  <h4 className="font-medium text-red-500 text-sm">退出登录</h4>
                  <p className="text-xs text-gray-400 mt-0.5">退出当前账户</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="px-3 mt-6 mb-4 text-center text-xs text-gray-400">
        <p>版本 1.0.0</p>
        <p className="mt-1">© 2026 孩子守护者</p>
      </div>
    </div>
  )
}
