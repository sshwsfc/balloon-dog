import { cn } from '@/lib/utils'

/**
 * 品牌标识：绿底 + 白色盾牌 + 绿色爪印。
 *
 * ★唯一权威来源是孩子端的启动图标 android/app/src/main/res/drawable/ic_launcher.xml
 *   （viewBox 108×108、底色 #07C160、盾牌 + 爪印）。这里的路径数据是从那个文件
 *   逐字抄过来的，孩子端换图标时这里要一起换。public/logo.svg 是同一份画稿的
 *   独立 SVG（favicon 用），改这里也要同步改它。
 *
 * 为什么不用 emoji：家长端原来在三处画 🐕、一处画 🐶、一处画「狗」字，五处各不
 * 相同，而且 emoji 的实际字形由系统字体决定（安卓/iOS/Windows 长得都不一样），
 * 换台设备就变样。改成矢量后与孩子端应用图标完全一致。
 */
const BRAND_GREEN = '#07C160'

/** 盾牌（白色）。 */
const SHIELD_PATH = 'M54,16 L86,29 V53 C86,72 72,87 54,93 C36,87 22,72 22,53 V29 Z'

/** 爪印（绿色）：上中一个脚趾 + 左右两个脚趾 + 下方掌垫。 */
const PAW_PATHS = [
  'M54,38 m-6,0 a6,6 0 1,0 12,0 a6,6 0 1,0 -12,0',
  'M41,47 m-4.5,0 a4.5,4.5 0 1,0 9,0 a4.5,4.5 0 1,0 -9,0',
  'M67,47 m-4.5,0 a4.5,4.5 0 1,0 9,0 a4.5,4.5 0 1,0 -9,0',
  'M54,52 C46,52 41,58 41,64 C41,70 47,73 54,73 C61,73 67,70 67,64 C67,58 62,52 54,52 Z',
]

export interface BrandLogoProps {
  /**
   * 尺寸与圆角走 Tailwind 类，例如 `h-8 w-8 rounded-lg`。
   * 圆角靠这层的 `overflow-hidden` 裁出来：绿底是贴边的 rect，不裁就是方角。
   */
  className?: string
}

/**
 * 纯装饰元素：五处落点旁边都写着「气球狗」，再给读屏念一遍是重复播报，
 * 所以固定 `aria-hidden`、不提供无障碍名称。
 *
 * 也正因如此这里**不用 useTranslation**：管理后台那个入口（src/admin/main.tsx）
 * 没有初始化 react-i18next，取 t() 会走 react-i18next 的「没有 i18next 实例」
 * 兜底路径并往控制台告警，而管理后台的 e2e 恰好会断言没有 console error。
 */
export function BrandLogo({ className }: BrandLogoProps) {
  return (
    <span className={cn('inline-block shrink-0 overflow-hidden bg-[#07C160]', className)} aria-hidden="true">
      <svg viewBox="0 0 108 108" className="block h-full w-full" aria-hidden="true" focusable="false">
        <path d={SHIELD_PATH} fill="#FFFFFF" />
        <g fill={BRAND_GREEN}>
          {PAW_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
      </svg>
    </span>
  )
}
