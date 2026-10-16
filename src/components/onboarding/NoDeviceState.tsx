import { Navigate, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Download, KeyRound, ShieldCheck, Smartphone, Sparkles } from 'lucide-react'
import { BrandLogo } from '@/components/BrandLogo'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { firstPendingStep, shouldAutoStart, useOnboarding, type OnboardingStepId } from '@/hooks/useOnboarding'

/**
 * 空态清单的展示顺序与文案；id 必须与引导步骤一一对应
 * （welcome → install → authorize → bind）。
 */
const CHECKLIST: { id: OnboardingStepId; icon: typeof Download; title: string; desc: string }[] = [
  {
    id: 'welcome',
    icon: Download,
    title: '下载孩子端安装包',
    desc: '用孩子手机扫二维码下载，或手动下载后传过去',
  },
  {
    id: 'install',
    icon: Smartphone,
    title: '装到孩子的手机上',
    desc: '家长端只装你自己手机，孩子端装被管的那台',
  },
  {
    id: 'authorize',
    icon: ShieldCheck,
    title: '在孩子手机上开启授权',
    desc: '尤其别漏掉「设备管理器」——没开它，孩子长按图标就能卸载',
  },
  {
    id: 'bind',
    icon: KeyRound,
    title: '输入绑定码完成绑定',
    desc: '绑定成功后就能远程管控了',
  },
]

/**
 * 「还没绑定任何设备」时的首页。
 *
 * 这是家长第一次打开应用最可能看到的画面，所以它**不是错误页**：
 * 没有红色感叹号、没有「加载失败」、也不弹 toast —— 那些都会让新手以为
 * 自己把软件弄坏了。这里只做三件事：说清这个软件是干嘛的、把绑定拆成
 * 看得见进度的四步、给一个明确的大按钮。
 *
 * 真正的操作都在 `/onboarding` 里做；这里只是入口 + 进度展示，避免两处
 * 维护同一套表单。
 */
export function NoDeviceState() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const state = useOnboarding()

  // 第一次打开（一步没走、也没跳过）直接进引导，别让用户自己找入口。
  // 跳过过就不再打扰，只保留下面的清单与按钮。
  if (shouldAutoStart(state)) return <Navigate to="/onboarding" replace />

  const pending = firstPendingStep(state)
  const doneCount = CHECKLIST.filter((item) => state.completed.includes(item.id)).length
  const percent = Math.round((doneCount / CHECKLIST.length) * 100)

  return (
    <div className="page-shell">
      <div className="page-header bg-white px-4 pb-6 pt-8">
        <div className="mx-auto flex max-w-md flex-col items-center text-center">
          <BrandLogo className="h-16 w-16 rounded-2xl" />
          <h1 className="mt-3 text-lg font-medium text-gray-900">{t('欢迎使用气球狗')}</h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-500">
            {t('你还没有绑定孩子的设备。绑定之后，就能在这里看到使用时长、位置，并设置锁屏与时长限制。')}
          </p>
        </div>
      </div>

      <div className="px-3 py-4">
        <Card className="mx-auto max-w-md">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-900">{t('设备绑定')}</span>
              <span className="text-xs text-gray-400">
                {t('已完成 {{v0}} / {{v1}} 步', { v0: doneCount, v1: CHECKLIST.length })}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100">
              <div className="h-full rounded-full bg-[#07c160] transition-all duration-300" style={{ width: `${percent}%` }} />
            </div>

            <div className="mt-4 space-y-3">
              {CHECKLIST.map((item, index) => {
                const done = state.completed.includes(item.id)
                const active = item.id === pending
                return (
                  <div key={item.id} className="flex gap-3">
                    <div
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                        done
                          ? 'bg-[#07c160] text-white'
                          : active
                            ? 'bg-[#07c160]/15 text-[#07c160] ring-1 ring-[#07c160]'
                            : 'bg-gray-100 text-gray-400'
                      }`}
                    >
                      {done ? <Check className="h-4 w-4" /> : <item.icon className="h-4 w-4" />}
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <p className={`text-sm ${done ? 'text-gray-400 line-through' : 'font-medium text-gray-900'}`}>
                        {t('第 {{v0}} 步', { v0: index + 1 })}：{t(item.title)}
                      </p>
                      <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{t(item.desc)}</p>
                    </div>
                  </div>
                )
              })}
            </div>

            <Button className="mt-5 w-full" onClick={() => navigate('/onboarding')}>
              <Sparkles className="h-4 w-4" />
              {doneCount === 0 ? t('开始 4 步设置') : t('继续设置')}
            </Button>
          </CardContent>
        </Card>

        <button
          type="button"
          className="mx-auto mt-3 flex max-w-md items-center justify-center gap-1 text-xs text-gray-400 hover:text-gray-600"
          onClick={() => navigate('/devices')}
        >
          {t('我已经有绑定码了，直接去绑定')}
          <ChevronRight className="h-3.5 w-3.5" />
        </button>

        <p className="mx-auto mt-6 max-w-md text-center text-[11px] leading-relaxed text-gray-400">
          {t('绑定前，孩子在设备上的任何内容都不会上传；每开启一项管控能力都会明确告诉你它采集了什么。')}
        </p>
      </div>
    </div>
  )
}
