import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  ArrowLeft,
  ArrowRight,
  BellRing,
  BookOpen,
  CalendarClock,
  Check,
  Clock,
  Eye,
  KeyRound,
  Loader2,
  MapPin,
  PartyPopper,
  ScanLine,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api, toUserMessage } from '@/services/api'
import { isWechatBrowser, scanWithWechat } from '@/lib/wechat'
import { InstallGuide } from '@/components/onboarding/InstallGuide'
import { ScanCodeDialog } from '@/components/onboarding/ScanCodeDialog'
import { AgentInstallCard } from '@/components/onboarding/AgentInstallCard'
import {
  ONBOARDING_STEPS,
  finishOnboarding,
  firstPendingStep,
  markStepDone,
  markStepUndone,
  skipOnboarding,
  useOnboarding,
  type OnboardingStepId,
} from '@/hooks/useOnboarding'

/** 引导里介绍的能力。刻意只列家长最关心的 6 项，不做成功能大全。 */
const HIGHLIGHTS = [
  { icon: Clock, title: '时间规划', desc: '到点自动锁屏，不用天天盯着' },
  { icon: ShieldCheck, title: '应用限制', desc: '给游戏、短视频单独设时长' },
  { icon: BookOpen, title: '答题解锁', desc: '答对题才能继续用，用时长当奖励' },
  { icon: MapPin, title: '位置与安全区', desc: '到校到家会记录，范围外可提醒' },
  { icon: Eye, title: '护眼与屏幕洞察', desc: '连续用眼提醒，内容异常会提醒你' },
  { icon: BellRing, title: '远程操作', desc: '远程锁屏、拍照、截图、协助' },
]

const STEP_TITLES: Record<OnboardingStepId, string> = {
  welcome: '欢迎使用气球狗',
  install: '在孩子手机上装好孩子端',
  bind: '输入绑定码完成绑定',
  done: '设置完成',
}

