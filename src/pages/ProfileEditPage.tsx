import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Check,
  Lock,
  Mail,
  Phone,
  ShieldCheck,
  MessageCircle,
  Smartphone,
  User as UserIcon,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import { useAuth } from '@/contexts/AuthContext'
import { formatDateTime } from '@/lib/format'
import { useTranslation } from 'react-i18next'
import type { User } from '@/types'

/**
 * 个人信息（规划里「我的 → 个人信息」那一项，此前只弹了一句「即将上线」）。
 *
 * 这一页只做三件事，都落在已有的接口上：
 *
 *  1. **昵称 / 邮箱**：`PUT /api/user/info`。邮箱是「可空」的，提交空串表示清空
 *     （服务端用 email=null 存），所以前端不做必填校验。
 *  2. **手机号**：已绑定时只读；微信一键登录建出来的账号没有手机号，这时才出现
 *     「绑定手机号」—— 走 `/auth/bind-phone`，验证码用途是 `bind`，与登录码分开。
 *     换号也走同一条链路，但只在没绑定时露出，避免家长误触把登录手机号换掉。
 *  3. **修改密码**：`/auth/change-password`，原密码 + 新密码 + 确认。
 *
 * 为什么新密码要输两遍：这一页没有「忘记密码」的兜底（改完就只剩验证码登录），
 * 输错了等于把账号锁死在自己的记忆里。
 *
 * 另一个坑记在这里：改密码接口用错原密码时返回的是 **401**，而前端 401 是
 * 「令牌失效」的全局信号 —— 直接在 api.ts 里给它开了 skipUnauthorizedHandler，
 * 否则「原密码输错」会把家长踢回登录页（还会把本地令牌清掉）。
 */
const PHONE_RE = /^1[3-9]\d{9}$/

