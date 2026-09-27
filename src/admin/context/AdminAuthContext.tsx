/* eslint-disable react-refresh/only-export-components -- Provider 与 useAdminAuth 就近导出是 React Context 的标准模式；拆成 context/Provider/hook 三个文件只为满足该规则属于过度设计（家长端 AuthContext 同此处理） */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { api } from '../api'
import {
  UNAUTHORIZED_EVENT,
  clearStoredAdmin,
  clearToken,
  getToken,
  setStoredAdmin,
  setToken,
  type StoredAdmin,
} from '../api/client'

interface AdminAuthValue {
  admin: StoredAdmin | null
  /** 首次校验登录态期间为 true */
  loading: boolean
  login: (username: string, password: string) => Promise<StoredAdmin>
  logout: (options?: { silent?: boolean }) => void
  /** 是否为超级管理员（决定是否显示「管理员」菜单与相关操作） */
  isSuper: boolean
}

const AdminAuthContext = createContext<AdminAuthValue | undefined>(undefined)

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<StoredAdmin | null>(null)
  const [loading, setLoading] = useState(true)

  const logout = useCallback((options?: { silent?: boolean }) => {
    clearToken()
    clearStoredAdmin()
    setAdmin(null)
    if (!options?.silent) toast.success('已退出登录')
  }, [])

  /** 令牌失效（后端 401）→ 统一登出，页面由路由守卫自动跳登录页。 */
  useEffect(() => {
    const onUnauthorized = () => {
      clearToken()
      clearStoredAdmin()
      setAdmin(null)
      toast.error('登录已过期，请重新登录')
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  /**
   * 启动时校验会话。
   * 这里**真的**向后端要一次 profile，而不是只信 localStorage 里的缓存 ——
   * 否则管理员被禁用/删除后，本地缓存仍会让页面显示为已登录。
   */
  useEffect(() => {
    let cancelled = false

    const restore = async () => {
      const token = getToken()
      if (!token) {
        setLoading(false)
        return
      }
      try {
        const profile = await api.auth.profile()
        if (cancelled) return
        setStoredAdmin(profile)
        setAdmin(profile)
      } catch {
        if (cancelled) return
        // 令牌无效或后端不可达：清掉本地状态，回到登录页
        clearToken()
        clearStoredAdmin()
        setAdmin(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void restore()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.auth.login(username, password)
    setToken(res.token)
    setStoredAdmin(res.admin)
    setAdmin(res.admin)
    return res.admin
  }, [])

  return (
    <AdminAuthContext.Provider
      value={{
        admin,
        loading,
        login,
        logout,
        isSuper: admin?.role === 'super',
      }}
    >
      {children}
    </AdminAuthContext.Provider>
  )
}

export function useAdminAuth(): AdminAuthValue {
  const ctx = useContext(AdminAuthContext)
  if (!ctx) throw new Error('useAdminAuth 必须在 AdminAuthProvider 内部使用')
  return ctx
}
