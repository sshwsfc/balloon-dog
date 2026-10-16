import { useTranslation } from 'react-i18next'
import { AlertTriangle, Cable, MessageCircle, ShieldAlert, Smartphone } from 'lucide-react'

interface Vendor {
  name: string
  steps: string
}

/**
 * 各厂商「禁止安装 / 未知来源」的解除路径。
 *
 * 这些是新手家长最容易卡住的地方：下载下来的安装包点了没反应、或者弹一句
 * 「为保护手机安全，已阻止安装」，然后就不知道怎么办了。把常见品牌逐条列出来，
 * 比只说一句「允许未知来源」有用得多。
 */
const VENDORS: Vendor[] = [
  {
    name: '小米 / 红米（MIUI、HyperOS）',
    steps: '设置 → 应用设置 → 应用管理 → 找到「文件管理」或你用的浏览器 → 权限管理 → 允许「安装未知应用」。若提示「为保护手机安全，已阻止安装」，再到设置的「安全」里关闭「纯净模式」。',
  },
  {
    name: '华为 / 荣耀（EMUI、HarmonyOS）',
    steps: '设置 → 安全 → 更多安全设置 → 安装外部来源应用 → 找到「文件管理」或浏览器 → 允许。若开着「纯净模式」，到「设置 → 系统和更新 → 纯净模式」里退出。',
  },
  {
    name: 'OPPO / 一加 / realme（ColorOS）',
    steps: '设置 → 密码与安全 → 系统安全 → 外部来源应用 → 找到对应的来源应用 → 允许。',
  },
  {
    name: 'vivo / iQOO（OriginOS）',
    steps: '设置 → 安全 → 更多安全设置 → 安装未知应用 → 找到对应的来源应用 → 允许。',
  },
  {
    name: '三星（One UI）',
    steps: '设置 → 生物识别和安全 → 安装未知应用 → 选择来源应用 → 允许。',
  },
  {
    name: '原生 Android / 其它品牌',
    steps: '设置 → 安全 → 安装未知应用（部分机型叫「外部来源应用」）→ 选择你用来打开安装包的那个应用 → 允许。',
  },
]

/**
 * 「怎么把安装包弄到孩子手机上」的几种办法。
 *
 * 只列真正可行的三条。**刻意不放「两台手机连同一个 WiFi」**：那句话听着合理，
 * 实际要求家长知道本机 IP、还要在手机浏览器里手敲一串地址，家庭网络里
 * 路由器开了 AP 隔离或访客网络时更是完全走不通，是这条引导里最容易让人卡住、
 * 最后放弃的一步。扫码下载已经覆盖了同样的场景，且没有这些前提。
 */
const TRANSFER_WAYS: { icon: typeof Smartphone; title: string; detail: string }[] = [
  {
    icon: Smartphone,
    title: '孩子手机就在你手上（最快）',
    detail: '用孩子手机扫上一步的二维码，下载完直接点开安装包安装。',
  },
  {
    icon: MessageCircle,
    title: '用微信 / QQ 发过去',
    detail: '在这台手机上把安装包下载下来，然后通过微信「文件传输助手」或 QQ 发给孩子的账号，在孩子手机上点开文件安装。',
  },
  {
    icon: Cable,
    title: '用数据线连电脑',
    detail: '把安装包拷到孩子手机的「Download」文件夹，再在手机上用「文件管理」找到它并点开。',
  },
]

export function InstallGuide() {
  const { t } = useTranslation()

  return (
    <div className="space-y-5">
      {/* ---------- 怎么传过去 ---------- */}
      <section>
        <h3 className="text-sm font-medium text-gray-900">{t('把安装包放到孩子手机上')}</h3>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">
          {t('注意区分两个端：你现在用的这个「气球狗」是家长端，只装在你自己手机上；孩子端要装在被管的那台手机上。下面三种方式任选一种。')}
        </p>
        <div className="mt-2 space-y-2">
          {TRANSFER_WAYS.map((way) => (
            <div key={way.title} className="flex gap-2.5 rounded-lg border border-gray-100 bg-white p-3">
              <way.icon className="mt-0.5 h-4 w-4 shrink-0 text-[#07c160]" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-gray-900">{t(way.title)}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">{t(way.detail)}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- 禁止安装 ---------- */}
      <section>
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-amber-900">
              {t('如果手机提示「禁止安装」或「已阻止安装」')}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-amber-800">
              {t('这不是安装包有问题，而是安卓默认不允许安装「非应用商店」的应用，需要在孩子手机上手动放开一次。按下面的机型找到对应开关：')}
            </p>
          </div>
        </div>

        <div className="mt-2 divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-100 bg-white">
          {VENDORS.map((vendor) => (
            <div key={vendor.name} className="p-3">
              <p className="text-xs font-medium text-gray-900">{t(vendor.name)}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-gray-500">{t(vendor.steps)}</p>
            </div>
          ))}
        </div>

        <div className="mt-2 space-y-2">
          <div className="flex gap-2.5 rounded-lg border border-gray-100 bg-white p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-orange-400" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-gray-900">{t('提示「被 Play 保护机制拦截」')}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">
                {t('在弹窗里选择「仍要安装」；如果只有「取消」，就到 Google Play 的设置里暂时关闭「扫描应用」再重试。')}
              </p>
            </div>
          </div>
          <div className="flex gap-2.5 rounded-lg border border-gray-100 bg-white p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-orange-400" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-gray-900">{t('装完还要开一批授权，尤其别漏「设备管理器」')}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">
                {t('孩子端第一次打开会列出待办清单：无障碍服务、悬浮窗、电池白名单、使用情况访问，以及「设备管理器」。前几项决定管不管得住，设备管理器决定「会不会被卸掉」——没开它，孩子长按桌面上的图标就能直接卸载。下一步会带你在孩子手机上走完这张清单。')}
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
