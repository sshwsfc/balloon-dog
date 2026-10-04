import { useCallback, useEffect, useState } from 'react'
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
  Building,
  Clock,
  Home,
  MapPin,
  Navigation,
  Plus,
  RefreshCw,
  School,
  Shield,
  Trash2,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { LocationPoint, SafeZone, ZoneType } from '@/types'

const ZONE_ICON: Record<ZoneType, typeof Home> = {
  home: Home,
  school: School,
  other: Building,
}

const ZONE_LABEL: Record<ZoneType, string> = {
  home: '家',
  school: '学校',
  other: '其它',
}

const ZONE_COLOR: Record<ZoneType, string> = {
  home: 'bg-green-100 text-green-700',
  school: 'bg-blue-100 text-blue-700',
  other: 'bg-gray-100 text-gray-600',
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return '刚刚'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return `昨天 ${new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  return `${days}天前`
}

/** 常用地点坐标（新增安全区时的快捷填充，避免用户手敲经纬度） */
const PRESETS: { name: string; type: ZoneType; latitude: number; longitude: number; address: string }[] = [
  { name: '家', type: 'home', latitude: 39.9955, longitude: 116.4709, address: '北京市朝阳区望京西园四区' },
  { name: '学校', type: 'school', latitude: 39.9836, longitude: 116.3164, address: '北京市海淀区中关村第一小学' },
]

/**
 * 位置监控。
 * 原实现把这 3 条位置数据写死在组件里 —— 后端有 locations/safeZones 表却没有任何接口。
 * 现在全部走真实接口：轨迹来自设备上报，类型由后端按安全区自动判定（haversine 距离）。
 */
export function LocationPage() {
  const [locations, setLocations] = useState<LocationPoint[]>([])
  const [zones, setZones] = useState<SafeZone[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [zoneDialogOpen, setZoneDialogOpen] = useState(false)
  const [zoneName, setZoneName] = useState('')
  const [zoneType, setZoneType] = useState<ZoneType>('other')
  const [zoneRadius, setZoneRadius] = useState('200')
  const [zoneLat, setZoneLat] = useState('')
  const [zoneLng, setZoneLng] = useState('')
  const [zoneAddress, setZoneAddress] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<SafeZone | null>(null)

  const load = useCallback(async () => {
    try {
      const [locationRes, zoneRes] = await Promise.all([
        api.getLocations({ limit: 100 }),
        api.getSafeZones(),
      ])
      setLocations(locationRes.locations ?? [])
      setZones(zoneRes.safeZones ?? [])
      setError(null)
    } catch (err) {
      setError(toUserMessage(err, '加载位置信息失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const latest = locations[0] ?? null

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setZoneName(preset.name)
    setZoneType(preset.type)
    setZoneLat(String(preset.latitude))
    setZoneLng(String(preset.longitude))
    setZoneAddress(preset.address)
  }

  const handleCreateZone = async () => {
    const latitude = Number(zoneLat)
    const longitude = Number(zoneLng)
    const radiusMeters = Number.parseInt(zoneRadius, 10)

    if (!zoneName.trim()) {
      toast.error('请输入安全区名称')
      return
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      toast.error('请输入有效的经纬度')
      return
    }
    if (!Number.isFinite(radiusMeters) || radiusMeters < 50) {
      toast.error('半径至少 50 米')
      return
    }

    setSubmitting(true)
    try {
      await api.createSafeZone({
        name: zoneName.trim(),
        latitude,
        longitude,
        radiusMeters,
        address: zoneAddress.trim() || undefined,
        type: zoneType,
      })
      toast.success('安全区已创建')
      setZoneDialogOpen(false)
      resetZoneForm()
      await load()
    } catch (err) {
      toast.error(toUserMessage(err, '创建安全区失败'))
    } finally {
      setSubmitting(false)
    }
  }

  const resetZoneForm = () => {
    setZoneName('')
    setZoneType('other')
    setZoneRadius('200')
    setZoneLat('')
    setZoneLng('')
    setZoneAddress('')
  }

  const handleRemoveZone = async () => {
    if (!removeTarget) return
    try {
      await api.deleteSafeZone(removeTarget.id)
      toast.success('安全区已删除')
      setRemoveTarget(null)
      await load()
    } catch (err) {
      toast.error(toUserMessage(err, '删除失败'))
    }
  }

  /** 用第三方地图打开该坐标（移动端会唤起对应 App） */
  const openInMap = (latitude: number, longitude: number, name: string) => {
    const url = `https://uri.amap.com/marker?position=${longitude},${latitude}&name=${encodeURIComponent(name)}`
    window.open(url, '_blank', 'noopener')
  }

  if (loading) {
    return (
      <div className="page-shell page-shell--center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]" />
          <p className="mt-2 text-gray-500 text-sm">加载中...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="page-shell">
        <div className="page-header flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
          <h1 className="text-xl font-medium text-gray-900">位置监控</h1>
        </div>
        <div className="px-6 py-20 text-center">
          <MapPin className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-700">{error}</p>
          <Button
            className="mt-4 bg-[#07c160] hover:bg-[#06a050]"
            onClick={() => {
              setLoading(true)
              void load()
            }}
          >
            重新加载
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="page-shell">
      <div className="page-header flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
        <h1 className="text-xl font-medium text-gray-900">位置监控</h1>
        <button type="button" onClick={() => void load()} className="text-gray-400 p-1" aria-label="刷新">
          <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      {/* 最新位置 */}
      <div className="px-3 py-3">
        <Card className="overflow-hidden">
          <div className="bg-gradient-to-br from-green-400 to-green-600 h-40 flex items-center justify-center relative">
            <div className="text-center text-white px-6">
              <MapPin className="w-10 h-10 mx-auto mb-2" />
              {latest ? (
                <>
                  <p className="text-base font-medium">{latest.address || '已获取定位'}</p>
                  <p className="text-xs opacity-80 mt-1">
                    {relativeTime(latest.timestamp)}
                    {latest.zoneName ? ` · 在「${latest.zoneName}」范围内` : ''}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-base font-medium">暂无定位记录</p>
                  <p className="text-xs opacity-80 mt-1">设备上报位置后会显示在这里</p>
                </>
              )}
            </div>
            {latest && (
              <button
                type="button"
                onClick={() => openInMap(latest.latitude, latest.longitude, latest.address || '孩子位置')}
                className="absolute right-3 bottom-3 bg-white/20 backdrop-blur rounded-full px-3 py-1.5 text-xs text-white flex items-center"
              >
                <Navigation className="w-3.5 h-3.5 mr-1" />
                地图查看
              </button>
            )}
          </div>
          {latest && (
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Clock className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-gray-500">{relativeTime(latest.timestamp)}更新</span>
                </div>
                <Badge className={ZONE_COLOR[latest.type]}>{ZONE_LABEL[latest.type]}</Badge>
              </div>
              <p className="text-[11px] text-gray-400 mt-2 font-mono">
                {latest.latitude.toFixed(5)}, {latest.longitude.toFixed(5)}
                {latest.accuracy > 0 ? ` · 精度约 ${Math.round(latest.accuracy)} 米` : ''}
              </p>
            </CardContent>
          )}
        </Card>
      </div>

      {/* 安全区 */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">安全区</span>
          <button
            type="button"
            className="text-xs text-[#07c160] flex items-center"
            onClick={() => setZoneDialogOpen(true)}
          >
            <Plus className="w-3.5 h-3.5 mr-0.5" />
            添加
          </button>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {zones.length === 0 ? (
              <div className="p-6 text-center">
                <Shield className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-500">
                  还没有安全区。添加「家」和「学校」后，定位会自动标注孩子是否在范围内。
                </p>
              </div>
            ) : (
              zones.map((zone, index) => {
                const Icon = ZONE_ICON[zone.type]
                return (
                  <div key={zone.id}>
                    <div className="flex items-center py-3 px-4">
                      <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center flex-shrink-0">
                        <Icon className="w-5 h-5 text-gray-500" />
                      </div>
                      <div className="flex-1 min-w-0 ml-3">
                        <div className="flex items-center space-x-2">
                          <span className="font-medium text-gray-900 text-sm">{zone.name}</span>
                          <Badge className={`${ZONE_COLOR[zone.type]} text-[10px]`}>
                            {ZONE_LABEL[zone.type]}
                          </Badge>
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5 truncate">
                          {zone.address || '未填写地址'} · 半径 {zone.radiusMeters} 米
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setRemoveTarget(zone)}
                        className="text-gray-300 hover:text-red-500 p-1.5"
                        aria-label={`删除 ${zone.name}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    {index < zones.length - 1 && <div className="mx-4 border-t border-gray-100" />}
                  </div>
                )
              })
            )}
          </CardContent>
        </Card>
      </div>

      {/* 轨迹 */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">位置轨迹</span>
          <span className="text-xs text-gray-400">共 {locations.length} 条</span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {locations.length === 0 ? (
              <p className="text-center text-sm text-gray-400 py-8">暂无轨迹记录</p>
            ) : (
              <div className="px-4 py-2">
                {locations.map((location, index) => {
                  const Icon = ZONE_ICON[location.type]
                  return (
                    <div key={location.id} className="flex">
                      <div className="flex flex-col items-center mr-3 pt-3">
                        <div className="w-2 h-2 rounded-full bg-[#07c160] flex-shrink-0" />
                        {index < locations.length - 1 && <div className="w-px flex-1 bg-gray-200 my-1" />}
                      </div>
                      <div className="flex-1 py-3 border-b border-gray-50 last:border-0 min-w-0">
                        <div className="flex items-start justify-between">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-gray-900 truncate">
                              {location.address || `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`}
                            </p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {new Date(location.timestamp).toLocaleString('zh-CN')}
                              {location.zoneName ? ` · 位于「${location.zoneName}」` : ''}
                            </p>
                          </div>
                          <Badge className={`${ZONE_COLOR[location.type]} text-[10px] ml-2 flex-shrink-0`}>
                            <Icon className="w-3 h-3 mr-0.5" />
                            {ZONE_LABEL[location.type]}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 新增安全区 */}
      <Dialog open={zoneDialogOpen} onOpenChange={setZoneDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加安全区</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="text-sm text-gray-600 mb-2">快捷填充</p>
              <div className="flex gap-2">
                {PRESETS.map((preset) => (
                  <Button
                    key={preset.name}
                    variant="outline"
                    size="sm"
                    onClick={() => applyPreset(preset)}
                    className={zoneName === preset.name ? 'border-[#07c160] text-[#07c160]' : ''}
                  >
                    {preset.name}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm text-gray-600 block mb-1.5">名称</label>
              <input
                type="text"
                value={zoneName}
                onChange={(e) => setZoneName(e.target.value)}
                placeholder="例如 奶奶家"
                maxLength={30}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
              />
            </div>

            <div>
              <label className="text-sm text-gray-600 block mb-1.5">类型</label>
              <div className="grid grid-cols-3 gap-2">
                {(['home', 'school', 'other'] as ZoneType[]).map((type) => (
                  <Button
                    key={type}
                    variant="outline"
                    onClick={() => setZoneType(type)}
                    className={zoneType === type ? 'border-[#07c160] text-[#07c160]' : ''}
                  >
                    {ZONE_LABEL[type]}
                  </Button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600 block mb-1.5">纬度</label>
                <input
                  type="number"
                  step="0.0001"
                  value={zoneLat}
                  onChange={(e) => setZoneLat(e.target.value)}
                  placeholder="39.9955"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600 block mb-1.5">经度</label>
                <input
                  type="number"
                  step="0.0001"
                  value={zoneLng}
                  onChange={(e) => setZoneLng(e.target.value)}
                  placeholder="116.4709"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
                />
              </div>
            </div>

            <div>
              <label className="text-sm text-gray-600 block mb-1.5">半径（米）</label>
              <input
                type="number"
                min={50}
                max={10000}
                value={zoneRadius}
                onChange={(e) => setZoneRadius(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
              />
            </div>

            <div>
              <label className="text-sm text-gray-600 block mb-1.5">地址（可选）</label>
              <input
                type="text"
                value={zoneAddress}
                onChange={(e) => setZoneAddress(e.target.value)}
                placeholder="便于识别的地址描述"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#07c160]"
              />
            </div>

            <p className="text-xs text-gray-400">
              提示：把「最新位置」的经纬度填入即可快速圈定当前位置周围的安全范围。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setZoneDialogOpen(false)} disabled={submitting}>
              取消
            </Button>
            <Button
              className="bg-[#07c160] hover:bg-[#06a050]"
              onClick={() => void handleCreateZone()}
              disabled={submitting}
            >
              {submitting ? '创建中…' : '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除安全区 */}
      <Dialog open={Boolean(removeTarget)} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除安全区</DialogTitle>
          </DialogHeader>
          <p className="text-gray-600">确定要删除「{removeTarget?.name}」吗？</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              取消
            </Button>
            <Button className="bg-red-500 hover:bg-red-600 text-white" onClick={() => void handleRemoveZone()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
