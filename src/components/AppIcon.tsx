import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useAppIcons } from '@/hooks/useAppIcons'

interface AppIconProps {
  /** 直接给图标地址（列表接口已经带回来了）；不传就按包名/应用名去映射表里查 */
  url?: string | null
  packageName?: string | null
  appName?: string | null
  /** 尺寸与圆角，例如 `w-9 h-9`；`rounded-*` 写在这里可以覆盖默认的 rounded-lg */
  className?: string
  /** 只在「没有图标」时生效的底色/文字色 */
  fallbackClassName?: string
  /** 只在「没有图标」时生效的字号 */
  letterClassName?: string
  /**
   * 没有图标时显示的字，默认取应用名首字。
   * 应用插件页的目标里有 `__appstore__` 这类伪包名，抓不到图标，
   * 那里的角标字是服务端人工挑的（「支」「微」「Q」），比首字准。
   */
  fallbackLetter?: string
}

/**
 * 应用图标。
 *
 * 有图标就渲染真实图标（孩子端从 PackageManager 抓的，服务端存好、带签名下发），
 * 没有就退回**首字徽标** —— 老版本孩子端不上传图标、图标抓取失败、
 * 或者应用列表还没加载完时会走到这一档，所以两种形态的尺寸必须严格一致，
 * 否则列表会随着图标陆续到达而跳动。
 */
export function AppIcon({
  url,
  packageName,
  appName,
  className,
  fallbackClassName,
  letterClassName = 'text-sm',
  fallbackLetter,
}: AppIconProps) {
  const icons = useAppIcons()
  // 记「失败的那个地址」而不是一个 boolean：换了地址之后要能重新尝试加载
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null)

  const resolved = url ?? icons.urlFor({ packageName, appName })
  const label = (fallbackLetter || appName || packageName || '').trim()

  if (resolved && resolved !== brokenUrl) {
    return (
      <img
        src={resolved}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setBrokenUrl(resolved)}
        className={cn('shrink-0 rounded-lg bg-gray-50 object-cover', className)}
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg font-medium',
        letterClassName,
        fallbackClassName ?? 'bg-gray-100 text-gray-600',
        className,
      )}
    >
      {label.slice(0, 1)}
    </span>
  )
}
