import type { Tone } from '../../components/status'

/**
 * 会员后台的共享口径。
 *
 * 金额一律以「分」在前后端之间传递，只在展示与表单输入时换算成元：
 * 用浮点数存钱迟早会出现 0.1 + 0.2 那类误差，而这里每次误差都是资损。
 */

/** 分 → 「￥12.00」。后台所有金额都必须走这个函数。 */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—'
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.round(cents))
  return `${sign}￥${(abs / 100).toFixed(2)}`
}

/** 元 → 分。表单里用户输入的是元，提交前必须换算，避免把「12」当成 12 分存进去。 */
export function yuanToCents(value: string): number {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.round(parsed * 100)
}

/** 分 → 表单里可编辑的元字符串（不带货币符号）。 */
export function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

export const TIER_OPTIONS = [
  { value: 'member', label: '会员' },
  { value: 'super', label: '超级会员' },
]

export const PERIOD_OPTIONS = [
  { value: 'monthly', label: '按月' },
  { value: 'yearly', label: '按年' },
  { value: 'auto_monthly', label: '连续包月' },
]

export const CHANNEL_OPTIONS = [
  { value: 'alipay', label: '支付宝' },
  { value: 'wechat', label: '微信支付' },
]

export const ORDER_STATUS_OPTIONS = [
  { value: 'pending', label: '待支付' },
  { value: 'paid', label: '已支付' },
  { value: 'failed', label: '支付失败' },
  { value: 'cancelled', label: '已取消' },
  { value: 'refunded', label: '已退款' },
]

export const CONDITION_OPTIONS = [
  { value: 'always', label: '不限条件' },
  { value: 'first_purchase', label: '首单（从未付费成功）' },
  { value: 'active_membership', label: '同档续费（当前已是该档会员）' },
  { value: 'no_active_membership', label: '当前不是会员' },
  { value: 'device_count', label: '绑定设备数达标' },
  { value: 'registered_within_days', label: '注册天数内（新用户）' },
  { value: 'tier_upgrade', label: '从指定档位升级' },
]

export const DISCOUNT_OPTIONS = [
  { value: 'percent', label: '按比例减（%）' },
  { value: 'amount', label: '按金额减（元）' },
]

/** 规则可作用的目标。'all' 表示不限。 */
export const TARGET_TIER_OPTIONS = [
  { value: 'all', label: '不限档位' },
  { value: 'member', label: '仅会员套餐' },
  { value: 'super', label: '仅超级会员套餐' },
]

export const TARGET_PERIOD_OPTIONS = [
  { value: 'all', label: '不限周期' },
  ...PERIOD_OPTIONS,
]

export const TIER_TONE: Record<string, Tone> = {
  ordinary: 'gray',
  member: 'blue',
  super: 'purple',
}

export const ORDER_STATUS_TONE: Record<string, Tone> = {
  pending: 'amber',
  paid: 'green',
  failed: 'red',
  cancelled: 'gray',
  refunded: 'blue',
}

export const CHANNEL_TONE: Record<string, Tone> = {
  alipay: 'blue',
  wechat: 'green',
}

/** 套餐折合每月：年付才看得出「哪个更划算」，这个数要在列表里直接给出来。 */
export function monthlyEquivalent(basePriceCents: number, months: number): number {
  if (months <= 0) return basePriceCents
  return Math.round(basePriceCents / months)
}
