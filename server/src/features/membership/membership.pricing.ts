/**
 * 动态定价引擎。
 *
 * 定价是纯函数：输入（套餐、规则表、账号画像）→ 输出（原价、实付、每一条优惠的明细）。
 * 不碰数据库、不读全局状态，所以后台「改规则后价格会变成多少」可以直接用同一份代码试算，
 * 家长端看到的价格与后台试算的价格必然一致。
 *
 * 三条必须能用一句话讲清楚的规则（不然家长会怀疑乱扣费）：
 *  1. 不可叠加的规则（首单立减、同档续费折扣）同一单只取优先级最高的一条；
 *  2. 可叠加的规则（年付立减、连续包月折扣、多设备折扣、升级抵扣）全部生效；
 *  3. 每条折扣都按**原价**计算再相加 —— 不做「折上折」的复利，
 *     否则同一条规则因为排序不同会算出不同价格，后台就没法解释了。
 */

import {
  DISCOUNT_TYPE_LABELS,
  MIN_PAYABLE_CENTS,
  TIER_RANK,
  type DiscountType,
  type MembershipTier,
} from './membership.constants';

/** 定价只关心规则的这些字段（Prisma 行结构兼容）。 */
export interface PricingRuleLike {
  id: string;
  name: string;
  conditionType: string;
  conditionMinDevices: number | null;
  conditionDays: number | null;
  conditionFromTier: string | null;
  targetTier: string;
  targetPeriod: string;
  discountType: string;
  discountValue: number;
  stackable: boolean;
  priority: number;
  note: string;
}

/** 定价只关心套餐的这些字段。 */
export interface PricingPlanLike {
  code: string;
  tier: string;
  period: string;
  basePriceCents: number;
  months: number;
}

/** 账号画像 —— 规则判断所需的一切，全部来自该账号自己的数据。 */
export interface PricingContext {
  /** 是否付费成功过（firstPaidAt 非空）。 */
  hasPaid: boolean;
  /** 当前**生效**档位（已按到期时间收敛，不是库里的原始值）。 */
  activeTier: MembershipTier;
  /** 已绑定的孩子设备数。 */
  deviceCount: number;
  /** 注册至今的天数。 */
  registeredDaysAgo: number;
}

export interface PricingAdjustment {
  ruleId: string;
  name: string;
  discountType: DiscountType;
  discountValue: number;
  /** 这条规则实际减掉的钱（分）。 */
  amountCents: number;
  /** 结算明细里给家长看的一句话。 */
  note: string;
}

export interface PricingResult {
  originalCents: number;
  finalCents: number;
  discountCents: number;
  /** 折合每月多少钱（分）。按年的套餐要靠它才能和按月比价。 */
  monthlyEquivalentCents: number;
  adjustments: PricingAdjustment[];
}

const ALL = 'all';

function matches(rule: PricingRuleLike, plan: PricingPlanLike, ctx: PricingContext): boolean {
  if (rule.targetTier !== ALL && rule.targetTier !== plan.tier) return false;
  if (rule.targetPeriod !== ALL && rule.targetPeriod !== plan.period) return false;

  switch (rule.conditionType) {
    case 'always':
      return true;
    case 'first_purchase':
      return !ctx.hasPaid;
    case 'active_membership':
      // 同一档位才叫「续费」：会员升超级会员是另一次购买（走 tier_upgrade 抵扣），
      // 否则两条规则会同时命中同一单，家长看到的就是「续费折扣 + 升级抵扣」双份优惠。
      return ctx.activeTier === plan.tier;
    case 'no_active_membership':
      return ctx.activeTier === 'ordinary';
    case 'device_count':
      return ctx.deviceCount >= (rule.conditionMinDevices ?? 2);
    case 'registered_within_days':
      return ctx.registeredDaysAgo <= (rule.conditionDays ?? 7);
    case 'tier_upgrade':
      return (
        rule.conditionFromTier !== null &&
        ctx.activeTier === rule.conditionFromTier &&
        TIER_RANK[plan.tier as MembershipTier] > TIER_RANK[ctx.activeTier]
      );
    default:
      // 后台写了未知条件（理论上被 zod 拦住）时按「不命中」处理：
      // 少给一次优惠是可解释的，凭空多减一笔钱不可解释。
      return false;
  }
}

