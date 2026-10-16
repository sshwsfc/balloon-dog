import i18n, { getLanguage, type LanguageCode } from '@/i18n'

/**
 * 跟随语言的日期与数字格式化。
 *
 * 为什么不能直接写 `toLocaleString('zh-CN')`：那样即使界面已经切成英文，
 * 时间戳仍然是「2026/1/8 22:41:00」这种中文习惯的写法，英文用户看着别扭，
 * 而且 12/24 小时制也应该是英文的 12 小时制。所以统一从这里取 locale。
 */

/** BCP 47 标签。zh 用 zh-CN（大陆的日期习惯），en 用 en-US。 */
const LOCALES: Record<LanguageCode, string> = {
  zh: 'zh-CN',
  en: 'en-US',
}

/** 当前界面语言对应的 BCP 47 标签 —— 也用于 localeCompare 排序。 */
export function locale(): string {
  return LOCALES[getLanguage()]
}

/** 日期 + 时间，例如「2026/1/8 22:41」/「1/8/2026, 10:41 PM」。 */
export function formatDateTime(iso: string | number | Date): string {
  return new Date(iso).toLocaleString(locale())
}

/**
 * 只到分钟。
 *
 * 用 `hour/minute` 显式指定而不是 `dateStyle/timeStyle`：后者在部分 WebView
 * 上支持不全，而这里要的是稳定输出。
 */
export function formatDateTimeShort(iso: string | number | Date): string {
  return new Date(iso).toLocaleString(locale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 只要时间，例如「22:41」/「10:41 PM」。 */
export function formatTime(iso: string | number | Date): string {
  return new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
}

/** 按当前语言排序字符串（应用名、联系人名这类）。 */
export function compareByLocale(a: string, b: string): number {
  return a.localeCompare(b, locale())
}

/**
 * 「3小时前」这类相对时间，**在客户端拼**而不是渲染服务端下发的 `lastActive`。
 *
 * 服务端也会算一份（`humanizeLastActive`）并放在 `lastActive` 里，但那是**写死的中文**：
 * 界面切到英文后，凡是直接渲染它的地方都会漏出「小时前」这种中文碎片
 * （UX 套件里「英文界面不再出现成片中文」这一条就是这么抓出来的）。
 * 所以需要相对时间的地方一律用这个函数，服务端那份只当兜底/审计字段。
 *
 * 粒度（分钟 / 小时 / 天）与服务端保持一致，避免同一台设备在两处显示不同。
 */
export function formatRelative(iso: string | number | Date | null | undefined): string {
  if (!iso) return i18n.t('从未活跃')
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return i18n.t('从未活跃')
  const diffMs = Date.now() - at.getTime()
  if (diffMs < 60_000) return i18n.t('刚刚')
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return i18n.t('{{v0}} 分钟前', { v0: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return i18n.t('{{v0}} 小时前', { v0: hours })
  return i18n.t('{{v0}} 天前', { v0: Math.floor(hours / 24) })
}

/** 切语言时不用做任何事：这些函数每次调用都重新读 i18n.language，调用方会随重渲染刷新。 */
export { i18n }
