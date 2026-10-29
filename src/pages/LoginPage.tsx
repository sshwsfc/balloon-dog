import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { BrandLogo } from '@/components/BrandLogo'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from 'sonner'
import { User, Lock, MessageCircle, ShieldCheck, RefreshCw, Gift } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { setAuthToken, userApi, wechatApi } from '@/services/api'
import type { WechatQr } from '@/services/api'
import { serverUrl } from '@/lib/serverUrl'
import { useTranslation } from 'react-i18next'

type Mode = 'login' | 'register' | 'sms'

const PHONE_RE = /^1[3-9]\d{9}$/

export function LoginPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { login, register, smsLogin, sendCode, wechatPoll, wechatCreateQr, wechatDevScan } = useAuth()

  /**
   * 邀请链接形如 `/login?mode=register&invite=XXXX`（由分享页生成）。
   * 这里只做「显示 + 透传」，邀请码的校验与绑定全在服务端：
   * 建号前校验（不存在 / 邀请人不活跃 / 与自己同手机号 → 直接拒绝），建号后才绑定。
   */
  const inviteCode = (searchParams.get('invite') ?? '').trim().toUpperCase()
  const [mode, setMode] = useState<Mode>(
    searchParams.get('mode') === 'register' || inviteCode ? 'register' : 'login',
  )
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [devCodeHint, setDevCodeHint] = useState('')
  const [sendingCode, setSendingCode] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [loading, setLoading] = useState(false)

  // 微信扫码
  const [qrOpen, setQrOpen] = useState(false)
  const [qr, setQr] = useState<WechatQr | null>(null)
  const [qrLoading, setQrLoading] = useState(false)
  const pollTimer = useRef<number | null>(null)

  const isWeChat = /micromicro|micromessenger/i.test(navigator.userAgent)

  /** 倒计时清理 */
  useEffect(() => {
    if (countdown <= 0) return
    const timer = window.setTimeout(() => setCountdown((v) => v - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [countdown])

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  /**
   * 处理微信回调带回来的结果。
   *
   * token 现在放在 **fragment**（`/login#wx_token=…`）：fragment 不会被发到服务端，
   * 也就不会留在 Nginx 访问日志和 Referer 里。为了兼容旧链接，query 上的 `wx_token`
   * 仍然认。消费后立刻把 fragment / query 都清掉，别把令牌留在地址栏与历史里。
   */
  useEffect(() => {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const wxToken = searchParams.get('wx_token') ?? fromHash.get('wx_token')
    const wxError = searchParams.get('wx_error') ?? fromHash.get('wx_error')
    if (!wxToken && !wxError) return

    const clearAddress = () => {
      if (window.location.hash) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
      }
      setSearchParams({}, { replace: true })
    }

    const consume = async () => {
      if (wxToken) {
        setAuthToken(wxToken)
        try {
          await userApi.getProfile()
          toast.success(t('微信登录成功'))
          clearAddress()
          navigate('/', { replace: true })
          return
        } catch {
          toast.error(t('微信登录失败，重试'))
        }
      } else if (wxError) {
        toast.error(decodeURIComponent(wxError))
      }
      clearAddress()
    }
    void consume()
  }, [searchParams, setSearchParams, navigate, t])

  const handleSendCode = async () => {
    if (!PHONE_RE.test(phone)) {
      toast.error(t('手机号不正确'))
      return
    }
    setSendingCode(true)
    // 注册 / 验证码登录 两种用途在后端是分开校验的，这里按当前模式传对
    const purpose = mode === 'register' ? 'register' : 'login'
    const devCode = await sendCode(phone, purpose)
    setSendingCode(false)
    if (devCode) {
      // 后端未配置真实短信通道（本地联调）：把码直接显示出来，省得去翻服务端日志
      setDevCodeHint(devCode)
      setVerificationCode(devCode)
    }
    setCountdown(60)
  }

  const handleLogin = async () => {
    if (!PHONE_RE.test(phone)) {
      toast.error(t('手机号不正确'))
      return
    }
    if (!password) {
      toast.error(t('密码不能为空'))
      return
    }
    setLoading(true)
    const ok = await login(phone, password)
    setLoading(false)
    if (ok) navigate('/', { replace: true })
  }

  const handleSmsLogin = async () => {
    if (!PHONE_RE.test(phone)) {
      toast.error(t('手机号不正确'))
      return
    }
    if (!/^\d{6}$/.test(verificationCode)) {
      toast.error(t('验证码是 6 位数字'))
      return
    }
    setLoading(true)
    const ok = await smsLogin(phone, verificationCode, inviteCode || undefined)
    setLoading(false)
    if (ok) navigate('/', { replace: true })
  }

  const handleRegister = async () => {
    if (!PHONE_RE.test(phone)) {
      toast.error(t('手机号不正确'))
      return
    }
    if (!/^\d{6}$/.test(verificationCode)) {
      toast.error(t('验证码是 6 位数字'))
      return
    }
    if (password.length < 6) {
      toast.error(t('密码至少 6 位'))
      return
    }
    if (password !== confirmPassword) {
      toast.error(t('两次密码不一致'))
      return
    }
    setLoading(true)
    const ok = await register(phone, password, verificationCode, inviteCode || undefined)
    setLoading(false)
    if (ok) navigate('/', { replace: true })
  }

  // ---------------- 微信登录 ----------------

  const startQrLogin = useCallback(async () => {
    setQrOpen(true)
    setQrLoading(true)
    stopPolling()
    try {
      const created = await wechatCreateQr()
      setQr(created)
      // 每 2 秒问一次后端「扫码完成了没」
      pollTimer.current = window.setInterval(async () => {
        const done = await wechatPoll(created.state)
        if (done) {
          stopPolling()
          setQrOpen(false)
          navigate('/', { replace: true })
        }
      }, 2000)
    } catch {
      toast.error(t('二维码生成失败，稍后重试'))
      setQrOpen(false)
    } finally {
      setQrLoading(false)
    }
  }, [wechatCreateQr, wechatPoll, stopPolling, navigate, t])

  const handleWechatLogin = async () => {
    if (!isWeChat) {
      void startQrLogin()
      return
    }
    // 微信内置浏览器：直接整页跳授权，回来后由上面的 useEffect 消费 wx_token
    try {
      // 回跳地址用对外基址而不是 window.location.origin：微信要求它同时出现在
      // 授权请求和公众号后台的「网页授权域名」里，配置的必然是公网域名。
      const { url } = await wechatApi.authorizeUrl(`${serverUrl()}/login`)
      window.location.href = url
    } catch {
      // 未配置真实微信时回退到联调扫码
      void startQrLogin()
    }
  }

  /** 联调模式：模拟一次「已扫码并授权」 */
  const handleDevScan = async () => {
    if (!qr) return
    try {
      await wechatDevScan(qr.state)
      toast.success(t('已模拟扫码，正在登录…'))
    } catch {
      toast.error(t('模拟扫码失败'))
    }
  }

  const switchMode = (next: Mode) => {
    setMode(next)
    setVerificationCode('')
    setDevCodeHint('')
    setConfirmPassword('')
    setCountdown(0)
  }

  return (
    <div className="flex min-h-screen flex-col overflow-y-auto bg-gradient-to-br from-green-400 to-green-600">
      {/*
        用「父容器不居中 + 子元素 my-auto」而不是 items-center：
        flex 布局里 items-center 在内容高于容器时会把顶部裁掉（且滚不到），
        横屏手机（可视高度 320–420px）正好会触发。my-auto 则会在空间不足时退化为顶部对齐。
      */}
      <div className="flex flex-1 px-4 py-8 [@media(max-height:600px)]:py-3">
        {/*
          `mx-auto` 与 `my-auto` 缺一不可：外层是 flex 行容器，
          默认 justify-content: flex-start，只给 w-full + max-w-sm 会让登录框
          在宽屏下贴着左边（窄屏被 px-4 填满所以看不出来）。
        */}
        <div className="mx-auto my-auto w-full max-w-sm">
          <div className="mb-6 text-center [@media(max-height:600px)]:mb-3">
            {/* 这一页背景本身就是绿色，绿底 logo 会糊成一片，所以垫一层白色底衬 */}
            <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-2xl bg-white shadow-lg [@media(max-height:600px)]:mb-2 [@media(max-height:600px)]:h-14 [@media(max-height:600px)]:w-14">
              <BrandLogo className="h-16 w-16 rounded-xl [@media(max-height:600px)]:h-11 [@media(max-height:600px)]:w-11" />
            </div>
            <h1 className="mb-2 text-2xl font-bold text-white">{t('气球狗')}</h1>
            <p className="text-sm text-white/80">{t('孩子的守护者')}</p>
          </div>

          <div className="bg-white rounded-2xl shadow-xl p-5">
            {inviteCode && (
              <div className="mb-4 flex items-start gap-2 rounded-lg bg-orange-50 px-3 py-2.5">
                <Gift className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
                <div className="text-[11px] leading-relaxed text-orange-700">
                  <p className="font-medium">{t('你正在通过好友的邀请链接注册')}</p>
                  <p className="mt-0.5 text-orange-600/80">
                    {t('邀请码 {{v0}}，注册并完成首次充值后，好友可获得返现', { v0: inviteCode })}
                  </p>
                </div>
              </div>
            )}

            {/* 模式切换 */}
            <div className="flex bg-gray-100 rounded-lg p-1 mb-5">
              {(
                [
                  ['login', t('密码登录')],
                  ['sms', t('验证码登录')],
                  ['register', t('注册')],
                ] as [Mode, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => switchMode(key)}
                  className={`flex-1 text-sm py-2 rounded-md transition-colors ${
                    mode === key ? 'bg-white text-gray-900 shadow-sm font-medium' : 'text-gray-500'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="space-y-3">
              {/* 手机号 */}
              <div className="flex items-center border border-gray-200 rounded-lg px-3 focus-within:border-[#07c160]">
                <User className="w-4 h-4 text-gray-400" />
                <input
                  type="tel"
                  inputMode="numeric"
                  maxLength={11}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                  placeholder={t('手机号')}
                  className="flex-1 px-2 py-3 text-sm outline-none bg-transparent"
                />
              </div>

              {/* 验证码（注册 / 验证码登录） */}
              {mode !== 'login' && (
                <div className="flex items-center border border-gray-200 rounded-lg px-3 focus-within:border-[#07c160]">
                  <ShieldCheck className="w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, ''))}
                    placeholder={t('验证码')}
                    className="flex-1 px-2 py-3 text-sm outline-none bg-transparent"
                  />
                  <button
                    type="button"
                    onClick={handleSendCode}
                    disabled={sendingCode || countdown > 0}
                    className="text-xs text-[#07c160] disabled:text-gray-400 whitespace-nowrap py-1"
                  >
                    {countdown > 0 ? t('{{v0}}s 后重发', { v0: countdown }) : sendingCode ? t('发送中…') : t('获取验证码')}
                  </button>
                </div>
              )}

              {devCodeHint && (
                <p className="text-xs text-orange-500 bg-orange-50 rounded-lg px-3 py-2">
                  {t('联调模式：验证码')} <span className="font-mono font-medium">{devCodeHint}</span>{t('已自动填入（未配置短信通道时才会显示）')}</p>
              )}

              {/* 密码：验证码登录这一档不显示 —— 那一档只认手机号 + 验证码，
                  多一个空密码框只会让人以为还要填，提交时还会被当作填错。 */}
              {mode !== 'sms' && (
                <div className="flex items-center border border-gray-200 rounded-lg px-3 focus-within:border-[#07c160]">
                  <Lock className="w-4 h-4 text-gray-400" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === 'register' ? t('密码（至少 6 位）') : t('密码')}
                    className="flex-1 px-2 py-3 text-sm outline-none bg-transparent"
                  />
                </div>
              )}

              {mode === 'register' && (
                <div className="flex items-center border border-gray-200 rounded-lg px-3 focus-within:border-[#07c160]">
                  <Lock className="w-4 h-4 text-gray-400" />
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={t('确认密码')}
                    className="flex-1 px-2 py-3 text-sm outline-none bg-transparent"
                  />
                </div>
              )}

              <Button
                className="w-full bg-[#07c160] hover:bg-[#06a050] h-11"
                disabled={loading}
                onClick={mode === 'login' ? handleLogin : mode === 'sms' ? handleSmsLogin : handleRegister}
              >
                {loading ? t('处理中…') : mode === 'login' ? t('登录') : mode === 'sms' ? t('登录') : t('注册并登录')}
              </Button>
            </div>

            {/* 微信登录 */}
            <div className="mt-5">
              <div className="flex items-center text-xs text-gray-400 mb-4">
                <div className="flex-1 h-px bg-gray-200" />
                <span className="px-3">{t('其他方式')}</span>
                <div className="flex-1 h-px bg-gray-200" />
              </div>
              <Button
                variant="outline"
                className="w-full text-[#07c160] border-[#07c160]/30 hover:bg-green-50"
                onClick={handleWechatLogin}
                disabled={loading}
              >
                <MessageCircle className="w-4 h-4 mr-2" />
                {t('微信一键登录')}
              </Button>
              {mode === 'login' && (
                <p className="text-center text-xs text-gray-400 mt-4">
                  {t('没有账号？')}
                  <button type="button" className="text-[#07c160] ml-1" onClick={() => switchMode('register')}>
                    {t('立即注册')}
                  </button>
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 微信扫码弹窗 */}
      <Dialog
        open={qrOpen}
        onOpenChange={(open) => {
          setQrOpen(open)
          if (!open) stopPolling()
        }}
      >
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>{t('微信扫码登录')}</DialogTitle>
          </DialogHeader>
          <div className="text-center py-2">
            {qrLoading && <p className="text-sm text-gray-500 py-8">{t('正在生成二维码…')}</p>}
            {!qrLoading && qr && (
              <>
                {qr.real ? (
                  <>
                    {/* 真实模式：把微信授权链接渲染成二维码 */}
                    <img
                      alt={t('微信登录二维码')}
                      className="w-40 h-40 mx-auto border border-gray-100 rounded-lg"
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(
                        qr.qrContent,
                      )}`}
                    />
                    <p className="text-xs text-gray-500 mt-3">{t('用微信扫一扫登录')}</p>
                  </>
                ) : (
                  <div className="py-2">
                    <p className="text-sm text-gray-600">
                      {t('未配置微信开放平台凭据，当前为联调模式。')}
                    </p>
                    <p className="text-xs text-gray-400 mt-2">{t('点下方按钮模拟「扫码并授权」。')}</p>
                  </div>
                )}
                <p className="text-[10px] text-gray-300 mt-3 break-all">
                  {t('会话')} {qr.state.slice(0, 12)}{t('· 每 2 秒自动检测')}</p>
                <div className="flex gap-2 mt-3">
                  {!qr.real && (
                    <Button className="flex-1 bg-[#07c160] hover:bg-[#06a050]" onClick={handleDevScan}>
                      {t('模拟扫码登录')}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    className={qr.real ? 'flex-1' : ''}
                    onClick={() => void startQrLogin()}
                    title={t('重新生成二维码')}
                  >
                    <RefreshCw className="w-4 h-4" />
                    {qr.real && <span className="ml-1">{t('刷新')}</span>}
                  </Button>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
