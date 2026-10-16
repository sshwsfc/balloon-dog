import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { toast } from 'sonner'
import { ArrowLeft, Bell, Info, Loader2, MessageCircle, Send } from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { NotificationPreferences } from '@/types'
import { useTranslation } from 'react-i18next'

/**
 * 通知设置（规划 §2.1 配套的「真正的通知偏好页」，第二档：微信模板消息）。
 *
 * 两条必须说清楚，否则这一页就是在骗人：
 *  1. **站内之外只有微信服务号这一条通道**。厂商推送（小米/华为/OPPO…）需要原生
 *     App 的推送 SDK，而家长端是移动网页 —— 所以它显示成「不适用」并给出原因，
 *     而不是一个存下来却永远不会生效的开关。
 *  2. 关掉某一类是**服务端**不再写这条通知（不是前端藏着不看），
 *     所以关掉之后未读角标也会跟着干净；微信开关同理 —— 关着的时候服务端连
 *     投递记录都不建。
 */
export function NotificationSettingsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  // 与消息中心同一个写法：`.then()` 链而不是 effect 里 `void asyncFn()`，
  // 免得 React Compiler 把 setState 追进 effect 判成同步 setState
  const loadData = useCallback(
    () =>
      api
        .getNotificationPreferences()
        .then((res) => setPrefs(res))
        .catch((error: unknown) => {
          toast.error(toUserMessage(error, t('加载通知设置失败，请稍后重试')))
        })
        .finally(() => setLoading(false)),
    [t],
  )

  useEffect(() => {
    void loadData()
  }, [loadData])

  const handleToggle = async (type: string, patch: { inApp?: boolean; wechat?: boolean }) => {
    if (!prefs) return
    // 乐观更新：开关是最忌讳「点了没反应」的控件
    const next: NotificationPreferences = {
      ...prefs,
      items: prefs.items.map((i) => (i.type === type ? { ...i, ...patch } : i)),
    }
    setPrefs(next)
    setSaving(true)
    try {
      const saved = await api.updateNotificationPreferences(
        next.items.map((i) => ({ type: i.type, inApp: i.inApp, wechat: i.wechat, push: i.push })),
      )
      setPrefs(saved)
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('保存失败，请稍后重试')))
      await loadData() // 回滚成服务端的真实状态，别让界面停在假状态
    } finally {
      setSaving(false)
    }
  }

  const handleTestWechat = async () => {
    setTesting(true)
    try {
      await api.testWechatNotification()
      toast.success(t('测试消息已发出，去微信看看'))
      await loadData()
    } catch (error: unknown) {
      // 失败原因里带微信的 errcode 原文，直接给家长看 —— 这一页就是用来回答
      // 「为什么没收到」的，把它藏在日志里等于没答
      toast.error(toUserMessage(error, t('发送测试消息失败')))
      await loadData()
    } finally {
      setTesting(false)
    }
  }

  const wechat = prefs?.channels.wechat
  const wechatReady = Boolean(wechat?.configured && wechat.bound)
  const lastDelivery = wechat?.lastDelivery ?? null

  return (
    <div className="page-shell">
      <div className="page-header">
        <div className="flex items-center space-x-2 px-4 py-3">
          <button
            type="button"
            className="p-1 -ml-1 rounded-full hover:bg-gray-100 active:bg-gray-200"
            onClick={() => navigate(-1)}
            aria-label={t('返回')}
          >
            <ArrowLeft className="w-5 h-5 text-gray-700" />
          </button>
          <h1 className="text-base font-medium text-gray-900">{t('通知设置')}</h1>
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
        </div>
      </div>

      <div className="px-3 py-3 space-y-3">
        {loading ? (
          <Card>
            <CardContent className="p-8 flex items-center justify-center space-x-2 text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">{t('加载中...')}</span>
            </CardContent>
          </Card>
        ) : prefs ? (
          <>
            <Card>
              <CardContent className="p-0">
                <div className="px-4 pt-3.5 pb-2">
                  <p className="text-sm font-medium text-gray-900">{t('站内消息')}</p>
                  <p className="mt-0.5 text-[11px] text-gray-400 leading-relaxed">
                    {t('关掉某一类之后，服务端就不再产生这类消息（未读角标也会跟着干净），不是只在界面上藏起来。')}
                  </p>
                </div>
                {wechatReady && (
                  <div className="flex items-center justify-end space-x-3.5 px-4 pb-1">
                    <span className="text-[11px] text-[#07c160]">{t('微信')}</span>
                    <span className="text-[11px] text-gray-400">{t('站内')}</span>
                  </div>
                )}
                {prefs.items.map((item) => (
                  <div
                    key={item.type}
                    className="flex items-center justify-between px-4 py-3 border-t border-gray-100"
                  >
                    <div className="flex items-center space-x-2.5 min-w-0">
                      <Bell className="w-4 h-4 text-gray-400 shrink-0" />
                      <span className="text-sm text-gray-800 truncate">{t(item.label)}</span>
                    </div>
                    <div className="flex items-center space-x-3 shrink-0">
                      {wechatReady && (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={item.wechat}
                          aria-label={`${t(item.label)} ${t('微信')}`}
                          className={`relative w-11 h-6 rounded-full transition-colors ${
                            item.wechat ? 'bg-[#07c160]' : 'bg-gray-200'
                          }`}
                          onClick={() => void handleToggle(item.type, { wechat: !item.wechat })}
                        >
                          <span
                            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${
                              item.wechat ? 'left-[22px]' : 'left-0.5'
                            }`}
                          />
                        </button>
                      )}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={item.inApp}
                        aria-label={`${t(item.label)} ${t('站内')}`}
                        className={`relative w-11 h-6 rounded-full transition-colors ${
                          item.inApp ? 'bg-[#07c160]' : 'bg-gray-200'
                        }`}
                        onClick={() => void handleToggle(item.type, { inApp: !item.inApp })}
                      >
                        <span
                          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${
                            item.inApp ? 'left-[22px]' : 'left-0.5'
                          }`}
                        />
                      </button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-0">
                <div className="px-4 pt-3.5 pb-2">
                  <p className="text-sm font-medium text-gray-900">{t('其它通道')}</p>
                  <p className="mt-0.5 text-[11px] text-gray-400 leading-relaxed">
                    {t('站内消息之外，可以把重要的事再发一条到微信服务号（需要先用微信扫码登录一次）。')}
                  </p>
                </div>

                <div className="px-4 py-3 border-t border-gray-100 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2.5 min-w-0">
                      <MessageCircle
                        className={`w-4 h-4 shrink-0 ${wechatReady ? 'text-[#07c160]' : 'text-gray-400'}`}
                      />
                      <span className={`text-sm truncate ${wechatReady ? 'text-gray-800' : 'text-gray-500'}`}>
                        {t(prefs.channels.wechat.label)}
                      </span>
                    </div>
                    {wechat?.configured ? (
                      wechat.bound ? (
                        <button
                          type="button"
                          disabled={testing}
                          onClick={() => void handleTestWechat()}
                          className="flex items-center space-x-1 text-[12px] text-[#07c160] disabled:opacity-50"
                        >
                          {testing ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Send className="w-3.5 h-3.5" />
                          )}
                          <span>{t('发一条测试消息')}</span>
                        </button>
                      ) : (
                        <span className="text-[11px] text-amber-600">{t('未绑定微信')}</span>
                      )
                    ) : (
                      <span className="text-[11px] text-gray-400">{t('服务端未配置')}</span>
                    )}
                  </div>
                  {wechat?.hint ? (
                    <p className="text-[11px] text-gray-400 leading-relaxed pl-6">{t(wechat.hint)}</p>
                  ) : null}
                  {wechat?.configured && wechat.bound && lastDelivery ? (
                    <p className="text-[11px] text-gray-400 leading-relaxed pl-6">
                      {lastDelivery.status === 'sent'
                        ? t('最近一次投递：成功')
                        : lastDelivery.status === 'failed'
                          ? t('最近一次投递：失败（已重试 {{v0}} 次）', { v0: lastDelivery.attempts })
                          : t('最近一次投递：排队中')}
                      {lastDelivery.lastError ? ` · ${lastDelivery.lastError}` : ''}
                    </p>
                  ) : null}
                </div>

                <div className="px-4 py-3 border-t border-gray-100 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-500">{t(prefs.channels.push.label)}</span>
                    <span className="text-[11px] text-gray-400">{t('不适用')}</span>
                  </div>
                  {prefs.channels.push.reason ? (
                    <p className="text-[11px] text-gray-400 leading-relaxed">{t(prefs.channels.push.reason)}</p>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            <div className="flex items-start space-x-2 px-1 pb-2">
              <Info className="w-3.5 h-3.5 text-gray-300 mt-0.5 shrink-0" />
              <p className="text-[11px] text-gray-400 leading-relaxed">
                {t('「设备失联」「管控能力失效」这类消息建议保持开启：它们意味着孩子手机上的管控可能已经不起作用了。')}
              </p>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
