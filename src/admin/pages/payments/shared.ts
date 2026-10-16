import type { Tone } from '../../components/status'

/**
 * 支付后台的共享口径。
 *
 * 金额换算复用会员后台那一份实现（`pages/membership/shared.ts`）：后台里
 * 「分 → ￥0.00」只能有一个实现，各写一份迟早会出现两种显示。
 * 这里只做转发，不重新实现。
 */
export { formatCents, yuanToCents, centsToYuan } from '../membership/shared'

/** 支付渠道。测试渠道不会真的收钱，所以单独列出来、并且用告警色。 */
export const PAY_CHANNEL_OPTIONS = [
  { value: 'alipay', label: '支付宝' },
  { value: 'wechat', label: '微信支付' },
  { value: 'fake', label: '测试渠道' },
]

/** 订单状态。比会员后台多一个 refunding（已发起退款、渠道还没回执）。 */
export const PAY_STATUS_OPTIONS = [
  { value: 'pending', label: '待支付' },
  { value: 'paid', label: '已支付' },
  { value: 'failed', label: '支付失败' },
  { value: 'cancelled', label: '已取消' },
  { value: 'refunding', label: '退款中' },
  { value: 'refunded', label: '已退款' },
]

export const INVOICE_STATUS_OPTIONS = [
  { value: 'pending', label: '待处理' },
  { value: 'issued', label: '已开具' },
  { value: 'rejected', label: '已驳回' },
]

export const PAY_STATUS_TONE: Record<string, Tone> = {
  pending: 'amber',
  paid: 'green',
  failed: 'red',
  cancelled: 'gray',
  refunding: 'purple',
  refunded: 'blue',
}

export const PAY_CHANNEL_TONE: Record<string, Tone> = {
  alipay: 'blue',
  wechat: 'green',
  fake: 'amber',
}

export const INVOICE_STATUS_TONE: Record<string, Tone> = {
  pending: 'amber',
  issued: 'green',
  rejected: 'red',
}

export const TIER_LABELS: Record<string, string> = {
  ordinary: '普通',
  member: '会员',
  super: '超级会员',
}

export const PERIOD_LABELS: Record<string, string> = {
  monthly: '按月',
  yearly: '按年',
  auto_monthly: '连续包月',
}

/** 状态码 → 中文。后端也会给 statusLabel，这里只作为没有 label 时的兜底。 */
export function labelOf(options: { value: string; label: string }[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value
}

/**
 * 一行流水是不是「坏签名」。
 * 只认 result 不够：验签失败的行 result 一定是 `bad_signature`，
 * 但把 signatureOk 一起看能覆盖以后新增的失败原因。
 */
export function isBadSignature(event: { signatureOk: boolean; result: string }): boolean {
  return !event.signatureOk || event.result === 'bad_signature'
}

/**
 * 渠道回调的结果码 → 中文。后端只发英文枚举，运营看不出 `amount_mismatch` 是什么意思。
 */
const RESULT_LABELS: Record<string, string> = {
  ok: '回调正常',
  success: '回调正常',
  duplicate: '重复回调，已忽略',
  amount_mismatch: '回调金额与订单不一致',
  channel_mismatch: '回调渠道与订单不一致',
  bad_signature: '验签失败',
}

export function resultLabel(result: string): string {
  return RESULT_LABELS[result] ?? ''
}

/**
 * 流水的强调色：验签失败是红色（系统不认这笔钱，最严重），
 * 金额/渠道不符这类异常回调是琥珀色，正常回调是绿色。
 */
export function eventTone(event: { signatureOk: boolean; result: string }): 'red' | 'amber' | 'green' {
  if (isBadSignature(event)) return 'red'
  return resultLabel(event.result) === '回调正常' || event.result === 'ok' ? 'green' : 'amber'
}
