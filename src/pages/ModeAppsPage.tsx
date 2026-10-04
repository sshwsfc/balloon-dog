import { useCallback, useEffect, useMemo, useState } from 'react'
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
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Check,
  Info,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
  X,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { DeviceApp, ModeApp, ModeAppGroup, ModeAppListResponse } from '@/types'

const GROUP_META: Record<ModeAppGroup, { label: string; desc: string; emptyHint: string }> = {
  study: {
    label: '学习模式',
    desc: '学习模式下允许使用这些应用，其他应用都会被拦下。',
    emptyHint: '白名单为空时，学习模式下所有应用都会被拦下。',
  },
  normal: {
    label: '普通模式',
    desc: '这些是普通模式专用应用；它们不在学习模式白名单里，学习模式下会被拦下。',
    emptyHint: '还没有标记普通模式专用应用。',
  },
}

export function ModeAppsPage() {
  const navigate = useNavigate()

  const [tab, setTab] = useState<ModeAppGroup>('study')
  const [modeApps, setModeApps] = useState<ModeAppListResponse | null>(null)
  /** null = 读取失败；[] = 设备确实还没有上报过应用 */
  const [deviceApps, setDeviceApps] = useState<DeviceApp[] | null>(null)
  const [search, setSearch] = useState('')
  const [includeSystem, setIncludeSystem] = useState(false)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)

  /**
   * 设备应用清单与模式分组一起加载。
   * `includeSystem` 变化时会重新拉取设备应用（后端的搜索/系统应用过滤是查询参数）。
   */
  const loadData = useCallback(
    async (options?: { silent?: boolean }) => {
      try {
        const [appsData, modeData] = await Promise.all([
          api.getDeviceApps({ includeSystem }),
          api.getModeApps(),
        ])
        setDeviceApps(appsData.apps ?? [])
        setModeApps(modeData)
        setError(null)
      } catch (err) {
        const message = toUserMessage(err, '加载应用列表失败')
        setError(message)
        if (!options?.silent) toast.error(message)
      } finally {
        setLoading(false)
      }
    },
    [includeSystem],
  )

  useEffect(() => {
    void loadData()
  }, [loadData])

  /** 增删之后只需要重拉分组，设备应用清单不会因此变化 */
  const reloadModeApps = useCallback(async () => {
    const data = await api.getModeApps()
    setModeApps(data)
  }, [])

  const activeList = useMemo(
    () => (tab === 'study' ? modeApps?.study : modeApps?.normal) ?? [],
    [modeApps, tab],
  )
  const activeByPackage = useMemo(
    () => new Map(activeList.map((app) => [app.packageName, app])),
    [activeList],
  )
  const otherPackages = useMemo(() => {
    const list = (tab === 'study' ? modeApps?.normal : modeApps?.study) ?? []
    return new Set(list.map((app) => app.packageName))
  }, [modeApps, tab])

  const filteredApps = useMemo(() => {
    const list = deviceApps ?? []
    const keyword = search.trim().toLowerCase()
    if (!keyword) return list
    return list.filter(
      (app) =>
        app.appName.toLowerCase().includes(keyword) ||
        app.packageName.toLowerCase().includes(keyword),
    )
  }, [deviceApps, search])

  /** 当前筛选结果里还没被加入本组的应用（「全选」只作用于这一个范围） */
  const pendingApps = useMemo(
    () => filteredApps.filter((app) => !activeByPackage.has(app.packageName)),
    [filteredApps, activeByPackage],
  )

  const handleAdd = async (app: DeviceApp) => {
    setBusyKey(app.packageName)
    try {
      await api.addModeApp({ packageName: app.packageName, appName: app.appName, group: tab })
      await reloadModeApps()
      toast.success(`已加入「${GROUP_META[tab].label}」：${app.appName || app.packageName}`)
    } catch (err) {
      toast.error(toUserMessage(err, '加入失败，请稍后重试'))
      console.error('加入模式应用失败：', err)
    } finally {
      setBusyKey(null)
    }
  }

  const handleRemove = async (app: ModeApp) => {
    setBusyKey(app.packageName)
    try {
      await api.deleteModeApp(app.id)
      await reloadModeApps()
      toast.success(`已移出「${GROUP_META[tab].label}」：${app.appName || app.packageName}`)
    } catch (err) {
      toast.error(toUserMessage(err, '移出失败，请稍后重试'))
      console.error('移出模式应用失败：', err)
    } finally {
      setBusyKey(null)
    }
  }

  /**
   * 全选：逐个调用新增接口。
   *
   * 后端没有批量新增分组应用的接口，只能循环；所以先弹确认框把数量讲清楚，
   * 避免家长误点之后要一个个点回来。
   */
  const handleBulkAdd = async () => {
    const targets = pendingApps
    if (targets.length === 0) {
      setBulkConfirmOpen(false)
      toast.info('当前列表里的应用都已在本组中')
      return
    }
    setBulkBusy(true)
    let done = 0
    let failed = 0
    for (const app of targets) {
      try {
        await api.addModeApp({ packageName: app.packageName, appName: app.appName, group: tab })
        done += 1
      } catch {
        failed += 1
      }
    }
    await reloadModeApps().catch(() => undefined)
    setBulkBusy(false)
    setBulkConfirmOpen(false)
    if (failed === 0) toast.success(`已把 ${done} 个应用加入「${GROUP_META[tab].label}」`)
    else toast.warning(`成功 ${done} 个，失败 ${failed} 个，请重试失败的部分`)
  }

  /** 「刷新应用列表」走的是指令队列，设备离线时会排队而不是立刻生效 */
  const handleRefreshApps = async () => {
    setRefreshing(true)
    try {
      const result = await api.refreshDeviceApps()
      if (result.noop) toast.info('设备已处于该状态，无需操作')
      else if (result.warning) toast.warning(result.warning)
      else toast.success('已请求设备重新上报应用列表，设备在线时通常几秒内完成')
      await loadData({ silent: true })
    } catch (err) {
      toast.error(toUserMessage(err, '下发刷新指令失败'))
      console.error('刷新应用列表失败：', err)
    } finally {
      setRefreshing(false)
    }
  }

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

  if (error && !deviceApps && !modeApps) {
    return (
      <div className="page-shell page-shell--wide">
        <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-xl font-medium text-gray-900 flex-1">选择应用</h1>
        </div>
        <div className="px-6 py-20 text-center">
          <Smartphone className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-700">{error}</p>
          <Button
            className="mt-4 bg-[#07c160] hover:bg-[#06a050]"
            onClick={() => {
              setLoading(true)
              void loadData()
            }}
          >
            重新加载
          </Button>
        </div>
      </div>
    )
  }

  const meta = GROUP_META[tab]

  return (
    <div className="page-shell page-shell--wide">
      <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1">选择应用</h1>
        <button
          type="button"
          onClick={() => void loadData({ silent: true })}
          className="text-gray-400 p-1"
          aria-label="刷新"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      {/* ---------------- 分组切换 ---------------- */}
      <div className="px-3 py-3">
        <div className="grid grid-cols-2 gap-2 p-1 bg-gray-200 rounded-lg">
          {(['study', 'normal'] as ModeAppGroup[]).map((group) => (
            <button
              key={group}
              type="button"
              onClick={() => setTab(group)}
              className={`py-2 rounded-md text-sm font-medium transition-colors ${
                tab === group ? 'bg-white text-[#07c160] shadow-sm' : 'text-gray-500'
              }`}
            >
              {GROUP_META[group].label}
              <span className="text-xs text-gray-400 ml-1">
                {(group === 'study' ? modeApps?.study.length : modeApps?.normal.length) ?? 0}
              </span>
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-2 leading-relaxed px-1">{meta.desc}</p>
      </div>

      {error && (
        <div className="px-3">
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-start space-x-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-700 flex-1">{error}</p>
            <button
              type="button"
              className="text-xs text-[#07c160] flex-shrink-0"
              onClick={() => void loadData({ silent: true })}
            >
              重试
            </button>
          </div>
        </div>
      )}

      {/* ---------------- 搜索与操作 ---------------- */}
      <div className="px-3 mt-3">
        <Card className="overflow-hidden">
          <CardContent className="p-3 space-y-3">
            <div className="flex items-center space-x-2">
              <div className="flex-1 flex items-center space-x-2 border border-gray-300 rounded-lg px-3 py-2 focus-within:border-[#07c160]">
                <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索应用名或包名"
                  className="flex-1 min-w-0 text-sm focus:outline-none"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="text-gray-400 p-0.5"
                    aria-label="清空搜索"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setBulkConfirmOpen(true)}
                disabled={bulkBusy || pendingApps.length === 0}
              >
                <Check className="w-3.5 h-3.5 mr-1" />
                全选加入（{pendingApps.length}）
              </Button>
              <Button size="sm" variant="outline" onClick={() => void handleRefreshApps()} disabled={refreshing}>
                {refreshing ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5 mr-1" />
                )}
                刷新应用列表
              </Button>
              <label className="flex items-center space-x-1.5 text-xs text-gray-500 ml-auto">
                <input
                  type="checkbox"
                  checked={includeSystem}
                  onChange={(e) => setIncludeSystem(e.target.checked)}
                  className="accent-[#07c160]"
                />
                显示系统应用
              </label>
            </div>

            <p className="text-[11px] text-gray-400 leading-relaxed">
              「刷新应用列表」是给设备下发一条指令：设备必须在线，Agent 重新读取已安装应用后再上报，
              所以不是立刻生效。列表里没有想找的应用时，先确认孩子设备在线再刷新。
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 设备应用清单 ---------------- */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">设备应用</span>
          <span className="text-xs text-gray-400">
            {deviceApps === null ? '读取失败' : `共 ${filteredApps.length} 个`}
          </span>
        </div>

        {deviceApps === null ? (
          <Card className="overflow-hidden">
            <CardContent className="p-6 text-center">
              <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto mb-2" />
              <p className="text-sm text-gray-500">应用清单读取失败，请点上方「刷新应用列表」或稍后重试。</p>
            </CardContent>
          </Card>
        ) : deviceApps.length === 0 ? (
          <Card className="overflow-hidden">
            <CardContent className="p-6 text-center">
              <Smartphone className="w-10 h-10 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-600 font-medium">该设备尚未上报应用列表</p>
              <p className="text-xs text-gray-500 mt-2 leading-relaxed">
                请确认孩子设备端 Agent 在线后点「刷新应用列表」。
                如果你只想看系统应用，也可以勾选上面的「显示系统应用」。
              </p>
              <Button
                className="mt-3 bg-[#07c160] hover:bg-[#06a050]"
                size="sm"
                onClick={() => void handleRefreshApps()}
                disabled={refreshing}
              >
                {refreshing ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5 mr-1" />
                )}
                刷新应用列表
              </Button>
            </CardContent>
          </Card>
        ) : filteredApps.length === 0 ? (
          <Card className="overflow-hidden">
            <CardContent className="p-6 text-center">
              <Search className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">没有匹配「{search}」的应用</p>
            </CardContent>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <CardContent className="p-0">
              {filteredApps.map((app, index) => {
                const inGroup = activeByPackage.get(app.packageName)
                const inOtherGroup = otherPackages.has(app.packageName)
                const busy = busyKey === app.packageName
                const displayName = app.appName || app.packageName
                return (
                  <div key={app.id}>
                    <div className="flex items-center py-3 px-4">
                      <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center text-sm text-gray-600 font-medium flex-shrink-0">
                        {displayName.slice(0, 1)}
                      </div>
                      <div className="flex-1 min-w-0 ml-3">
                        <div className="flex items-center space-x-1.5 min-w-0">
                          <span className="text-sm text-gray-900 truncate">{displayName}</span>
                          {app.isSystem && (
                            <Badge className="bg-gray-100 text-gray-500 text-[10px] flex-shrink-0">系统</Badge>
                          )}
                          {inOtherGroup && !inGroup && (
                            <Badge className="bg-blue-50 text-blue-600 text-[10px] flex-shrink-0">
                              {tab === 'study' ? '普通模式专用' : '已在学习白名单'}
                            </Badge>
                          )}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate mt-0.5">{app.packageName}</div>
                      </div>

                      {busy ? (
                        <Loader2 className="w-4 h-4 animate-spin text-[#07c160] flex-shrink-0 ml-2" />
                      ) : inGroup ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-shrink-0 ml-2 text-red-500 border-red-200"
                          disabled={bulkBusy}
                          onClick={() => void handleRemove(inGroup)}
                        >
                          <Minus className="w-3.5 h-3.5 mr-0.5" />
                          取消
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          className="flex-shrink-0 ml-2 bg-[#07c160] hover:bg-[#06a050]"
                          disabled={bulkBusy}
                          onClick={() => void handleAdd(app)}
                        >
                          <Plus className="w-3.5 h-3.5 mr-0.5" />
                          加入
                        </Button>
                      )}
                    </div>
                    {index < filteredApps.length - 1 && <div className="mx-4 border-t border-gray-100" />}
                  </div>
                )
              })}
            </CardContent>
          </Card>
        )}
      </div>

      {/* ---------------- 当前分组 ---------------- */}
      <div className="px-3 mt-3">
        <div className="mb-2 px-1">
          <span className="text-sm font-medium text-gray-500">
            已加入「{meta.label}」（{activeList.length}）
          </span>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-4">
            {activeList.length === 0 ? (
              <div className="text-center py-2">
                <BookOpen className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-500">{meta.emptyHint}</p>
              </div>
            ) : (
              <div className="flex flex-wrap gap-x-3 gap-y-2">
                {activeList.map((app) => (
                  <div key={app.id} className="flex items-center space-x-1.5">
                    <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center text-xs text-[#07c160] font-medium">
                      {(app.appName || app.packageName).slice(0, 1)}
                    </div>
                    <span className="text-xs text-gray-700 max-w-[80px] truncate">
                      {app.appName || app.packageName}
                    </span>
                    <button
                      type="button"
                      aria-label={`移出 ${app.appName || app.packageName}`}
                      className="text-gray-300 hover:text-red-500 p-0.5"
                      disabled={busyKey === app.packageName}
                      onClick={() => void handleRemove(app)}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="px-3 mt-3">
        <div className="bg-white rounded-lg p-3 border border-gray-100">
          <div className="flex items-start space-x-2">
            <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-gray-500 leading-relaxed space-y-1">
              <p className="font-medium text-gray-700">两组应用的区别</p>
              <p>· <b>学习模式</b>：白名单，学习模式下允许使用。</p>
              <p>
                · <b>普通模式</b>：普通模式专用清单，只是把它们标记出来；
                不在学习白名单里的应用，学习模式下一样会被拦下。
              </p>
              <p>· 既不在任何一组的应用，学习模式下默认被拦（更安全的一侧）。</p>
            </div>
          </div>
        </div>
      </div>

      {/* ---------------- 全选确认 ---------------- */}
      <Dialog open={bulkConfirmOpen} onOpenChange={(open) => !bulkBusy && setBulkConfirmOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>全选加入「{GROUP_META[tab].label}」</DialogTitle>
          </DialogHeader>
          <p className="text-gray-600">
            将把当前筛选结果里尚未加入的 <b>{pendingApps.length}</b> 个应用逐个加入
            「{GROUP_META[tab].label}」。接口没有批量提交，数量较多时需要等待一会儿。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkConfirmOpen(false)} disabled={bulkBusy}>
              取消
            </Button>
            <Button
              className="bg-[#07c160] hover:bg-[#06a050]"
              onClick={() => void handleBulkAdd()}
              disabled={bulkBusy}
            >
              {bulkBusy ? '加入中…' : '确认加入'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
