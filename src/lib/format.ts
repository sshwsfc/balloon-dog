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

/** 切语言时不用做任何事：这些函数每次调用都重新读 i18n.language，调用方会随重渲染刷新。 */
export { i18n }