function autoNote(rule: PricingRuleLike): string {
  if (rule.discountType === 'percent') return `${rule.name}（${100 - rule.discountValue} 折）`;
  return `${rule.name}（${DISCOUNT_TYPE_LABELS.amount}）`;
}

function amountOf(rule: PricingRuleLike, basePriceCents: number): number {
  if (rule.discountType === 'percent') {
    const pct = Math.min(100, Math.max(0, rule.discountValue));
    return Math.round((basePriceCents * pct) / 100);
  }
  return Math.max(0, rule.discountValue);
}

/**
 * 计算某个套餐在这个账号下的最终价格。
 *
 * @param enforceStacking false 时忽略「不可叠加」限制，把命中的规则全部列出 ——
 *        后台的规则试算用这个模式，方便运营看清每条规则各自会减多少。
 */
export function priceOf(
  plan: PricingPlanLike,
  rules: PricingRuleLike[],
  ctx: PricingContext,
  enforceStacking = true,
): PricingResult {
  const matched = rules.filter((r) => matches(r, plan, ctx));

  let applied = matched;
  if (enforceStacking) {
    const exclusive = matched
      .filter((r) => !r.stackable)
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const stackable = matched.filter((r) => r.stackable);
    // 不可叠加的规则只保留优先级最高的一条
    applied = exclusive.length > 0 ? [...stackable, exclusive[0]] : stackable;
  }

  const ordered = [...applied].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  const adjustments: PricingAdjustment[] = ordered.map((r) => ({
    ruleId: r.id,
    name: r.name,
    discountType: r.discountType === 'percent' ? 'percent' : 'amount',
    discountValue: r.discountValue,
    amountCents: amountOf(r, plan.basePriceCents),
    note: r.note || autoNote(r),
  }));

  const totalDiscount = adjustments.reduce((sum, a) => sum + a.amountCents, 0);
  // 兜底不低于 MIN_PAYABLE_CENTS：后台把规则配成「减 9999 元」时，
  // 结果必须是一笔还能收的钱，而不是 0 元单或负数。
  const finalCents = Math.max(MIN_PAYABLE_CENTS, plan.basePriceCents - totalDiscount);
  const discountCents = plan.basePriceCents - finalCents;

  // 地板价生效时，各条明细的减免额加起来会比实际折扣多（比如「首月 1 元」）。
  // 从优先级最低的那条开始把多出来的部分削掉，甚至整条去掉，这样家长把明细逐条相加
  // 得到的永远等于实际要付的钱 —— 否则「明细 ￥-100 减了 ￥0.5」看着就像算错了。
  let excess = totalDiscount - discountCents;
  for (let i = adjustments.length - 1; i >= 0 && excess > 0; i -= 1) {
    const cut = Math.min(adjustments[i].amountCents, excess);
    adjustments[i] = { ...adjustments[i], amountCents: adjustments[i].amountCents - cut };
    excess -= cut;
  }
  const reconciled = adjustments.filter((a) => a.amountCents > 0);
  const months = plan.months > 0 ? plan.months : 1;

  return {
    originalCents: plan.basePriceCents,
    finalCents,
    discountCents,
    monthlyEquivalentCents: Math.round(finalCents / months),
    adjustments: reconciled,
  };
}

/** 按档位给套餐分组，家长端一档一列展示。 */
export function groupByTier<T extends { tier: string }>(plans: T[]): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const p of plans) {
    (out[p.tier] ??= []).push(p);
  }
  return out;
}

// ============================================================
// 受邀用户定价 —— 会员价格与「买家是不是被邀请来的」的关联公式
// ============================================================

