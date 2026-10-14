/* eslint-disable react-refresh/only-export-components -- Provider 与 useAuth 就近导出是 React Context 的标准模式；拆分会迫使所有调用方多一次导入 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  ApiError,
  authApi,
  setAuthToken,
  setUnauthorizedHandler,
  toUserMessage,
  userApi,
  wechatApi,
} from '@/services/api'
import type { User } from '@/types'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'

interface AuthContextValue {
  user: User | null
  /** 首次校验登录态期间为 true，避免受保护路由误跳登录页 */
  loading: boolean
  login: (phone: string, password: string) => Promise<boolean>
  smsLogin: (phone: string, code: string, inviteCode?: string) => Promise<boolean>
  register: (phone: string, password: string, code: string, inviteCode?: string) => Promise<boolean>
  sendCode: (phone: string, purpose?: 'register' | 'login' | 'bind') => Promise<string | null>
  /** 轮询微信扫码状态，成功后落地登录 */
  wechatPoll: (state: string) => Promise<boolean>
  wechatCreateQr: typeof wechatApi.createQr
  wechatDevScan: typeof wechatApi.devScan
  logout: (options?: { silent?: boolean }) => void
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const logout = useCallback((options?: { silent?: boolean }) => {
    setAuthToken(null)
    setUser(null)
    if (!options?.silent) toast.success(t('已退出登录'))
  }, [t])

  /**
   * 令牌失效的集中处理：API 层已经在 401 时清掉本地凭证，
   * 这里只负责把内存里的 user 一并清空（路由守卫据此跳登录页）。
   */
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null)
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  // 首次挂载：用已存的令牌换取用户信息，验证登录态是否仍然有效
  useEffect(() => {
    let cancelled = false

    const restore = async () => {
      const token = localStorage.getItem('balloon_dog_token')
      if (!token) {
        setLoading(false)
        return
      }
      setAuthToken(token)

      /*
       * 只有 401/403 才说明「令牌真的失效了」，那时才清凭证。
       *
       * 这里以前不分青红皂白，任何异常都走 setAuthToken(null) + setUser(null)：
       * 于是限流 429、后端 5xx、一次网络抖动，统统被当成「登录已过期」，
       * 用户被踢回登录页、本地令牌也被删掉，只能重新输一遍密码。
       * 那些都不是登录态失效，只是这一次请求没成功，退避重试一下就该恢复。
       */
      const MAX_ATTEMPTS = 3
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          const profile = await userApi.getProfile()
          if (!cancelled) setUser(profile)
          break
        } catch (error) {
          if (cancelled) break

          const authFailed =
            error instanceof ApiError && (error.status === 401 || error.status === 403)
          if (authFailed) {
            // 令牌过期/账号被禁用：静默清理，不要弹错误打扰用户
            setAuthToken(null)
            setUser(null)
            break
          }

          if (attempt < MAX_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
            continue
          }
          /*
           * 重试后仍然失败（离线、后端 5xx、被限流 429）：保留本地令牌。
           * 清掉凭证会把「服务端抖了一下」升级成「必须重新登录」；留着它，
           * 用户刷新一次页面就能恢复。
           */
          console.error('恢复登录态失败（已保留本地凭证，可刷新重试）：', error)
        }
      }

      if (!cancelled) setLoading(false)
    }

    void restore()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (phone: string, password: string) => {
    try {
      const res = await authApi.login({ phone, password })
      setAuthToken(res.token)
      setUser(res.user)
      toast.success(t('登录成功'))
      return true
    } catch (error) {
      toast.error(toUserMessage(error, t('登录失败，请稍后重试')))
      return false
    }
  }, [t])

  const smsLogin = useCallback(async (phone: string, code: string, inviteCode?: string) => {
    try {
      const res = await authApi.smsLogin({ phone, code, ...(inviteCode ? { inviteCode } : {}) })
      setAuthToken(res.token)
      setUser(res.user)
      toast.success(res.isNew ? t('账号已创建，欢迎使用') : t('登录成功'))
      return true
    } catch (error) {
      toast.error(toUserMessage(error, t('登录失败，请稍后重试')))
      return false
    }
  }, [t])

  const register = useCallback(async (phone: string, password: string, code: string, inviteCode?: string) => {
    try {
      const res = await authApi.register({ phone, password, code, ...(inviteCode ? { inviteCode } : {}) })
      setAuthToken(res.token)
      setUser(res.user)
      toast.success(t('注册成功'))
      return true
    } catch (error) {
      toast.error(toUserMessage(error, t('注册失败，请稍后重试')))
      return false
    }
  }, [t])

  /** 发送验证码；联调模式下返回 devCode 供页面提示（生产环境为 null）。 */
  const sendCode = useCallback(async (phone: string, purpose: 'register' | 'login' | 'bind' = 'register') => {
    try {
      const res = await authApi.sendCode(phone, purpose)
      toast.success(res.message || t('验证码已发送'))
      return res.devCode ?? null
    } catch (error) {
      toast.error(toUserMessage(error, t('发送验证码失败')))
      return null
    }
  }, [t])

  /**
   * 轮询一次微信扫码状态。
   * 注意：原实现是前端 Math.random() 造一个 openid 直接调登录接口，
   * 结果每次登录都会创建新账号、永远找不回数据。现在走真实的
   * 「建会话 → 轮询 → 后端回调换 openid」流程。
   */
  const wechatPoll = useCallback(async (state: string) => {
    try {
      const res = await wechatApi.poll(state)
      if (res.status === 'done' && res.token) {
        setAuthToken(res.token)
        if (res.user) {
          setUser(res.user)
        } else {
          // 后端只回 token 时补拉一次用户信息
          try {
            setUser(await userApi.getProfile())
          } catch {
            /* 让后续请求的 401 处理兜底 */
          }
        }
        toast.success(t('微信登录成功'))
        return true
      }
      return false
    } catch (error) {
      // 二维码过期是常见情况，提示一次即可，不打断轮询外的其它 UI
      toast.error(toUserMessage(error, t('微信登录失败')))
      return false
    }
  }, [t])

  const refreshUser = useCallback(async () => {
    try {
      setUser(await userApi.getProfile())
    } catch (error) {
      console.error('刷新用户信息失败：', error)
    }
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        smsLogin,
        register,
        sendCode,
        wechatPoll,
        wechatCreateQr: wechatApi.createQr,
        wechatDevScan: wechatApi.devScan,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth 必须在 AuthProvider 内部使用')
  }
  return context
}
