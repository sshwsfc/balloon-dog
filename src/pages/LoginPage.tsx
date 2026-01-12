import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { User, Lock, MessageCircle } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'

export function LoginPage() {
  const navigate = useNavigate()
  const { login, register, wechatLogin, sendVerificationCode } = useAuth()

  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [sendingCode, setSendingCode] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [loading, setLoading] = useState(false)

  const isWeChat = /micromessenger/i.test(navigator.userAgent)

  const handleSendCode = async () => {
    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      toast.error('请输入正确的手机号')
      return
    }

    setSendingCode(true)
    const success = await sendVerificationCode(phone)
    setSendingCode(false)

    if (success) {
      setCountdown(60)
      const timer = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(timer)
            return 0
          }
          return prev - 1
        })
      }, 1000)
    }
  }

  const handleLogin = async () => {
    if (!phone) {
      toast.error('请输入手机号')
      return
    }
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      toast.error('请输入正确的手机号')
      return
    }
    if (!password) {
      toast.error('请输入密码')
      return
    }

    setLoading(true)
    const success = await login(phone, password)
    setLoading(false)

    if (success) {
      navigate('/')
    }
  }

  const handleRegister = async () => {
    if (!phone) {
      toast.error('请输入手机号')
      return
    }
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      toast.error('请输入正确的手机号')
      return
    }
    if (!verificationCode) {
      toast.error('请输入验证码')
      return
    }
    if (!password) {
      toast.error('请输入密码')
      return
    }
    if (password.length < 6) {
      toast.error('密码至少6位')
      return
    }
    if (password !== confirmPassword) {
      toast.error('两次密码不一致')
      return
    }

    setLoading(true)
    const success = await register(phone, password)
    setLoading(false)

    if (success) {
      navigate('/')
    }
  }

  const handleWechatLogin = async () => {
    const wechatOpenId = 'wx_openid_' + Math.random().toString(36).substr(2, 9)
    const wechatNickname = '微信用户'
    const wechatAvatar = 'https://api.dicebear.com/7.x/avataaars/svg?seed=wechat'

    setLoading(true)
    const success = await wechatLogin(wechatOpenId, wechatNickname, wechatAvatar)
    setLoading(false)

    if (success) {
      navigate('/')
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-400 to-green-600 flex flex-col">
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="w-20 h-20 bg-white rounded-2xl mx-auto mb-4 flex items-center justify-center shadow-lg">
              <div className="text-4xl">🐕</div>
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">气球狗</h1>
            <p className="text-white/80 text-sm">孩子的守护者</p>
          </div>

          {isWeChat && (
            <Button
              className="w-full bg-white text-green-600 hover:bg-gray-50 mb-4"
              onClick={handleWechatLogin}
              disabled={loading}
            >
              <MessageCircle className="w-5 h-5 mr-2" />
              微信一键登录
            </Button>
          )}

          <div className="bg-white rounded-2xl shadow-xl p-6">
            <div className="flex mb-6">
              <button
                className={`flex-1 pb-3 text-center font-medium transition-colors ${mode === 'login' ? 'text-green-600 border-b-2 border-green-600' : 'text-gray-400'}`}
                onClick={() => setMode('login')}
              >
                登录
              </button>
              <button
                className={`flex-1 pb-3 text-center font-medium transition-colors ${mode === 'register' ? 'text-green-600 border-b-2 border-green-600' : 'text-gray-400'}`}
                onClick={() => setMode('register')}
              >
                注册
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm text-gray-600">手机号</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="请输入手机号"
                    maxLength={11}
                    className="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:border-green-500 focus:ring-2 focus:ring-green-200 transition-all"
                  />
                </div>
              </div>

              {mode === 'register' && (
                <div className="space-y-2">
                  <label className="text-sm text-gray-600">验证码</label>
                  <div className="flex space-x-2">
                    <input
                      type="text"
                      value={verificationCode}
                      onChange={(e) => setVerificationCode(e.target.value)}
                      placeholder="请输入验证码"
                      maxLength={6}
                      className="flex-1 px-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:border-green-500 focus:ring-2 focus:ring-green-200 transition-all"
                    />
                    <Button
                      variant="outline"
                      onClick={handleSendCode}
                      disabled={countdown > 0 || sendingCode}
                      className="whitespace-nowrap"
                    >
                      {sendingCode ? '发送中...' : countdown > 0 ? `${countdown}s` : '获取验证码'}
                    </Button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-sm text-gray-600">密码</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="请输入密码"
                    className="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:border-green-500 focus:ring-2 focus:ring-green-200 transition-all"
                  />
                </div>
              </div>

              {mode === 'register' && (
                <div className="space-y-2">
                  <label className="text-sm text-gray-600">确认密码</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="请再次输入密码"
                      className="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:border-green-500 focus:ring-2 focus:ring-green-200 transition-all"
                    />
                  </div>
                </div>
              )}

              <Button
                className="w-full bg-green-600 hover:bg-green-700 text-white"
                onClick={mode === 'login' ? handleLogin : handleRegister}
                disabled={loading}
              >
                {loading ? '处理中...' : mode === 'login' ? '登录' : '注册'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="p-4 text-center">
        <p className="text-white/60 text-xs">
          登录即表示同意{' '}
          <a href="#" className="text-white/80 underline">
            用户协议
          </a>{' '}
          和{' '}
          <a href="#" className="text-white/80 underline">
            隐私政策
          </a>
        </p>
      </div>
    </div>
  )
}
