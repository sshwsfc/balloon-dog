import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { api, setAuthToken } from '@/services/api'
import { toast } from 'sonner'

interface User {
  id: string
  name: string
  phone?: string
  email?: string
  avatar?: string
  wechatOpenId?: string
  wechatNickname?: string
  wechatAvatar?: string
  createdAt: string
}

interface AuthContextType {
  user: User | null
  loading: boolean
  login: (phone: string, password: string) => Promise<boolean>
  register: (phone: string, password: string) => Promise<boolean>
  wechatLogin: (wechatOpenId: string, wechatNickname: string, wechatAvatar: string) => Promise<boolean>
  logout: () => void
  sendVerificationCode: (phone: string) => Promise<boolean>
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const checkAuth = async () => {
      const token = localStorage.getItem('auth_token')
      if (token) {
        try {
          setAuthToken(token)
          const userInfo = await api.getUserInfo()
          setUser(userInfo)
        } catch (error) {
          console.error('Failed to get user info:', error)
          setAuthToken(null)
        }
      }
      setLoading(false)
    }
    checkAuth()
  }, [])

  const login = async (phone: string, password: string): Promise<boolean> => {
    try {
      const response = await api.login({ phone, password })
      setAuthToken(response.token)
      setUser({
        ...response.user,
        createdAt: new Date().toISOString()
      })
      toast.success('登录成功')
      return true
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '登录失败，请稍后重试'
      toast.error(message)
      return false
    }
  }

  const register = async (phone: string, password: string): Promise<boolean> => {
    try {
      const response = await api.register({ phone, password })
      setAuthToken(response.token)
      setUser({
        ...response.user,
        createdAt: new Date().toISOString()
      })
      toast.success('注册成功')
      return true
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '注册失败，请稍后重试'
      toast.error(message)
      return false
    }
  }

  const wechatLogin = async (wechatOpenId: string, wechatNickname: string, wechatAvatar: string): Promise<boolean> => {
    try {
      const response = await api.wechatLogin(wechatOpenId, wechatNickname, wechatAvatar)
      setAuthToken(response.token)
      setUser({
        ...response.user,
        createdAt: new Date().toISOString()
      })
      toast.success('登录成功')
      return true
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '登录失败，请稍后重试'
      toast.error(message)
      return false
    }
  }

  const logout = () => {
    setAuthToken(null)
    setUser(null)
    toast.success('已退出登录')
  }

  const sendVerificationCode = async (phone: string): Promise<boolean> => {
    try {
      await api.sendVerificationCode(phone)
      toast.success('验证码已发送')
      return true
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '发送验证码失败'
      toast.error(message)
      return false
    }
  }

  const refreshUser = async () => {
    try {
      const userInfo = await api.getUserInfo()
      setUser(userInfo)
    } catch (error) {
      console.error('Failed to refresh user info:', error)
    }
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, wechatLogin, logout, sendVerificationCode, refreshUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
