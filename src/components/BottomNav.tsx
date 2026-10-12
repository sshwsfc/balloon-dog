import { Link, useLocation } from 'react-router-dom'
import { Home, MapPin, Monitor, User, type LucideIcon } from 'lucide-react'
import { BrandLogo } from '@/components/BrandLogo'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

/**
 * 四个一级入口。
 *
 * <p>「洞察」是后来提上来的：它原本只是首页洞察摘要卡右下角一个灰字链接，
 * 家长根本注意不到（用户原话：「AI洞察的入口按钮太不明显了」）。这一页不是
 * 「看一眼就走」的附属信息，而是三类报告（游戏时长 / 动画集数 / 不适龄内容）
 * 的入口，值得占一个一级位置。首页那张摘要卡保留 —— 它给出的是「今天怎么样」
 * 的快照，洞察页给的是「为什么」。
 *
 * <p>图标用 `Monitor` 而不是别的：它和首页九宫格里跳同一处的「屏幕洞察」格子
 * 保持同一个图标，避免同一目的地出现两套视觉。
 */
const navItems: { path: string; icon: LucideIcon; label: string }[] = [
  { path: '/', icon: Home, label: '首页' },
  { path: '/location', icon: MapPin, label: '位置' },
  { path: '/insights', icon: Monitor, label: '洞察' },
  { path: '/profile', icon: User, label: '我的' },
]

/** 侧栏宽度，写成常量是为了 App 里给主内容让位时两处不会写岔。 */
export const SIDEBAR_WIDTH_CLASS = 'lg:pl-56'

/**
 * 导航。
 *
 * <p>同一份数据渲染两种形态，靠 CSS 切换而不是 JS 监听窗口宽度：
 *  - **窄屏 / 竖屏手机**：底部固定栏（原来的样子），在稍宽的手机上居中限宽，
 *    免得 700px 宽的窗口里四个入口被拉得老远。
 *  - **≥1024px（平板横屏 / 桌面）**：左侧竖排侧栏。桌面浏览器里把导航钉在屏幕底部
 *    是最典型的「手机页面没适配」的特征，而且鼠标要横跨整个窗口才点得到。
 *  - **矮视口（横屏手机）**：底栏压缩高度，图标与文字同时缩小。
 *    横屏手机最缺垂直空间，3.5rem 的底栏加安全区能吃掉十分之一屏。
 *
 * <p>刻意用 CSS 而不是 `useMediaQuery`：首帧就要正确。JS 方案在首屏必然有一瞬间的
 * 错位，这个应用是纯 CSR，闪烁一样看得见。
 */
export function BottomNav() {
  const { t } = useTranslation()
  const location = useLocation()
  const isActive = (path: string) => location.pathname === path

  return (
    <>
      {/* ---------- 窄屏：底部导航 ---------- */}
      <nav
        className={cn(
          'safe-area-inset-bottom fixed bottom-0 left-0 right-0 z-50 border-t border-gray-200 bg-white',
          'lg:hidden',
        )}
        aria-label={t('主导航')}
      >
        <div className="mx-auto flex h-14 max-w-md items-center justify-around [@media(max-height:520px)]:h-11">
          {navItems.map((item) => {
            const Icon = item.icon
            const active = isActive(item.path)
            return (
              <Link
                key={item.path}
                to={item.path}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-full w-full flex-col items-center justify-center space-y-0.5',
                  active ? 'text-green-500' : 'text-gray-400',
                )}
              >
                <Icon
                  className={cn(
                    'h-6 w-6 [@media(max-height:520px)]:h-5 [@media(max-height:520px)]:w-5',
                    active ? 'text-green-500' : 'text-gray-400',
                  )}
                />
                <span className="text-xs [@media(max-height:520px)]:text-[10px]">{t(item.label)}</span>
              </Link>
            )
          })}
        </div>
      </nav>

      {/* ---------- 宽屏：左侧竖排导航 ---------- */}
      <nav
        className="fixed left-0 top-0 z-50 hidden h-screen w-56 flex-col border-r border-gray-200 bg-white lg:flex"
        aria-label={t('主导航')}
      >
        <div className="flex h-16 items-center gap-2 px-5">
          {/* 旁边的文字已经念了「气球狗」，标记本身对读屏隐藏，免得重复播报 */}
          <BrandLogo className="h-8 w-8 rounded-lg" />
          <span className="text-base font-medium text-gray-900">{t('气球狗')}</span>
        </div>

        <div className="flex-1 space-y-1 px-3 py-2">
          {navItems.map((item) => {
            const Icon = item.icon
            const active = isActive(item.path)
            return (
              <Link
                key={item.path}
                to={item.path}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors',
                  active
                    ? 'bg-green-50 font-medium text-green-600'
                    : 'text-gray-600 hover:bg-gray-50 active:bg-gray-100',
                )}
              >
                <Icon className="h-5 w-5" />
                <span>{t(item.label)}</span>
              </Link>
            )
          })}
        </div>

        {/* 桌面用户第一次打开时不一定意识到这是手机端同款界面，底部留一句说明 */}
        <p className="px-5 py-4 text-[11px] leading-relaxed text-gray-400">{t('家长端 · 与手机端数据实时同步')}</p>
      </nav>
    </>
  )
}
