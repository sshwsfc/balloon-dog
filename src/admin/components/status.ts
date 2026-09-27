/**
 * 状态展示的配色与文案映射（纯数据 + 类型，不含组件）。
 *
 * 单独成文件有两个原因：
 *  1. 让 `ui-kit.tsx` 只导出组件，满足 react-refresh/only-export-components
 *     （组件文件混出常量会让 Fast Refresh 失效）；
 *  2. 这套口径家长端与管理后台共用，集中一处便于保持一致。
 */

export const TONES = {
  green: 'bg-primary/10 text-primary',
  red: 'bg-destructive/10 text-destructive',
  amber: 'bg-amber-100 text-amber-700',
  blue: 'bg-blue-100 text-blue-700',
  gray: 'bg-muted text-muted-foreground',
  purple: 'bg-purple-100 text-purple-700',
} as const

export type Tone = keyof typeof TONES

/** 指令状态 → 文案与配色。与后端 COMMAND_STATUSES 一一对应。 */
export const COMMAND_STATUS_TONE: Record<string, { label: string; tone: Tone }> = {
  pending: { label: '等待设备响应', tone: 'amber' },
  dispatched: { label: '设备执行中', tone: 'blue' },
  succeeded: { label: '已完成', tone: 'green' },
  failed: { label: '执行失败', tone: 'red' },
  expired: { label: '已超时', tone: 'gray' },
  cancelled: { label: '已撤销', tone: 'gray' },
}

/** HTTP 方法配色（操作日志用）。 */
export const METHOD_TONE: Record<string, Tone> = {
  GET: 'gray',
  POST: 'green',
  PATCH: 'amber',
  PUT: 'amber',
  DELETE: 'red',
}

/** 短信验证码用途。 */
export const SMS_PURPOSE_LABEL: Record<string, string> = {
  register: '注册',
  login: '验证码登录',
  bind: '绑定手机号',
}

/** 短信验证码状态。 */
export const SMS_STATE_VIEW: Record<string, { label: string; tone: Tone }> = {
  pending: { label: '未使用', tone: 'amber' },
  consumed: { label: '已使用', tone: 'green' },
  expired: { label: '已过期', tone: 'gray' },
}

/** 答题类型。 */
export const QUIZ_TYPE_LABEL: Record<string, string> = {
  english: '英文单词',
  poetry: '古诗填空',
}

export const QUIZ_GRADES = [
  { value: 'grade1', label: '一年级' },
  { value: 'grade2', label: '二年级' },
  { value: 'grade3', label: '三年级' },
  { value: 'grade4', label: '四年级' },
  { value: 'grade5', label: '五年级' },
  { value: 'grade6', label: '六年级' },
] as const

export function gradeLabel(value: string): string {
  return QUIZ_GRADES.find((g) => g.value === value)?.label ?? value
}

export function quizTypeLabel(value: string): string {
  return QUIZ_TYPE_LABEL[value] ?? value
}
