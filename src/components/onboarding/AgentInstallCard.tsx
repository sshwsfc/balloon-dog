import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Link as LinkIcon } from 'lucide-react'
import { InstallGuide } from '@/components/onboarding/InstallGuide'
import { QrBlock } from '@/components/onboarding/QrBlock'
import { AGENT_APK_PATH, agentApkUrl } from '@/components/onboarding/apk'
import { isLocalServerUrl } from '@/lib/serverUrl'
import { cn } from '@/lib/utils'

interface AgentInstallCardProps {
  /**
   * 紧凑版：绑定对话框里用。
   *
   * 对话框可视高度有限（横屏手机只有 320–420px），二维码按 200px 展示会把
   * 绑定码输入框和「确认绑定」挤出屏幕，所以这里同时缩小二维码并压掉
   * 引导页才需要的那段长说明。
   */
  compact?: boolean
  /** 是否给「安装遇到问题」的可展开排障引导，默认给 */
  withTroubleshooting?: boolean
  className?: string
}

/**
 * 「怎么把孩子端装到孩子手机上」的完整入口：二维码 + 手动下载地址 + 排障引导。
 *
 * 新手引导页和「绑定新设备」对话框都要展示它，所以抽成一个组件：两处各写一份
 * 必然会漂移，而这个二维码一旦和实际下载地址对不上，家长是**扫了没反应**，
 * 连报错都没有，最难排查。
 *
 * 二维码里编码的是 `agentApkUrl()`（构建期注入的对外域名 + 固定路径），
 * 不是当前页面的 origin —— 家长可能是用局域网 IP 或 localhost 打开家长端的，
 * 那时代码写进二维码孩子手机必然打不开，所以本机地址会额外给一条警示。
 */
export function AgentInstallCard({
  compact = false,
  withTroubleshooting = true,
  className,
}: AgentInstallCardProps) {
  const { t } = useTranslation()
  const [showGuide, setShowGuide] = useState(false)
  const apkUrl = agentApkUrl()

  return (
    <div className={cn('space-y-3', className)}>
      <QrBlock
        value={apkUrl}
        caption="用孩子手机扫这个二维码"
        hint={
          compact
            ? '扫一扫就开始下载孩子端安装包（约 5MB）。'
            : '扫一扫就开始下载孩子端安装包（约 5MB）。要扫给「孩子那台手机」，不是你现在这台。'
        }
        size={compact ? 140 : 200}
      />

      {isLocalServerUrl() && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5">
          <p className="text-[11px] leading-relaxed text-amber-800">
            {t('当前对外地址是本机地址（{{v0}}），孩子手机扫了也打不开。请在仓库根目录 .env 里把 VITE_SERVER_URL 配成孩子手机能访问的域名，或先用下面的手动下载方式。', { v0: apkUrl })}
          </p>
        </div>
      )}

      <section className="rounded-xl bg-gray-50 p-3">
        <p className="text-xs font-medium text-gray-700">{t('手动下载方式')}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
          {t('扫码不方便时，用孩子手机浏览器打开下面地址：')}
        </p>
        <p className="mt-1.5 break-all font-mono text-[11px] text-gray-700">{apkUrl}</p>
        <a
          href={AGENT_APK_PATH}
          download
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-[#07c160] underline"
        >
          <LinkIcon className="h-3 w-3" />
          {t('也可以在这台手机上下载后，再传给孩子手机')}
        </a>
      </section>

      {withTroubleshooting && (
        <div className="overflow-hidden rounded-xl border border-gray-100 bg-white">
          <button
            type="button"
            aria-expanded={showGuide}
            onClick={() => setShowGuide((value) => !value)}
            className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left active:bg-gray-50"
          >
            <span className="text-xs font-medium text-gray-700">
              {t('装不上？看看怎么传过去、怎么放开「禁止安装」')}
            </span>
            <ChevronDown
              className={cn('h-4 w-4 shrink-0 text-gray-400 transition-transform', showGuide && 'rotate-180')}
            />
          </button>
          {showGuide && (
            <div className="border-t border-gray-100 p-3">
              <InstallGuide />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
