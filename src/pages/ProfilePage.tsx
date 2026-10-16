import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Baby, Bell, ChevronRight, Crown, Gift, Hourglass, Image as ImageIcon, LifeBuoy, Lightbulb, LogOut, Mail, Plus, Shield, Smartphone, Sparkles, User } from 'lucide-react'
import { LanguageSetting } from '@/components/LanguageSetting'
import { MembershipBadge } from '@/components/MembershipGate'
import { resetOnboarding, useOnboarding } from '@/hooks/useOnboarding'
import { useMembership } from '@/hooks/useMembership'
import { formatDateTime } from '@/lib/format'
import { resetTips } from '@/hooks/useFeatureTips'
import { useAuth } from '@/contexts/AuthContext'
import { api, toUserMessage } from '@/services/api'
import { toast } from 'sonner'
import type { Device } from '@/types'
import { useTranslation } from 'react-i18next'

export function ProfilePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const membership = useMembership()
  const { user, logout } = useAuth()
  const onboarding = useOnboarding()
  const onboardingDone = Boolean(onboarding.finishedAt)
  const [devices, setDevices] = useState<Device[]>([])
  const [deviceError, setDeviceError] = useState<string | null>(null)
  // 未读消息数：放在「我的」这一页是因为它是家长扫一眼就会来的地方。
  // 失败就静默当 0 —— 一个角标不值得弹错误提示。
  const [unreadCount, setUnreadCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    api
      .getNotificationUnreadCount()
      .then((res) => {
        if (!cancelled) setUnreadCount(res.unreadCount)
      })
      .catch(() => {
        /* 静默：角标不是关键路径 */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const fetchDevices = useCallback(() => api.getDevices(), [])

  useEffect(() => {
    let cancelled = false
    fetchDevices()
      .then((res) => {
        if (cancelled) return
        setDevices(res.devices ?? [])
        setDeviceError(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setDeviceError(toUserMessage(error, t('加载设备失败')))
      })
    return () => {
      cancelled = true
    }
  }, [fetchDevices, t])

  const reloadDevices = useCallback(async () => {
    try {
      const res = await fetchDevices()
      setDevices(res.devices ?? [])
      setDeviceError(null)
    } catch (error) {
      setDeviceError(toUserMessage(error, t('加载设备失败')))
    }
  }, [fetchDevices, t])

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  // 待审批的申请条数：跨设备求和。家长可能有多台设备，而「我的」这一页
  // 不该逼家长先在脑子里选中某一台才知道有没有人在等他。
  const pendingRequests = devices.reduce((sum, d) => sum + (d.pendingTimeRequests ?? 0), 0)

  const menuItems = [
    { icon: User, title: t('个人信息'), desc: t('修改昵称、邮箱'), onClick: () => toast.info(t('个人信息编辑即将上线')) },
    {
      icon: Bell,
      title: t('消息中心'),
      desc: unreadCount > 0 ? t('{{v0}} 条未读', { v0: unreadCount }) : t('设备异常、安全区、装应用申请'),
      badge: unreadCount,
      onClick: () => navigate('/notifications'),
    },
    {
      icon: Hourglass,
      title: t('孩子的申请'),
      desc:
        pendingRequests > 0
          ? t('{{v0}} 条等你回应', { v0: pendingRequests })
          : t('加时、延后锁屏的申请会出现在这里'),
      badge: pendingRequests,
      onClick: () => navigate('/time-requests'),
    },
    { icon: Bell, title: t('通知设置'), desc: t('消息提醒、推送通知'), onClick: () => navigate('/notifications/settings') },
    {
      icon: Baby,
      title: t('孩子档案'),
      desc: t('年龄、学校、设备归属与今日任务'),
      onClick: () => navigate('/children'),
    },
    { icon: Shield, title: t('合规与隐私'), desc: t('监护授权、数据导出与注销账号'), onClick: () => navigate('/privacy') },
    { icon: LifeBuoy, title: t('帮助与反馈'), desc: t('遇到问题就描述一下，客服在工单里回复'), onClick: () => navigate('/support') },
  ]

  return (
    <div className="page-shell">
      <div className="bg-gradient-to-br from-green-400 to-green-600 text-white px-4 py-6">
        <div className="flex items-center space-x-3">
          {user?.avatar ? (
            <img src={user.avatar} alt={t('头像')} className="w-16 h-16 rounded-full bg-white/20" />
          ) : (
            <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center">
              <User className="w-8 h-8" />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-xl font-medium truncate">{user?.name || t('家长用户')}</h1>
            <p className="text-xs opacity-80 mt-0.5">{t('家长账户')}</p>
            <p className="text-xs opacity-60 mt-1 truncate">
              {user?.phone || user?.email || t('未绑定手机号')}
              {user?.wechatBound ? t(' · 已绑定微信') : ''}
            </p>
          </div>
        </div>
      </div>

      {/* 设备列表 */}
      <div className="px-3 -mt-4">
        <Card>
          <CardContent className="p-0">
            {deviceError ? (
              <div className="px-4 py-4 text-center">
                <p className="text-sm text-gray-500">{deviceError}</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => void reloadDevices()}>
                  {t('重试')}
                </Button>
              </div>
            ) : devices.length === 0 ? (
              // 原实现这里没有 onClick，点了没反应
              <button
                type="button"
                className="w-full flex items-center justify-center py-4 hover:bg-gray-50 active:bg-gray-100 transition-colors"
                onClick={() => navigate('/devices')}
              >
                <Plus className="w-4 h-4 text-gray-400 mr-1.5" />
                <span className="text-sm text-gray-500">{t('绑定孩子设备')}</span>
              </button>
            ) : (
              <>
                {devices.map((device, index) => (
                  <div key={device.id}>
                    <button
                      type="button"
                      className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
                      onClick={() => navigate('/devices')}
                    >
                      <div className="flex items-center space-x-3 min-w-0">
                        <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                          <Smartphone className="w-5 h-5 text-blue-500" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center space-x-2">
                            <h4 className="font-medium text-gray-900 text-sm truncate">{device.name}</h4>
                            <Badge
                              className={
                                device.status === 'online'
                                  ? 'bg-[#07c160] text-white text-[10px]'
                                  : 'bg-gray-400 text-white text-[10px]'
                              }
                            >
                              {device.status === 'online' ? t('在线') : t('离线')}
                            </Badge>
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5 truncate">{device.model}</p>
                        </div>
                      </div>
                      <ChevronRight className="w-5 h-5 text-gray-300 flex-shrink-0" />
                    </button>
                    {index < devices.length - 1 && <div className="mx-4 border-t border-gray-100" />}
                  </div>
                ))}
                <div className="mx-4 border-t border-gray-100" />
                <button
                  type="button"
                  className="w-full flex items-center justify-center py-3 hover:bg-gray-50 active:bg-gray-100 transition-colors"
                  onClick={() => navigate('/devices')}
                >
                  <Plus className="w-4 h-4 text-gray-400 mr-1.5" />
                  <span className="text-sm text-gray-500">{t('管理设备')}</span>
                </button>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 会员入口：放在媒体之上，因为它是「为什么有些功能点不动」的答案 */}
      <div className="px-3 mt-3">
        <Card>
          <CardContent className="p-0">
            <button
              type="button"
              className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
              onClick={() => navigate('/membership')}
            >
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-amber-50 rounded-lg flex items-center justify-center">
                  <Crown className="w-5 h-5 text-amber-500" />
                </div>
                <div>
                  <div className="flex items-center space-x-1.5">
                    <h4 className="font-medium text-gray-900 text-sm">{t('会员中心')}</h4>
                    <MembershipBadge />
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {membership.isMember
                      ? membership.status?.expiresAt
                        ? t('有效期至 {{v0}}', { v0: formatDateTime(membership.status.expiresAt) })
                        : t('已开通')
                      : t('充值后解锁答题解锁、远程监控与 AI 洞察')}
                  </p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300" />
            </button>
          </CardContent>
        </Card>
      </div>

      {/* 邀请返现入口：放在会员下面 —— 「会员要花钱」和「邀请能赚钱」是同一组心智 */}
      <div className="px-3 mt-3">
        <Card>
          <CardContent className="p-0">
            <button
              type="button"
              className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
              onClick={() => navigate('/referral')}
            >
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-orange-50 rounded-lg flex items-center justify-center">
                  <Gift className="w-5 h-5 text-orange-500" />
                </div>
                <div>
                  <h4 className="font-medium text-gray-900 text-sm">{t('邀请返现')}</h4>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {t('邀请好友注册充值，最高返现 50%，次月发放')}
                  </p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300" />
            </button>
          </CardContent>
        </Card>
      </div>

      {/* 媒体入口 */}
      <div className="px-3 mt-3">
        <Card>
          <CardContent className="p-0">
            <button
              type="button"
              className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
              onClick={() => navigate('/media')}
            >
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-cyan-50 rounded-lg flex items-center justify-center">
                  <ImageIcon className="w-5 h-5 text-cyan-500" />
                </div>
                <div>
                  <h4 className="font-medium text-gray-900 text-sm">{t('设备照片')}</h4>
                  <p className="text-xs text-gray-400 mt-0.5">{t('孩子端回传的照片与截图')}</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300" />
            </button>
          </CardContent>
        </Card>
      </div>

      {/* 语言：独立一张卡，不用再点进「通用设置」找 */}
      <div className="px-3 mt-3">
        <LanguageSetting />
      </div>

      {/* 引导与功能提示的复位入口。
          这两样都是「只影响本机显示」的偏好，放在一起最容易被找到；
          尤其是新手引导 —— 用户跳过之后想再看一次，必须有个明确的地方进去。 */}
      <div className="px-3 mt-3">
        <Card>
          <CardContent className="p-0">
            <button
              type="button"
              className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
              onClick={() => {
                resetOnboarding()
                navigate('/onboarding')
              }}
            >
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-green-50 rounded-lg flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-[#07c160]" />
                </div>
                <div>
                  <h4 className="font-medium text-gray-900 text-sm">
                    {onboardingDone ? t('再看一次新手引导') : t('继续新手引导')}
                  </h4>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {onboardingDone
                      ? t('重新走一遍 3 步绑定流程')
                      : t('接着上次继续')}
                  </p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300" />
            </button>
            <div className="mx-4 border-t border-gray-100" />
            <button
              type="button"
              className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
              onClick={() => {
                resetTips()
                toast.success(t('已恢复所有功能提示'))
              }}
            >
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-amber-50 rounded-lg flex items-center justify-center">
                  <Lightbulb className="w-5 h-5 text-amber-500" />
                </div>
                <div>
                  <h4 className="font-medium text-gray-900 text-sm">{t('重置功能提示')}</h4>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {t('让各功能页的首次提示再出现一次')}
                  </p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300" />
            </button>
          </CardContent>
        </Card>
      </div>

      {/* 设置项 */}
      <div className="px-3 mt-3">
        <Card>
          <CardContent className="p-0">
            {menuItems.map((item, index) => (
              <div key={item.title}>
                <button
                  type="button"
                  className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
                  onClick={item.onClick}
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center">
                      <item.icon className="w-5 h-5 text-gray-500" />
                    </div>
                    <div>
                      <h4 className="font-medium text-gray-900 text-sm">{item.title}</h4>
                      <p className="text-xs text-gray-400 mt-0.5">{item.desc}</p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    {'badge' in item && item.badge ? (
                      <span className="px-1.5 py-0.5 rounded-full bg-red-500 text-white text-[10px] leading-none">
                        {item.badge > 99 ? '99+' : item.badge}
                      </span>
                    ) : null}
                    <ChevronRight className="w-5 h-5 text-gray-300" />
                  </div>
                </button>
                {index < menuItems.length - 1 && <div className="mx-4 border-t border-gray-100" />}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* 客服 + 退出 */}
      <div className="px-3 mt-3">
        <Card>
          <CardContent className="p-0">
            <button
              type="button"
              className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
              onClick={() => toast.info(t('客服联系方式即将上线'))}
            >
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center">
                  <Mail className="w-5 h-5 text-gray-500" />
                </div>
                <div>
                  <h4 className="font-medium text-gray-900 text-sm">{t('联系客服')}</h4>
                  <p className="text-xs text-gray-400 mt-0.5">{t('获取帮助')}</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300" />
            </button>
            <div className="mx-4 border-t border-gray-100" />
            <button
              type="button"
              className="w-full flex items-center justify-between py-3 px-4 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
              onClick={handleLogout}
            >
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center">
                  <LogOut className="w-5 h-5 text-red-500" />
                </div>
                <div>
                  <h4 className="font-medium text-red-500 text-sm">{t('退出登录')}</h4>
                  <p className="text-xs text-gray-400 mt-0.5">{t('退出当前账号')}</p>
                </div>
              </div>
            </button>
          </CardContent>
        </Card>
      </div>

      <div className="px-3 mt-6 mb-4 text-center text-xs text-gray-400">
        <p>{t('版本 {{v0}}', { v0: __APP_VERSION__ })}</p>
        <p className="mt-1">{t('© 2026 气球狗 - 孩子的守护者')}</p>
      </div>
    </div>
  )
}
