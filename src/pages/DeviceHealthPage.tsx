import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HeaderRefreshButton } from '@/components/HeaderRefreshButton'
import { FeatureTip } from '@/components/FeatureTip'
import { toast } from 'sonner'
import {
  AlertOctagon,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Clock,
  HelpCircle,
  Info,
  Loader2,
  Power,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Wrench,
  XCircle,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { DeviceHealth, DeviceHealthGap, DeviceHealthLevel } from '@/types'
import { useTranslation } from 'react-i18next'
import { formatDateTime, formatRelative } from '@/lib/format'

/**
 * 「重新检测」之后等设备回报快照的最长时间。
 *
 * 设备是长轮询领指令的（`/api/agent/commands/next?wait=`），在线的设备通常一两秒就回；
 * 但息屏后可能被 Doze 拖到十几秒。超过这个时间就如实告诉家长「设备可能离线」，
 * **不要**假装检测成功 —— 乐观置绿比不置绿更糟。
 */
const SELF_CHECK_TIMEOUT_MS = 15_000
const SELF_CHECK_POLL_MS = 1_500

/** 顶部的三档配色：绿=全部生效、琥珀=有降级、红=关键开关被关 */
const LEVEL_STYLE: Record<DeviceHealthLevel, { ring: string; bg: string; text: string; icon: typeof ShieldCheck }> = {
  ok: { ring: 'border-green-200', bg: 'bg-green-50', text: 'text-[#07c160]', icon: ShieldCheck },
  warn: { ring: 'border-amber-200', bg: 'bg-amber-50', text: 'text-amber-600', icon: AlertTriangle },
  danger: { ring: 'border-red-200', bg: 'bg-red-50', text: 'text-red-600', icon: AlertOctagon },
}

/** 缺口左侧竖条的颜色；critical 用红色，其余琥珀色 */
function gapAccent(gap: DeviceHealthGap): string {
  if (gap.importance === 'critical') return 'border-l-red-500'
  if (gap.importance === 'major') return 'border-l-amber-500'
  return 'border-l-gray-300'
}

function gapBadgeClass(gap: DeviceHealthGap): string {
  if (gap.importance === 'critical') return 'bg-red-50 text-red-600 border-red-200'
  if (gap.importance === 'major') return 'bg-amber-50 text-amber-700 border-amber-200'
  return 'bg-gray-100 text-gray-600 border-gray-200'
}

/**
 * 「怎么修」：分机型步骤的折叠块（规划 §1.4）。
 *
 * 默认收起 —— 一屏里可能有三条缺口，全展开会把页面变成一篇说明书，
 * 家长真正要的是「这条严重吗」，步骤是在他决定动手之后才需要的。
 *
 * 步骤文案由**服务端**按设备机型选好（`devices.fix-steps.ts`），家长端只负责排版：
 * 客户端判断机型需要 model 字段和一套机型表，而这两件事服务端都已经有了。
 */
function FixSteps({ title, steps }: { title?: string; steps: string[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  if (steps.length === 0) return null
  return (
    <div className="mt-2 rounded-md border border-gray-100 bg-white">
      <button
        type="button"
        className="flex w-full items-center justify-between px-2.5 py-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center space-x-1.5">
          <Wrench className="h-3.5 w-3.5 flex-shrink-0 text-[#07c160]" />
          <span className="text-[11px] font-medium text-gray-700">
            {title ? t('{{v0}} · 怎么修', { v0: t(title) }) : t('怎么修（{{v0}} 步）', { v0: steps.length })}
          </span>
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 flex-shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <ol className="space-y-1.5 border-t border-gray-100 px-2.5 py-2">
          {steps.map((step, index) => (
            <li key={index} className="flex items-start space-x-1.5">
              <span className="mt-[1px] flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[#07c160]/10 text-[10px] font-medium text-[#07c160]">
                {index + 1}
              </span>
              <span className="flex-1 text-[11px] leading-relaxed text-gray-600">{step}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export function DeviceHealthPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [health, setHealth] = useState<DeviceHealth | null>(null)
  const [checking, setChecking] = useState(false)
  /** 轮询用的定时器；卸载时必须清掉，否则会对着已卸载的组件 setState */
  const pollTimer = useRef<number | null>(null)

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  /**
   * 拉一次健康快照。
   *
   * 写成 `.then()` 链而不是 `async` 函数：React Compiler 会把 `async` 函数里的
   * setState 追进调用它的 effect，判成「effect 里同步 setState」而报 lint。
   * 链式写法语义一样（同样返回 Promise，调用方照旧可以 await），但边界清晰。
   */
  const loadData = useCallback(
    (options?: { silent?: boolean }) =>
      api
        .getDeviceHealth()
        .then((data) => {
          setHealth(data)
          setError(null)
        })
        .catch((err: unknown) => {
          const message = toUserMessage(err, t('加载设备健康状态失败'))
          setError(message)
          if (!options?.silent) toast.error(message)
        })
        .finally(() => setLoading(false)),
    [t],
  )

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => stopPolling, [stopPolling])

  /**
   * 让设备立刻体检一次。
   *
   * 三步，缺一不可：
   *  1. 下发 `self_check`（真指令，走队列 —— 服务端不能替设备看系统开关）；
   *  2. 轮询 `updatedAt`，等设备把新快照报回来；
   *  3. 超时就如实说「没等到回报」，把判断权交回家长。
   *
   * 刻意不做「点了就变绿」的乐观更新：那会让家长以为已经修好了。
   */
  const requestSelfCheck = async () => {
    const baseline = health?.updatedAt ?? null
    setChecking(true)
    try {
      const result = await api.requestDeviceHealthCheck()
      if (!result.success || !result.command) {
        toast.error(t('下发检测指令失败，请稍后重试'))
        return
      }
      toast.success(t('已让设备开始体检，请稍候…'))

      const startedAt = Date.now()
      stopPolling()
      pollTimer.current = window.setInterval(async () => {
        try {
          const next = await api.getDeviceHealth()
          setHealth(next)
          if (next.updatedAt && next.updatedAt !== baseline) {
            stopPolling()
            setChecking(false)
            toast.success(t('设备已回报最新状态'))
            return
          }
        } catch {
          // 轮询期间的网络抖动不用打扰家长；到点统一提示
        }
        if (Date.now() - startedAt > SELF_CHECK_TIMEOUT_MS) {
          stopPolling()
          setChecking(false)
          toast.error(t('没等到设备回报。它可能离线、被冻结，或已被卸载。'))
        }
      }, SELF_CHECK_POLL_MS)
    } catch (err) {
      toast.error(toUserMessage(err, t('下发检测指令失败，请稍后重试')))
    } finally {
      // checking 由轮询的成功/超时分支收尾；这里只兜住同步抛出的路径
      if (pollTimer.current === null) setChecking(false)
    }
  }

  if (loading) {
    return (
      <div className="page-shell page-shell--center">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-b-2 border-[#07c160]" />
          <p className="mt-2 text-sm text-gray-500">{t('加载中...')}</p>
        </div>
      </div>
    )
  }

  const header = (
    <div className="page-header flex items-center border-b border-gray-200 bg-white px-4 py-3 [@media(max-height:520px)]:py-2 sm:px-5">
      <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
        <ArrowLeft className="w-5 h-5" />
      </Button>
      <h1 className="flex-1 text-xl font-medium text-gray-900">{t('设备健康')}</h1>
      <HeaderRefreshButton onRefresh={() => loadData({ silent: true })} />
    </div>
  )

  if (error && !health) {
    return (
      <div className="page-shell">
        {header}
        <div className="px-6 py-20 text-center">
          <ShieldAlert className="mx-auto mb-3 h-12 w-12 text-gray-300" />
          <p className="text-gray-700">{error}</p>
          <Button
            className="mt-4 bg-[#07c160] hover:bg-[#06a050]"
            onClick={() => {
              setLoading(true)
              void loadData()
            }}
          >
            {t('重新加载')}
          </Button>
        </div>
      </div>
    )
  }

  if (!health) return null

  const style = LEVEL_STYLE[health.level]
  const LevelIcon = health.reported ? style.icon : HelpCircle
  /** 失联时整页都要提醒：再绿的开关也不代表「现在」 */
  const livenessTone =
    health.liveness === 'online'
      ? 'text-[#07c160]'
      : health.liveness === 'delayed'
        ? 'text-amber-600'
        : 'text-red-600'

  return (
    <div className="page-shell">
      {header}

      {error && (
        <div className="px-3 pt-3">
          <div className="flex items-start space-x-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
            <p className="flex-1 text-xs text-amber-700">{error}</p>
          </div>
        </div>
      )}

      {/* ---------------- 结论卡 ---------------- */}
      <div className="px-3 py-3">
        <Card className={`overflow-hidden border ${style.ring}`}>
          <CardContent className="p-4">
            <div className="flex items-start">
              <div className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl ${style.bg}`}>
                <LevelIcon className={`h-6 w-6 ${style.text}`} />
              </div>
              <div className="ml-3 min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-gray-900">{t(health.levelLabel)}</span>
                  <Badge variant="outline" className={`text-xs ${livenessTone} border-current`}>
                    {t(health.livenessLabel)}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {health.deviceName} · {formatRelative(health.lastActiveAt)}
                </p>
                {health.reported && health.summary.openGaps > 0 && (
                  <p className="mt-1 text-xs text-gray-600">
                    {t('{{v0}} 项失效，其中 {{v1}} 项可一键修复', {
                      v0: health.summary.openGaps,
                      v1: health.summary.autoFixable,
                    })}
                  </p>
                )}
              </div>
            </div>

            {/* 设备一次都没报过：不要装作「一切正常」 */}
            {!health.reported && (
              <div className="mt-3 flex items-start space-x-2 rounded-lg bg-gray-50 px-3 py-2">
                <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-400" />
                <p className="flex-1 text-xs leading-relaxed text-gray-600">
                  {t('这台设备还没有上报过体检结果。点下面的「重新检测」，让它在孩子手机上自己检查一遍。')}
                </p>
              </div>
            )}

            {/* 快照过期：里面的绿灯不代表现在 */}
            {health.reported && health.stale && (
              <div className="mt-3 flex items-start space-x-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <Clock className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
                <p className="flex-1 text-xs leading-relaxed text-amber-700">
                  {t('这份状态已经超过 30 分钟没更新了，下面的「已开启」不一定还成立。')}
                </p>
              </div>
            )}

            <div className="mt-3 flex items-center gap-2">
              <Button
                className="flex-1 bg-[#07c160] hover:bg-[#06a050]"
                disabled={checking}
                onClick={() => void requestSelfCheck()}
              >
                {checking ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('等待设备回报…')}
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {t('重新检测')}
                  </>
                )}
              </Button>
            </div>
            {/* 只有设备端能真正执行检测，所以这颗按钮是下发指令，不是本地刷新 */}
            <p className="mt-2 text-center text-[11px] text-gray-400">
              {t('检测在孩子的手机上执行，结果会自动传回来。')}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 缺口：为什么重要 + 怎么修 ---------------- */}
      {health.gaps.length > 0 && (
        <div className="px-3 pb-3">
          <h2 className="mb-2 px-1 text-sm font-medium text-gray-700">
            {t('需要处理（{{v0}}）', { v0: health.gaps.length })}
          </h2>
          <div className="space-y-2">
            {health.gaps.map((gap) => (
              <Card key={gap.id} className={`overflow-hidden border-l-4 ${gapAccent(gap)}`}>
                <CardContent className="p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-gray-900">
                      {gap.label ? t(gap.label) : t('未命名问题')}
                    </span>
                    <Badge variant="outline" className={`flex-shrink-0 text-[11px] ${gapBadgeClass(gap)}`}>
                      {gap.importance === 'critical'
                        ? t('关键')
                        : gap.importance === 'major'
                          ? t('重要')
                          : t('提示')}
                    </Badge>
                  </div>
                  {/* 设备端下发的原文：不在家长端二次翻译，避免两边描述不一致 */}
                  <p className="mt-1.5 text-xs leading-relaxed text-gray-600">{gap.detail}</p>
                  {gap.fixHint && (
                    <div className="mt-2 flex items-start space-x-1.5 rounded-md bg-gray-50 px-2.5 py-1.5">
                      <Wrench className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
                      <p className="flex-1 text-[11px] leading-relaxed text-gray-600">{gap.fixHint}</p>
                    </div>
                  )}
                  <p className="mt-2 text-[11px] text-gray-400">
                    {gap.fixability === 'auto'
                      ? t('点上方「重新检测」即可尝试自动修复')
                      : gap.fixability === 'manual'
                        ? t('需要有人在孩子的手机上操作')
                        : t('系统限制，暂时无法修复')}
                  </p>
                  {/* 只有 manual 的缺口服务端才会给步骤（见 types 里的注释） */}
                  <FixSteps steps={gap.fixSteps ?? []} />
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* ---------------- 开关一览 ---------------- */}
      <div className="px-3 pb-3">
        <h2 className="mb-2 px-1 text-sm font-medium text-gray-700">{t('管控能力')}</h2>
        <Card>
          <CardContent className="p-0">
            {health.checks.map((item, index) => (
              <div
                key={item.key}
                className={`flex items-start gap-3 px-4 py-3 ${index > 0 ? 'border-t border-gray-100' : ''}`}
              >
                <div className="mt-0.5 flex-shrink-0">
                  {item.status === 'on' ? (
                    <CheckCircle2 className="h-5 w-5 text-[#07c160]" />
                  ) : item.status === 'off' ? (
                    item.critical ? (
                      <XCircle className="h-5 w-5 text-red-500" />
                    ) : (
                      <AlertTriangle className="h-5 w-5 text-amber-500" />
                    )
                  ) : (
                    <HelpCircle className="h-5 w-5 text-gray-300" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm text-gray-900">{t(item.label)}</span>
                    {item.critical && (
                      <span className="rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-500">
                        {t('关键')}
                      </span>
                    )}
                  </div>
                  {/* 只在「不是绿灯」时解释后果，全绿时不用刷屏 */}
                  {item.status !== 'on' && (
                    <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">{t(item.why)}</p>
                  )}
                </div>
                <span
                  className={`mt-0.5 flex-shrink-0 text-xs ${
                    item.status === 'on'
                      ? 'text-[#07c160]'
                      : item.status === 'off'
                        ? 'text-amber-600'
                        : 'text-gray-400'
                  }`}
                >
                  {item.status === 'on' ? t('已开启') : item.status === 'off' ? t('已关闭') : t('未知')}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 运行时权限 ---------------- */}
      <div className="px-3 pb-3">
        <h2 className="mb-2 px-1 text-sm font-medium text-gray-700">{t('应用权限')}</h2>
        <Card>
          <CardContent className="grid grid-cols-2 gap-x-4 gap-y-2 p-4 sm:grid-cols-3">
            {health.permissions.map((item) => (
              <div key={item.key} className="flex items-center gap-1.5">
                {item.status === 'granted' ? (
                  <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-[#07c160]" />
                ) : item.status === 'denied' ? (
                  <XCircle className="h-4 w-4 flex-shrink-0 text-red-500" />
                ) : (
                  <HelpCircle className="h-4 w-4 flex-shrink-0 text-gray-300" />
                )}
                <span className="truncate text-xs text-gray-700">{t(item.label)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/*
          被拒的权限再单独给一块「怎么开」：上面的网格是状态一览，这里才是动作。
          设备所有者模式下服务端不会下发步骤（那些权限是静默自授的），所以这里为空。
        */}
        {health.permissions.some((item) => (item.fixSteps ?? []).length > 0) && (
          <Card className="mt-2">
            <CardContent className="p-3.5">
              <p className="text-[11px] leading-relaxed text-gray-500">
                {t('下面这几项权限被系统拒绝了。点开看在这台手机上怎么打开：')}
              </p>
              {health.permissions
                .filter((item) => (item.fixSteps ?? []).length > 0)
                .map((item) => (
                  <FixSteps key={item.key} title={item.label} steps={item.fixSteps} />
                ))}
            </CardContent>
          </Card>
        )}
      </div>

      {/* ---------------- 加固项 ---------------- */}
      {health.restrictions.length > 0 && (
        <div className="px-3 pb-3">
          <h2 className="mb-2 px-1 text-sm font-medium text-gray-700">{t('防绕过加固')}</h2>
          <Card>
            <CardContent className="p-0">
              {health.restrictions.map((item, index) => (
                <div
                  key={item.id}
                  className={`flex items-center gap-3 px-4 py-2.5 ${index > 0 ? 'border-t border-gray-100' : ''}`}
                >
                  <Power
                    className={`h-4 w-4 flex-shrink-0 ${
                      !item.supported ? 'text-gray-300' : item.applied ? 'text-[#07c160]' : 'text-amber-500'
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-gray-700">{t(item.label)}</span>
                  <span className="flex-shrink-0 text-[11px] text-gray-400">
                    {!item.supported ? t('本机不支持') : item.applied ? t('已生效') : t('未生效')}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ---------------- 运行状态 ---------------- */}
      <div className="px-3 pb-6">
        <h2 className="mb-2 px-1 text-sm font-medium text-gray-700">{t('运行状态')}</h2>
        <Card>
          <CardContent className="p-4 text-xs text-gray-600">
            <div className="flex items-center justify-between py-1">
              <span>{t('守护服务')}</span>
              <span className={health.serviceRunning ? 'text-[#07c160]' : 'text-red-500'}>
                {health.serviceRunning ? t('运行中') : t('未运行')}
              </span>
            </div>
            <div className="flex items-center justify-between py-1">
              <span>{t('自动修复次数')}</span>
              <span>{health.healCount}</span>
            </div>
            {health.lastHealAt && (
              <div className="flex items-center justify-between py-1">
                <span>{t('最近一次修复')}</span>
                <span>{formatDateTime(health.lastHealAt)}</span>
              </div>
            )}
            {health.reportedAt && (
              <div className="flex items-center justify-between py-1">
                <span>{t('本次体检时间')}</span>
                <span>{formatDateTime(health.reportedAt)}</span>
              </div>
            )}
            {/* 时钟偏移：孩子改系统时间就能绕过定时锁屏，偏移大必须说出来 */}
            {Math.abs(health.clockSkewSeconds) >= 60 && (
              <div className="mt-2 flex items-start space-x-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5">
                <Clock className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-600" />
                <p className="flex-1 text-[11px] leading-relaxed text-amber-700">
                  {t('孩子手机的时间和服务端相差 {{v0}} 秒。时间被改动会让定时锁屏、屏幕时间限制失准。', {
                    v0: Math.round(Math.abs(health.clockSkewSeconds)),
                  })}
                </p>
              </div>
            )}
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-gray-400">
              <Smartphone className="h-3.5 w-3.5" />
              <span>{t('这些状态由孩子手机上的客户端上报，家长端不做修改。')}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <FeatureTip
        id="deviceHealth"
        text={t('「重新检测」是在孩子手机上跑一次体检：能自动修的（无障碍、权限）会顺手修好，修不了的会告诉你具体在哪一步操作。')}
      />
    </div>
  )
}
