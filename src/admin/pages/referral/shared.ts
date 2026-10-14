import type { Tone } from '../../components/status'

/**
 * 邀请返现后台的共享口径。
 *
 * 金额换算复用会员后台那一份实现（`pages/membership/shared.ts`）：后台里
 * 「分 → ￥0.00」只能有一个实现，各写一份迟早会出现两种显示。
 * 这里只做转发，不重新实现。
 */
export { formatCents, yuanToCents, centsToYuan } from '../membership/shared'

/**
 * 提成后台的列表接口没有 `totalPages`（其它后台列表都带），统一在这里算一次，
 * 免得每个页签各写一遍 `Math.ceil`，也算漏一次。
 */
export function totalPagesOf(paged: { total: number; pageSize: number }): number {
  return Math.max(1, Math.ceil(paged.total / Math.max(1, paged.pageSize)))
}

/**
 * 起止时间筛选的后端参数换算。
 *
 * 两个输入框都是 `type="date"`，拿到的是 `YYYY-MM-DD`。后端用 `new Date(raw)` 解析，
 * 只给日期会落到当天 00:00，所以「结束」必须补到当天最后一毫秒，
 * 否则选同一天会查出空结果。
 */
export function dayStart(value: string): string | undefined {
  return value ? `${value}T00:00:00.000` : undefined
}

export function dayEnd(value: string): string | undefined {
  return value ? `${value}T23:59:59.999` : undefined
}

// ---------------- 邀请关系 ----------------

export const REFERRAL_STATUS_OPTIONS = [
  { value: 'bound', label: '已注册' },
  { value: 'valid', label: '有效邀请' },
  { value: 'invalid', label: '已作废' },
]

export const REFERRAL_STATUS_TONE: Record<string, Tone> = {
  bound: 'amber',
  valid: 'green',
  invalid: 'gray',
}

// ---------------- 返现 ----------------

export const REWARD_KIND_OPTIONS = [
  { value: 'first_purchase', label: '首充返现' },
  { value: 'renewal', label: '续费返现' },
]

export const REWARD_KIND_TONE: Record<string, Tone> = {
  first_purchase: 'blue',
  renewal: 'purple',
}

export const REWARD_STATUS_OPTIONS = [
  { value: 'pending', label: '待发放' },
  { value: 'settled', label: '已发放' },
  { value: 'cancelled', label: '已取消' },
]

export const REWARD_STATUS_TONE: Record<string, Tone> = {
  pending: 'amber',
  settled: 'green',
  cancelled: 'gray',
}

// ---------------- 提现 ----------------

export const WITHDRAWAL_STATUS_OPTIONS = [
  { value: 'pending', label: '待审核' },
  { value: 'approved', label: '审核通过' },
  { value: 'paid', label: '已打款' },
  { value: 'rejected', label: '已驳回' },
]

export const WITHDRAWAL_STATUS_TONE: Record<string, Tone> = {
  pending: 'amber',
  approved: 'blue',
  paid: 'green',
  rejected: 'red',
}

export const WITHDRAW_CHANNEL_OPTIONS = [
  { value: 'alipay', label: '支付宝' },
  { value: 'wechat', label: '微信' },
  { value: 'bank', label: '银行卡' },
]

export const WITHDRAW_CHANNEL_TONE: Record<string, Tone> = {
  alipay: 'blue',
  wechat: 'green',
  bank: 'purple',
}

// ---------------- 优惠券 ----------------

export const COUPON_STATUS_OPTIONS = [
  { value: 'unused', label: '未使用' },
  { value: 'used', label: '已使用' },
  { value: 'expired', label: '已过期' },
]

export const COUPON_STATUS_TONE: Record<string, Tone> = {
  unused: 'blue',
  used: 'green',
  expired: 'gray',
}

export const COUPON_SOURCE_LABEL: Record<string, string> = {
  milestone: '邀请里程碑',
}

// ---------------- 风控 ----------------

export const RISK_LEVEL_TONE: Record<string, Tone> = { high: 'red', medium: 'amber' }

export const RISK_LEVEL_LABEL: Record<string, string> = { high: '高风险', medium: '中风险' }

/**
 * 每类风险的口径说明。
 * 后台把这些只**列出来给人看**，不做自动处罚 —— 误伤一个正常家长的代价
 * 远大于漏掉一个刷单的，最终判断必须由人工做出。
 */
export const RISK_TYPE_META: Record<string, { label: string; rule: string }> = {
  self_invite: {
    label: '自我邀请',
    rule: '邀请人与被邀请人的手机号完全相同。同一手机号自邀自返是最直接的套现手法。',
  },
  same_identity: {
    label: '同一实名证件',
    rule: '邀请双方使用了同一个实名证件。一个证件开多个账号互相邀请，是提现套现最常见的形态。',
  },
  burst_invite: {
    label: '集中绑定',
    rule: '同一邀请人在 1 小时内绑定了 5 名及以上新用户。正常家长不会在一小时内拉来五个好友。',
  },
  stale_withdrawal: {
    label: '提现积压',
    rule: '提现申请提交超过 3 天仍未审核。这不是作弊，但会引发投诉，属于运营问题。',
  },
}

