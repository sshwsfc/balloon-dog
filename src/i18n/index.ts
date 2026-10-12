import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { en } from './locales/en'

export const LANGUAGE_STORAGE_KEY = 'balloon_dog_language'

/**
 * 支持的语言。
 *
 * 命名上有个刻意的取舍：`label` 用**各语言自己的写法**（简体中文 / English），
 * 而不是把语言名也送去翻译 —— 语言选择器要能在「用户还看不懂当前语言」时被读懂，
 * 所以它自己不能依赖当前语言。
 */
export const LANGUAGES = [
  { code: 'zh', label: '简体中文', short: '中' },
  { code: 'en', label: 'English', short: 'EN' },
] as const

export type LanguageCode = (typeof LANGUAGES)[number]['code']

const SUPPORTED_LANGUAGES = LANGUAGES.map((l) => l.code) as LanguageCode[]

export function isSupportedLanguage(value: string | null | undefined): value is LanguageCode {
  return Boolean(value) && SUPPORTED_LANGUAGES.includes(value as LanguageCode)
}

/**
 * 语言检测：用户显式选择 > 浏览器语言 > 中文兜底。
 *
 * 不引入 i18next-browser-languagedetector：它默认会读 cookie / querystring / navigator
 * 四个来源并各自带一套配置，而这里只需要「localStorage 里选了就用，否则看浏览器」。
 */
export function detectLanguage(): LanguageCode {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (isSupportedLanguage(saved)) return saved
  } catch {
    // 隐私模式下 localStorage 可能不可用，忽略即可
  }
  const navigatorLanguage = (typeof navigator !== 'undefined' ? navigator.language : '') || ''
  const normalized = navigatorLanguage.toLowerCase()
  if (normalized.startsWith('zh')) return 'zh'
  if (normalized.startsWith('en')) return 'en'
  return 'zh'
}

/**
 * 初始化 i18next。
 *
 * 本项目约定 **中文原文就是 key**：
 *  - `zh` 的词条表是空的 —— 查不到翻译时 i18next 原样回显 key，中文界面因此天然正确，
 *    也不会出现「改了中文文案忘了改词条」的不一致；
 *  - 只有 `en` 需要一份「中文 → 英文」的映射（src/i18n/locales/en.ts）。
 *
 * 两个分隔符必须关掉：key 里会出现 `.`（"加载中..."）与 `:`（"提示：..."），
 * 开着的话 i18next 会把它们当命名空间/路径分隔符去拆，永远查不到。
 */
void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: {} },
    en: { translation: en },
  },
  lng: detectLanguage(),
  fallbackLng: 'zh',
  supportedLngs: SUPPORTED_LANGUAGES,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnNull: false,
  // 词条是内联的，不存在异步加载，关掉 Suspense 避免首屏闪一下
  react: { useSuspense: false },
  saveMissing: false,
})

// init 时设好的初始语言不会再触发 languageChanged，这里补一次
syncDocumentLanguage()

export function getLanguage(): LanguageCode {
  return isSupportedLanguage(i18n.language) ? i18n.language : 'zh'
}

export function setLanguage(code: LanguageCode): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, code)
  } catch {
    // 存不下也不影响本次会话
  }
  void i18n.changeLanguage(code)
  syncDocumentLanguage(code)
}

/** 让 `<html lang>`、无障碍朗读与标签页标题跟着走 */
export function syncDocumentLanguage(code: LanguageCode = getLanguage()): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = code
  // index.html 里写死的是中文品牌名，切到英文时标签页也要跟着换
  document.title = code === 'en' ? 'Balloon Dog' : '气球狗'
}

// 任何来源的语言切换（语言选择器、将来可能的服务端下发）都同步到 <html lang>
i18n.on('languageChanged', (code: string) => {
  syncDocumentLanguage(isSupportedLanguage(code) ? code : 'zh')
})

/**
 * 给**非 React 代码**用的翻译：模块级工具函数（formatDateTime、validateForm…）
 * 不能调 hook，只能用 i18n 实例。
 *
 * 代价是它不会自己触发重渲染 —— 所以 AppShell 订阅了 languageChanged，
 * 切语言时整棵树会重渲一次，这些函数随之重新求值。
 * 模块级**常量**不能这么用（模块加载时求值，会把语言固化在启动那一刻）。
 */
export function tt(key: string, options?: Record<string, unknown>): string {
  const value = i18n.t(key, options)
  return typeof value === 'string' ? value : key
}

export { i18n }
export default i18n