export function ProfileEditPage() {
  const { t } = useTranslation()
  const { user } = useAuth()

  /*
   * 用 key 重挂表单，而不是在 effect 里 setState：
   * 刷新这一页时 AuthContext 还在恢复登录态，`user` 会从 null 变成真实值；
   * 表单的初始值只在挂载时读一次，所以拿 user.id 当 key —— user 到了就整块
   * 重挂，输入框自然拿到新值。在 effect 里同步 setState 会触发级联渲染，
   * 而且 lint 会直接报 react-hooks/set-state-in-effect。
   */
  if (!user) {
    return (
      <div className="page-shell page-shell--center">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-b-2 border-[#07c160]" />
          <p className="mt-2 text-sm text-gray-500">{t('加载中...')}</p>
        </div>
      </div>
    )
  }

  return <ProfileEditForm key={user.id} user={user} />
}

function ProfileEditForm({ user }: { user: User }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { refreshUser, sendCode } = useAuth()

  // 资料
  const [nickname, setNickname] = useState(user.name ?? '')
  const [email, setEmail] = useState(user.email ?? '')
  const [savingProfile, setSavingProfile] = useState(false)

  // 绑定手机号（只在没有手机号时出现）
  const [bindPhone, setBindPhone] = useState('')
  const [bindCode, setBindCode] = useState('')
  const [sendingCode, setSendingCode] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [binding, setBinding] = useState(false)

  // 修改密码
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changing, setChanging] = useState(false)

  useEffect(() => {
    if (countdown <= 0) return
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [countdown])

  const handleSaveProfile = async () => {
    const name = nickname.trim()
    if (!name) {
      toast.error(t('昵称不能为空'))
      return
    }
    if (name.length > 30) {
      toast.error(t('昵称最多 30 个字'))
      return
    }
    const trimmedEmail = email.trim()
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      toast.error(t('邮箱格式不正确'))
      return
    }
    setSavingProfile(true)
    try {
      await api.updateUser({ name, email: trimmedEmail })
      await refreshUser()
      toast.success(t('个人信息已保存'))
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('保存失败，请稍后重试')))
    } finally {
      setSavingProfile(false)
    }
  }

  const handleSendBindCode = async () => {
    if (!PHONE_RE.test(bindPhone)) {
      toast.error(t('手机号不正确'))
      return
    }
    setSendingCode(true)
    const devCode = await sendCode(bindPhone, 'bind')
    setSendingCode(false)
    if (devCode) setBindCode(devCode)
    setCountdown(60)
  }

  const handleBindPhone = async () => {
    if (!PHONE_RE.test(bindPhone)) {
      toast.error(t('手机号不正确'))
      return
    }
    if (bindCode.length !== 6) {
      toast.error(t('请输入 6 位验证码'))
      return
    }
    setBinding(true)
    try {
      await api.bindPhone({ phone: bindPhone, code: bindCode })
      await refreshUser()
      setBindPhone('')
      setBindCode('')
      toast.success(t('手机号已绑定'))
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('绑定失败，请稍后重试')))
    } finally {
      setBinding(false)
    }
  }

  const handleChangePassword = async () => {
    if (!oldPassword) {
      toast.error(t('请输入原密码'))
      return
    }
    if (newPassword.length < 6) {
      toast.error(t('新密码至少 6 位'))
      return
    }
    if (newPassword === oldPassword) {
      toast.error(t('新密码不能与原密码相同'))
      return
    }
    if (newPassword !== confirmPassword) {
      toast.error(t('两次输入的新密码不一致'))
      return
    }
    setChanging(true)
    try {
      await api.changePassword({ oldPassword, newPassword })
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
      toast.success(t('密码已修改，下次登录请使用新密码'))
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('修改失败，请稍后重试')))
    } finally {
      setChanging(false)
    }
  }

  return (
    <div className="page-shell">
      <div className="page-header">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={t('返回')}
            className="p-2 -ml-2 rounded-full active:bg-gray-100"
            onClick={() => navigate(-1)}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-lg font-medium flex-1">{t('个人信息')}</h1>
        </div>
      </div>

      <div className="space-y-3 p-3">
        {/* ── 基本资料 ─────────────────────────────────────── */}
        <Card>
          <CardContent className="p-0">
            <label className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
              <UserIcon className="h-4 w-4 shrink-0 text-gray-400" />
              <input
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                maxLength={30}
                placeholder={t('昵称')}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </label>

            <label className="flex items-center gap-2 px-4 py-3">
              <Mail className="h-4 w-4 shrink-0 text-gray-400" />
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t('邮箱（选填，用于接收发票与通知）')}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </label>
          </CardContent>
        </Card>

        <Button
          className="h-11 w-full bg-[#07c160] text-white hover:bg-[#06a050]"
          disabled={savingProfile}
          onClick={handleSaveProfile}
        >
          {savingProfile ? t('保存中…') : t('保存资料')}
        </Button>

        {/* ── 账号信息 ─────────────────────────────────────── */}
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
              <Phone className="h-4 w-4 shrink-0 text-gray-400" />
              <span className="flex-1 text-sm text-gray-900">{t('手机号')}</span>
              <span className="text-sm text-gray-500">
                {user.phone ?? t('未绑定手机号')}
              </span>
            </div>

            {!user.phone && (
              <div className="space-y-2 border-b border-gray-100 px-4 py-3">
                <p className="text-[11px] leading-relaxed text-gray-500">
                  {t('你现在只能用微信登录。绑定手机号后，就能用手机号 + 验证码（或密码）登录了。')}
                </p>
                <div className="flex items-center gap-2 rounded-xl border border-gray-200 px-3">
                  <Smartphone className="h-4 w-4 shrink-0 text-gray-400" />
                  <input
                    type="tel"
                    inputMode="numeric"
                    maxLength={11}
                    value={bindPhone}
                    onChange={(event) => setBindPhone(event.target.value.replace(/\D/g, ''))}
                    placeholder={t('手机号')}
                    className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none"
                  />
                </div>
                <div className="flex items-center gap-2 rounded-xl border border-gray-200 px-3">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-gray-400" />
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={bindCode}
                    onChange={(event) => setBindCode(event.target.value.replace(/\D/g, ''))}
                    placeholder={t('验证码')}
                    className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleSendBindCode}
                    disabled={sendingCode || countdown > 0}
                    className="whitespace-nowrap py-1 text-xs text-[#07c160] disabled:text-gray-400"
                  >
                    {countdown > 0
                      ? t('{{v0}}s 后重发', { v0: countdown })
                      : sendingCode
                        ? t('发送中…')
                        : t('获取验证码')}
                  </button>
                </div>
                <Button
                  variant="outline"
                  className="h-10 w-full"
                  disabled={binding}
                  onClick={handleBindPhone}
                >
                  {binding ? t('绑定中…') : t('绑定手机号')}
                </Button>
              </div>
            )}

            <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
              <MessageCircle className="h-4 w-4 shrink-0 text-gray-400" />
              <span className="flex-1 text-sm text-gray-900">{t('微信绑定')}</span>
              <span
                className={`flex items-center text-sm ${user.wechatBound ? 'text-[#07c160]' : 'text-gray-400'}`}
              >
                {user.wechatBound && <Check className="mr-1 h-4 w-4" />}
                {user.wechatBound ? t('已绑定') : t('未绑定')}
              </span>
            </div>

            {user.createdAt && (
              <div className="flex items-center gap-2 px-4 py-3">
                <span className="flex-1 text-sm text-gray-900">{t('注册时间')}</span>
                <span className="text-xs text-gray-400">{formatDateTime(user.createdAt)}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── 修改密码 ─────────────────────────────────────── */}
        <Card>
          <CardContent className="p-0">
            <div className="border-b border-gray-100 px-4 py-3">
              <p className="flex items-center text-sm font-medium text-gray-900">
                <Lock className="mr-1.5 h-4 w-4 text-gray-400" />
                {t('修改密码')}
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">
                {t('改完请记住新密码：微信创建的账号如果没设过密码，请先退出登录用验证码登录一次再回来设置。')}
              </p>
            </div>
            <div className="space-y-2 px-4 py-3">
              <div className="flex items-center gap-2 rounded-xl border border-gray-200 px-3">
                <Lock className="h-4 w-4 shrink-0 text-gray-400" />
                <input
                  type="password"
                  value={oldPassword}
                  onChange={(event) => setOldPassword(event.target.value)}
                  placeholder={t('原密码')}
                  autoComplete="current-password"
                  className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none"
                />
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-gray-200 px-3">
                <Lock className="h-4 w-4 shrink-0 text-gray-400" />
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder={t('新密码（至少 6 位）')}
                  autoComplete="new-password"
                  className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none"
                />
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-gray-200 px-3">
                <Lock className="h-4 w-4 shrink-0 text-gray-400" />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder={t('确认新密码')}
                  autoComplete="new-password"
                  className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Button
          className="h-11 w-full bg-[#07c160] text-white hover:bg-[#06a050]"
          disabled={changing}
          onClick={handleChangePassword}
        >
          {changing ? t('提交中…') : t('修改密码')}
        </Button>

        <p className="px-1 pb-4 text-center text-[11px] leading-relaxed text-gray-400">
          {t('密码只保存在服务器上，我们不会通过电话、短信或微信向你索取密码。')}
        </p>
      </div>
    </div>
  )
}
