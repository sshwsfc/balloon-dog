import { useTranslation } from 'react-i18next'
import { Accessibility, AppWindow, BatteryCharging, Lock, ShieldCheck, Timer, TriangleAlert } from 'lucide-react'

/**
 * 引导第 3 步：在孩子手机上开启授权。
 *
 * 为什么单独占一步：这一步原先只是「安装说明」折叠区里的一句附注，家长几乎必跳过，
 * 而实测的后果很直接 —— 用户反馈「长按桌面上的图标，菜单里就有卸载，点一下应用就没了」。
 * 装完 APK 只代表应用进了手机，「会不会被卸掉」取决于孩子端首页那张「需要开启」清单，
 * 尤其是**设备管理器**：非设备所有者时，它是卸载路上唯一的闸。
 *
 * 这一屏刻意不复述安装步骤（上一步讲了），只讲清单里每一项「不开会怎样」，
 * 并把「设备管理器」标成必做 —— 其余几项只影响管得住管不住，不影响能不能被卸掉。
 */

interface AuthorizeItem {
  icon: typeof Lock
  title: string
  desc: string
  /** 必做项会显示红色「必做」徽标，排在第一位 */
  required?: boolean
}

/**
 * 顺序跟着孩子端首页的清单走，但把「设备管理器」提到第一位：
 * 家长端这一步的目的就是防卸载，先讲最要紧的那一项。
 */
const AUTHORIZE_ITEMS: AuthorizeItem[] = [
  {
    icon: Lock,
    title: '设备管理器',
    desc: '激活后，孩子想卸载本应用必须先「停用设备管理器」，而那个页面会被守护挡回桌面。没开它，卸载前连一句提醒都没有。',
    required: true,
  },
  {
    icon: Accessibility,
    title: '无障碍服务',
    desc: '锁屏、拦截应用、退回桌面、免授权截图都靠它。被关掉时守护会自己发现并提醒，但中间的窗口期是敞开的。',
  },
  {
    icon: AppWindow,
    title: '悬浮窗权限',
    desc: '锁定时需要在最上层盖一整页；没有它，锁屏只剩一条通知，孩子一划就过去了。',
  },
  {
    icon: BatteryCharging,
    title: '电池优化白名单',
    desc: '否则息屏一会儿系统就会冻结守护，出现「点了锁屏半天没反应」。',
  },
  {
    icon: Timer,
    title: '使用情况访问',
    desc: '应用限时和应用审核要靠它读使用时长，没开只能看到「未授权」。',
  },
]

export function AuthorizeGuide() {
  const { t } = useTranslation()

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-gray-600">
        {t('孩子端装好、第一次打开它，首页会列出一张「需要开启」清单。请把「设备管理器」这一项勾上——它是「长按图标就能卸载」那条路上唯一的闸。')}
      </p>

      <div className="rounded-xl border border-red-200 bg-red-50 p-3.5">
        <div className="flex gap-2.5">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
          <p className="text-xs leading-relaxed text-red-700">
            {t('没开「设备管理器」的话：孩子长按桌面上的守卫图标，菜单里就有「卸载」，点一下应用就没了——系统不会拦，也不会问你。')}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {AUTHORIZE_ITEMS.map((item) => (
          <div key={item.title} className="flex gap-2.5 rounded-xl border border-gray-100 bg-white p-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-green-50">
              <item.icon className="h-4 w-4 text-[#07c160]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="text-xs font-medium text-gray-900">{t(item.title)}</p>
                {item.required && (
                  <span className="shrink-0 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-600">
                    {t('必做')}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">{t(item.desc)}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-gray-100 bg-white p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-[#07c160]" />
          <p className="text-sm font-medium text-gray-900">{t('怎么开')}</p>
        </div>
        <ol className="mt-2 space-y-1.5 text-xs leading-relaxed text-gray-600">
          <li>{t('1. 让孩子端停在首页那张「需要开启」清单上，点每一项右边的「去开启」。')}</li>
          <li>
            {t('2. 只剩「设备管理器」没开时，点清单上方的「一键开启权限」，会直接跳到系统的激活页，在弹框里选「激活」。')}
          </li>
          <li>
            {t('3. 每一项都能看见「已开启 ✓」就算走完了，回到这里输入绑定码。')}
          </li>
        </ol>
      </div>

      <div className="rounded-xl bg-gray-50 p-3">
        <p className="text-[11px] leading-relaxed text-gray-500">
          {t('想更彻底：能用电脑的话，把孩子手机设成「设备所有者」（孩子端设置页里有开通说明）。设了它，连桌面上的占位图标都不会再出现，卸载会被系统直接拦下。这一步不是必须的。')}
        </p>
      </div>
    </div>
  )
}
