/* eslint-disable react-refresh/only-export-components -- Provider 与 useDevices / RequireDevice 就近导出是 React Context 的标准模式；拆分会迫使所有调用方多一次导入 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '@/services/api'
import { useAuth } from '@/contexts/AuthContext'
import { NoDeviceState } from '@/components/onboarding/NoDeviceState'
import type { Device } from '@/types'

/**
 * 「当前账号下有哪些设备」的共享状态。
 *
 * 为什么需要它：绝大多数页面都是**设备维度**的，没绑设备时后端会按业务规则返回
 * 404。逐个页面去 catch 这个 404 既啰嗦又容易漏，漏掉的那个页面就会朝新手
 * 弹一句红色错误 —— 而「还没绑设备」根本不是错误。
 *
 * 所以把判断收到一处：登录后拉一次设备列表，`RequireDevice` 统一决定是渲染
 * 页面还是渲染引导态。页面内部不需要再关心这件事。
 */
interface DeviceContextValue {
  devices: Device[]
  loading: boolean
  /** 拉取失败（网络/服务端问题）时的提示，与「没绑设备」区分开 */
  error: string | null
  /** 账号下是否至少有一台设备 */
  hasDevice: boolean
  reload: () => Promise<void>
}

const DeviceContext = createContext<DeviceContextValue | null>(null)

export function DeviceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [devices, setDevices] = useState<Device[]>([])
  /*
   * 初值必须是 true。
   *
   * 恢复登录态（AuthContext 的 loading）期间 user 还是 null，这一帧 devices
   * 必然是空数组。若 loading 为 false，RequireDevice 会立刻断言「这个账号没有
   * 设备」并渲染 NoDeviceState —— 而它在「一步没走、也没跳过」时会自动跳转到
   * /onboarding。现象就是：已经绑过设备的家长硬刷新 /location、/quiz-unlock
   * 这类设备页，被弹进新手引导。
   *
   * 所以「拉过一次设备列表」之前一律算加载中，不确定就什么都不判。
   */
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!user) {
      setDevices([])
      setError(null)
      // 还没拿到登录态，仍然处于「未知」，别让守卫据此下结论
      setLoading(true)
      return
    }
    setLoading(true)
    try {
      const res = await api.getDevices()
      setDevices(res.devices ?? [])
      setError(null)
    } catch {
      // 网络问题不该被当成「没绑设备」——那会把有设备的家长也推进引导页。
      // 这里只记错误，沿用已有列表，由页面自己的错误态去提示。
      setError('device-list-unavailable')
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    void reload()
  }, [reload])

  const value = useMemo<DeviceContextValue>(
    () => ({ devices, loading, error, hasDevice: devices.length > 0, reload }),
    [devices, loading, error, reload],
  )

  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>
}

export function useDevices(): DeviceContextValue {
  const ctx = useContext(DeviceContext)
  if (!ctx) throw new Error('useDevices 必须在 DeviceProvider 内部使用')
  return ctx
}

/**
 * 设备维度页面的守卫。
 *
 * - 设备列表还在加载 → 骨架，别闪一下引导页
 * - 确实一台设备都没有 → 渲染引导态（不是错误）
 * - 拉列表本身失败 → 放行，让页面按自己的错误态处理，避免误判
 * - 引导页/绑定页自己就是用来解决这个问题的，不要套这层守卫
 */
export function RequireDevice({ children }: { children: ReactNode }) {
  const { loading, hasDevice, error } = useDevices()
  const location = useLocation()

  if (loading && !error) return <DeviceGateSkeleton />
  if (!hasDevice && !error) {
    // 首页自己就渲染引导态，别再套一层
    if (location.pathname === '/') return <>{children}</>
    return <NoDeviceState />
  }
  return <>{children}</>
}

function DeviceGateSkeleton() {
  return (
    <div className="page-shell page-shell--center">
      <div className="text-center">
        <div className="inline-block h-8 w-8 animate-spin rounded-full border-b-2 border-[#07c160]" />
      </div>
    </div>
  )
}
