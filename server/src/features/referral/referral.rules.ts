/**
 * 分享提成的计算规则 —— 纯函数，不碰数据库。
 *
 * 抽成纯函数是为了能在后台「试算」里复用同一套逻辑：后台看到的金额
 * 与家长端下单时算出来的金额必须是同一个函数算的，否则对不上账时
 * 根本分不清是规则配错了还是代码有两份。
 */

import {
  MAX_RENEWAL_RATE_PERCENT,
  MAX_REWARD_CENTS,
  isLongPeriod,
} from './referral.constants';

/** 阶梯行的最小形状（Prisma 行与后台试算的临时对象都能喂进来）。 */
export interface RewardTierLike {
  minInvitees: number;
  maxInvitees: number | null;
  ratePercent: number;
  sortOrder?: number;
  enabled?: boolean;
}

export interface CouponRuleLike {
  id: string;
  name: string;
  inviteeCount: number;
  repeatEvery: number | null;
  amountCents: number;
  validDays: number;
  sortOrder?: number;
  enabled?: boolean;
}

export interface ReferralConfigLike {
  shortPeriodMinRatePercent: number;
  longPeriodCapCents: number;
  renewalRatePercent: number;
  renewalCapCents: number;
  withdrawMinInvitees: number;
  withdrawMinCents: number;
  withdrawRequireVerified: boolean;
}

export interface RewardQuote {
  /** 生效比例（%）。0 表示不产生返现。 */
  ratePercent: number;
  /** 返现额（分）。 */
  amountCents: number;
  /** 是否击穿了单笔上限（家长端要提示「已达单笔上限」）。 */
  capApplied: boolean;
  /** 命中说明，写进返现记录 note 供客服解释。 */
  note: string;
}

/**
 * 按「有效邀请人数」挑一档阶梯。
 *
 * 第一档（sortOrder 最小）对下开口：人数比它的 minInvitees 还小时也命中它。
 * 其余档严格按 [min, max] 匹配，max 为 null 表示开区间。
 */
export function pickTier<T extends RewardTierLike>(
  tiers: T[],
  inviteeCount: number,
): T | null {
  const enabled = tiers
    .filter((t) => t.enabled !== false)
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  if (enabled.length === 0) return null;

  for (const tier of enabled) {
    const max = tier.maxInvitees;
    if (max === null || inviteeCount <= max) return tier;
  }
  return enabled[enabled.length - 1];
}

function applyCap(amountCents: number, capCents: number | null): { amount: number; capped: boolean } {
  const hardMax = Math.min(capCents ?? Number.MAX_SAFE_INTEGER, MAX_REWARD_CENTS);
  if (amountCents > hardMax) return { amount: hardMax, capped: true };
  return { amount: amountCents, capped: false };
}

/**
 * 首充返现。
 *
 * - 比例来自邀请人数阶梯；
 * - 月卡/季卡（短周期）比例有下限（截图「月卡、季卡返现 50%」）；
 * - 年卡及以上（长周期）击穿单笔上限（截图「年卡以上最高返现 75 元」）。
 *
 * 比例取 max 而不是直接覆盖：家长买的是月卡但已经拉满 10 人，
 * 阶梯给的 20% 低于月卡下限的 50%，此时按 50% 算 —— 下限的含义是
 * 「至少给到这个数」，不是「不管什么情况都只给这个数」。
 */
export function quoteFirstPurchase(params: {
  baseAmountCents: number;
  inviteeCount: number;
  period: string;
  tiers: RewardTierLike[];
  config: ReferralConfigLike;
}): RewardQuote {
  const { baseAmountCents, inviteeCount, period, tiers, config } = params;
  const tier = pickTier(tiers, inviteeCount);
  if (!tier) {
    return { ratePercent: 0, amountCents: 0, capApplied: false, note: '未配置返现阶梯' };
  }

  const long = isLongPeriod(period);
  let rate = tier.ratePercent;
  const notes: string[] = [`首充返现 ${rate}%（有效邀请 ${inviteeCount} 人档）`];

  if (!long && rate < config.shortPeriodMinRatePercent) {
    rate = config.shortPeriodMinRatePercent;
    notes.push(`月卡/季卡保底 ${rate}%`);
  }

  const raw = Math.floor((baseAmountCents * rate) / 100);
  const cap = long ? config.longPeriodCapCents : null;
  const { amount, capped } = applyCap(raw, cap);
  if (capped) notes.push(`已达单笔上限 ¥${(amount / 100).toFixed(2)}`);

  return { ratePercent: rate, amountCents: amount, capApplied: capped, note: notes.join('；') };
}

/**
 * 续费返现。
 *
 * 截图给它的是一个区间（20%~50%）而不是一张阶梯，所以这里复用邀请人数阶梯
 * 落在区间内的值，并用 [renewalRatePercent, 50] 夹住：
 * 阶梯失效或人数很少时按 20% 兜底，任何配置失误都不会超过 50%。
 */
