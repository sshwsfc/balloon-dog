import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MapPin, Home, School, Building, Clock, Phone, Navigation, ChevronRight } from 'lucide-react'

interface Location {
  id: string
  address: string
  time: string
  type: 'home' | 'school' | 'other'
  icon: typeof Home
}

const locations: Location[] = [
  {
    id: '1',
    address: '北京市朝阳区望京SOHO',
    time: '5分钟前',
    type: 'other',
    icon: Building,
  },
  {
    id: '2',
    address: '北京市海淀区中关村第一小学',
    time: '3小时前',
    type: 'school',
    icon: School,
  },
  {
    id: '3',
    address: '北京市朝阳区望京西园四区',
    time: '昨天 18:30',
    type: 'home',
    icon: Home,
  },
]

export function LocationPage() {
  return (
    <div className="min-h-screen pb-20 bg-gray-100">
      <div className="bg-white px-4 py-4 border-b border-gray-200">
        <h1 className="text-xl font-medium text-gray-900">位置监控</h1>
      </div>

      <div className="px-3 py-3">
        <Card className="overflow-hidden">
          <div className="bg-gradient-to-br from-green-400 to-green-600 h-48 flex items-center justify-center">
            <div className="text-center text-white">
              <MapPin className="w-12 h-12 mx-auto mb-2" />
              <p className="text-base font-medium px-4">北京市朝阳区望京SOHO</p>
              <p className="text-xs opacity-80 mt-1">当前位置</p>
            </div>
          </div>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Clock className="w-4 h-4 text-gray-400" />
                <span className="text-sm text-gray-500">5分钟前更新</span>
              </div>
              <Badge className="bg-[#07c160] text-white text-xs">在线</Badge>
            </div>
            <div className="flex space-x-2 mt-4">
              <Button className="flex-1 h-9 text-sm bg-[#07c160] hover:bg-[#06a050]">
                <Navigation className="w-4 h-4 mr-1.5" />
                导航
              </Button>
              <Button className="flex-1 h-9 text-sm" variant="outline">
                <Phone className="w-4 h-4 mr-1.5" />
                呼叫
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="px-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">历史轨迹</span>
        </div>
        <Card>
          <CardContent className="p-0">
            {locations.map((location, index) => {
              const Icon = location.icon
              const typeColors = {
                home: 'text-blue-500 bg-blue-50',
                school: 'text-green-500 bg-green-50',
                other: 'text-orange-500 bg-orange-50',
              }
              const typeLabels = {
                home: '家',
                school: '学校',
                other: '其他',
              }
              
              return (
                <div key={location.id}>
                  <div className="flex items-start space-x-3 p-4 hover:bg-gray-50 active:bg-gray-100 transition-colors">
                    <div className={`w-10 h-10 rounded-lg ${typeColors[location.type]} flex items-center justify-center flex-shrink-0`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <h4 className="font-medium text-gray-900 text-sm">{location.address}</h4>
                        <Badge variant="outline" className="text-xs px-2 py-0.5 border-gray-200 text-gray-500">
                          {typeLabels[location.type]}
                        </Badge>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">{location.time}</p>
                    </div>
                  </div>
                  {index < locations.length - 1 && (
                    <div className="mx-4 border-t border-gray-100" />
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>
      </div>

      <div className="px-3 mt-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">安全区域</span>
        </div>
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center">
                  <Home className="w-5 h-5 text-blue-500" />
                </div>
                <div>
                  <h4 className="font-medium text-gray-900 text-sm">家</h4>
                  <p className="text-xs text-gray-400 mt-0.5">望京西园四区</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300" />
            </div>
            <div className="mx-4 border-t border-gray-100" />
            <div className="flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-green-50 rounded-lg flex items-center justify-center">
                  <School className="w-5 h-5 text-green-500" />
                </div>
                <div>
                  <h4 className="font-medium text-gray-900 text-sm">学校</h4>
                  <p className="text-xs text-gray-400 mt-0.5">中关村第一小学</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300" />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