/**
 * 一句话讲清这条关联公式：
 *
 * ```
 * 结账价 = max(常规定价, 受邀加价)
 *
 * 常规定价 = 套餐基准价 − Σ(MembershipPricingRule 命中的规则)     // 上面的 priceOf，完全不变
 * 受邀加价 = 每条命中的 MembershipReferralPriceRule 各算一个价，取其中**最高**的：
 *              percent → round(常规定价实付 × (100 + v) / 100)   // v 是上浮百分比
 *              amount  → 常规定价实付 + v
 *              fixed   → v（一口价）
 *            再兜底不低于 MIN_PAYABLE_CENTS
 * ```
 *
 * **为什么是「加价」而不是「打折」**：邀请人会拿到分享返现（最高 50%），这笔钱是平台出的，
 * 成本必须落在这位被邀请家长的订单上。若让被邀请的人更便宜，就等于每拉一个新用户平台净亏
 * 一笔返现 —— 拉得越多亏得越多。
 *
 * 三个刻意的选择：
 *  1. **max 而不是相加、也不是 min**。受邀用户的价格只会不低于常规定价：
 *     - 相加会让「后台多配一条规则」变成对家长的乱收费，也没法向家长解释为什么贵这么多；
 *     - min 会让被邀请反而更便宜，而返现正是按**实付**金额算的，等于给刷单留了一个口子。
 *     取 max 之后，规则配错（上浮填成负数、一口价填得比常规价还低）只会「不生效」。
 *  2. **基数是常规定价的实付价**，不是套餐原价。受邀加价是在常规优惠**之后**对家长实际要付
 *     的钱加价：否则「加收 30 元」会被常规折扣吃掉一部分，后台写着 30 元、实际只多收 20 元。
 *  3. **规则之间不可叠加**，而是所有命中规则各算一次再取最高价（不是按 priority 挑一条）。
 *     后台临时加一条更高的规则就一定生效，不用去猜现有规则的优先级。
 *
 * 引擎依然是纯函数：`PricingContext` 与 `ReferralPricingContext` 都由服务层从账号自己的
 * 数据里读出来，所以后台试算与家长端看到的价格必然一致。
 */

/** 受邀定价规则只关心这些字段（Prisma 行结构兼容）。 */
export interface ReferralPriceRuleLike {
  id: string;
  name: string;
  targetTier: string;
  targetPeriod: string;
  priceType: string; // percent | amount | fixed
  priceValue: number;
  firstPurchaseOnly: boolean;
  requireActiveReferral: boolean;
  priority: number;
  note: string;
}

/** 账号的邀请身份 —— 由服务层从 User / Referral 读出来后传进来。 */
export interface ReferralPricingContext {
  /** 是否通过邀请链接注册（`User.referredById` 非空）。 */
  invited: boolean;
  /** 邀请关系是否仍然有效（`Referral.status !== 'invalid'`，即没被反诈判为自买自返）。 */
  active: boolean;
}

/** 报价里回给前端的「受邀用户定价」说明块。 */
export interface ReferralPriceView {
  /** 这个账号有没有资格走受邀定价（受邀注册）。 */
  applicable: boolean;
  /** 受邀加价最终有没有真的生效（生效 = 结账价比常规定价高）。 */
  applied: boolean;
  /** 一句话解释当前状态，家长端与后台试算共用。 */
  reason: string;
  ruleId: string | null;
  ruleName: string;
  priceType: string | null;
  priceValue: number;
  /** 加价基数：常规定价的实付价。 */
  baseCents: number;
  /** 命中的规则算出来的最高那个价（没命中则为 null）。 */
  candidateCents: number | null;
  /** 比常规定价多收了多少分。 */
  surchargeCents: number;
  /** 结账价 = max(常规定价, candidateCents)。 */
  finalCents: number;
  /** 一共命中几条规则 —— 后台试算用它说明「价格是取的最高的一条」。 */
  matchedCount: number;
  /** 明细里给家长看的一句话。 */
  note: string;
}

function referralMatches(
  rule: ReferralPriceRuleLike,
  plan: PricingPlanLike,
  ctx: PricingContext,
): boolean {
  if (rule.targetTier !== ALL && rule.targetTier !== plan.tier) return false;
  if (rule.targetPeriod !== ALL && rule.targetPeriod !== plan.period) return false;
  if (rule.firstPurchaseOnly && ctx.hasPaid) return false;
  return true;
}

/** 把一条规则折算成价格（基数是常规定价的实付价）。 */
function referralCandidateCents(rule: ReferralPriceRuleLike, baseCents: number): number {
  switch (rule.priceType) {
    case 'percent': {
      const pct = Math.max(0, rule.priceValue);
      return Math.round((baseCents * (100 + pct)) / 100);
    }
    case 'fixed':
      return Math.max(0, rule.priceValue);
    default:
      // amount：加收固定金额
      return Math.max(0, baseCents + rule.priceValue);
  }
}

function referralAutoNote(rule: ReferralPriceRuleLike): string {
  if (rule.priceType === 'percent') return `${rule.name}（上浮 ${rule.priceValue}%）`;
  if (rule.priceType === 'fixed') return `${rule.name}（一口价）`;
  return `${rule.name}（受邀加收）`;
}