export function quoteRenewal(params: {
  baseAmountCents: number;
  inviteeCount: number;
  tiers: RewardTierLike[];
  config: ReferralConfigLike;
}): RewardQuote {
  const { baseAmountCents, inviteeCount, tiers, config } = params;
  const tier = pickTier(tiers, inviteeCount);
  const floor = Math.max(0, Math.min(config.renewalRatePercent, MAX_RENEWAL_RATE_PERCENT));
  const ladderRate = tier ? tier.ratePercent : floor;
  const rate = Math.max(floor, Math.min(ladderRate, MAX_RENEWAL_RATE_PERCENT));

  const raw = Math.floor((baseAmountCents * rate) / 100);
  const { amount, capped } = applyCap(raw, config.renewalCapCents);
  const notes = [`续费返现 ${rate}%`];
  if (capped) notes.push(`已达单笔上限 ¥${(amount / 100).toFixed(2)}`);

  return { ratePercent: rate, amountCents: amount, capApplied: capped, note: notes.join('；') };
}

export interface CouponAward {
  ruleId: string;
  name: string;
  amountCents: number;
  validDays: number;
  /** 第几轮（repeatEvery 规则会多轮达成）。 */
  round: number;
  /** 幂等键：同一里程碑同一轮只发一次。 */
  sourceRef: string;
}

/**
 * 当前有效邀请人数能拿到哪些券。
 *
 * 返回「所有已达成」的里程碑而不是「新达成」的：调用方用 sourceRef 的
 * 唯一索引做幂等，重复调用不会重复发券，也就不用维护「上次算到哪」。
 */
export function couponAwardsFor(rules: CouponRuleLike[], inviteeCount: number): CouponAward[] {
  const awards: CouponAward[] = [];
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (inviteeCount < rule.inviteeCount) continue;

    if (rule.repeatEvery && rule.repeatEvery > 0) {
      const rounds = 1 + Math.floor((inviteeCount - rule.inviteeCount) / rule.repeatEvery);
      for (let round = 1; round <= rounds; round += 1) {
        awards.push({
          ruleId: rule.id,
          name: round > 1 ? `${rule.name}（第 ${round} 次）` : rule.name,
          amountCents: rule.amountCents,
          validDays: rule.validDays,
          round,
          sourceRef: `${rule.id}#${round}`,
        });
      }
    } else {
      awards.push({
        ruleId: rule.id,
        name: rule.name,
        amountCents: rule.amountCents,
        validDays: rule.validDays,
        round: 1,
        sourceRef: `${rule.id}#1`,
      });
    }
  }
  return awards;
}

export interface WithdrawRequirement {
  key: 'invitees' | 'verified' | 'amount' | 'balance';
  label: string;
  met: boolean;
  current: string;
  required: string;
}

export interface WithdrawEligibility {
  eligible: boolean;
  /** 可提现金额（分）：已发放 − 已提现 − 审核中的申请。 */
  availableCents: number;
  requirements: WithdrawRequirement[];
  /** 第一条未满足的原因，直接给家长看。 */
  blockedReason: string;
}

/** 提现资格（截图第 6 条）：≥N 名有效充值用户 + 实名认证 + 累计返现 ≥M 元。 */
export function checkWithdrawEligibility(params: {
  settledCents: number;
  withdrawnCents: number;
  pendingWithdrawCents: number;
  validInvitees: number;
  verified: boolean;
  config: ReferralConfigLike;
}): WithdrawEligibility {
  const { settledCents, withdrawnCents, pendingWithdrawCents, validInvitees, verified, config } = params;
  const availableCents = Math.max(0, settledCents - withdrawnCents - pendingWithdrawCents);

  const y = (cents: number) => `¥${(cents / 100).toFixed(2)}`;

  const requirements: WithdrawRequirement[] = [
    {
      key: 'invitees',
      label: `至少邀请 ${config.withdrawMinInvitees} 名有效充值用户`,
      met: validInvitees >= config.withdrawMinInvitees,
      current: `${validInvitees} 人`,
      required: `${config.withdrawMinInvitees} 人`,
    },
  ];

  if (config.withdrawRequireVerified) {
    requirements.push({
      key: 'verified',
      label: '完成实名认证',
      met: verified,
      current: verified ? '已认证' : '未认证',
      required: '已认证',
    });
  }

  requirements.push({
    key: 'amount',
    label: `累计返现满 ${y(config.withdrawMinCents)}`,
    met: settledCents >= config.withdrawMinCents,
    current: y(settledCents),
    required: y(config.withdrawMinCents),
  });

  requirements.push({
    key: 'balance',
    label: '有可提现余额',
    met: availableCents > 0,
    current: y(availableCents),
    required: '> ¥0.00',
  });

  const blocked = requirements.find((r) => !r.met);
  return {
    eligible: !blocked,
    availableCents,
    requirements,
    blockedReason: blocked ? `${blocked.label}（当前 ${blocked.current}）` : '',
  };
}