/** 按这个顺序分组展示：越像作弊的越靠前。 */
export const RISK_TYPE_ORDER = ['self_invite', 'same_identity', 'burst_invite', 'stale_withdrawal']

// ---------------- 试算 ----------------

/**
 * 与后端 `referral.constants.ts` 的 `isLongPeriod` 一致：只有年卡算长周期。
 * 试算必须和真正发钱的规则同口径，否则「后台算出来」和「实际发的」会对不上账。
 */
export function isLongPeriod(period: string): boolean {
  return period === 'yearly'
}

export const PERIOD_OPTIONS = [
  { value: 'monthly', label: '月卡 / 季卡' },
  { value: 'yearly', label: '年卡及以上' },
]

/**
 * 首充返现的绝对兜底上限（分），与后端 `MAX_REWARD_CENTS` 一致。
 * 任何配置失误都不该让单笔返现失控。
 */
export const MAX_REWARD_CENTS = 100000

export interface RewardQuotePreview {
  ratePercent: number
  amountCents: number
  capApplied: boolean
  note: string
}

/**
 * 单档试算，逐行镜像后端的 `quoteFirstPurchase`
 * （`server/src/features/referral/referral.rules.ts`）：
 *
 *  - 比例取该档的 `ratePercent`；
 *  - 短周期（非年卡）比例有下限，取 `max(档位比例, shortPeriodMinRatePercent)` ——
 *    是「至少给到」而不是「只给这个数」；
 *  - 长周期击穿单笔上限 `longPeriodCapCents`，且再被 `MAX_REWARD_CENTS` 兜一次底；
 *  - 返现额向下取整。
 *
 * 抽成纯函数是为了能在页面上逐档展示，同时保证和家长端下单时算的是同一套逻辑。
 */
export function quoteTier(
  params: {
    baseAmountCents: number
    tierRatePercent: number
    period: string
  },
  config: { shortPeriodMinRatePercent: number; longPeriodCapCents: number },
): RewardQuotePreview {
  const { baseAmountCents, tierRatePercent, period } = params
  const long = isLongPeriod(period)
  let rate = tierRatePercent
  const notes: string[] = []

  if (!long && rate < config.shortPeriodMinRatePercent) {
    rate = config.shortPeriodMinRatePercent
    notes.push(`月卡/季卡保底 ${rate}%`)
  }

  const raw = Math.floor((baseAmountCents * rate) / 100)
  const hardMax = Math.min(long ? config.longPeriodCapCents : Number.MAX_SAFE_INTEGER, MAX_REWARD_CENTS)
  const capped = raw > hardMax
  const amountCents = capped ? hardMax : raw
  if (capped) notes.push(`已达单笔上限 ￥${(amountCents / 100).toFixed(2)}`)

  return {
    ratePercent: rate,
    amountCents,
    capApplied: capped,
    note: notes.length > 0 ? notes.join('；') : '—',
  }
}

/** 档位表必须满足的两条服务端约束，这里在提交前先查一遍，别让运营撞 400。 */
export function validateTiers(tiers: { minInvitees: number; maxInvitees: number | null }[]): string[] {
  const problems: string[] = []
  if (tiers.length === 0) {
    problems.push('至少需要一档返现阶梯')
    return problems
  }

  const sorted = [...tiers].sort((a, b) => a.minInvitees - b.minInvitees)
  if (sorted[0].minInvitees !== 0) {
    problems.push('必须有一档从 0 人开始（兜底档），否则只邀请 1-2 人的家长一分钱都拿不到')
  }

  for (let i = 0; i < sorted.length; i += 1) {
    const cur = sorted[i]
    if (cur.maxInvitees !== null && cur.maxInvitees < cur.minInvitees) {
      problems.push(`第 ${i + 1} 档的人数上限小于下限（${cur.minInvitees} - ${cur.maxInvitees}）`)
    }
  }

  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const cur = sorted[i]
    const next = sorted[i + 1]
    // 上一档 max 为 null 表示开口到无穷，后面就不该再有档位
    if (cur.maxInvitees === null) {
      problems.push(`第 ${i + 1} 档没有上限，它后面的档位永远不会命中`)
      continue
    }
    if (next.minInvitees <= cur.maxInvitees) {
      problems.push(`第 ${i + 1} 档与第 ${i + 2} 档的人数区间重叠（${cur.minInvitees}-${cur.maxInvitees} / ${next.minInvitees}）`)
    }
  }

  return problems
}