export function OnboardingPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const state = useOnboarding()
  const current = firstPendingStep(state)

  const totalSteps = ONBOARDING_STEPS.length
  const currentIndex = ONBOARDING_STEPS.indexOf(current)
  /**
   * 'done' 是走完三步之后的庆功页，不在 ONBOARDING_STEPS 里，indexOf 会返回 -1。
   * 直接用会让页头显示「第 0 / 3 步」、进度条算出负数，所以在这里落回最后一步。
   */
  const stepNumber = current === 'done' ? totalSteps : currentIndex + 1
  const progressPercent =
    current === 'done' ? 100 : Math.round((currentIndex / (totalSteps - 1)) * 100)

  const [deviceCode, setDeviceCode] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [binding, setBinding] = useState(false)
  const [scanning, setScanning] = useState(false)

  /**
   * 这里以前在挂载时就把 'welcome' 标成已完成（当时的理由是「返回时不要从头开始」）。
   * 现在第一步里放了下载二维码，一挂载就标完成会让这一步**只闪一帧就被跳过**，
   * 家长永远看不到二维码。改成由底部「下一步」来推进（见 goNext）。
   */
  const goNext = useCallback(() => {
    markStepDone(current)
  }, [current])

  const handleSkip = () => {
    skipOnboarding()
    toast.info(t('已跳过引导，随时可在「我的」重新开始'))
    navigate('/', { replace: true })
  }

  /**
   * 绑定。成功后不再让用户点「下一步」——直接把这一步标成完成、
   * 标记引导结束并跳到庆祝页，减少一次无意义的点击。
   */
  const handleBind = async () => {
    const code = deviceCode.trim().toUpperCase()
    if (!/^[A-Z0-9]{6,12}$/.test(code)) {
      toast.error(t('绑定码是孩子端首页的 6-12 位字符'))
      return
    }
    setBinding(true)
    try {
      const res = await api.bindDevice({ deviceCode: code, name: deviceName.trim() || undefined })
      markStepDone('bind')
      finishOnboarding()
      toast.success(res.alreadyBound ? t('这台设备已在你账号下') : t('绑定成功，开始守护吧'))
    } catch (error) {
      toast.error(toUserMessage(error, t('绑定失败，请检查绑定码')))
    } finally {
      setBinding(false)
    }
  }

  const handleFinish = () => {
    finishOnboarding()
    navigate('/', { replace: true })
  }

  /** 扫到二维码后把内容填进输入框，并顺手把焦点交还给用户确认，不直接提交 */
  const handleScanResult = (raw: string) => {
    const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
    if (!code) {
      toast.error(t('这个二维码里没有绑定码，请扫孩子端首页的'))
      return
    }
    setDeviceCode(code)
    toast.success(t('已扫到绑定码，确认后点「绑定这台设备」'))
  }

  /**
   * 点扫一扫图标。
   *
   * 微信内先调微信自己的扫一扫 —— 识别率、对焦和权限体验都明显更好；
   * 不在微信里、或微信那条链路走不通时，再退到页面内的摄像头扫码。
   *
   * 微信那一步必须在**点击的同一个事件里**发起：挪进对话框的 effect 里会丢掉
   * 用户手势，iOS 微信上可能直接不弹扫一扫界面。
   */
  const handleScanClick = async () => {
    if (isWechatBrowser()) {
      try {
        const raw = await scanWithWechat()
        if (raw) handleScanResult(raw)
        return
      } catch (error) {
        // 最常见的原因是公众号没配「JS 接口安全域名」或没有扫一扫权限。
        // 这里刻意不弹错误框打断家长，直接退到页面内扫码 / 手动输入。
        // 代价是「用户在微信里主动取消」也会走到下面弹摄像头对话框，可以接受：
        // 关掉它就好了，但配错域名的人能因此找到可用的路。
        console.warn('微信扫一扫不可用，改用页面内扫码：', error)
      }
    }
    setScanning(true)
  }

  /** 绑定步骤里查一下是否其实已经有设备（用户可能中途自己绑好了） */
  const [hasDevice, setHasDevice] = useState(false)
  useEffect(() => {
    let cancelled = false
    api
      .getDevices()
      .then((res) => {
        if (!cancelled) setHasDevice((res.devices ?? []).length > 0)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [current])

  return (
    <div className="page-shell page-shell--immersive">
      {/* ---------- 顶部进度 ---------- */}
      <div className="page-header border-b border-gray-200 bg-white px-4 pb-3 pt-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label={t('返回')}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100"
            onClick={() => navigate('/')}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-gray-400">
              {t('新手引导')} · {t('第 {{v0}} / {{v1}} 步', { v0: stepNumber, v1: totalSteps })}
            </p>
            <h1 className="truncate text-base font-medium text-gray-900">{t(STEP_TITLES[current])}</h1>
          </div>
          <button type="button" className="shrink-0 text-xs text-gray-400 hover:text-gray-600" onClick={handleSkip}>
            {t('跳过')}
          </button>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-100">
          <div
            className="h-full rounded-full bg-[#07c160] transition-all duration-300"
            style={{ width: `${Math.max(6, progressPercent)}%` }}
          />
        </div>
        {/* 步骤点：做完的打勾，让「已经走了多远」一眼可见 */}
        <div className="mt-3 flex items-center justify-between">
          {ONBOARDING_STEPS.map((step, index) => {
            const done = state.completed.includes(step)
            const active = step === current
            return (
              <div key={step} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-medium ${
                    done
                      ? 'bg-[#07c160] text-white'
                      : active
                        ? 'bg-[#07c160]/15 text-[#07c160] ring-1 ring-[#07c160]'
                        : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  {done ? <Check className="h-3.5 w-3.5" /> : index + 1}
                </div>
                <span className={`text-[10px] ${active ? 'text-[#07c160]' : 'text-gray-400'}`}>
                  {t(STEP_TITLES[step])}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* ---------- 步骤内容 ---------- */}
      <div className="px-4 py-4">
        {current === 'welcome' && (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-gray-600">
              {t('气球狗分两端：这个是家长端，装在你自己手机上；孩子端装在被管的那台手机上。配对后就能远程管使用时间、看位置，必要时锁屏。')}
            </p>
            {/* 六张卡固定一行两个、共三行：手机上也是两列，避免竖着排六行把「下一步」挤出屏幕。
                page-shell 在宽屏下已把内容限宽到 48rem，所以不需要再加 sm:/lg: 档位。 */}
            <div className="grid grid-cols-2 gap-2">
              {HIGHLIGHTS.map((item) => (
                <div key={item.title} className="flex gap-2.5 rounded-xl border border-gray-100 bg-white p-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-green-50">
                    <item.icon className="h-4 w-4 text-[#07c160]" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-gray-900">{t(item.title)}</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">{t(item.desc)}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* ---------- 下载孩子端：以「扫一扫」为主入口 ---------- */}
            {/* 二维码 + 手动下载 + 排障引导统一在 AgentInstallCard 里：绑定对话框
                也用它，两处各写一份必然会漂移（二维码和真实下载地址对不上时，
                家长扫了没反应、连报错都没有）。 */}
            <section className="rounded-xl border border-gray-100 bg-white p-4">
              {/* 排障引导（怎么传过去 / 怎么放开「禁止安装」）在下一步「install」里
                  完整展示，这里不重复折叠一份。 */}
              <AgentInstallCard withTroubleshooting={false} />
            </section>

            <div className="rounded-xl bg-gray-50 p-3">
              <p className="text-[11px] leading-relaxed text-gray-500">
                {t('整个过程约 5 分钟：装孩子端 → 拿绑定码 → 在这里输入。装好配对后，其他设置可以慢慢来。')}
              </p>
            </div>
          </div>
        )}

        {current === 'install' && <InstallGuide />}

        {current === 'bind' && (
          <div className="space-y-4">
            {hasDevice ? (
              <div className="rounded-xl border border-green-200 bg-green-50 p-4">
                <div className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-[#07c160]" />
                  <p className="text-sm font-medium text-green-800">{t('你已绑定设备')}</p>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-green-700">
                  {t('可以直接进入下一步设置管控规则。')}
                </p>
              </div>
            ) : (
              <>
                <div className="rounded-xl border border-gray-100 bg-white p-4">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4 text-[#07c160]" />
                    <p className="text-sm font-medium text-gray-900">{t('绑定码在孩子端首页')}</p>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-gray-600">
                    {t('第一次打开孩子端，首页会显示 6-12 位字母数字，就是绑定码；下面还有内容相同的二维码，可以手输，也可以直接扫。')}
                  </p>
                  <div className="mt-3 rounded-lg bg-gray-50 px-3 py-3 text-center">
                    <p className="font-mono text-lg tracking-[0.3em] text-gray-800">{t('例如 A3F9K2M7')}</p>
                  </div>
                </div>

                <div className="rounded-xl border border-gray-100 bg-white p-4">
                  <label className="block text-xs font-medium text-gray-700" htmlFor="onboarding-code">
                    {t('设备绑定码')}
                  </label>
                  <div className="relative mt-2">
                    <input
                      id="onboarding-code"
                      value={deviceCode}
                      onChange={(e) => setDeviceCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                      placeholder={t('例如 A3F9K2M7')}
                      maxLength={12}
                      autoCapitalize="characters"
                      autoComplete="off"
                      className="w-full rounded-lg border border-gray-300 py-3 pl-3 pr-12 text-center font-mono text-lg tracking-[0.25em] focus:border-[#07c160] focus:outline-none"
                    />
                    {/* 扫一扫：直接扫孩子端绑定码下方那个同值二维码，省掉手输 8 位码 */}
                    <button
                      type="button"
                      aria-label={t('扫一扫')}
                      title={t('扫一扫')}
                      onClick={() => void handleScanClick()}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-2 text-[#07c160] hover:bg-green-50 active:bg-green-100"
                    >
                      <ScanLine className="h-5 w-5" />
                    </button>
                  </div>
                  <label className="mt-3 block text-xs font-medium text-gray-700" htmlFor="onboarding-name">
                    {t('给孩子设备起个名字（可选）')}
                  </label>
                  <input
                    id="onboarding-name"
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    placeholder={t('例如 小明的小米手机')}
                    maxLength={30}
                    className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-[#07c160] focus:outline-none"
                  />
                </div>
                <Button className="w-full" disabled={binding} onClick={() => void handleBind()}>
                  {binding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Smartphone className="h-4 w-4" />}
                  {binding ? t('绑定中…') : t('绑定这台设备')}
                </Button>
                <p className="text-center text-[11px] text-gray-400">
                  {t('绑定失败通常是绑定码输错，或设备已被别的账号认领。')}
                </p>
              </>
            )}
          </div>
        )}

        {current === 'done' && (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-50">
              <PartyPopper className="h-8 w-8 text-[#07c160]" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900">{t('都设置好了 🎉')}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-gray-500">
                {t('孩子端已在你账号下。其他设置按需要慢慢配，建议先从「时间规划」开始。')}
              </p>
            </div>
            <div className="space-y-2 text-left">
              {[
                { icon: CalendarClock, title: t('设置作息时间表'), desc: t('睡觉、上学时段自动锁屏'), to: '/schedule' },
                { icon: BookOpen, title: t('打开答题解锁'), desc: t('答对题换取时长'), to: '/quiz-unlock' },
                { icon: Eye, title: t('看看护眼设置'), desc: t('连续用眼提醒与强制休息'), to: '/eye-care' },
              ].map((item) => (
                <button
                  key={item.title}
                  type="button"
                  className="flex w-full items-center gap-3 rounded-xl border border-gray-100 bg-white p-3 text-left active:bg-gray-50"
                  onClick={() => navigate(item.to)}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-green-50">
                    <item.icon className="h-4 w-4 text-[#07c160]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-gray-900">{t(item.title)}</p>
                    <p className="mt-0.5 text-[11px] text-gray-500">{t(item.desc)}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-gray-300" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ---------- 底部操作 ---------- */}
      <div className="sticky bottom-0 border-t border-gray-200 bg-white px-4 py-3">
        {current === 'done' ? (
          <Button className="w-full" onClick={handleFinish}>
            <Sparkles className="h-4 w-4" />
            {t('进入家长端')}
          </Button>
        ) : (
          <div className="flex gap-2">
            {currentIndex > 0 && (
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => markStepUndone(ONBOARDING_STEPS[currentIndex - 1])}
              >
                <ArrowLeft className="h-4 w-4" />
                {t('上一步')}
              </Button>
            )}
            <Button className="flex-1" onClick={goNext} disabled={current === 'bind' && !hasDevice}>
              {t('下一步')}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      <ScanCodeDialog open={scanning} onOpenChange={setScanning} onResult={handleScanResult} />
    </div>
  )
}