/**
 * 在常规定价之上套用受邀定价：**取两者中更高的那个价**。
 *
 * 加价**不**作为一条明细塞进 `result.adjustments`。adjustments 是「逐条相加 == 实际优惠」
 * 的优惠清单，把正数（加价）混进去会让这条恒等式变成假的；家长端把加价单独显示一行。
 * 因此这里的关系是：`finalCents === normal.finalCents + surchargeCents`，而
 * `plan.basePriceCents − Σ(adjustments) === normal.finalCents` 仍然成立。
 */
export function referralSurchargeOf(
  plan: PricingPlanLike,
  normal: PricingResult,
  rules: ReferralPriceRuleLike[],
  ctx: PricingContext,
  referralCtx: ReferralPricingContext,
): { result: PricingResult; referral: ReferralPriceView } {
  const empty = (reason: string, applicable: boolean): ReferralPriceView => ({
    applicable,
    applied: false,
    reason,
    ruleId: null,
    ruleName: '',
    priceType: null,
    priceValue: 0,
    baseCents: normal.finalCents,
    candidateCents: null,
    surchargeCents: 0,
    finalCents: normal.finalCents,
    matchedCount: 0,
    note: '',
  });

  if (!referralCtx.invited) {
    return { result: normal, referral: empty('该账号不是通过邀请注册的，按常规定价结算', false) };
  }

  const inScope = rules.filter(
    (r) => (!r.requireActiveReferral || referralCtx.active) && referralMatches(r, plan, ctx),
  );
  if (inScope.length === 0) {
    // 受邀但没命中：分两种更好解释的情况 —— 关系被作废 vs 本单只是没有匹配的规则
    const reason = referralCtx.active
      ? '当前套餐没有匹配的受邀定价规则，按常规定价结算'
      : '邀请关系已作废，按常规定价结算';
    return { result: normal, referral: empty(reason, true) };
  }

  /*
    所有命中规则各算一次，取最高价 —— 不是按 priority 挑一条。
    priority 只在**同价**时决定显示哪条（以及后台的排序），让「优先级」保持可解释但
    不会因为优先级低的规则算出更高的价而被忽略。
  */
  const priced = inScope.map((rule) => ({
    rule,
    cents: Math.max(MIN_PAYABLE_CENTS, referralCandidateCents(rule, normal.finalCents)),
  }));
  const best = [...priced].sort(
    (a, b) =>
      b.cents - a.cents || b.rule.priority - a.rule.priority || a.rule.id.localeCompare(b.rule.id),
  )[0];

  const note = best.rule.note || referralAutoNote(best.rule);
  const base = {
    ruleId: best.rule.id,
    ruleName: best.rule.name,
    priceType: best.rule.priceType,
    priceValue: best.rule.priceValue,
    baseCents: normal.finalCents,
    candidateCents: best.cents,
    matchedCount: inScope.length,
    note,
  };

  if (best.cents <= normal.finalCents) {
    return {
      result: normal,
      referral: {
        ...empty('常规定价已经不低于这条受邀定价规则，规则不生效', true),
        ...base,
      },
    };
  }

  const surchargeCents = best.cents - normal.finalCents;
  const finalCents = best.cents;
  const months = plan.months > 0 ? plan.months : 1;

  return {
    result: {
      originalCents: plan.basePriceCents,
      finalCents,
      // 可能是负数：受邀加价把常规优惠抵消掉、甚至超过套餐原价。前端只在 > 0 时显示
      // 「已优惠」，所以不需要在这里做展示层的兜底，但保留真实数值方便后台对账。
      discountCents: plan.basePriceCents - finalCents,
      monthlyEquivalentCents: Math.round(finalCents / months),
      adjustments: normal.adjustments,
    },
    referral: {
      ...base,
      applicable: true,
      applied: true,
      reason: '已按受邀用户定价结算',
      surchargeCents,
      finalCents,
    },
  };
}

/** 常规定价 + 受邀定价，一次算完（家长端、下单、后台试算都走它）。 */
export function priceWithReferral(
  plan: PricingPlanLike,
  rules: PricingRuleLike[],
  ctx: PricingContext,
  referralRules: ReferralPriceRuleLike[],
  referralCtx: ReferralPricingContext,
  enforceStacking = true,
): { result: PricingResult; referral: ReferralPriceView } {
  const normal = priceOf(plan, rules, ctx, enforceStacking);
  return referralSurchargeOf(plan, normal, referralRules, ctx, referralCtx);
}
